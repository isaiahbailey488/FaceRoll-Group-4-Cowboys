import importlib.util
import unittest
from pathlib import Path

from faceroll_recognition import ClassroomFaceResult, IdentificationResult


APP_PATH = Path(__file__).resolve().parents[1] / "windows" / "app.py"
SPEC = importlib.util.spec_from_file_location("faceroll_windows_app", APP_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery guard
    raise RuntimeError(f"Could not load classroom worker from {APP_PATH}")
CLASSROOM_WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLASSROOM_WORKER)


class ClassroomWorkerEventTests(unittest.TestCase):
    def recognized_face(self):
        return ClassroomFaceResult(
            face_index=2,
            identification=IdentificationResult(
                recognized=True,
                distance=0.12,
                threshold=0.3,
                confidence=0.6,
                model="Facenet512",
                uid="firebase-uid-123",
                embedding_id="sample-2",
            ),
            student_id="school-456",
            display_name="Student Name",
        )

    def test_event_uses_firebase_uid_as_authoritative_identity(self):
        event = CLASSROOM_WORKER.build_recognition_event(
            self.recognized_face(),
            timestamp="2026-09-08T12:00:00Z",
        )

        self.assertEqual(event["uid"], "firebase-uid-123")
        self.assertEqual(event["identity"], "firebase-uid-123")
        self.assertEqual(event["identityLabel"], "Student Name")
        self.assertEqual(event["studentId"], "school-456")
        self.assertNotEqual(event["identity"], event["identityLabel"])
        self.assertEqual(event["model"], "Facenet512")

    def test_nonmatch_cannot_produce_an_event(self):
        face = ClassroomFaceResult(
            face_index=1,
            identification=IdentificationResult(
                recognized=False,
                distance=0.8,
                threshold=0.3,
                confidence=0.0,
                model="Facenet512",
            ),
        )

        with self.assertRaisesRegex(ValueError, "recognized Firebase UID"):
            CLASSROOM_WORKER.build_recognition_event(face)


if __name__ == "__main__":
    unittest.main()
