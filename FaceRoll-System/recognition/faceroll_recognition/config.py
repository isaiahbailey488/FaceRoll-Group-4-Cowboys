"""Authoritative configuration for FaceRoll facial recognition."""

from dataclasses import dataclass


@dataclass(frozen=True)
class RecognitionSettings:
    """Immutable model contract shared by every FaceRoll recognition adapter."""

    model_name: str = "Facenet512"
    detector_backend: str = "opencv"
    distance_metric: str = "cosine"
    distance_threshold: float = 0.30
    align_faces: bool = True
    enforce_detection: bool = True
    embedding_dimension: int = 512
    embedding_schema_version: int = 1
    embedding_version: int = 1
    core_version: str = "0.1.0"

    def __post_init__(self) -> None:
        if self.model_name != "Facenet512":
            raise ValueError("FaceRoll's shared recognition model must be Facenet512.")
        if self.distance_metric != "cosine":
            raise ValueError("FaceRoll currently supports only cosine distance.")
        if not 0.0 < self.distance_threshold <= 2.0:
            raise ValueError("Cosine distance threshold must be between 0 and 2.")
        if self.embedding_dimension != 512:
            raise ValueError("Facenet512 embeddings must contain 512 values.")
        if self.embedding_schema_version < 1:
            raise ValueError("Embedding schema version must be positive.")
        if self.embedding_version < 1:
            raise ValueError("Embedding version must be positive.")


SETTINGS = RecognitionSettings()

# Named constants keep adapters readable while preserving SETTINGS as the
# single immutable source of truth.
MODEL_NAME = SETTINGS.model_name
DETECTOR_BACKEND = SETTINGS.detector_backend
DISTANCE_METRIC = SETTINGS.distance_metric
DISTANCE_THRESHOLD = SETTINGS.distance_threshold
ALIGN_FACES = SETTINGS.align_faces
ENFORCE_DETECTION = SETTINGS.enforce_detection
EMBEDDING_DIMENSION = SETTINGS.embedding_dimension
EMBEDDING_SCHEMA_VERSION = SETTINGS.embedding_schema_version
EMBEDDING_VERSION = SETTINGS.embedding_version
CORE_VERSION = SETTINGS.core_version
