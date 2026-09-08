import tempfile
import unittest
from pathlib import Path

import numpy as np

from faceroll_recognition import (
    ClassroomRecognizer,
    DetectedFaceEmbedding,
    EnrollmentReader,
    EnrollmentRecord,
    FaceRegion,
    MobileEnrollmentStore,
    RecognitionCooldown,
)


TIMESTAMP = "2026-09-08T12:00:00Z"


def unit_vector(index):
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1.0
    return vector


def enrollment(uid, offset, *, student_id=None, display_name=None):
    return EnrollmentRecord.create(
        student_uid=uid,
        student_id=student_id,
        display_name=display_name,
        vectors=[
            unit_vector(offset).tolist(),
            unit_vector(offset + 1).tolist(),
            unit_vector(offset + 2).tolist(),
        ],
        created_at=TIMESTAMP,
    )


class ClassroomRecognizerTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name) / "enrollments"
        self.store = MobileEnrollmentStore(self.root)
        self.reader = EnrollmentReader(self.root)
        self.image = np.ones((100, 120, 3), dtype=np.uint8)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def save(self, record):
        self.store.save_mobile_enrollment(
            record,
            authenticated_uid=record.student_uid,
        )

    def test_multiple_faces_are_identified_by_firebase_uid(self):
        first = enrollment(
            "firebase-uid-a",
            0,
            student_id="school-a",
            display_name="Student A",
        )
        second = enrollment(
            "firebase-uid-b",
            10,
            student_id="school-b",
            display_name="Student B",
        )
        self.save(first)
        self.save(second)
        detected = [
            DetectedFaceEmbedding(unit_vector(0), FaceRegion(10, 10, 30, 30)),
            DetectedFaceEmbedding(unit_vector(10), FaceRegion(60, 10, 30, 30)),
        ]

        batch = ClassroomRecognizer(
            self.reader,
            embedding_generator=lambda _image: detected,
        ).recognize(self.image)

        self.assertEqual([face.uid for face in batch.faces], ["firebase-uid-a", "firebase-uid-b"])
        self.assertEqual([face.face_index for face in batch.faces], [1, 2])
        self.assertEqual(batch.faces[0].student_id, "school-a")
        self.assertEqual(batch.faces[0].display_name, "Student A")
        self.assertEqual(batch.candidate_count, 6)

    def test_course_roster_filter_excludes_other_students(self):
        self.save(enrollment("allowed-uid", 0))
        self.save(enrollment("excluded-uid", 10))
        detected = [DetectedFaceEmbedding(unit_vector(10), FaceRegion(10, 10, 30, 30))]

        batch = ClassroomRecognizer(
            self.reader,
            allowed_uids={"allowed-uid"},
            embedding_generator=lambda _image: detected,
        ).recognize(self.image)

        self.assertEqual(batch.candidate_count, 3)
        self.assertEqual(len(batch.faces), 1)
        self.assertFalse(batch.faces[0].identification.recognized)
        self.assertIsNone(batch.faces[0].uid)

    def test_obviously_clipped_face_is_recorded_and_ignored(self):
        self.save(enrollment("firebase-uid-a", 0))
        detected = [DetectedFaceEmbedding(unit_vector(0), FaceRegion(0, 10, 30, 30))]

        batch = ClassroomRecognizer(
            self.reader,
            embedding_generator=lambda _image: detected,
        ).recognize(self.image)

        self.assertEqual(batch.faces, ())
        self.assertEqual(len(batch.ignored_faces), 1)
        self.assertEqual(batch.ignored_faces[0].face_index, 1)
        self.assertIn("image edge", batch.ignored_faces[0].reason)

    def test_bad_enrollment_file_does_not_stop_valid_recognition(self):
        self.save(enrollment("firebase-uid-a", 0))
        (self.root / "malformed.json").write_text("{not-json", encoding="utf-8")
        detected = [DetectedFaceEmbedding(unit_vector(0), FaceRegion(10, 10, 30, 30))]

        batch = ClassroomRecognizer(
            self.reader,
            embedding_generator=lambda _image: detected,
        ).recognize(self.image)

        self.assertEqual(batch.faces[0].uid, "firebase-uid-a")
        self.assertEqual(batch.rejected_files[0].filename, "malformed.json")

    def test_no_candidates_avoids_embedding_generation(self):
        generator_called = False

        def generator(_image):
            nonlocal generator_called
            generator_called = True
            return []

        batch = ClassroomRecognizer(
            self.reader,
            embedding_generator=generator,
        ).recognize(self.image)

        self.assertEqual(batch.candidate_count, 0)
        self.assertEqual(batch.faces, ())
        self.assertFalse(generator_called)


class RecognitionCooldownTests(unittest.TestCase):
    def test_cooldown_is_independent_for_each_firebase_uid(self):
        current_time = [100.0]
        cooldown = RecognitionCooldown(10, clock=lambda: current_time[0])

        self.assertTrue(cooldown.allow("firebase-uid-a"))
        self.assertFalse(cooldown.allow("firebase-uid-a"))
        self.assertTrue(cooldown.allow("firebase-uid-b"))
        current_time[0] = 110.0
        self.assertTrue(cooldown.allow("firebase-uid-a"))

    def test_clear_allows_uid_immediately(self):
        cooldown = RecognitionCooldown(10, clock=lambda: 100.0)
        self.assertTrue(cooldown.allow("firebase-uid-a"))
        self.assertFalse(cooldown.allow("firebase-uid-a"))
        cooldown.clear()
        self.assertTrue(cooldown.allow("firebase-uid-a"))

    def test_blank_uid_is_rejected(self):
        cooldown = RecognitionCooldown(10)
        with self.assertRaisesRegex(ValueError, "Firebase UID"):
            cooldown.allow(" ")


if __name__ == "__main__":
    unittest.main()
