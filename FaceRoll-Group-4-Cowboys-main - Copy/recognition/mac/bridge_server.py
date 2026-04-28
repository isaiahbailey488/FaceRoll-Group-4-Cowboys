import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


APP_DIR = Path(__file__).resolve().parent
SHARED_DIR = APP_DIR / "shared"
DATABASE_DIR = APP_DIR / "database"
EVENT_LOG_PATH = SHARED_DIR / "recognition-events.jsonl"
DOCKER_IMAGE = "faceroll"
CONTAINER_NAME = "faceroll-recognizer"
DEEPFACE_DIR = Path.home() / ".deepface"
HOST = "127.0.0.1"
PORT = 8765


class FaceRollBridgeServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class SessionManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.capture_process = None
        self.recognizer_process = None
        self.session_started_at = None
        self.log_lines = deque(maxlen=200)

    def _log(self, message):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{stamp}] {message}"
        self.log_lines.append(line)
        print(line, flush=True)

    def _pump_process_output(self, name, process):
        if not process.stdout:
            return

        for line in process.stdout:
            self._log(f"{name}: {line.rstrip()}")

    def _run_command(self, command):
        return subprocess.run(
            command,
            cwd=str(APP_DIR),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def _spawn_process(self, name, command, cwd):
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(
            target=self._pump_process_output,
            args=(name, process),
            daemon=True,
        ).start()
        return process

    def _is_running(self, process):
        return process is not None and process.poll() is None

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
        SHARED_DIR.mkdir(parents=True, exist_ok=True)
        DATABASE_DIR.mkdir(parents=True, exist_ok=True)
        DEEPFACE_DIR.mkdir(parents=True, exist_ok=True)

    def _ensure_docker_image(self):
        inspect = self._run_command(["docker", "image", "inspect", DOCKER_IMAGE])
        if inspect.returncode == 0:
            return

        self._log("Docker image not found locally. Building faceroll image.")
        build = self._run_command(["docker", "build", "-t", DOCKER_IMAGE, "."])
        if build.returncode != 0:
            raise RuntimeError(build.stderr.strip() or build.stdout.strip() or "Docker build failed.")

    def _remove_stale_container(self):
        self._run_command(["docker", "rm", "-f", CONTAINER_NAME])

    def start_session(self):
        with self._lock:
            self._ensure_directories()
            EVENT_LOG_PATH.write_text("", encoding="utf-8")

            if self._is_running(self.capture_process) or self._is_running(self.recognizer_process):
                self._log("Session start requested while processes are already running.")
                return self.get_status()

            self._remove_stale_container()
            self._ensure_docker_image()

            recognizer_command = [
                "docker",
                "run",
                "--rm",
                "-i",
                "-e",
                "PYTHONUNBUFFERED=1",
                "-e",
                "PYTHONIOENCODING=utf-8",
                "-v",
                f"{SHARED_DIR}:/app/shared",
                "-v",
                f"{DATABASE_DIR}:/app/database",
                "-v",
                f"{DEEPFACE_DIR}:/root/.deepface",
                "--name",
                CONTAINER_NAME,
                DOCKER_IMAGE,
            ]
            capture_command = [sys.executable, "-u", "capture.py"]

            self.recognizer_process = self._spawn_process("recognizer", recognizer_command, APP_DIR)
            time.sleep(1)
            if self.recognizer_process.poll() is not None:
                self.recognizer_process = None
                recent_logs = "\n".join(self.log_lines)
                raise RuntimeError(
                    "Recognizer container exited immediately.\n" + recent_logs
                )

            self.capture_process = self._spawn_process("capture", capture_command, APP_DIR)
            time.sleep(1)
            if self.capture_process.poll() is not None:
                self._terminate_process(self.recognizer_process, "recognizer")
                self.capture_process = None
                self.recognizer_process = None
                recent_logs = "\n".join(self.log_lines)
                raise RuntimeError(
                    "capture.py exited immediately.\n" + recent_logs
                )

            self.session_started_at = time.time()
            self._log("Live session processes started")
            return self.get_status()

    def stop_session(self):
        with self._lock:
            self._terminate_process(self.capture_process, "capture")
            self._terminate_process(self.recognizer_process, "recognizer")

            self.capture_process = None
            self.recognizer_process = None
            self.session_started_at = None

            self._remove_stale_container()

            self._log("Live session processes stopped")
            return self.get_status()

    def get_events(self, cursor):
        if not EVENT_LOG_PATH.exists():
            return [], 0

        events = []
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

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/status"):
            self._write_json(200, {"ok": True, "status": SESSION_MANAGER.get_status()})
            return

        if parsed.path == "/events":
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
                status = SESSION_MANAGER.start_session()
                self._write_json(200, {"ok": True, "status": status})
                return

            if parsed.path == "/stop-session":
                status = SESSION_MANAGER.stop_session()
                self._write_json(200, {"ok": True, "status": status})
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
