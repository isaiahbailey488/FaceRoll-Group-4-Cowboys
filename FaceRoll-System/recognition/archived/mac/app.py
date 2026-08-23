import json
import os
import re
import time
from datetime import datetime, timezone
from deepface import DeepFace

IMAGE_PATH = "shared/input.jpg"
PROCESSING_IMAGE_PATH = "shared/input.processing.jpg"
EVENT_LOG_PATH = "shared/recognition-events.jsonl"
POLL_INTERVAL_SECONDS = 1
MATCH_COOLDOWN_SECONDS = 10
recent_match_times = {}


def identity_to_label(identity):
    filename = os.path.basename(str(identity or ""))
    name_without_extension = os.path.splitext(filename)[0]
    normalized = re.sub(r"[_-]+", " ", name_without_extension).strip()
    return normalized or filename or "unknown"


def append_recognition_event(payload):
    os.makedirs(os.path.dirname(EVENT_LOG_PATH), exist_ok=True)
    with open(EVENT_LOG_PATH, "a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(payload) + "\n")

print("Recognizer ready. Waiting for image...", flush=True)

while True:
    if os.path.exists(IMAGE_PATH):
        print("Image detected. Claiming shared/input.jpg...", flush=True)
        try:
            os.replace(IMAGE_PATH, PROCESSING_IMAGE_PATH)
        except FileNotFoundError:
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        except OSError as e:
            print("Error claiming image:", e, flush=True)
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        try:
            print("Running DeepFace.find against database...", flush=True)
            result = DeepFace.find(
                img_path=PROCESSING_IMAGE_PATH,
                db_path="database",
                model_name="Facenet",
                detector_backend="opencv",
                enforce_detection=False
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
        except Exception as e:
            print("Error:", e, flush=True)

        if os.path.exists(PROCESSING_IMAGE_PATH):
            os.remove(PROCESSING_IMAGE_PATH)
        print("Processed image. Waiting for next one...", flush=True)

    time.sleep(POLL_INTERVAL_SECONDS)
