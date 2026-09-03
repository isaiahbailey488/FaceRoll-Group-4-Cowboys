"""Canonical, validated enrollment records for FaceRoll embeddings."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from numbers import Real
from typing import Any, Mapping, Sequence

from .config import SETTINGS, RecognitionSettings
from .engine import EmbeddingCandidate, validate_embedding
from .errors import IncompatibleEmbeddingError, InvalidEmbeddingError


ENROLLMENT_SAMPLE_COUNT = 3


def _required(data: Mapping[str, Any], field: str) -> Any:
    if field not in data:
        raise InvalidEmbeddingError(f"Enrollment record is missing '{field}'.")
    return data[field]


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidEmbeddingError(f"'{field}' must be a non-empty string.")
    normalized = value.strip()
    if any(ord(character) < 32 for character in normalized):
        raise InvalidEmbeddingError(f"'{field}' cannot contain control characters.")
    return normalized


def _optional_string(value: Any, field: str) -> str | None:
    if value is None or value == "":
        return None
    return _required_string(value, field)


def _required_integer(value: Any, field: str) -> int:
    if type(value) is not int:
        raise InvalidEmbeddingError(f"'{field}' must be an integer.")
    return value


def _normalize_utc_timestamp(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidEmbeddingError(f"'{field}' must be a UTC ISO-8601 timestamp.")

    text = value.strip()
    parseable = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(parseable)
    except ValueError as error:
        raise InvalidEmbeddingError(
            f"'{field}' must be a valid UTC ISO-8601 timestamp."
        ) from error

    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise InvalidEmbeddingError(f"'{field}' must include the UTC timezone.")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_json_vector(value: Any, settings: RecognitionSettings) -> tuple[float, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise InvalidEmbeddingError("Embedding 'vector' must be a numeric array.")
    if any(not isinstance(item, Real) or isinstance(item, bool) for item in value):
        raise InvalidEmbeddingError("Embedding 'vector' must contain only numbers.")
    validated = validate_embedding(value, settings=settings)
    return tuple(float(item) for item in validated)


@dataclass(frozen=True)
class EnrollmentEmbedding:
    """One validated enrollment sample without its source photograph."""

    embedding_id: str
    created_at: str
    vector: tuple[float, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "embedding_id", _required_string(self.embedding_id, "embedding_id")
        )
        object.__setattr__(
            self, "created_at", _normalize_utc_timestamp(self.created_at, "created_at")
        )
        object.__setattr__(
            self, "vector", _validate_json_vector(self.vector, SETTINGS)
        )

    @classmethod
    def from_dict(
        cls,
        data: Mapping[str, Any],
        *,
        settings: RecognitionSettings = SETTINGS,
    ) -> "EnrollmentEmbedding":
        if not isinstance(data, Mapping):
            raise InvalidEmbeddingError("Each enrollment embedding must be an object.")
        return cls(
            embedding_id=_required(data, "embedding_id"),
            created_at=_required(data, "created_at"),
            vector=_validate_json_vector(_required(data, "vector"), settings),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "embedding_id": self.embedding_id,
            "created_at": self.created_at,
            "vector": list(self.vector),
        }


@dataclass(frozen=True)
class EnrollmentRecord:
    """Canonical enrollment for one Firebase user and exactly three samples."""

    schema_version: int
    embedding_version: int
    student_uid: str
    student_id: str | None
    display_name: str | None
    model: str
    detector: str
    distance_metric: str
    embedding_dimension: int
    created_at: str
    updated_at: str
    embeddings: tuple[EnrollmentEmbedding, ...]

    def __post_init__(self) -> None:
        schema_version = _required_integer(self.schema_version, "schema_version")
        embedding_version = _required_integer(
            self.embedding_version, "embedding_version"
        )
        if schema_version != SETTINGS.embedding_schema_version:
            raise IncompatibleEmbeddingError(
                f"Unsupported enrollment schema version {schema_version}; expected "
                f"{SETTINGS.embedding_schema_version}."
            )
        if embedding_version != SETTINGS.embedding_version:
            raise IncompatibleEmbeddingError(
                f"Unsupported embedding version {embedding_version}; expected "
                f"{SETTINGS.embedding_version}."
            )

        student_uid = _required_string(self.student_uid, "student_uid")
        student_id = _optional_string(self.student_id, "student_id")
        display_name = _optional_string(self.display_name, "display_name")
        model = _required_string(self.model, "model")
        detector = _required_string(self.detector, "detector")
        distance_metric = _required_string(self.distance_metric, "distance_metric")
        embedding_dimension = _required_integer(
            self.embedding_dimension, "embedding_dimension"
        )

        if model != SETTINGS.model_name:
            raise IncompatibleEmbeddingError(
                f"Enrollment uses incompatible model '{model}'; expected "
                f"'{SETTINGS.model_name}'."
            )
        if detector != SETTINGS.detector_backend:
            raise IncompatibleEmbeddingError(
                f"Enrollment uses incompatible detector '{detector}'; expected "
                f"'{SETTINGS.detector_backend}'."
            )
        if distance_metric != SETTINGS.distance_metric:
            raise IncompatibleEmbeddingError(
                f"Enrollment uses incompatible distance metric '{distance_metric}'; "
                f"expected '{SETTINGS.distance_metric}'."
            )
        if embedding_dimension != SETTINGS.embedding_dimension:
            raise IncompatibleEmbeddingError(
                f"Enrollment declares embedding dimension {embedding_dimension}; expected "
                f"{SETTINGS.embedding_dimension}."
            )

        created_at = _normalize_utc_timestamp(self.created_at, "created_at")
        updated_at = _normalize_utc_timestamp(self.updated_at, "updated_at")
        created_datetime = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        updated_datetime = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        if updated_datetime < created_datetime:
            raise InvalidEmbeddingError("'updated_at' cannot be earlier than 'created_at'.")

        if not isinstance(self.embeddings, tuple) or any(
            not isinstance(item, EnrollmentEmbedding) for item in self.embeddings
        ):
            raise InvalidEmbeddingError(
                "'embeddings' must contain validated enrollment samples."
            )
        if len(self.embeddings) != ENROLLMENT_SAMPLE_COUNT:
            raise InvalidEmbeddingError(
                f"A finalized enrollment must contain exactly "
                f"{ENROLLMENT_SAMPLE_COUNT} embeddings; received {len(self.embeddings)}."
            )
        embedding_ids = [item.embedding_id for item in self.embeddings]
        if len(embedding_ids) != len(set(embedding_ids)):
            raise InvalidEmbeddingError("Enrollment embedding IDs must be unique.")

        object.__setattr__(self, "student_uid", student_uid)
        object.__setattr__(self, "student_id", student_id)
        object.__setattr__(self, "display_name", display_name)
        object.__setattr__(self, "model", model)
        object.__setattr__(self, "detector", detector)
        object.__setattr__(self, "distance_metric", distance_metric)
        object.__setattr__(self, "created_at", created_at)
        object.__setattr__(self, "updated_at", updated_at)

    @property
    def recognition_uid(self) -> str:
        """Return the only identity allowed to drive recognition and attendance."""

        return self.student_uid

    @property
    def enrolled_vectors(self) -> tuple[tuple[float, ...], ...]:
        return tuple(item.vector for item in self.embeddings)

    def to_candidates(self) -> tuple[EmbeddingCandidate, ...]:
        return tuple(
            EmbeddingCandidate(
                uid=self.student_uid,
                vector=item.vector,
                embedding_id=item.embedding_id,
            )
            for item in self.embeddings
        )

    @classmethod
    def create(
        cls,
        *,
        student_uid: str,
        vectors: Sequence[Sequence[float]],
        student_id: str | None = None,
        display_name: str | None = None,
        created_at: str | None = None,
        settings: RecognitionSettings = SETTINGS,
    ) -> "EnrollmentRecord":
        timestamp = created_at or datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        embeddings = tuple(
            EnrollmentEmbedding(
                embedding_id=f"embedding_{index:03d}",
                created_at=timestamp,
                vector=_validate_json_vector(vector, settings),
            )
            for index, vector in enumerate(vectors, start=1)
        )
        return cls(
            schema_version=settings.embedding_schema_version,
            embedding_version=settings.embedding_version,
            student_uid=student_uid,
            student_id=student_id,
            display_name=display_name,
            model=settings.model_name,
            detector=settings.detector_backend,
            distance_metric=settings.distance_metric,
            embedding_dimension=settings.embedding_dimension,
            created_at=timestamp,
            updated_at=timestamp,
            embeddings=embeddings,
        )

    @classmethod
    def from_dict(
        cls,
        data: Mapping[str, Any],
        *,
        settings: RecognitionSettings = SETTINGS,
    ) -> "EnrollmentRecord":
        if not isinstance(data, Mapping):
            raise InvalidEmbeddingError("Enrollment JSON root must be an object.")

        # Check the model before parsing vectors so a legacy Facenet record is
        # always rejected with an explicit compatibility error.
        declared_model = _required(data, "model")
        if declared_model != settings.model_name:
            raise IncompatibleEmbeddingError(
                f"Enrollment uses incompatible model '{declared_model}'; expected "
                f"'{settings.model_name}'."
            )

        raw_embeddings = _required(data, "embeddings")
        if not isinstance(raw_embeddings, list):
            raise InvalidEmbeddingError("'embeddings' must be an array.")
        embeddings = tuple(
            EnrollmentEmbedding.from_dict(item, settings=settings)
            for item in raw_embeddings
        )

        record = cls(
            schema_version=_required(data, "schema_version"),
            embedding_version=_required(data, "embedding_version"),
            student_uid=_required(data, "student_uid"),
            student_id=data.get("student_id"),
            display_name=data.get("display_name"),
            model=declared_model,
            detector=_required(data, "detector"),
            distance_metric=_required(data, "distance_metric"),
            embedding_dimension=_required(data, "embedding_dimension"),
            created_at=_required(data, "created_at"),
            updated_at=_required(data, "updated_at"),
            embeddings=embeddings,
        )

        # A caller-supplied settings object is used for compatibility checks
        # before the canonical default constructor validation above.
        if record.schema_version != settings.embedding_schema_version:
            raise IncompatibleEmbeddingError(
                f"Unsupported enrollment schema version {record.schema_version}; expected "
                f"{settings.embedding_schema_version}."
            )
        if record.embedding_version != settings.embedding_version:
            raise IncompatibleEmbeddingError(
                f"Unsupported embedding version {record.embedding_version}; expected "
                f"{settings.embedding_version}."
            )
        return record

    @classmethod
    def from_json(
        cls,
        text: str,
        *,
        settings: RecognitionSettings = SETTINGS,
    ) -> "EnrollmentRecord":
        if not isinstance(text, str):
            raise InvalidEmbeddingError("Enrollment JSON must be text.")
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, TypeError) as error:
            raise InvalidEmbeddingError("Enrollment JSON is malformed.") from error
        return cls.from_dict(data, settings=settings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "embedding_version": self.embedding_version,
            "student_uid": self.student_uid,
            "student_id": self.student_id,
            "display_name": self.display_name,
            "model": self.model,
            "detector": self.detector,
            "distance_metric": self.distance_metric,
            "embedding_dimension": self.embedding_dimension,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "embeddings": [item.to_dict() for item in self.embeddings],
        }

    def to_json(self, *, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, allow_nan=False)
