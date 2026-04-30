import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from deepface import DeepFace


APP_DIR = Path(__file__).resolve().parent
STUDENTS_ROOT = APP_DIR / "students"
EMBEDDINGS_ROOT = APP_DIR / "embeddings"
MODEL_NAME = "Facenet"
DETECTOR_BACKEND = "opencv"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create face embeddings for a student without storing raw enrollment photos."
    )
    parser.add_argument("--student-id", required=True, help="Student ID")
    parser.add_argument("--first-name", required=True, help="Student first name")
    parser.add_argument("--last-name", required=True, help="Student last name")
    parser.add_argument(
        "--images",
        required=True,
        nargs="+",
        help="One or more image paths to convert into face embeddings",
    )
    return parser.parse_args()


def utc_timestamp():
    return datetime.now(timezone.utc).isoformat()


def load_metadata(metadata_path, student_id, first_name, last_name):
    # Keep one metadata file per student so new photos can be added later.
    if metadata_path.exists():
        with metadata_path.open("r", encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
    else:
        metadata = {
            "student_id": student_id,
            "first_name": first_name,
            "last_name": last_name,
            "created_at": utc_timestamp(),
            "embeddings": [],
        }

    metadata["first_name"] = first_name
    metadata["last_name"] = last_name
    metadata["updated_at"] = utc_timestamp()
    return metadata


def next_embedding_number(embeddings):
    # Continue numbering from existing embedding_### records.
    if not embeddings:
        return 1

    existing_numbers = []
    for embedding in embeddings:
        embedding_id = str(embedding.get("embedding_id", ""))
        if embedding_id.startswith("embedding_"):
            try:
                existing_numbers.append(int(embedding_id.split("_", maxsplit=1)[1]))
            except ValueError:
                continue

    if not existing_numbers:
        return 1

    return max(existing_numbers) + 1


def generate_embedding_from_image(image, source_label="image"):
    results = DeepFace.represent(
        img_path=image,
        model_name=MODEL_NAME,
        detector_backend=DETECTOR_BACKEND,
        enforce_detection=False,
        align=True,
    )
    if not results:
        raise ValueError(f"No face detected in {source_label}")

    return list(np.asarray(results[0]["embedding"], dtype=float))


def generate_embedding(image_path):
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f"Could not read image: {image_path}")

    return generate_embedding_from_image(image, str(image_path))


def store_embedding_vectors(student_id, first_name, last_name, embedding_items):
    # Store only embeddings and metadata. Enrollment photos are not copied.
    student_dir = STUDENTS_ROOT / student_id
    metadata_path = student_dir / "metadata.json"
    embedding_path = EMBEDDINGS_ROOT / f"{student_id}.json"

    student_dir.mkdir(parents=True, exist_ok=True)
    EMBEDDINGS_ROOT.mkdir(parents=True, exist_ok=True)
    metadata = load_metadata(metadata_path, student_id, first_name, last_name)
    metadata.setdefault("embeddings", [])
    embedding_number = next_embedding_number(metadata["embeddings"])

    if embedding_path.exists():
        with embedding_path.open("r", encoding="utf-8") as embedding_file:
            embedding_record = json.load(embedding_file)
    else:
        embedding_record = {
            "student_id": student_id,
            "first_name": first_name,
            "last_name": last_name,
            "model": MODEL_NAME,
            "detector": DETECTOR_BACKEND,
            "created_at": utc_timestamp(),
            "embeddings": [],
        }

    embedding_record["first_name"] = first_name
    embedding_record["last_name"] = last_name
    embedding_record["updated_at"] = utc_timestamp()

    for item in embedding_items:
        embedding_id = f"embedding_{embedding_number:03d}"
        embedding = item["vector"]
        source_name = item.get("source_name", embedding_id)
        stored_at = utc_timestamp()

        metadata["embeddings"].append(
            {
                "embedding_id": embedding_id,
                "original_name": source_name,
                "stored_at": utc_timestamp(),
                "model": MODEL_NAME,
            }
        )
        embedding_record["embeddings"].append(
            {
                "embedding_id": embedding_id,
                "vector": embedding,
                "original_name": source_name,
                "stored_at": stored_at,
            }
        )
        embedding_number += 1

    metadata["embedding_count"] = len(metadata["embeddings"])
    embedding_record["embedding_count"] = len(embedding_record["embeddings"])

    with metadata_path.open("w", encoding="utf-8") as metadata_file:
        json.dump(metadata, metadata_file, indent=2)

    with embedding_path.open("w", encoding="utf-8") as embedding_file:
        json.dump(embedding_record, embedding_file, indent=2)

    return embedding_path, metadata["embedding_count"]


def store_embeddings(student_id, first_name, last_name, image_paths):
    embedding_items = []
    for image_path_str in image_paths:
        image_path = Path(image_path_str)
        if not image_path.is_file():
            raise FileNotFoundError(f"Image not found: {image_path}")

        embedding_items.append(
            {
                "vector": generate_embedding(image_path),
                "source_name": image_path.name,
            }
        )

    return store_embedding_vectors(student_id, first_name, last_name, embedding_items)


def main():
    args = parse_args()
    embedding_path, embedding_count = store_embeddings(
        student_id=args.student_id.strip(),
        first_name=args.first_name.strip(),
        last_name=args.last_name.strip(),
        image_paths=args.images,
    )
    print(
        f"Stored {embedding_count} face embeddings for {args.student_id} in {embedding_path}"
    )


if __name__ == "__main__":
    main()
