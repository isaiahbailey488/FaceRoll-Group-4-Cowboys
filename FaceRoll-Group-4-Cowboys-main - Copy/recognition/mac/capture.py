import cv2
import os
import time

IMAGE_PATH = "shared/input.jpg"
PENDING_IMAGE_PATH = "shared/input.pending.jpg"

os.makedirs("shared", exist_ok=True)

cap = cv2.VideoCapture(0)
face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
capture_cooldown_seconds = 3
last_capture_time = 0

if not cap.isOpened():
    print("Could not open webcam", flush=True)
    exit()

if face_cascade.empty():
    print("Could not load face detector", flush=True)
    cap.release()
    exit()

while True:
    ret, frame = cap.read()
    if not ret:
        break

    gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(
        gray_frame,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(80, 80),
    )

    for (x, y, w, h) in faces:
        cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)

    current_time = time.time()
    if (
        len(faces) > 0
        and current_time - last_capture_time >= capture_cooldown_seconds
        and not os.path.exists(IMAGE_PATH)
        and not os.path.exists(PENDING_IMAGE_PATH)
    ):
        if cv2.imwrite(PENDING_IMAGE_PATH, frame):
            os.replace(PENDING_IMAGE_PATH, IMAGE_PATH)
            last_capture_time = current_time
            print("Face detected. Saved shared/input.jpg", flush=True)
        else:
            print("Could not save pending image", flush=True)

    cv2.putText(
        frame,
        "Auto capture when face is detected",
        (10, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 0),
        2,
    )
    cv2.putText(
        frame,
        "Press q to quit",
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

cap.release()
cv2.destroyAllWindows()
