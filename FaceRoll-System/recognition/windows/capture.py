import os
import sys
import time
from pathlib import Path

try:
    import cv2
except ModuleNotFoundError as error:
    if error.name != "cv2":
        raise

    print(
        "OpenCV is not installed for this Python environment.\n"
        "Install Python 3.10, then run:\n"
        "  py -3.10 -m pip install -r requirements.txt\n"
        "  py -3.10 capture.py",
        flush=True,
    )
    raise SystemExit(1) from error


APP_DIR = Path(__file__).resolve().parent
SHARED_DIR = APP_DIR / "shared"
IMAGE_PATH = SHARED_DIR / "input.jpg"
PENDING_IMAGE_PATH = SHARED_DIR / "input.pending.jpg"

SHARED_DIR.mkdir(parents=True, exist_ok=True)

# Use DirectShow on Windows so OpenCV opens the webcam faster and more
# consistently than the default backend.
if sys.platform == "win32":
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
elif sys.platform.startswith("linux"):
    cap = cv2.VideoCapture(0, cv2.CAP_V4L2)
else:
    cap = cv2.VideoCapture(0)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)


# DeepFace does the actual recognition later in app.py.
face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
capture_cooldown_seconds = 3
face_log_cooldown_seconds = 5
last_capture_time = 0
last_face_log_time = 0
# Detect on a smaller frame for speed, then scale boxes back up for display.
detection_scale = 0.5

if not cap.isOpened():
    print("Could not open webcam", flush=True)
    raise SystemExit(1)

if face_cascade.empty():
    print("Could not load face detector", flush=True)
    cap.release()
    raise SystemExit(1)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    # Downscale before detection to keep webcam preview responsive.
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
    scaled_faces = [
        (x * scale_back, y * scale_back, w * scale_back, h * scale_back)
        for (x, y, w, h) in faces
    ]

    for (x, y, w, h) in scaled_faces:
        cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)

    current_time = time.time()
    face_count = len(faces)
    # Face detection can flicker frame-to-frame, so only log positive detections
    # every few seconds and skip "No faces detected" terminal noise.
    if face_count > 0 and current_time - last_face_log_time >= face_log_cooldown_seconds:
        print(f"Detected faces: {face_count}", flush=True)
        last_face_log_time = current_time

    if (
        face_count > 0
        and current_time - last_capture_time >= capture_cooldown_seconds
        and not IMAGE_PATH.exists()
        and not PENDING_IMAGE_PATH.exists()
    ):
        # Write to a temporary filename first, then atomically rename it. This
        # prevents app.py from reading a half-written image.
        if cv2.imwrite(str(PENDING_IMAGE_PATH), frame):
            os.replace(PENDING_IMAGE_PATH, IMAGE_PATH)
            last_capture_time = current_time
            print("Face detected. Saved shared/input.jpg", flush=True)
        else:
            print("Could not save pending image", flush=True)

    cv2.putText(
        frame,
        f"Detected faces: {len(faces)}",
        (10, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 0),
        2,
    )
    cv2.putText(
        frame,
        "Auto capture on face. Space saves manually. q quits.",
        (10, 60),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 0),
        2,
    )

    cv2.imshow("Face Detection Capture", frame)
    key = cv2.waitKey(1) & 0xFF

    if key == ord("q"):
        break

    if key == ord(" ") and not IMAGE_PATH.exists() and not PENDING_IMAGE_PATH.exists():
        # Manual capture uses the same pending-file handoff as auto capture.
        if cv2.imwrite(str(PENDING_IMAGE_PATH), frame):
            os.replace(PENDING_IMAGE_PATH, IMAGE_PATH)
            last_capture_time = time.time()
            print("Manual capture. Saved shared/input.jpg", flush=True)
        else:
            print("Could not save pending image", flush=True)

cap.release()
cv2.destroyAllWindows()
