"""Shared facial-recognition primitives for all FaceRoll clients.

The mobile API and classroom-camera adapters will depend on this package rather
than defining their own model, preprocessing, or matching configuration.
"""

from .config import SETTINGS, RecognitionSettings
from .errors import (
    DependencyUnavailableError,
    EnrollmentNotFoundError,
    IncompatibleEmbeddingError,
    InvalidEmbeddingError,
    InvalidImageError,
    MultipleFacesDetectedError,
    NoFaceDetectedError,
    RecognitionCoreError,
    StorageError,
    StorageAuthorizationError,
)
from .engine import (
    EmbeddingCandidate,
    IdentificationResult,
    VerificationResult,
    cosine_distance,
    decode_base64_image,
    find_best_match,
    generate_embeddings,
    generate_single_embedding,
    load_image_file,
    validate_embedding,
    validate_image,
    verify_embedding,
)
from .schemas import ENROLLMENT_SAMPLE_COUNT, EnrollmentEmbedding, EnrollmentRecord
from .storage import (
    EnrollmentLoadError,
    EnrollmentLoadReport,
    EnrollmentReader,
    MobileEnrollmentStore,
)

__all__ = [
    "SETTINGS",
    "RecognitionSettings",
    "RecognitionCoreError",
    "DependencyUnavailableError",
    "EnrollmentNotFoundError",
    "InvalidImageError",
    "NoFaceDetectedError",
    "MultipleFacesDetectedError",
    "InvalidEmbeddingError",
    "IncompatibleEmbeddingError",
    "StorageError",
    "StorageAuthorizationError",
    "EmbeddingCandidate",
    "VerificationResult",
    "IdentificationResult",
    "decode_base64_image",
    "load_image_file",
    "validate_image",
    "validate_embedding",
    "generate_embeddings",
    "generate_single_embedding",
    "cosine_distance",
    "verify_embedding",
    "find_best_match",
    "ENROLLMENT_SAMPLE_COUNT",
    "EnrollmentEmbedding",
    "EnrollmentRecord",
    "EnrollmentLoadError",
    "EnrollmentLoadReport",
    "EnrollmentReader",
    "MobileEnrollmentStore",
]

__version__ = "0.1.0"
