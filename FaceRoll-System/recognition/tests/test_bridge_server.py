import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "windows" / "bridge_server.py"
SPEC = importlib.util.spec_from_file_location("faceroll_bridge_server", BRIDGE_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery guard
    raise RuntimeError(f"Could not load classroom bridge from {BRIDGE_PATH}")
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class SessionConfigurationTests(unittest.TestCase):
    def test_dashboard_session_context_is_validated_and_deduplicated(self):
        configuration = BRIDGE.parse_session_configuration(
            {
                "sessionId": " session-123 ",
                "courseId": "course-456",
                "allowedUids": ["uid-b", "uid-a", "uid-a"],
            }
        )

        self.assertEqual(configuration.session_id, "session-123")
        self.assertEqual(configuration.course_id, "course-456")
        self.assertEqual(configuration.allowed_uids, frozenset({"uid-a", "uid-b"}))

    def test_missing_roster_keeps_filter_disabled(self):
        configuration = BRIDGE.parse_session_configuration({})
        self.assertIsNone(configuration.allowed_uids)

    def test_empty_roster_enables_deny_all_filter(self):
        configuration = BRIDGE.parse_session_configuration({"allowedUids": []})
        self.assertEqual(configuration.allowed_uids, frozenset())

    def test_invalid_roster_uid_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "invalid Firebase UID"):
            BRIDGE.parse_session_configuration({"allowedUids": ["../unsafe"]})


class DockerCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        self.shared = root / "shared"
        self.enrollments = root / "enrollments"
        self.model_home = root / "model-home"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_recognizer_mounts_mobile_enrollments_read_only(self):
        manager = BRIDGE.SessionManager()
        configuration = BRIDGE.SessionConfiguration(
            session_id="session-123",
            course_id="course-456",
            allowed_uids=frozenset({"uid-b", "uid-a"}),
        )
        with (
            patch.object(BRIDGE, "SHARED_DIR", self.shared),
            patch.object(BRIDGE, "ENROLLMENTS_DIR", self.enrollments),
            patch.object(BRIDGE, "DEEPFACE_HOME", self.model_home),
        ):
            command = manager.build_recognizer_command(configuration)

        joined = "\n".join(command)
        self.assertIn(f"{self.shared.resolve()}:/app/shared", command)
        self.assertIn(
            f"{self.enrollments.resolve()}:/data/enrollments:ro",
            command,
        )
        self.assertIn(f"{self.model_home.resolve()}:/model-cache", command)
        self.assertIn("DEEPFACE_HOME=/model-cache", command)
        self.assertIn("FACEROLL_ENROLLMENT_DIR=/data/enrollments", command)
        self.assertIn("FACEROLL_SESSION_ID=session-123", command)
        self.assertIn("FACEROLL_COURSE_ID=course-456", command)
        self.assertIn("FACEROLL_ALLOWED_UIDS=uid-a,uid-b", command)
        self.assertNotIn("/app/embeddings", joined)

    def test_image_build_uses_recognition_root_context(self):
        manager = BRIDGE.SessionManager()
        success = SimpleNamespace(returncode=0, stdout="", stderr="")
        missing = SimpleNamespace(returncode=1, stdout="", stderr="missing")
        manager._run_command = unittest.mock.Mock(
            side_effect=[success, missing, success]
        )

        manager._ensure_docker_image()

        build_call = manager._run_command.call_args_list[2]
        self.assertEqual(
            build_call.args[0],
            [
                "docker",
                "build",
                "-f",
                "windows/Dockerfile",
                "-t",
                BRIDGE.DOCKER_IMAGE,
                ".",
            ],
        )
        self.assertEqual(build_call.kwargs["cwd"], BRIDGE.RECOGNITION_DIR)

    def test_docker_unavailable_has_clear_error(self):
        manager = BRIDGE.SessionManager()
        failure = SimpleNamespace(returncode=1, stdout="", stderr="unavailable")
        manager._run_command = unittest.mock.Mock(return_value=failure)

        with self.assertRaisesRegex(RuntimeError, "Docker is unavailable"):
            manager._ensure_docker_image()


class FakeProcess:
    def __init__(self, pid):
        self.pid = pid

    def poll(self):
        return None


class SessionLifecycleTests(unittest.TestCase):
    def test_start_preserves_dashboard_context_and_launches_both_processes(self):
        manager = BRIDGE.SessionManager()
        configuration = BRIDGE.SessionConfiguration(
            session_id="session-123",
            course_id="course-456",
            allowed_uids=frozenset({"uid-a"}),
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            with (
                patch.object(BRIDGE, "SHARED_DIR", root / "shared"),
                patch.object(BRIDGE, "EVENT_LOG_PATH", root / "shared" / "events.jsonl"),
                patch.object(BRIDGE, "ENROLLMENTS_DIR", root / "enrollments"),
                patch.object(BRIDGE, "DEEPFACE_HOME", root / "model-home"),
                patch.object(manager, "_remove_stale_container"),
                patch.object(manager, "_ensure_docker_image"),
                patch.object(
                    manager,
                    "_spawn_process",
                    side_effect=[FakeProcess(101), FakeProcess(202)],
                ) as spawn,
                patch.object(manager, "_wait_for_process_startup"),
            ):
                status = manager.start_session(configuration)

        self.assertTrue(status["recognizerRunning"])
        self.assertTrue(status["captureRunning"])
        self.assertEqual(status["sessionId"], "session-123")
        self.assertEqual(status["courseId"], "course-456")
        self.assertTrue(status["rosterFilterEnabled"])
        self.assertEqual(status["rosterSize"], 1)
        self.assertEqual(spawn.call_count, 2)
        recognizer_command = spawn.call_args_list[0].args[1]
        self.assertIn("FACEROLL_SESSION_ID=session-123", recognizer_command)
        capture_command = spawn.call_args_list[1].args[1]
        self.assertEqual(capture_command[-1], "capture.py")

    def test_duplicate_start_does_not_clear_existing_events(self):
        manager = BRIDGE.SessionManager()
        manager.recognizer_process = FakeProcess(101)
        manager.session_configuration = BRIDGE.SessionConfiguration(
            session_id="existing-session"
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            event_log = Path(temporary_directory) / "events.jsonl"
            event_log.write_text("existing event\n", encoding="utf-8")
            with (
                patch.object(BRIDGE, "EVENT_LOG_PATH", event_log),
                patch.object(manager, "_ensure_directories") as ensure_directories,
            ):
                status = manager.start_session(
                    BRIDGE.SessionConfiguration(session_id="new-session")
                )

            self.assertEqual(
                event_log.read_text(encoding="utf-8"),
                "existing event\n",
            )

        self.assertEqual(status["sessionId"], "existing-session")
        ensure_directories.assert_not_called()


if __name__ == "__main__":
    unittest.main()
