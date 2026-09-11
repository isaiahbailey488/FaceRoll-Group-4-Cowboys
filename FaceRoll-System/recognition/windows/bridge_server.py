import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


APP_DIR = Path(__file__).resolve().parent
RECOGNITION_DIR = APP_DIR.parent
SHARED_DIR = APP_DIR / "shared"
DEFAULT_ENROLLMENTS_DIR = Path.home() / ".local" / "share" / "faceroll" / "enrollments"
DEFAULT_DEEPFACE_HOME = Path.home() / ".local" / "share" / "faceroll-deepface"
ENROLLMENTS_DIR = Path(
    os.getenv("FACEROLL_ENROLLMENT_DIR", str(DEFAULT_ENROLLMENTS_DIR))
).expanduser()
DEEPFACE_HOME = Path(
    os.getenv("FACEROLL_DEEPFACE_HOME")
    or os.getenv("DEEPFACE_HOME")
    or str(DEFAULT_DEEPFACE_HOME)
).expanduser()
# The dashboard polls this jsonl file through /events to learn about matches.
EVENT_LOG_PATH = SHARED_DIR / "recognition-events.jsonl"
DOCKER_IMAGE = "faceroll-recognition:0.1.0"
CONTAINER_NAME = "faceroll-recognizer-windows"
HOST = "127.0.0.1"
PORT = 8765
MAX_REQUEST_BYTES = 64_000
MAX_ROSTER_UIDS = 5_000
SAFE_FIREBASE_UID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


@dataclass(frozen=True)
class SessionConfiguration:
    session_id: str | None = None
    course_id: str | None = None
    allowed_uids: frozenset[str] | None = None


def _optional_identifier(value, label):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string.")
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > 200 or any(ord(character) < 32 for character in normalized):
        raise ValueError(f"{label} is invalid.")
    return normalized


def parse_session_configuration(payload):
    """Validate the dashboard context passed to a new recognition session."""

    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ValueError("Session request must be a JSON object.")

    allowed_uids = None
    if "allowedUids" in payload:
        raw_uids = payload["allowedUids"]
        if not isinstance(raw_uids, list):
            raise ValueError("allowedUids must be an array.")
        if len(raw_uids) > MAX_ROSTER_UIDS:
            raise ValueError("Course roster is too large.")
        normalized_uids = set()
        for uid in raw_uids:
            if not isinstance(uid, str) or not SAFE_FIREBASE_UID.fullmatch(uid.strip()):
                raise ValueError("Course roster contains an invalid Firebase UID.")
            normalized_uids.add(uid.strip())
        allowed_uids = frozenset(normalized_uids)

    return SessionConfiguration(
        session_id=_optional_identifier(payload.get("sessionId"), "sessionId"),
        course_id=_optional_identifier(payload.get("courseId"), "courseId"),
        allowed_uids=allowed_uids,
    )


class FaceRollBridgeServer(ThreadingHTTPServer):
    # Allows quick restarts during testing without waiting for the port to clear.
    allow_reuse_address = True
    daemon_threads = True


class SessionManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.capture_process = None
        self.recognizer_process = None
        self.session_started_at = None
        self.session_configuration = SessionConfiguration()
        self.log_lines = deque(maxlen=200)

    def _log(self, message):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{stamp}] {message}"
        self.log_lines.append(line)
        print(line, flush=True)

    def _pump_process_output(self, name, process):
        # Keep child process output visible in one terminal and store recent logs so dashboard startup errors can include useful context.
        if not process.stdout:
            return

        for line in process.stdout:
            self._log(f"{name}: {line.rstrip()}")

    def _run_command(self, command, *, cwd=APP_DIR):
        return subprocess.run(
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def _spawn_process(self, name, command, cwd):
        startupinfo = None
        creationflags = 0
        if sys.platform == "win32":
            # The bridge is started from the dashboard, so hide extra console
            # windows for Docker/capture child processes.
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            creationflags = subprocess.CREATE_NO_WINDOW

        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            # Decode as UTF-8 and replace invalid bytes so log streaming never crashes the bridge.
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
        threading.Thread(
            target=self._pump_process_output,
            args=(name, process),
            daemon=True,
        ).start()
        return process

    def _is_running(self, process):
        return process is not None and process.poll() is None

    def _wait_for_process_startup(self, process, name, timeout_seconds=2):
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if process.poll() is not None:
                recent_logs = "\n".join(self.log_lines)
                raise RuntimeError(f"{name} exited during startup.\n{recent_logs}")
            time.sleep(0.1)

    def _terminate_process(self, process, name):
        if not self._is_running(process):
            return

        self._log(f"Stopping {name} process")
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._log(f"Force killing {name} process")
            process.kill()
            process.wait(timeout=5)

    def _ensure_directories(self):
        # The host writes enrollments; the recognizer receives a read-only mount.
        SHARED_DIR.mkdir(parents=True, exist_ok=True)
        ENROLLMENTS_DIR.mkdir(parents=True, exist_ok=True)
        DEEPFACE_HOME.mkdir(parents=True, exist_ok=True)
        if os.name == "posix":
            ENROLLMENTS_DIR.chmod(0o700)
            DEEPFACE_HOME.chmod(0o700)

    def _ensure_docker_image(self):
        docker_info = self._run_command(["docker", "info"])
        if docker_info.returncode != 0:
            raise RuntimeError(
                "Docker is unavailable. Start Docker Desktop or the Docker engine."
            )

        inspect = self._run_command(["docker", "image", "inspect", DOCKER_IMAGE])
        if inspect.returncode == 0:
            return

        self._log("Recognition image not found locally. Building it now.")
        build = self._run_command(
            [
                "docker",
                "build",
                "-f",
                "windows/Dockerfile",
                "-t",
                DOCKER_IMAGE,
                ".",
            ],
            cwd=RECOGNITION_DIR,
        )
        if build.returncode != 0:
            raise RuntimeError(
                build.stderr.strip() or build.stdout.strip() or "Docker build failed."
            )

    def _remove_stale_container(self):
        self._run_command(["docker", "rm", "-f", CONTAINER_NAME])

    def _docker_mount(self, host_path, container_path, *, read_only=False):
        mount = f"{host_path.resolve()}:{container_path}"
        return f"{mount}:ro" if read_only else mount

    def build_recognizer_command(self, configuration):
        command = [
            "docker",
            "run",
            "--rm",
            "-i",
            "-e",
            "PYTHONUNBUFFERED=1",
            "-e",
            "PYTHONIOENCODING=utf-8",
            "-e",
            "DEEPFACE_HOME=/model-cache",
            "-e",
            "FACEROLL_ENROLLMENT_DIR=/data/enrollments",
            "-v",
            self._docker_mount(SHARED_DIR, "/app/shared"),
            "-v",
            self._docker_mount(
                ENROLLMENTS_DIR,
                "/data/enrollments",
                read_only=True,
            ),
            "-v",
            self._docker_mount(DEEPFACE_HOME, "/model-cache"),
        ]
        if configuration.session_id:
            command.extend(
                ["-e", f"FACEROLL_SESSION_ID={configuration.session_id}"]
            )
        if configuration.course_id:
            command.extend(["-e", f"FACEROLL_COURSE_ID={configuration.course_id}"])
        if configuration.allowed_uids is not None:
            command.extend(
                [
                    "-e",
                    "FACEROLL_ALLOWED_UIDS="
                    + ",".join(sorted(configuration.allowed_uids)),
                ]
            )
        command.extend(["--name", CONTAINER_NAME, DOCKER_IMAGE])
        return command

    def start_session(self, configuration=None):
        configuration = configuration or SessionConfiguration()
        with self._lock:
            if self._is_running(self.capture_process) or self._is_running(self.recognizer_process):
                self._log("Session start requested while processes are already running.")
                return self.get_status()

            self._ensure_directories()
            # A new live session should start with no unread recognition events.
            EVENT_LOG_PATH.write_text("", encoding="utf-8")
            self._remove_stale_container()
            self._ensure_docker_image()

            recognizer_command = self.build_recognizer_command(configuration)
            # Capture runs on the host because Docker on Windows cannot access
            # the laptop webcam reliably. The recognizer runs in Docker.
            capture_command = [sys.executable, "-u", "capture.py"]

            self.recognizer_process = self._spawn_process("recognizer", recognizer_command, APP_DIR)
            try:
                self._wait_for_process_startup(
                    self.recognizer_process,
                    "Recognizer container",
                )
            except RuntimeError:
                self.recognizer_process = None
                raise

            self.capture_process = self._spawn_process("capture", capture_command, APP_DIR)
            try:
                self._wait_for_process_startup(self.capture_process, "capture.py")
            except RuntimeError:
                self._terminate_process(self.recognizer_process, "recognizer")
                self.capture_process = None
                self.recognizer_process = None
                raise

            self.session_started_at = time.time()
            self.session_configuration = configuration
            self._log("Live session processes started")
            return self.get_status()

    def stop_session(self):
        with self._lock:
            self._terminate_process(self.capture_process, "capture")
            self._terminate_process(self.recognizer_process, "recognizer")

            self.capture_process = None
            self.recognizer_process = None
            self.session_started_at = None
            self.session_configuration = SessionConfiguration()

            self._remove_stale_container()

            self._log("Live session processes stopped")
            return self.get_status()

    def get_events(self, cursor):
        if not EVENT_LOG_PATH.exists():
            return [], 0

        events = []
        # Cursor is the 1-based line number already sent to the browser. Keeps polling simple and avoids duplicating matches on the dashboard.
        lines = EVENT_LOG_PATH.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines, start=1):
            if index <= cursor:
                continue

            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                self._log(f"Skipping malformed recognition event on line {index}")
                continue

            payload["cursor"] = index
            events.append(payload)

        return events, len(lines)

    def get_status(self):
        return {
            "captureRunning": self._is_running(self.capture_process),
            "recognizerRunning": self._is_running(self.recognizer_process),
            "sessionStartedAt": self.session_started_at,
            "capturePid": self.capture_process.pid if self._is_running(self.capture_process) else None,
            "recognizerPid": self.recognizer_process.pid if self._is_running(self.recognizer_process) else None,
            "bridgeHost": HOST,
            "bridgePort": PORT,
            "eventLogPath": str(EVENT_LOG_PATH),
            "model": "Facenet512",
            "sessionId": self.session_configuration.session_id,
            "courseId": self.session_configuration.course_id,
            "rosterFilterEnabled": self.session_configuration.allowed_uids is not None,
            "rosterSize": (
                len(self.session_configuration.allowed_uids)
                if self.session_configuration.allowed_uids is not None
                else None
            ),
        }


SESSION_MANAGER = SessionManager()


class BridgeRequestHandler(BaseHTTPRequestHandler):
    def _write_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Required by Chromium when a secure/local page calls a private-network
        # http://127.0.0.1:8765.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _read_json_body(self):
        raw_length = self.headers.get("Content-Length", "0")
        try:
            content_length = int(raw_length)
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            raise ValueError("Bridge request body is too large.")
        if content_length == 0:
            return {}
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Bridge request body must be valid JSON.") from error
        if not isinstance(payload, dict):
            raise ValueError("Bridge request body must be a JSON object.")
        return payload

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/status"):
            self._write_json(200, {"ok": True, "status": SESSION_MANAGER.get_status()})
            return

        if parsed.path == "/events":
            # The live session page polls this endpoint and then writes returned matches into Firestore.
            query = parse_qs(parsed.query)
            try:
                cursor = int((query.get("cursor") or ["0"])[0])
            except ValueError:
                cursor = 0
            events, next_cursor = SESSION_MANAGER.get_events(cursor)
            self._write_json(
                200,
                {
                    "ok": True,
                    "events": events,
                    "nextCursor": next_cursor,
                    "status": SESSION_MANAGER.get_status(),
                },
            )
            return

        self._write_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)

        try:
            if parsed.path == "/start-session":
                configuration = parse_session_configuration(self._read_json_body())
                status = SESSION_MANAGER.start_session(configuration)
                self._write_json(200, {"ok": True, "status": status})
                return

            if parsed.path == "/stop-session":
                status = SESSION_MANAGER.stop_session()
                self._write_json(200, {"ok": True, "status": status})
                return
        except ValueError as error:
            self._write_json(
                400,
                {
                    "ok": False,
                    "error": str(error),
                    "status": SESSION_MANAGER.get_status(),
                },
            )
            return
        except Exception as error:
            self._write_json(
                500,
                {
                    "ok": False,
                    "error": str(error),
                    "logs": list(SESSION_MANAGER.log_lines),
                    "status": SESSION_MANAGER.get_status(),
                },
            )
            return

        self._write_json(404, {"ok": False, "error": "Not found"})

    def log_message(self, format_string, *args):
        return


def main():
    server = FaceRollBridgeServer((HOST, PORT), BridgeRequestHandler)
    print(f"FaceRoll bridge listening on http://{HOST}:{PORT}", flush=True)

    def shutdown_server(signum, frame):
        print("", flush=True)

        def stop_everything():
            SESSION_MANAGER.stop_session()
            server.shutdown()

        threading.Thread(target=stop_everything, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown_server)
    signal.signal(signal.SIGTERM, shutdown_server)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
