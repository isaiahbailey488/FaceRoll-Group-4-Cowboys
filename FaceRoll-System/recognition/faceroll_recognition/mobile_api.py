"""Authenticated mobile API for the shared FaceRoll recognition core."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from .config import SETTINGS
from .engine import decode_base64_image, generate_single_embedding, verify_embedding
from .errors import (
    DependencyUnavailableError,
    EnrollmentNotFoundError,
    InvalidImageError,
    RecognitionCoreError,
    StorageError,
)
from .schemas import ENROLLMENT_SAMPLE_COUNT, EnrollmentRecord
from .storage import MobileEnrollmentStore


API_VERSION = "1.0.0"
DEFAULT_MAX_REQUEST_BYTES = 25_000_000
DEFAULT_MAX_IMAGE_CHARACTERS = 8_000_000
IDENTITY_BODY_FIELDS = frozenset({"uid", "student_uid", "studentUid", "userId"})


class AuthenticationError(Exception):
    """The request does not contain a valid Firebase authentication token."""


class StudentAuthorizationError(Exception):
    """The authenticated account is not an authorized student."""


@dataclass(frozen=True)
class AuthenticatedStudent:
    """Student identity and optional metadata obtained from trusted Firebase data."""

    uid: str
    student_id: str | None = None
    display_name: str | None = None


class StudentTokenVerifier(Protocol):
    """Boundary used by the API to authenticate and authorize a student."""

    def verify(self, id_token: str) -> AuthenticatedStudent:
        """Return the student represented by a valid Firebase ID token."""


class FirebaseStudentTokenVerifier:
    """Verify Firebase ID tokens and require a student profile in Firestore."""

    def verify(self, id_token: str) -> AuthenticatedStudent:
        try:
            import firebase_admin
            from firebase_admin import auth, firestore
        except ImportError as error:
            raise DependencyUnavailableError(
                "Firebase Admin is required to authenticate mobile requests."
            ) from error

        try:
            try:
                firebase_admin.get_app()
            except ValueError:
                firebase_admin.initialize_app()
        except Exception as error:
            raise DependencyUnavailableError(
                "Firebase Admin could not be initialized."
            ) from error

        try:
            decoded = auth.verify_id_token(id_token, check_revoked=True)
            uid = decoded.get("uid") or decoded.get("sub")
            if not isinstance(uid, str) or not uid.strip():
                raise AuthenticationError("Firebase token is missing its user identity.")
        except AuthenticationError:
            raise
        except Exception as error:
            raise AuthenticationError("Firebase ID token could not be verified.") from error

        try:
            client = _firestore_client(firestore)
            snapshot = client.collection("users").document(uid).get()
        except DependencyUnavailableError:
            raise
        except Exception as error:
            raise DependencyUnavailableError(
                "Firebase student profile service is unavailable."
            ) from error

        try:
            if not snapshot.exists:
                raise StudentAuthorizationError(
                    "Authenticated account does not have a student profile."
                )
            profile = snapshot.to_dict() or {}
            role = profile.get("role") or profile.get("userType")
            if role != "student":
                raise StudentAuthorizationError(
                    "Only authenticated student accounts may use this endpoint."
                )

            student_id = _optional_profile_string(profile.get("studentId"))
            display_name = _optional_profile_string(
                profile.get("displayName") or profile.get("fullName") or profile.get("name")
            )
            return AuthenticatedStudent(
                uid=uid.strip(),
                student_id=student_id,
                display_name=display_name,
            )
        except (AuthenticationError, StudentAuthorizationError):
            raise
        except DependencyUnavailableError:
            raise
        except Exception as error:
            raise StudentAuthorizationError(
                "Authenticated student profile is invalid."
            ) from error


def _firestore_client(admin_firestore: Any) -> Any:
    """Create a production or explicitly emulator-only Firestore client."""

    if not os.getenv("FIRESTORE_EMULATOR_HOST"):
        return admin_firestore.client()

    project_id = (
        os.getenv("GCLOUD_PROJECT")
        or os.getenv("GOOGLE_CLOUD_PROJECT")
        or os.getenv("FIREBASE_PROJECT_ID")
    )
    if not project_id:
        raise DependencyUnavailableError(
            "A Firebase project ID is required with the Firestore emulator."
        )
    try:
        from google.auth.credentials import AnonymousCredentials
        from google.cloud import firestore as google_firestore
    except ImportError as error:
        raise DependencyUnavailableError(
            "Google Cloud Firestore dependencies are unavailable."
        ) from error
    return google_firestore.Client(
        project=project_id,
        credentials=AnonymousCredentials(),
    )


def _optional_profile_string(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _error_response(
    status: int,
    code: str,
    message: str,
    *,
    recognized: bool | None = None,
) -> tuple[Response, int]:
    payload: dict[str, Any] = {
        "success": False,
        "error": code,
        "message": message,
    }
    if recognized is not None:
        payload["recognized"] = recognized
    return jsonify(payload), status


def _bearer_token() -> str:
    header = request.headers.get("Authorization", "")
    scheme, separator, token = header.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token.strip():
        raise AuthenticationError(
            "Authorization header must contain a Firebase Bearer token."
        )
    if " " in token.strip():
        raise AuthenticationError("Authorization Bearer token is malformed.")
    return token.strip()


def _json_object() -> Mapping[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, Mapping):
        raise ValueError("Request body must be a JSON object.")
    supplied_identity = IDENTITY_BODY_FIELDS.intersection(data)
    if supplied_identity:
        raise ValueError(
            "Student identity must come from the Firebase token, not the request body."
        )
    return data


def _image_string(value: Any, *, max_characters: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Image data must be a non-empty base64 string.")
    image = value.strip()
    if len(image) > max_characters:
        raise ValueError("One or more images exceed the per-image size limit.")
    return image


def create_mobile_app(
    *,
    enrollment_store: MobileEnrollmentStore | None = None,
    token_verifier: StudentTokenVerifier | None = None,
    image_decoder: Callable[[str], Any] = decode_base64_image,
    embedding_generator: Callable[[Any], Any] = generate_single_embedding,
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
    max_image_characters: int = DEFAULT_MAX_IMAGE_CHARACTERS,
) -> Flask:
    """Create the mobile API with replaceable boundaries for focused testing."""

    if enrollment_store is None:
        configured_directory = os.getenv("FACEROLL_ENROLLMENT_DIR")
        directory = (
            Path(configured_directory).expanduser()
            if configured_directory
            else Path.home() / ".local" / "share" / "faceroll" / "enrollments"
        )
        enrollment_store = MobileEnrollmentStore(directory)
    verifier = token_verifier or FirebaseStudentTokenVerifier()

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = max_request_bytes

    def student_required(handler: Callable[..., Response | tuple[Response, int]]):
        @wraps(handler)
        def wrapped(*args: Any, **kwargs: Any):
            try:
                student = verifier.verify(_bearer_token())
            except AuthenticationError as error:
                return _error_response(401, "authentication_required", str(error))
            except StudentAuthorizationError as error:
                return _error_response(403, "student_required", str(error))
            except DependencyUnavailableError as error:
                return _error_response(503, "authentication_unavailable", str(error))
            return handler(student, *args, **kwargs)

        return wrapped

    @app.errorhandler(RequestEntityTooLarge)
    def request_too_large(_error: RequestEntityTooLarge):
        return _error_response(
            413,
            "request_too_large",
            f"Request exceeds the {max_request_bytes}-byte limit.",
        )

    @app.get("/health")
    def health():
        return jsonify(
            {
                "status": "ok",
                "service": "FaceRoll Mobile Recognition API",
                "api_version": API_VERSION,
                "model": SETTINGS.model_name,
                "detector": SETTINGS.detector_backend,
                "distance_metric": SETTINGS.distance_metric,
                "threshold": SETTINGS.distance_threshold,
                "embedding_dimension": SETTINGS.embedding_dimension,
                "schema_version": SETTINGS.embedding_schema_version,
                "embedding_version": SETTINGS.embedding_version,
                "enrollment_samples": ENROLLMENT_SAMPLE_COUNT,
            }
        )

    @app.post("/enroll")
    @student_required
    def enroll(student: AuthenticatedStudent):
        try:
            data = _json_object()
            images = data.get("images")
            if not isinstance(images, list) or len(images) != ENROLLMENT_SAMPLE_COUNT:
                raise ValueError(
                    f"Enrollment requires exactly {ENROLLMENT_SAMPLE_COUNT} images."
                )

            vectors = []
            for value in images:
                encoded = _image_string(value, max_characters=max_image_characters)
                decoded = image_decoder(encoded)
                try:
                    generated = embedding_generator(decoded)
                    vectors.append(tuple(float(item) for item in generated))
                finally:
                    del decoded

            record = EnrollmentRecord.create(
                student_uid=student.uid,
                student_id=student.student_id,
                display_name=student.display_name,
                vectors=vectors,
            )
            enrollment_store.save_mobile_enrollment(
                record,
                authenticated_uid=student.uid,
            )
            return jsonify(
                {
                    "success": True,
                    "uid": student.uid,
                    "sample_count": len(record.embeddings),
                    "model": record.model,
                    "message": "Face enrollment saved successfully.",
                }
            )
        except RequestEntityTooLarge:
            raise
        except ValueError as error:
            return _error_response(400, "invalid_request", str(error))
        except InvalidImageError as error:
            return _error_response(422, "invalid_face_image", str(error))
        except RecognitionCoreError as error:
            return _error_response(500, "enrollment_failed", str(error))
        except Exception:
            app.logger.exception("Unexpected mobile enrollment failure")
            return _error_response(
                500, "internal_error", "Enrollment could not be completed."
            )
        finally:
            # Request image strings and temporary vectors are request-scoped only.
            images = None
            vectors = None

    @app.post("/recognize")
    @student_required
    def recognize(student: AuthenticatedStudent):
        try:
            data = _json_object()
            encoded = _image_string(
                data.get("image"), max_characters=max_image_characters
            )
            record = enrollment_store.load(student.uid)
            decoded = image_decoder(encoded)
            try:
                query_vector = embedding_generator(decoded)
            finally:
                del decoded
            result = verify_embedding(query_vector, record.enrolled_vectors)
            return jsonify(
                {
                    "success": True,
                    "recognized": result.recognized,
                    "uid": student.uid if result.recognized else None,
                    "distance": result.distance,
                    "threshold": result.threshold,
                    "confidence": result.confidence,
                    "model": result.model,
                }
            )
        except RequestEntityTooLarge:
            raise
        except ValueError as error:
            return _error_response(400, "invalid_request", str(error), recognized=False)
        except EnrollmentNotFoundError as error:
            return _error_response(404, "not_enrolled", str(error), recognized=False)
        except InvalidImageError as error:
            return _error_response(422, "invalid_face_image", str(error), recognized=False)
        except RecognitionCoreError as error:
            return _error_response(500, "recognition_failed", str(error), recognized=False)
        except Exception:
            app.logger.exception("Unexpected mobile recognition failure")
            return _error_response(
                500,
                "internal_error",
                "Recognition could not be completed.",
                recognized=False,
            )
        finally:
            query_vector = None

    @app.delete("/enrollment")
    @student_required
    def delete_enrollment(student: AuthenticatedStudent):
        try:
            deleted = enrollment_store.delete_enrollment(
                student.uid,
                authenticated_uid=student.uid,
            )
            if not deleted:
                return _error_response(
                    404,
                    "not_enrolled",
                    "No local enrollment exists for the authenticated student.",
                )
            return jsonify(
                {
                    "success": True,
                    "uid": student.uid,
                    "message": "Face enrollment deleted successfully.",
                }
            )
        except StorageError as error:
            return _error_response(500, "deletion_failed", str(error))
        except Exception:
            app.logger.exception("Unexpected enrollment deletion failure")
            return _error_response(
                500, "internal_error", "Enrollment could not be deleted."
            )

    return app


def main() -> None:
    """Run a local development server; production deployment should use WSGI."""

    host = os.getenv("FACEROLL_API_HOST", "127.0.0.1")
    port = int(os.getenv("FACEROLL_API_PORT", "5055"))
    create_mobile_app().run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
