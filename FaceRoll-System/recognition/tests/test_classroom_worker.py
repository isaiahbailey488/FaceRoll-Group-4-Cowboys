import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_event_includes_bridge_session_context(self):
        event = CLASSROOM_WORKER.build_recognition_event(
            self.recognized_face(),
            session_id="session-123",
            course_id="course-456",
        )

        self.assertEqual(event["sessionId"], "session-123")
        self.assertEqual(event["courseId"], "course-456")

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


class DynamicRosterTests(unittest.TestCase):
    def test_roster_file_changes_are_loaded_without_restarting_the_worker(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            roster = Path(temporary_directory) / "course-roster.json"
            environment = {
                "FACEROLL_ROSTER_FILE": str(roster),
                "FACEROLL_SESSION_ID": "session-123",
                "FACEROLL_COURSE_ID": "course-456",
            }
            with patch.dict(CLASSROOM_WORKER.os.environ, environment, clear=True):
                roster.write_text(json.dumps({
                    "sessionId": "session-123",
                    "courseId": "course-456",
                    "allowedUids": ["uid-a"],
                }), encoding="utf-8")
                self.assertEqual(
                    CLASSROOM_WORKER.configured_allowed_uids(),
                    frozenset({"uid-a"}),
                )
                roster.write_text(json.dumps({
                    "sessionId": "session-123",
                    "courseId": "course-456",
                    "allowedUids": ["uid-b"],
                }), encoding="utf-8")
                self.assertEqual(
                    CLASSROOM_WORKER.configured_allowed_uids(),
                    frozenset({"uid-b"}),
                )

    def test_invalid_or_stale_roster_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            roster = Path(temporary_directory) / "course-roster.json"
            roster.write_text(json.dumps({
                "sessionId": "old-session",
                "courseId": "course-456",
                "allowedUids": ["uid-a"],
            }), encoding="utf-8")
            with patch.dict(CLASSROOM_WORKER.os.environ, {
                "FACEROLL_ROSTER_FILE": str(roster),
                "FACEROLL_SESSION_ID": "session-123",
                "FACEROLL_COURSE_ID": "course-456",
            }, clear=True):
                self.assertEqual(
                    CLASSROOM_WORKER.configured_allowed_uids(),
                    frozenset(),
                )


if __name__ == "__main__":
    unittest.main()
