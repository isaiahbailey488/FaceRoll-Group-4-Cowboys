"""Read-only classroom identification built on the shared recognition core."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Collection, Iterable

from .engine import (
    DetectedFaceEmbedding,
    IdentificationResult,
    find_best_match,
    generate_detected_embeddings,
    validate_image,
)
from .storage import EnrollmentLoadError, EnrollmentReader


@dataclass(frozen=True)
class IgnoredClassroomFace:
    """One detected face intentionally excluded from matching."""

    face_index: int
    reason: str


@dataclass(frozen=True)
class ClassroomFaceResult:
    """One non-clipped classroom face and its identification result."""

    face_index: int
    identification: IdentificationResult
    student_id: str | None = None
    display_name: str | None = None

    @property
    def uid(self) -> str | None:
        return self.identification.uid


@dataclass(frozen=True)
class ClassroomRecognitionBatch:
    """Safe result for one classroom frame."""

    faces: tuple[ClassroomFaceResult, ...]
    ignored_faces: tuple[IgnoredClassroomFace, ...]
    rejected_files: tuple[EnrollmentLoadError, ...]
    candidate_count: int


class ClassroomRecognizer:
    """Identify every usable face against validated local enrollments."""

    def __init__(
        self,
        enrollment_reader: EnrollmentReader,
        *,
        allowed_uids: Collection[str] | None = None,
        embedding_generator: Callable[
            [Any], Iterable[DetectedFaceEmbedding]
        ] = generate_detected_embeddings,
        matcher: Callable[[Any, Iterable[Any]], IdentificationResult] = find_best_match,
    ) -> None:
        self._reader = enrollment_reader
        self._allowed_uids = (
            None
            if allowed_uids is None
            else frozenset(
                uid.strip()
                for uid in allowed_uids
                if isinstance(uid, str) and uid.strip()
            )
        )
        self._embedding_generator = embedding_generator
        self._matcher = matcher

    def recognize(self, image: Any) -> ClassroomRecognitionBatch:
        """Recognize all usable faces without mutating enrollment storage."""

        validated_image = validate_image(image)
        report = self._reader.load_all()
        records = tuple(
            record
            for record in report.records
            if self._allowed_uids is None
            or record.student_uid in self._allowed_uids
        )
        candidates = tuple(
            candidate
            for record in records
            for candidate in record.to_candidates()
        )
        if not candidates:
            return ClassroomRecognitionBatch(
                faces=(),
                ignored_faces=(),
                rejected_files=report.rejected_files,
                candidate_count=0,
            )

        record_by_uid = {record.student_uid: record for record in records}
        image_height, image_width = validated_image.shape[:2]
        faces = []
        ignored_faces = []
        for face_index, detected in enumerate(
            self._embedding_generator(validated_image), start=1
        ):
            if detected.region is not None and detected.region.is_obviously_clipped(
                image_width, image_height
            ):
                ignored_faces.append(
                    IgnoredClassroomFace(
                        face_index=face_index,
                        reason="face bounds touch the image edge",
                    )
                )
                continue

            identification = self._matcher(detected.vector, candidates)
            record = (
                record_by_uid.get(identification.uid)
                if identification.uid is not None
                else None
            )
            faces.append(
                ClassroomFaceResult(
                    face_index=face_index,
                    identification=identification,
                    student_id=record.student_id if record is not None else None,
                    display_name=record.display_name if record is not None else None,
                )
            )

        return ClassroomRecognitionBatch(
            faces=tuple(faces),
            ignored_faces=tuple(ignored_faces),
            rejected_files=report.rejected_files,
            candidate_count=len(candidates),
        )


class RecognitionCooldown:
    """Suppress repeated events independently for each Firebase UID."""

    def __init__(
        self,
        cooldown_seconds: float,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if cooldown_seconds < 0:
            raise ValueError("Recognition cooldown cannot be negative.")
        self._cooldown_seconds = float(cooldown_seconds)
        self._clock = clock
        self._last_emitted_at: dict[str, float] = {}

    def allow(self, uid: str) -> bool:
        """Record and allow a UID unless it is still on cooldown."""

        normalized_uid = uid.strip() if isinstance(uid, str) else ""
        if not normalized_uid:
            raise ValueError("Recognition cooldown requires a Firebase UID.")
        now = self._clock()
        last_emitted_at = self._last_emitted_at.get(normalized_uid)
        if (
            last_emitted_at is not None
            and now - last_emitted_at < self._cooldown_seconds
        ):
            return False
        self._last_emitted_at[normalized_uid] = now
        return True

    def clear(self) -> None:
        self._last_emitted_at.clear()
