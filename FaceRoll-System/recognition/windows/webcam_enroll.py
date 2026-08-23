import argparse
import time

import cv2

from enroll_student import generate_embedding_from_image, store_embedding_vectors


def parse_args():
    parser = argparse.ArgumentParser(
        description="Enroll one or more students from the webcam without saving raw photos."
    )
    parser.add_argument("--student-id", help="Student ID for single-student mode")
    parser.add_argument("--first-name", help="Student first name for single-student mode")
    parser.add_argument("--last-name", help="Student last name for single-student mode")
    parser.add_argument("--samples", type=int, default=3, help="Embeddings to capture per student")
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index")
    return parser.parse_args()


def get_students(args):
    if args.student_id and args.first_name and args.last_name:
        return [
            {
                "student_id": args.student_id.strip(),
                "first_name": args.first_name.strip(),
                "last_name": args.last_name.strip(),
            }
        ]

    students = []
    print("Interactive webcam enrollment. Leave Student ID blank when finished.")
    while True:
        student_id = input("Student ID: ").strip()
        if not student_id:
            break
        first_name = input("First name: ").strip()
        last_name = input("Last name: ").strip()
        if not first_name or not last_name:
            print("First and last name are required.")
            continue
        students.append(
            {
                "student_id": student_id,
                "first_name": first_name,
                "last_name": last_name,
            }
        )

    return students


def draw_label(frame, face, label, captured_count, target_count):
    x, y, w, h = face
    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 180, 255), 2)

    text = f"{label}  {captured_count}/{target_count}"
    label_y = max(25, y - 10)
    cv2.putText(
        frame,
        text,
        (x, label_y),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 180, 255),
        2,
    )


def detect_faces(frame, face_cascade):
    detection_scale = 0.5
    small_frame = cv2.resize(frame, None, fx=detection_scale, fy=detection_scale)
    gray_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2GRAY)
    gray_frame = cv2.equalizeHist(gray_frame)
    faces = face_cascade.detectMultiScale(
        gray_frame,
        scaleFactor=1.1,
        minNeighbors=4,
        minSize=(40, 40),
    )
    scale_back = int(1 / detection_scale)
    return [
        (x * scale_back, y * scale_back, w * scale_back, h * scale_back)
        for (x, y, w, h) in faces
    ]


def capture_student_embeddings(cap, face_cascade, student, target_count):
    label = f"{student['first_name']} {student['last_name']}"
    captured = []
    last_capture_time = 0
    capture_cooldown_seconds = 1.5

    print(f"Enrolling {label}. Press SPACE to capture, n to skip, q to quit.")

    while len(captured) < target_count:
        ok, frame = cap.read()
        if not ok:
            raise RuntimeError("Could not read from webcam.")

        faces = detect_faces(frame, face_cascade)
        largest_face = None
        if faces:
            largest_face = max(faces, key=lambda face: face[2] * face[3])
            draw_label(frame, largest_face, label, len(captured), target_count)

        cv2.putText(
            frame,
            "SPACE captures embedding. n skips student. q quits.",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 0),
            2,
        )
        cv2.imshow("FaceRoll Webcam Enrollment", frame)
        key = cv2.waitKey(1) & 0xFF

        if key == ord("q"):
            return captured, "quit"
        if key == ord("n"):
            return captured, "skip"
        if key != ord(" "):
            continue
        if largest_face is None:
            print("No face detected. Center the student and try again.")
            continue
        if time.time() - last_capture_time < capture_cooldown_seconds:
            continue

        try:
            vector = generate_embedding_from_image(frame, label)
        except Exception as error:
            print(f"Could not capture embedding: {error}")
            continue

        captured.append(
            {
                "vector": vector,
                "source_name": f"webcam_sample_{len(captured) + 1:03d}",
            }
        )
        last_capture_time = time.time()
        print(f"Captured embedding {len(captured)}/{target_count} for {label}")

    return captured, "done"


def main():
    args = parse_args()
    students = get_students(args)
    if not students:
        print("No students selected.")
        return

    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    if face_cascade.empty():
        raise RuntimeError("Could not load OpenCV face detector.")

    cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    if not cap.isOpened():
        raise RuntimeError("Could not open webcam.")

    try:
        for student in students:
            captured, result = capture_student_embeddings(
                cap,
                face_cascade,
                student,
                max(1, args.samples),
            )
            if captured:
                embedding_path, embedding_count = store_embedding_vectors(
                    student["student_id"],
                    student["first_name"],
                    student["last_name"],
                    captured,
                )
                print(
                    f"Stored {len(captured)} new embeddings for "
                    f"{student['student_id']} in {embedding_path} "
                    f"({embedding_count} total)."
                )
            if result == "quit":
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
