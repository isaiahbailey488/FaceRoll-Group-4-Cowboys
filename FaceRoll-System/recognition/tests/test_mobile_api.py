import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from faceroll_recognition import EnrollmentRecord, InvalidImageError, MobileEnrollmentStore
from faceroll_recognition.mobile_api import (
    API_VERSION,
    AuthenticatedStudent,
    AuthenticationError,
    FirebaseStudentTokenVerifier,
    StudentAuthorizationError,
    create_mobile_app,
)


AUTHORIZATION = {"Authorization": "Bearer valid-token"}


def unit_vector(index):
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1.0
    return vector


class FakeTokenVerifier:
    def verify(self, token):
        if token == "valid-token":
            return AuthenticatedStudent(
                uid="firebase-uid-123",
                student_id="school-id-456",
                display_name="Example Student",
            )
        if token == "other-token":
            return AuthenticatedStudent(uid="different-student")
        if token == "instructor-token":
            raise StudentAuthorizationError(
                "Only authenticated student accounts may use this endpoint."
            )
        raise AuthenticationError("Firebase ID token could not be verified.")


def fake_firebase_modules(*, decoded=None, profile=None, token_error=None):
    firebase_admin = types.ModuleType("firebase_admin")
    firebase_admin.get_app = lambda: object()
    firebase_admin.initialize_app = lambda: object()

    auth = types.ModuleType("firebase_admin.auth")

    def verify_id_token(_token, *, check_revoked):
        if token_error is not None:
            raise token_error
        if not check_revoked:
            raise AssertionError("Token revocation checks must remain enabled.")
        return decoded or {}

    auth.verify_id_token = verify_id_token

    snapshot = types.SimpleNamespace(
        exists=profile is not None,
        to_dict=lambda: profile,
    )
    document = types.SimpleNamespace(get=lambda: snapshot)
    collection = types.SimpleNamespace(document=lambda _uid: document)
    database = types.SimpleNamespace(collection=lambda _name: collection)
    firestore = types.ModuleType("firebase_admin.firestore")
    firestore.client = lambda: database

    firebase_admin.auth = auth
    firebase_admin.firestore = firestore
    return {
        "firebase_admin": firebase_admin,
        "firebase_admin.auth": auth,
        "firebase_admin.firestore": firestore,
    }


def fake_decoder(value):
    return value


def fake_embedding_generator(value):
    if value == "bad-face":
        raise InvalidImageError("No face was detected in the image.")
    indices = {
        "front": 0,
        "left": 1,
        "right": 2,
        "same-person": 0,
        "different-person": 10,
    }
    return unit_vector(indices[value])


class MobileRecognitionApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.storage_directory = Path(self.temporary_directory.name) / "enrollments"
        self.store = MobileEnrollmentStore(self.storage_directory)
        self.app = create_mobile_app(
            enrollment_store=self.store,
            token_verifier=FakeTokenVerifier(),
            image_decoder=fake_decoder,
            embedding_generator=fake_embedding_generator,
        )
        self.app.testing = True
        self.client = self.app.test_client()

    def tearDown(self):
        self.temporary_directory.cleanup()

    def enroll(self):
        return self.client.post(
            "/enroll",
            json={"images": ["front", "left", "right"]},
            headers=AUTHORIZATION,
        )

    def test_health_describes_the_shared_core_without_authentication(self):
        response = self.client.get("/health")
        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["api_version"], API_VERSION)
        self.assertEqual(payload["model"], "Facenet512")
        self.assertEqual(payload["embedding_dimension"], 512)
        self.assertEqual(payload["enrollment_samples"], 3)

    def test_protected_endpoints_require_a_bearer_token(self):
        for method, path, body in (
            (self.client.post, "/enroll", {"images": ["front", "left", "right"]}),
            (self.client.post, "/recognize", {"image": "front"}),
            (self.client.delete, "/enrollment", None),
        ):
            response = method(path, json=body)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.get_json()["error"], "authentication_required")

    def test_invalid_token_is_rejected(self):
        response = self.client.post(
            "/enroll",
            json={"images": ["front", "left", "right"]},
            headers={"Authorization": "Bearer invalid-token"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertFalse(self.storage_directory.exists())

    def test_non_student_account_is_rejected(self):
        response = self.client.post(
            "/enroll",
            json={"images": ["front", "left", "right"]},
            headers={"Authorization": "Bearer instructor-token"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["error"], "student_required")

    def test_enrollment_requires_exactly_three_images(self):
        for images in ([], ["front"], ["front", "left"], ["front", "left", "right", "front"]):
            response = self.client.post(
                "/enroll", json={"images": images}, headers=AUTHORIZATION
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("exactly 3", response.get_json()["message"])
        self.assertFalse(self.storage_directory.exists())

    def test_enrollment_identity_comes_from_verified_firebase_data(self):
        response = self.enroll()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["uid"], "firebase-uid-123")
        record = self.store.load("firebase-uid-123")
        self.assertEqual(record.student_uid, "firebase-uid-123")
        self.assertEqual(record.student_id, "school-id-456")
        self.assertEqual(record.display_name, "Example Student")
        self.assertEqual(len(record.embeddings), 3)

    def test_request_body_cannot_supply_an_identity(self):
        for field in ("uid", "student_uid", "studentUid", "userId"):
            response = self.client.post(
                "/enroll",
                json={field: "attacker", "images": ["front", "left", "right"]},
                headers=AUTHORIZATION,
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("Firebase token", response.get_json()["message"])
        self.assertFalse(self.storage_directory.exists())

    def test_raw_images_are_not_written_to_the_enrollment_file(self):
        self.assertEqual(self.enroll().status_code, 200)
        path = self.storage_directory / "firebase-uid-123.json"
        serialized = path.read_text(encoding="utf-8")
        data = json.loads(serialized)
        self.assertNotIn("front", serialized)
        self.assertNotIn("left", serialized)
        self.assertNotIn("right", serialized)
        self.assertEqual(len(data["embeddings"]), 3)

    def test_failed_reenrollment_preserves_the_previous_record(self):
        original = EnrollmentRecord.create(
            student_uid="firebase-uid-123",
            vectors=[
                unit_vector(20).tolist(),
                unit_vector(21).tolist(),
                unit_vector(22).tolist(),
            ],
            created_at="2026-09-07T12:00:00Z",
        )
        self.store.save_mobile_enrollment(
            original, authenticated_uid="firebase-uid-123"
        )
        response = self.client.post(
            "/enroll",
            json={"images": ["front", "bad-face", "right"]},
            headers=AUTHORIZATION,
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.store.load("firebase-uid-123"), original)

    def test_recognition_compares_against_the_authenticated_students_samples(self):
        self.assertEqual(self.enroll().status_code, 200)
        response = self.client.post(
            "/recognize",
            json={"image": "same-person"},
            headers=AUTHORIZATION,
        )
        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["recognized"])
        self.assertEqual(payload["uid"], "firebase-uid-123")
        self.assertEqual(payload["distance"], 0.0)

    def test_recognition_does_not_return_uid_for_a_nonmatch(self):
        self.assertEqual(self.enroll().status_code, 200)
        response = self.client.post(
            "/recognize",
            json={"image": "different-person"},
            headers=AUTHORIZATION,
        )
        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertFalse(payload["recognized"])
        self.assertIsNone(payload["uid"])

    def test_one_student_cannot_recognize_against_another_students_record(self):
        self.assertEqual(self.enroll().status_code, 200)
        response = self.client.post(
            "/recognize",
            json={"image": "same-person"},
            headers={"Authorization": "Bearer other-token"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "not_enrolled")

    def test_delete_removes_only_the_authenticated_students_enrollment(self):
        self.assertEqual(self.enroll().status_code, 200)
        response = self.client.delete("/enrollment", headers=AUTHORIZATION)
        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.storage_directory / "firebase-uid-123.json").exists())
        second = self.client.delete("/enrollment", headers=AUTHORIZATION)
        self.assertEqual(second.status_code, 404)

    def test_malformed_json_has_a_controlled_error(self):
        response = self.client.post(
            "/enroll",
            data="not-json",
            content_type="application/json",
            headers=AUTHORIZATION,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "invalid_request")

    def test_request_size_limit_has_a_controlled_error(self):
        limited_app = create_mobile_app(
            enrollment_store=self.store,
            token_verifier=FakeTokenVerifier(),
            image_decoder=fake_decoder,
            embedding_generator=fake_embedding_generator,
            max_request_bytes=100,
        )
        limited_app.testing = True
        response = limited_app.test_client().post(
            "/enroll",
            json={"images": ["x" * 100, "left", "right"]},
            headers=AUTHORIZATION,
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["error"], "request_too_large")


class FirebaseStudentTokenVerifierTests(unittest.TestCase):
    def test_verified_student_uses_uid_and_metadata_from_firebase(self):
        modules = fake_firebase_modules(
            decoded={"uid": "trusted-firebase-uid"},
            profile={
                "role": "student",
                "studentId": "school-123",
                "displayName": "Trusted Student",
            },
        )
        with patch.dict(sys.modules, modules):
            student = FirebaseStudentTokenVerifier().verify("firebase-token")
        self.assertEqual(student.uid, "trusted-firebase-uid")
        self.assertEqual(student.student_id, "school-123")
        self.assertEqual(student.display_name, "Trusted Student")

    def test_instructor_profile_is_rejected(self):
        modules = fake_firebase_modules(
            decoded={"uid": "instructor-uid"},
            profile={"role": "instructor"},
        )
        with patch.dict(sys.modules, modules):
            with self.assertRaises(StudentAuthorizationError):
                FirebaseStudentTokenVerifier().verify("firebase-token")

    def test_missing_student_profile_is_rejected(self):
        modules = fake_firebase_modules(
            decoded={"uid": "unknown-uid"},
            profile=None,
        )
        with patch.dict(sys.modules, modules):
            with self.assertRaises(StudentAuthorizationError):
                FirebaseStudentTokenVerifier().verify("firebase-token")

    def test_invalid_or_revoked_token_has_a_controlled_error(self):
        modules = fake_firebase_modules(token_error=ValueError("invalid token"))
        with patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(AuthenticationError, "could not be verified"):
                FirebaseStudentTokenVerifier().verify("firebase-token")


if __name__ == "__main__":
    unittest.main()
