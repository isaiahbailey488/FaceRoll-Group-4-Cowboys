import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from deepface import DeepFace


APP_DIR = Path(__file__).resolve().parent
IMAGE_PATH = APP_DIR / "shared" / "input.jpg"
PROCESSING_IMAGE_PATH = APP_DIR / "shared" / "input.processing.jpg"
EVENT_LOG_PATH = APP_DIR / "shared" / "recognition-events.jsonl"
EMBEDDINGS_DIR = APP_DIR / "embeddings"
POLL_INTERVAL_SECONDS = 1
# Avoid writing duplicate attendance events when the same face is captured
# several times in a row.
MATCH_COOLDOWN_SECONDS = 10
MODEL_NAME = "Facenet"
DETECTOR_BACKEND = "opencv"
DISTANCE_THRESHOLD = 0.30
recent_match_times = {}


def identity_to_label(identity):
    normalized = re.sub(r"[_-]+", " ", str(identity or "")).strip()
    return normalized or "unknown"


def append_recognition_event(payload):
    # The bridge reads this append-only file and exposes new lines through
    # /events, where the dashboard turns them into Firestore attendance records.
    EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with EVENT_LOG_PATH.open("a", encoding="utf-8") as event_log:
        event_log.write(json.dumps(payload) + "\n")


def generate_embedding(image_path):
    results = DeepFace.represent(
        img_path=str(image_path),
        model_name=MODEL_NAME,
        detector_backend=DETECTOR_BACKEND,
        enforce_detection=False,
        align=True,
    )
    if not results:
        return None
    return np.asarray(results[0]["embedding"], dtype=np.float32)


def cosine_distance(left, right):
    left = np.asarray(left, dtype=np.float32)
    right = np.asarray(right, dtype=np.float32)
    denom = (np.linalg.norm(left) * np.linalg.norm(right)) + 1e-10
    return float(1.0 - (np.dot(left, right) / denom))


def load_embedding_database():
    records = []
    if not EMBEDDINGS_DIR.exists():
        return records

    for embedding_file in EMBEDDINGS_DIR.glob("*.json"):
        try:
            with embedding_file.open("r", encoding="utf-8") as file:
                payload = json.load(file)
        except (OSError, json.JSONDecodeError) as error:
            print(f"Skipping invalid embedding file {embedding_file}: {error}", flush=True)
            continue

        student_id = str(payload.get("student_id") or embedding_file.stem)
        full_name = " ".join(
            part for part in [payload.get("first_name"), payload.get("last_name")] if part
        ).strip()
        identity_label = full_name or student_id

        for item in payload.get("embeddings", []):
            vector = item.get("vector")
            if not vector:
                continue
            records.append(
                {
                    "student_id": student_id,
                    "identity_label": identity_label,
                    "embedding_id": item.get("embedding_id", ""),
                    "vector": vector,
                }
            )

    return records


def find_best_match(query_embedding, database_records):
    best_record = None
    best_distance = float("inf")

    for record in database_records:
        distance = cosine_distance(query_embedding, record["vector"])
        if distance < best_distance:
            best_record = record
            best_distance = distance

    if best_record is None or best_distance > DISTANCE_THRESHOLD:
        return None, best_distance

    return best_record, best_distance


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
            print("Loading face embeddings...", flush=True)
            database_records = load_embedding_database()
            if not database_records:
                print("No enrolled embeddings found.", flush=True)
                continue

            print("Generating embedding for captured face...", flush=True)
            query_embedding = generate_embedding(PROCESSING_IMAGE_PATH)
            if query_embedding is None:
                print("No face embedding generated for captured image.", flush=True)
                continue

            best_match, best_distance = find_best_match(query_embedding, database_records)
            if best_match is None:
                print(f"NO MATCH. Best distance: {best_distance:.4f}", flush=True)
                continue

            print("Embedding comparison completed.", flush=True)
            current_time = time.time()
            identity = best_match["student_id"]
            last_match_time = recent_match_times.get(identity)

            # The webcam may save several frames of the same person. Cool down
            # each identity so one student does not spam Firestore.
            if (
                last_match_time is not None
                and current_time - last_match_time < MATCH_COOLDOWN_SECONDS
            ):
                print(f"MATCH ON COOLDOWN: {identity}", flush=True)
                continue

            confidence = max(0.0, 1.0 - (best_distance / DISTANCE_THRESHOLD))
            recent_match_times[identity] = current_time
            print(f"MATCH: {identity}", flush=True)
            print(f"Distance: {best_distance:.4f}", flush=True)
            print(f"Confidence: {confidence:.2f}", flush=True)
            append_recognition_event(
                {
                    "eventType": "match",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "uid": str(identity),
                    "studentId": str(identity),
                    "identity": str(identity),
                    "identityLabel": identity_to_label(best_match["identity_label"]),
                    "distance": float(best_distance),
                    "confidence": float(confidence),
                    "faceIndex": 1,
                    "embeddingId": best_match["embedding_id"],
                }
            )
        except Exception as error:
            print("Error:", error, flush=True)

        if PROCESSING_IMAGE_PATH.exists():
            PROCESSING_IMAGE_PATH.unlink()
        print("Processed image. Waiting for next one...", flush=True)

    time.sleep(POLL_INTERVAL_SECONDS)
