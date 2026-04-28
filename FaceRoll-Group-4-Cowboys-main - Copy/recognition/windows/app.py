import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from deepface import DeepFace


APP_DIR = Path(__file__).resolve().parent
IMAGE_PATH = APP_DIR / "shared" / "input.jpg"
PROCESSING_IMAGE_PATH = APP_DIR / "shared" / "input.processing.jpg"
EVENT_LOG_PATH = APP_DIR / "shared" / "recognition-events.jsonl"
DATABASE_DIR = APP_DIR / "database"
POLL_INTERVAL_SECONDS = 1
# Avoid writing duplicate attendance events when the same face is captured
# several times in a row.
MATCH_COOLDOWN_SECONDS = 10
recent_match_times = {}


def identity_to_label(identity):
    # DeepFace returns the matched image path. Convert filenames like into a readable label for the Firebase UI.
    filename = os.path.basename(str(identity or ""))
    name_without_extension = os.path.splitext(filename)[0]
    normalized = re.sub(r"[_-]+", " ", name_without_extension).strip()
    return normalized or filename or "unknown"


def append_recognition_event(payload):
    # The bridge reads this append-only file and exposes new lines through
    # /events, where the dashboard turns them into Firestore attendance records.
    EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with EVENT_LOG_PATH.open("a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(payload) + "\n")


print("Recognizer ready. Waiting for image...", flush=True)

while True:
    if IMAGE_PATH.exists():
        print("Image detected. Claiming shared/input.jpg...", flush=True)
        try:
            # Rename first so capture.py knows the recognizer has claimed the
            # image and can safely save the next one later.
            IMAGE_PATH.replace(PROCESSING_IMAGE_PATH)
        except FileNotFoundError:
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        except OSError as error:
            print("Error claiming image:", error, flush=True)
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        try:
            print("Running DeepFace.find against database...", flush=True)
            # Database images live in /app/database inside Docker. The folder is
            # mounted from recognition/windows/database by bridge_server.py.
            result = DeepFace.find(
                img_path=str(PROCESSING_IMAGE_PATH),
                db_path=str(DATABASE_DIR),
                model_name="Facenet",
                detector_backend="opencv",
                enforce_detection=False,
            )
            print("DeepFace.find completed.", flush=True)
            current_time = time.time()

            for face_index, matches in enumerate(result, start=1):
                if matches.empty:
                    print(f"Face {face_index}: NO MATCH", flush=True)
                    continue

                best_match = matches.iloc[0]
                identity = best_match["identity"]
                last_match_time = recent_match_times.get(identity)

                # The webcam may save several frames of the same person. Cool
                # down each identity so one student does not spam Firestore.
                if (
                    last_match_time is not None
                    and current_time - last_match_time < MATCH_COOLDOWN_SECONDS
                ):
                    print(f"Face {face_index}: MATCH ON COOLDOWN: {identity}", flush=True)
                    continue

                recent_match_times[identity] = current_time
                print(f"Face {face_index}: MATCH: {identity}", flush=True)
                print(f"Distance: {best_match['distance']:.4f}", flush=True)
                print(f"Confidence: {best_match['confidence']:.2f}", flush=True)
                append_recognition_event(
                    {
                        "eventType": "match",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "identity": str(identity),
                        "identityLabel": identity_to_label(identity),
                        "distance": float(best_match["distance"]),
                        "confidence": float(best_match["confidence"]),
                        "faceIndex": int(face_index),
                    }
                )
        except Exception as error:
            print("Error:", error, flush=True)

        if PROCESSING_IMAGE_PATH.exists():
            PROCESSING_IMAGE_PATH.unlink()
        print("Processed image. Waiting for next one...", flush=True)

    time.sleep(POLL_INTERVAL_SECONDS)
