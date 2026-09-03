"""Domain exceptions raised by the shared FaceRoll recognition core."""


class RecognitionCoreError(Exception):
    """Base class for expected recognition-core failures."""


class DependencyUnavailableError(RecognitionCoreError):
    """A required recognition runtime dependency is unavailable."""


class InvalidImageError(RecognitionCoreError):
    """The supplied image cannot be decoded or processed safely."""


class NoFaceDetectedError(InvalidImageError):
    """The supplied image does not contain a detectable face."""


class MultipleFacesDetectedError(InvalidImageError):
    """An operation requiring one face received an image with multiple faces."""


class InvalidEmbeddingError(RecognitionCoreError):
    """An embedding is missing, malformed, or has invalid numeric values."""


class IncompatibleEmbeddingError(InvalidEmbeddingError):
    """An embedding was produced by an incompatible model or schema version."""


class StorageError(RecognitionCoreError):
    """An enrollment record could not be loaded, stored, or deleted safely."""


class EnrollmentNotFoundError(StorageError):
    """A requested local enrollment record does not exist."""


class StorageAuthorizationError(StorageError):
    """A storage mutation is not authorized for the requested student UID."""
