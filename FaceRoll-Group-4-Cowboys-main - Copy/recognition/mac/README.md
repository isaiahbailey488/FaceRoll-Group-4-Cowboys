# Face Recognition Prototype

This project currently has two separate workflows:

- `capture.py` opens the webcam, detects faces, and auto-saves a frame as `shared/input.jpg`
- `app.py` polls for `shared/input.jpg` and runs `DeepFace.find(...)`

`capture.py` uses OpenCV face detection and a short cooldown so it does not save every frame continuously.
`app.py` now processes each detected face returned by DeepFace and applies a short per-match cooldown to reduce repeat match events.

## Student photo storage

`enroll_student.py` stores multiple enrollment photos for a single student on the local machine.

Example:

```bash
python enroll_student.py \
  --student-id 12345 \
  --first-name Jane \
  --last-name Doe \
  --images /path/to/front.jpg /path/to/left.jpg /path/to/right.jpg
```

This creates a folder structure like:

```text
students/
  12345/
    metadata.json
    photos/
      photo_001.jpg
      photo_002.jpg
      photo_003.jpg
```

`metadata.json` stores the student's name, ID, timestamps, and a list of stored photo files.

For a live Demo: Please run the Firebase emulator `firebase emulators:start --only hosting` and in a separate terminal run the Server bridge with this command `python3 bridge_server.py`.
This allows the instructor dashboard and the facial recognition to communicate with each other, resulting in control in the dashboard to start and stop a session when you please.

`capture.py` requires python 3.10 to install please follow these steps 

winget install Python.Python.3.10

py -3.10 -m pip install -r requirements.txt
