"""Validated local storage for FaceRoll enrollment embeddings."""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .engine import EmbeddingCandidate
from .errors import (
    EnrollmentNotFoundError,
    RecognitionCoreError,
    StorageAuthorizationError,
    StorageError,
)
from .schemas import EnrollmentRecord


MAX_ENROLLMENT_FILE_BYTES = 1_000_000
_SAFE_FIREBASE_UID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _validate_storage_uid(uid: str) -> str:
    if not isinstance(uid, str) or not uid.strip():
        raise StorageError("Firebase UID must be a non-empty string.")
    normalized = uid.strip()
    if not _SAFE_FIREBASE_UID.fullmatch(normalized):
        raise StorageError(
            "Firebase UID contains characters that are unsafe for local storage."
        )
    return normalized


def _restrict_permissions(path: Path, mode: int) -> None:
    if os.name != "posix":
        return
    try:
        os.chmod(path, mode)
    except OSError as error:
        raise StorageError(f"Could not restrict permissions for '{path.name}'.") from error


def _sync_directory(directory: Path) -> None:
    if os.name != "posix" or not hasattr(os, "O_DIRECTORY"):
        return
    try:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        # The file itself has already been flushed and atomically replaced.
        # Some filesystems do not support syncing directory handles.
        return


@dataclass(frozen=True)
class EnrollmentLoadError:
    """Controlled description of one enrollment rejected during bulk loading."""

    filename: str
    error_type: str
    message: str


@dataclass(frozen=True)
class EnrollmentLoadReport:
    """Valid records and rejected files returned without aborting a session."""

    records: tuple[EnrollmentRecord, ...]
    rejected_files: tuple[EnrollmentLoadError, ...]

    @property
    def candidates(self) -> tuple[EmbeddingCandidate, ...]:
        return tuple(
            candidate
            for record in self.records
            for candidate in record.to_candidates()
        )


class EnrollmentReader:
    """Read-only enrollment access intended for classroom recognition."""

    def __init__(self, directory: str | Path):
        self._directory = Path(directory).expanduser()

    @property
    def directory(self) -> Path:
        return self._directory

    def _record_path(self, student_uid: str) -> Path:
        uid = _validate_storage_uid(student_uid)
        return self._directory / f"{uid}.json"

    def _validate_directory_for_read(self) -> None:
        if not self._directory.exists():
            return
        if self._directory.is_symlink() or not self._directory.is_dir():
            raise StorageError("Enrollment storage path must be a real directory.")

    def _load_path(self, path: Path) -> EnrollmentRecord:
        if path.is_symlink():
            raise StorageError("Symbolic-link enrollment files are not allowed.")
        if not path.is_file():
            raise StorageError("Enrollment path is not a regular file.")
        if path.stat().st_size > MAX_ENROLLMENT_FILE_BYTES:
            raise StorageError(
                f"Enrollment file exceeds the {MAX_ENROLLMENT_FILE_BYTES}-byte limit."
            )

        filename_uid = _validate_storage_uid(path.stem)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise StorageError(f"Could not read enrollment file '{path.name}'.") from error

        record = EnrollmentRecord.from_json(text)
        if record.student_uid != filename_uid:
            raise StorageError(
                f"Enrollment UID '{record.student_uid}' does not match filename "
                f"UID '{filename_uid}'."
            )
        return record

    def load(self, student_uid: str) -> EnrollmentRecord:
        """Load one validated record or raise a controlled not-found error."""

        self._validate_directory_for_read()
        path = self._record_path(student_uid)
        if not path.exists():
            raise EnrollmentNotFoundError(
                f"No local enrollment exists for Firebase UID '{student_uid}'."
            )
        return self._load_path(path)

    def load_all(self) -> EnrollmentLoadReport:
        """Load every valid record while reporting, rather than raising, bad files."""

        self._validate_directory_for_read()
        if not self._directory.exists():
            return EnrollmentLoadReport(records=(), rejected_files=())

        records = []
        rejected = []
        for path in sorted(self._directory.glob("*.json"), key=lambda item: item.name):
            try:
                records.append(self._load_path(path))
            except (RecognitionCoreError, OSError, UnicodeError) as error:
                rejected.append(
                    EnrollmentLoadError(
                        filename=path.name,
                        error_type=type(error).__name__,
                        message=str(error),
                    )
                )
        return EnrollmentLoadReport(
            records=tuple(records),
            rejected_files=tuple(rejected),
        )


class MobileEnrollmentStore(EnrollmentReader):
    """Enrollment mutations reserved for a future authenticated mobile service."""

    def _ensure_directory_for_write(self) -> None:
        if self._directory.exists() and (
            self._directory.is_symlink() or not self._directory.is_dir()
        ):
            raise StorageError("Enrollment storage path must be a real directory.")
        try:
            self._directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError as error:
            raise StorageError("Could not create the enrollment storage directory.") from error
        _restrict_permissions(self._directory, 0o700)

    @staticmethod
    def _authorize(student_uid: str, authenticated_uid: str) -> str:
        requested = _validate_storage_uid(student_uid)
        authenticated = _validate_storage_uid(authenticated_uid)
        if requested != authenticated:
            raise StorageAuthorizationError(
                "Authenticated Firebase UID does not match the enrollment owner."
            )
        return requested

    def save_mobile_enrollment(
        self,
        record: EnrollmentRecord,
        *,
        authenticated_uid: str,
    ) -> Path:
        """Atomically create or replace the authenticated student's enrollment."""

        if not isinstance(record, EnrollmentRecord):
            raise StorageError("Only a validated EnrollmentRecord can be stored.")
        uid = self._authorize(record.student_uid, authenticated_uid)
        self._ensure_directory_for_write()
        target = self._record_path(uid)
        if target.is_symlink():
            raise StorageError("Refusing to replace a symbolic-link enrollment file.")

        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._directory,
                prefix=f".{uid}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(record.to_json())
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())

            _restrict_permissions(temporary_path, 0o600)
            os.replace(temporary_path, target)
            temporary_path = None
            _restrict_permissions(target, 0o600)
            _sync_directory(self._directory)
            return target
        except StorageError:
            raise
        except (OSError, TypeError, ValueError) as error:
            raise StorageError(
                f"Could not store enrollment for Firebase UID '{uid}'."
            ) from error
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def delete_enrollment(
        self,
        student_uid: str,
        *,
        authenticated_uid: str,
    ) -> bool:
        """Delete only the authenticated student's own local enrollment."""

        uid = self._authorize(student_uid, authenticated_uid)
        self._validate_directory_for_read()
        path = self._record_path(uid)
        if not path.exists():
            return False
        if path.is_symlink() or not path.is_file():
            raise StorageError("Refusing to delete a non-regular enrollment file.")
        try:
            path.unlink()
            _sync_directory(self._directory)
        except OSError as error:
            raise StorageError(
                f"Could not delete enrollment for Firebase UID '{uid}'."
            ) from error
        return True

