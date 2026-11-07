"""Classroom camera capture; the optional preview is for troubleshooting only."""

import argparse
import os
import sys
import time
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
SHARED_DIR = APP_DIR / "shared"
IMAGE_PATH = SHARED_DIR / "input.jpg"
PENDING_IMAGE_PATH = SHARED_DIR / "input.pending.jpg"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true", help="Show the classroom webcam preview for troubleshooting.")
    arguments = parser.parse_args(argv)
    show_preview = arguments.preview or os.getenv("FACEROLL_CAMERA_PREVIEW", "").strip().lower() in {"1", "true", "yes", "on"}

    if show_preview and sys.platform.startswith("linux") and os.getenv("DISPLAY"):
        os.environ.setdefault("QT_QPA_PLATFORM", "xcb")

    try:
        import cv2
    except ModuleNotFoundError as error:
        if error.name != "cv2":
            raise
        print("OpenCV is not installed for this Python environment. Install the recognition dependencies first.", flush=True)
        return 1

    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    elif sys.platform.startswith("linux"):
        cap = cv2.VideoCapture(0, cv2.CAP_V4L2)
    else:
        cap = cv2.VideoCapture(0)

    try:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not cap.isOpened():
            print("Could not open webcam", flush=True)
            return 1
        # This detector selects candidates; app.py performs identity recognition.
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if face_cascade.empty():
            print("Could not load face detector", flush=True)
            return 1
        capture_cooldown_seconds = 3
        face_log_cooldown_seconds = 5
        last_capture_time = 0
        last_face_log_time = 0
        detection_scale = 0.5
        print("Classroom capture started; preview {}.".format("enabled" if show_preview else "hidden"), flush=True)

        while True:
            ret, frame = cap.read()
            if not ret:
                break
            # Recognition must never receive preview boxes or labels.
            recognition_frame = frame.copy()
            small_frame = cv2.resize(frame, None, fx=detection_scale, fy=detection_scale)
            gray_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2GRAY)
            gray_frame = cv2.equalizeHist(gray_frame)
            faces = face_cascade.detectMultiScale(gray_frame, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40))
            current_time = time.time()
            face_count = len(faces)
            if face_count > 0 and current_time - last_face_log_time >= face_log_cooldown_seconds:
                print(f"Face candidates: {face_count}", flush=True)
                last_face_log_time = current_time
            if (face_count > 0 and current_time - last_capture_time >= capture_cooldown_seconds
                    and not IMAGE_PATH.exists() and not PENDING_IMAGE_PATH.exists()):
                if cv2.imwrite(str(PENDING_IMAGE_PATH), recognition_frame):
                    os.replace(PENDING_IMAGE_PATH, IMAGE_PATH)
                    last_capture_time = current_time
                    print("Candidate frame queued for recognition.", flush=True)
                else:
                    print("Could not save pending image", flush=True)

            if show_preview:
                scale_back = int(1 / detection_scale)
                for (x, y, w, h) in faces:
                    cv2.rectangle(frame, (x * scale_back, y * scale_back),
                                  ((x + w) * scale_back, (y + h) * scale_back), (0, 255, 0), 2)
                cv2.putText(frame, f"Face candidates: {face_count}", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                cv2.putText(frame, "Auto capture on candidate. Space saves manually. q quits.", (10, 60),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                cv2.imshow("Face Detection Capture", frame)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
                if key == ord(" ") and not IMAGE_PATH.exists() and not PENDING_IMAGE_PATH.exists():
                    if cv2.imwrite(str(PENDING_IMAGE_PATH), recognition_frame):
                        os.replace(PENDING_IMAGE_PATH, IMAGE_PATH)
                        last_capture_time = time.time()
                        print("Manual capture queued for recognition.", flush=True)
                    else:
                        print("Could not save pending image", flush=True)
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        cap.release()
        if show_preview:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    raise SystemExit(main())
