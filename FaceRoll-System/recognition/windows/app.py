"""Classroom worker backed exclusively by the shared Facenet512 core."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from faceroll_recognition import (
    SETTINGS,
    ClassroomFaceResult,
    ClassroomRecognizer,
    EnrollmentReader,
    RecognitionCooldown,
    RecognitionCoreError,
    load_image_file,
)


APP_DIR = Path(__file__).resolve().parent
IMAGE_PATH = APP_DIR / "shared" / "input.jpg"
PROCESSING_IMAGE_PATH = APP_DIR / "shared" / "input.processing.jpg"
EVENT_LOG_PATH = APP_DIR / "shared" / "recognition-events.jsonl"
DEFAULT_ENROLLMENTS_DIR = Path.home() / ".local" / "share" / "faceroll" / "enrollments"
POLL_INTERVAL_SECONDS = 1
MATCH_COOLDOWN_SECONDS = 10


def configured_enrollment_directory() -> Path:
    configured = os.getenv("FACEROLL_ENROLLMENT_DIR")
    return Path(configured).expanduser() if configured else DEFAULT_ENROLLMENTS_DIR


def configured_allowed_uids() -> frozenset[str] | None:
    """Read an optional course roster supplied by the future bridge layer."""

    raw = os.getenv("FACEROLL_ALLOWED_UIDS")
    if raw is None:
        return None
    return frozenset(uid.strip() for uid in raw.split(",") if uid.strip())


def configured_session_context() -> tuple[str | None, str | None]:
    """Return optional bridge-supplied session and course identifiers."""

    session_id = os.getenv("FACEROLL_SESSION_ID", "").strip() or None
    course_id = os.getenv("FACEROLL_COURSE_ID", "").strip() or None
    return session_id, course_id


def append_recognition_event(payload: dict[str, Any]) -> None:
    """Append one non-biometric match event for the dashboard bridge."""

    EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with EVENT_LOG_PATH.open("a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(payload, allow_nan=False) + "\n")
        event_log.flush()


def build_recognition_event(
    face: ClassroomFaceResult,
    *,
    timestamp: str | None = None,
    session_id: str | None = None,
    course_id: str | None = None,
) -> dict[str, Any]:
    """Build a dashboard event whose authoritative identity is Firebase UID."""

    result = face.identification
    if not result.recognized or not result.uid:
        raise ValueError("Only a recognized Firebase UID can produce a match event.")

    payload: dict[str, Any] = {
        "eventType": "match",
        "timestamp": timestamp
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "uid": result.uid,
        "identity": result.uid,
        "identityLabel": face.display_name or face.student_id or "Recognized student",
        "distance": result.distance,
        "threshold": result.threshold,
        "confidence": result.confidence,
        "model": result.model,
        "faceIndex": face.face_index,
        "embeddingId": result.embedding_id,
    }
    if face.student_id:
        payload["studentId"] = face.student_id
    if session_id:
        payload["sessionId"] = session_id
    if course_id:
        payload["courseId"] = course_id
    return payload


def process_classroom_image(
    recognizer: ClassroomRecognizer,
    cooldown: RecognitionCooldown,
    *,
    image_path: Path = PROCESSING_IMAGE_PATH,
    session_id: str | None = None,
    course_id: str | None = None,
) -> int:
    """Process all usable faces in one frame and return emitted event count."""

    image = load_image_file(image_path)
    batch = recognizer.recognize(image)

    for rejection in batch.rejected_files:
        print(
            f"SKIPPED ENROLLMENT: {rejection.filename}: {rejection.message}",
            flush=True,
        )

    if batch.candidate_count == 0:
        print("No compatible Facenet512 enrollments found.", flush=True)
        return 0

    for ignored in batch.ignored_faces:
        print(
            f"IGNORED FACE {ignored.face_index}: {ignored.reason}",
            flush=True,
        )

    emitted = 0
    for face in batch.faces:
        result = face.identification
        if not result.recognized or not result.uid:
            distance = "none" if result.distance is None else f"{result.distance:.4f}"
            print(
                f"NO MATCH: face={face.face_index} best_distance={distance}",
                flush=True,
            )
            continue

        if not cooldown.allow(result.uid):
            print(
                f"MATCH ON COOLDOWN: uid={result.uid} face={face.face_index}",
                flush=True,
            )
            continue

        append_recognition_event(
            build_recognition_event(
                face,
                session_id=session_id,
                course_id=course_id,
            )
        )
        emitted += 1
        print(
            f"MATCH: uid={result.uid} face={face.face_index} "
            f"distance={result.distance:.4f} confidence={result.confidence:.2f}",
            flush=True,
        )

    return emitted


def claim_pending_image() -> bool:
    if not IMAGE_PATH.exists():
        return False
    try:
        IMAGE_PATH.replace(PROCESSING_IMAGE_PATH)
        return True
    except FileNotFoundError:
        return False
    except OSError as error:
        print(f"Error claiming image: {error}", flush=True)
        return False


def main() -> None:
    enrollment_directory = configured_enrollment_directory()
    allowed_uids = configured_allowed_uids()
    session_id, course_id = configured_session_context()
    recognizer = ClassroomRecognizer(
        EnrollmentReader(enrollment_directory),
        allowed_uids=allowed_uids,
    )
    cooldown = RecognitionCooldown(MATCH_COOLDOWN_SECONDS)

    print(
        f"Recognizer ready: model={SETTINGS.model_name} "
        f"dimension={SETTINGS.embedding_dimension} "
        f"enrollments={enrollment_directory}",
        flush=True,
    )
    if allowed_uids is not None:
        print(f"Course roster filter enabled: {len(allowed_uids)} UIDs", flush=True)
    if session_id or course_id:
        print(
            f"Session context: session={session_id or 'none'} "
            f"course={course_id or 'none'}",
            flush=True,
        )
    print("Waiting for classroom image...", flush=True)

    try:
        while True:
            if claim_pending_image():
                print("Image detected and claimed.", flush=True)
                try:
                    process_classroom_image(
                        recognizer,
                        cooldown,
                        session_id=session_id,
                        course_id=course_id,
                    )
                except RecognitionCoreError as error:
                    print(f"IGNORED FRAME: {error}", flush=True)
                except (OSError, ValueError) as error:
                    print(f"ERROR PROCESSING FRAME: {error}", flush=True)
                finally:
                    PROCESSING_IMAGE_PATH.unlink(missing_ok=True)
                print("Processed image. Waiting for next one...", flush=True)
            time.sleep(POLL_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        print("Recognizer stopped.", flush=True)


if __name__ == "__main__":
    main()
