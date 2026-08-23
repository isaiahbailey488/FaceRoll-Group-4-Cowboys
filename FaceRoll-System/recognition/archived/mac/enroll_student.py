import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


STUDENTS_ROOT = Path("students")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Store multiple enrollment photos for a student on the local machine."
    )
    parser.add_argument("--student-id", required=True, help="Student ID")
    parser.add_argument("--first-name", required=True, help="Student first name")
    parser.add_argument("--last-name", required=True, help="Student last name")
    parser.add_argument(
        "--images",
        required=True,
        nargs="+",
        help="One or more image paths to store for the student",
    )
    return parser.parse_args()


def utc_timestamp():
    return datetime.now(timezone.utc).isoformat()


def load_metadata(metadata_path, student_id, first_name, last_name):
    if metadata_path.exists():
        with metadata_path.open("r", encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
    else:
        metadata = {
            "student_id": student_id,
            "first_name": first_name,
            "last_name": last_name,
            "created_at": utc_timestamp(),
            "photos": [],
        }

    metadata["first_name"] = first_name
    metadata["last_name"] = last_name
    metadata["updated_at"] = utc_timestamp()
    return metadata


def next_photo_number(photos):
    if not photos:
        return 1

    existing_numbers = []
    for photo in photos:
        file_name = Path(photo["file"]).name
        stem = Path(file_name).stem
        if stem.startswith("photo_"):
            try:
                existing_numbers.append(int(stem.split("_", maxsplit=1)[1]))
            except ValueError:
                continue

    if not existing_numbers:
        return 1

    return max(existing_numbers) + 1


def store_images(student_id, first_name, last_name, image_paths):
    student_dir = STUDENTS_ROOT / student_id
    photos_dir = student_dir / "photos"
    metadata_path = student_dir / "metadata.json"

    photos_dir.mkdir(parents=True, exist_ok=True)
    metadata = load_metadata(metadata_path, student_id, first_name, last_name)
    photo_number = next_photo_number(metadata["photos"])

    for image_path_str in image_paths:
        image_path = Path(image_path_str)
        if not image_path.is_file():
            raise FileNotFoundError(f"Image not found: {image_path}")

        suffix = image_path.suffix.lower() or ".jpg"
        target_name = f"photo_{photo_number:03d}{suffix}"
        target_path = photos_dir / target_name
        shutil.copy2(image_path, target_path)

        metadata["photos"].append(
            {
                "file": str(Path("photos") / target_name),
                "original_name": image_path.name,
                "stored_at": utc_timestamp(),
            }
        )
        photo_number += 1

    metadata["photo_count"] = len(metadata["photos"])

    with metadata_path.open("w", encoding="utf-8") as metadata_file:
        json.dump(metadata, metadata_file, indent=2)

    return student_dir, metadata["photo_count"]


def main():
    args = parse_args()
    student_dir, photo_count = store_images(
        student_id=args.student_id.strip(),
        first_name=args.first_name.strip(),
        last_name=args.last_name.strip(),
        image_paths=args.images,
    )
    print(f"Stored {photo_count} photos for {args.student_id} in {student_dir}")


if __name__ == "__main__":
    main()
