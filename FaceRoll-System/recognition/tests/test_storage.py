import json
import os
import stat
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np

from faceroll_recognition import (
    EnrollmentNotFoundError,
    EnrollmentReader,
    EnrollmentRecord,
    MobileEnrollmentStore,
    StorageAuthorizationError,
    StorageError,
)
from faceroll_recognition.storage import MAX_ENROLLMENT_FILE_BYTES


TIMESTAMP = "2026-08-31T16:00:00Z"


def unit_vector(index):
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1.0
    return vector.tolist()


def enrollment(uid="firebase-uid-123", display_name="Example Student"):
    return EnrollmentRecord.create(
        student_uid=uid,
        student_id="school-id-456",
        display_name=display_name,
        vectors=[unit_vector(0), unit_vector(1), unit_vector(2)],
        created_at=TIMESTAMP,
    )


class EnrollmentStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name) / "embeddings"
        self.reader = EnrollmentReader(self.root)
        self.store = MobileEnrollmentStore(self.root)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_reader_does_not_expose_enrollment_writes(self):
        self.assertFalse(hasattr(self.reader, "save_mobile_enrollment"))
        self.assertFalse(hasattr(self.reader, "delete_enrollment"))

    def test_mobile_save_and_read_round_trip(self):
        record = enrollment()
        path = self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )
        self.assertEqual(path.name, "firebase-uid-123.json")
        self.assertEqual(self.reader.load(record.student_uid), record)

    def test_stored_json_contains_no_raw_image_fields(self):
        record = enrollment()
        path = self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        forbidden = {"image", "image_base64", "photo", "source_path", "filename"}
        self.assertTrue(forbidden.isdisjoint(data))
        self.assertEqual(len(data["embeddings"]), 3)

    def test_save_uses_restrictive_posix_permissions(self):
        record = enrollment()
        path = self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_atomic_save_leaves_no_temporary_file(self):
        record = enrollment()
        self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )
        self.assertEqual(list(self.root.glob("*.tmp")), [])
        self.assertEqual(list(self.root.glob(".*.tmp")), [])

    def test_reenrollment_replaces_only_the_same_uid(self):
        original = enrollment(display_name="Original Name")
        replacement = replace(original, display_name="Updated Name")
        self.store.save_mobile_enrollment(
            original,
            authenticated_uid=original.student_uid,
        )
        self.store.save_mobile_enrollment(
            replacement,
            authenticated_uid=replacement.student_uid,
        )
        self.assertEqual(self.reader.load(original.student_uid).display_name, "Updated Name")
        self.assertEqual(len(list(self.root.glob("*.json"))), 1)

    def test_authenticated_uid_must_match_record_owner(self):
        with self.assertRaises(StorageAuthorizationError):
            self.store.save_mobile_enrollment(
                enrollment(),
                authenticated_uid="different-firebase-uid",
            )
        self.assertFalse(self.root.exists())

    def test_writer_rejects_unvalidated_objects(self):
        with self.assertRaisesRegex(StorageError, "validated EnrollmentRecord"):
            self.store.save_mobile_enrollment(  # type: ignore[arg-type]
                {"student_uid": "firebase-uid-123"},
                authenticated_uid="firebase-uid-123",
            )

    def test_unsafe_uid_is_rejected(self):
        unsafe_record = enrollment(uid="../outside")
        with self.assertRaisesRegex(StorageError, "unsafe"):
            self.store.save_mobile_enrollment(
                unsafe_record,
                authenticated_uid="../outside",
            )
        with self.assertRaisesRegex(StorageError, "unsafe"):
            self.reader.load("../outside")

    def test_missing_record_raises_controlled_error(self):
        with self.assertRaises(EnrollmentNotFoundError):
            self.reader.load("missing-firebase-uid")

    def test_authorized_delete_is_idempotent(self):
        record = enrollment()
        self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )
        self.assertTrue(
            self.store.delete_enrollment(
                record.student_uid,
                authenticated_uid=record.student_uid,
            )
        )
        self.assertFalse(
            self.store.delete_enrollment(
                record.student_uid,
                authenticated_uid=record.student_uid,
            )
        )

    def test_delete_rejects_different_authenticated_uid(self):
        record = enrollment()
        self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )
        with self.assertRaises(StorageAuthorizationError):
            self.store.delete_enrollment(
                record.student_uid,
                authenticated_uid="different-firebase-uid",
            )
        self.assertEqual(self.reader.load(record.student_uid), record)

    def test_bulk_load_keeps_valid_records_and_reports_bad_files(self):
        first = enrollment(uid="firebase-uid-a")
        second = enrollment(uid="firebase-uid-b")
        self.store.save_mobile_enrollment(first, authenticated_uid=first.student_uid)
        self.store.save_mobile_enrollment(second, authenticated_uid=second.student_uid)
        (self.root / "malformed.json").write_text("{not-json", encoding="utf-8")

        legacy = first.to_dict()
        legacy["student_uid"] = "legacy-student"
        legacy["model"] = "Facenet"
        (self.root / "legacy-student.json").write_text(
            json.dumps(legacy), encoding="utf-8"
        )

        report = self.reader.load_all()
        self.assertEqual(
            {record.student_uid for record in report.records},
            {"firebase-uid-a", "firebase-uid-b"},
        )
        self.assertEqual(
            {error.filename for error in report.rejected_files},
            {"legacy-student.json", "malformed.json"},
        )
        legacy_error = next(
            error for error in report.rejected_files if error.filename == "legacy-student.json"
        )
        self.assertIn("incompatible model 'Facenet'", legacy_error.message)
        self.assertEqual(len(report.candidates), 6)

    def test_filename_uid_mismatch_is_reported(self):
        self.root.mkdir()
        (self.root / "wrong-filename.json").write_text(
            enrollment(uid="actual-uid").to_json(), encoding="utf-8"
        )
        report = self.reader.load_all()
        self.assertEqual(report.records, ())
        self.assertIn("does not match filename", report.rejected_files[0].message)

    def test_oversized_file_is_reported(self):
        self.root.mkdir()
        (self.root / "oversized.json").write_bytes(
            b" " * (MAX_ENROLLMENT_FILE_BYTES + 1)
        )
        report = self.reader.load_all()
        self.assertEqual(report.records, ())
        self.assertIn("exceeds", report.rejected_files[0].message)

    def test_empty_directory_returns_empty_report(self):
        report = self.reader.load_all()
        self.assertEqual(report.records, ())
        self.assertEqual(report.rejected_files, ())

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links unavailable")
    def test_symbolic_link_record_is_rejected(self):
        self.root.mkdir()
        outside = Path(self.temporary_directory.name) / "outside.json"
        outside.write_text(enrollment().to_json(), encoding="utf-8")
        (self.root / "firebase-uid-123.json").symlink_to(outside)
        report = self.reader.load_all()
        self.assertEqual(report.records, ())
        self.assertIn("Symbolic-link", report.rejected_files[0].message)


if __name__ == "__main__":
    unittest.main()

