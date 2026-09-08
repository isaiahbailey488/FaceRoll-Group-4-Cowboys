"""Shared Facenet512 embedding generation and matching operations."""

from __future__ import annotations

import base64
import binascii
import math
from dataclasses import dataclass
from numbers import Real
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from .config import SETTINGS, RecognitionSettings
from .errors import (
    DependencyUnavailableError,
    InvalidEmbeddingError,
    InvalidImageError,
    MultipleFacesDetectedError,
    NoFaceDetectedError,
)

try:
    import numpy as np
except ImportError:  # pragma: no cover - exercised by dependency guard tests
    np = None  # type: ignore[assignment]

try:
    import cv2
except ImportError:  # pragma: no cover - expected in lightweight test environments
    cv2 = None  # type: ignore[assignment]

try:
    from deepface import DeepFace
except ImportError:  # pragma: no cover - expected in lightweight test environments
    DeepFace = None  # type: ignore[assignment]


@dataclass(frozen=True)
class EmbeddingCandidate:
    """One enrolled embedding and the identity it represents."""

    uid: str
    vector: Sequence[float]
    embedding_id: str = ""


@dataclass(frozen=True)
class FaceRegion:
    """Pixel bounds returned by the configured face detector."""

    x: int
    y: int
    width: int
    height: int

    def is_obviously_clipped(self, image_width: int, image_height: int) -> bool:
        """Return true when detector bounds touch or cross an image edge."""

        if self.width <= 0 or self.height <= 0:
            return True
        return (
            self.x <= 0
            or self.y <= 0
            or self.x + self.width >= image_width
            or self.y + self.height >= image_height
        )


@dataclass(frozen=True)
class DetectedFaceEmbedding:
    """Validated embedding plus optional detector bounds for one face."""

    vector: Sequence[float]
    region: FaceRegion | None = None


@dataclass(frozen=True)
class VerificationResult:
    """Result of comparing one face with one student's enrolled samples."""

    recognized: bool
    distance: float | None
    threshold: float
    confidence: float
    model: str


@dataclass(frozen=True)
class IdentificationResult(VerificationResult):
    """Best identity returned by a one-to-many search."""

    uid: str | None = None
    embedding_id: str = ""


def _require_numpy() -> Any:
    if np is None:
        raise DependencyUnavailableError(
            "NumPy is required by the FaceRoll recognition core."
        )
    return np


def _require_opencv() -> Any:
    if cv2 is None:
        raise DependencyUnavailableError(
            "OpenCV is required to decode and load recognition images."
        )
    return cv2


def _require_deepface() -> Any:
    if DeepFace is None:
        raise DependencyUnavailableError(
            "DeepFace is required to generate Facenet512 embeddings."
        )
    return DeepFace


def validate_image(image: Any) -> Any:
    """Validate an in-memory OpenCV-compatible image array."""

    numpy = _require_numpy()
    if not isinstance(image, numpy.ndarray):
        raise InvalidImageError("Image must be a NumPy array.")
    if image.size == 0:
        raise InvalidImageError("Image contains no pixel data.")
    if image.ndim not in (2, 3):
        raise InvalidImageError("Image must have two or three dimensions.")
    if image.shape[0] < 1 or image.shape[1] < 1:
        raise InvalidImageError("Image width and height must be positive.")
    if image.ndim == 3 and image.shape[2] not in (1, 3, 4):
        raise InvalidImageError("Image must have 1, 3, or 4 channels.")
    return image


def decode_base64_image(image_data: str) -> Any:
    """Decode a raw base64 string or data URL into an OpenCV image array."""

    if not isinstance(image_data, str) or not image_data.strip():
        raise InvalidImageError("Image data must be a non-empty base64 string.")

    encoded = image_data.strip()
    if encoded.lower().startswith("data:"):
        if "," not in encoded:
            raise InvalidImageError("Image data URL is missing its payload.")
        encoded = encoded.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise InvalidImageError("Image data is not valid base64.") from error

    if not image_bytes:
        raise InvalidImageError("Decoded image contains no data.")

    numpy = _require_numpy()
    opencv = _require_opencv()
    encoded_array = numpy.frombuffer(image_bytes, dtype=numpy.uint8)
    image = opencv.imdecode(encoded_array, opencv.IMREAD_COLOR)
    if image is None:
        raise InvalidImageError("Decoded data is not a supported image.")
    return validate_image(image)


def load_image_file(image_path: str | Path) -> Any:
    """Load an image file without altering or retaining the source file."""

    path = Path(image_path)
    if not path.is_file():
        raise InvalidImageError(f"Image file does not exist: {path}")

    opencv = _require_opencv()
    image = opencv.imread(str(path), opencv.IMREAD_COLOR)
    if image is None:
        raise InvalidImageError(f"Image file could not be decoded: {path}")
    return validate_image(image)


def validate_embedding(
    embedding: Sequence[float],
    *,
    settings: RecognitionSettings = SETTINGS,
) -> Any:
    """Return a validated, one-dimensional float32 embedding array."""

    numpy = _require_numpy()
    try:
        vector = numpy.asarray(embedding, dtype=numpy.float32)
    except (TypeError, ValueError) as error:
        raise InvalidEmbeddingError("Embedding must contain numeric values.") from error

    if vector.ndim != 1:
        raise InvalidEmbeddingError("Embedding must be a one-dimensional vector.")
    if vector.size != settings.embedding_dimension:
        raise InvalidEmbeddingError(
            f"{settings.model_name} embeddings must contain "
            f"{settings.embedding_dimension} values; received {vector.size}."
        )
    if not numpy.isfinite(vector).all():
        raise InvalidEmbeddingError("Embedding contains NaN or infinite values.")
    if float(numpy.linalg.norm(vector)) <= 0.0:
        raise InvalidEmbeddingError("Embedding cannot be a zero vector.")
    return vector


def _face_region(result: Mapping[str, Any]) -> FaceRegion | None:
    area = result.get("facial_area")
    if not isinstance(area, Mapping):
        return None
    values = [area.get(field) for field in ("x", "y", "w", "h")]
    if any(
        not isinstance(value, Real)
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        for value in values
    ):
        return None
    return FaceRegion(
        x=int(values[0]),
        y=int(values[1]),
        width=int(values[2]),
        height=int(values[3]),
    )


def generate_detected_embeddings(
    image: Any,
    *,
    settings: RecognitionSettings = SETTINGS,
) -> list[DetectedFaceEmbedding]:
    """Generate validated Facenet512 embeddings with available face bounds."""

    validate_image(image)
    deepface = _require_deepface()

    try:
        results = deepface.represent(
            img_path=image,
            model_name=settings.model_name,
            detector_backend=settings.detector_backend,
            enforce_detection=settings.enforce_detection,
            align=settings.align_faces,
        )
    except ValueError as error:
        message = str(error).lower()
        if "face" in message and ("detect" in message or "could not" in message):
            raise NoFaceDetectedError("No face was detected in the image.") from error
        raise InvalidImageError(f"Face embedding generation failed: {error}") from error
    except Exception as error:
        raise InvalidImageError(f"Face embedding generation failed: {error}") from error

    if isinstance(results, Mapping):
        results = [results]
    if not isinstance(results, Sequence) or isinstance(results, (str, bytes)):
        raise InvalidEmbeddingError("DeepFace returned an invalid result collection.")
    if not results:
        raise NoFaceDetectedError("No face was detected in the image.")

    embeddings: list[DetectedFaceEmbedding] = []
    for result in results:
        if not isinstance(result, Mapping) or "embedding" not in result:
            raise InvalidEmbeddingError("DeepFace result is missing an embedding.")
        embeddings.append(
            DetectedFaceEmbedding(
                vector=validate_embedding(result["embedding"], settings=settings),
                region=_face_region(result),
            )
        )
    return embeddings


def generate_embeddings(
    image: Any,
    *,
    settings: RecognitionSettings = SETTINGS,
) -> list[Any]:
    """Generate one Facenet512 embedding for every detected face in an image."""

    return [
        detected.vector
        for detected in generate_detected_embeddings(image, settings=settings)
    ]


def generate_single_embedding(
    image: Any,
    *,
    settings: RecognitionSettings = SETTINGS,
) -> Any:
    """Generate exactly one embedding for enrollment or phone verification."""

    embeddings = generate_embeddings(image, settings=settings)
    if len(embeddings) > 1:
        raise MultipleFacesDetectedError(
            "Exactly one face is required for this recognition operation."
        )
    return embeddings[0]


def cosine_distance(
    left: Sequence[float],
    right: Sequence[float],
    *,
    settings: RecognitionSettings = SETTINGS,
) -> float:
    """Calculate cosine distance between two compatible embeddings."""

    numpy = _require_numpy()
    left_vector = validate_embedding(left, settings=settings)
    right_vector = validate_embedding(right, settings=settings)
    denominator = float(
        numpy.linalg.norm(left_vector) * numpy.linalg.norm(right_vector)
    )
    if denominator <= 0.0:
        raise InvalidEmbeddingError("Cannot compare a zero-length embedding.")
    similarity = float(numpy.dot(left_vector, right_vector) / denominator)
    # Floating-point rounding can place cosine similarity barely outside its
    # mathematical range.
    similarity = max(-1.0, min(1.0, similarity))
    return float(1.0 - similarity)


def _confidence_from_distance(distance: float, threshold: float) -> float:
    if not math.isfinite(distance) or threshold <= 0.0:
        return 0.0
    return max(0.0, min(1.0, 1.0 - (distance / threshold)))


def verify_embedding(
    query_embedding: Sequence[float],
    enrolled_embeddings: Iterable[Sequence[float]],
    *,
    settings: RecognitionSettings = SETTINGS,
) -> VerificationResult:
    """Verify a live embedding against one student's enrolled samples."""

    query = validate_embedding(query_embedding, settings=settings)
    distances = [
        cosine_distance(query, enrolled, settings=settings)
        for enrolled in enrolled_embeddings
    ]
    if not distances:
        return VerificationResult(
            recognized=False,
            distance=None,
            threshold=settings.distance_threshold,
            confidence=0.0,
            model=settings.model_name,
        )

    best_distance = min(distances)
    return VerificationResult(
        recognized=best_distance <= settings.distance_threshold,
        distance=best_distance,
        threshold=settings.distance_threshold,
        confidence=_confidence_from_distance(
            best_distance, settings.distance_threshold
        ),
        model=settings.model_name,
    )


def find_best_match(
    query_embedding: Sequence[float],
    candidates: Iterable[EmbeddingCandidate],
    *,
    settings: RecognitionSettings = SETTINGS,
) -> IdentificationResult:
    """Identify the closest enrolled candidate to a live embedding."""

    query = validate_embedding(query_embedding, settings=settings)
    best_candidate: EmbeddingCandidate | None = None
    best_distance: float | None = None

    for candidate in candidates:
        if not candidate.uid.strip():
            raise InvalidEmbeddingError("Embedding candidate UID cannot be empty.")
        distance = cosine_distance(query, candidate.vector, settings=settings)
        if best_distance is None or distance < best_distance:
            best_candidate = candidate
            best_distance = distance

    if best_candidate is None or best_distance is None:
        return IdentificationResult(
            recognized=False,
            distance=None,
            threshold=settings.distance_threshold,
            confidence=0.0,
            model=settings.model_name,
        )

    recognized = best_distance <= settings.distance_threshold
    return IdentificationResult(
        recognized=recognized,
        distance=best_distance,
        threshold=settings.distance_threshold,
        confidence=_confidence_from_distance(
            best_distance, settings.distance_threshold
        ),
        model=settings.model_name,
        uid=best_candidate.uid if recognized else None,
        embedding_id=best_candidate.embedding_id if recognized else "",
    )
