# Face Recognition Prototype - Windows

This folder is the Windows version of the Mac recognition workflow.

- `capture.py` opens the Windows webcam with OpenCV DirectShow, detects faces, and auto-saves a frame as `shared/input.jpg`
- `enroll_student.py` converts enrollment photos into face embeddings stored as JSON
- `webcam_enroll.py` enrolls one or more students directly from the webcam and labels the detected face in the preview
- `app.py` polls for `shared/input.jpg`, converts the temporary image into an embedding, and compares it with stored embeddings
- `bridge_server.py` exposes the same local HTTP bridge used by the dashboard to start, stop, and poll the live session

## Requirements

Install these first:

- Python 3.10
- Docker Desktop for Windows

Then install the Python packages used by the native webcam capture and bridge:

```powershell
cd windows
py -3.10 -m pip install -r requirements.txt
```

Docker Desktop must be running before starting a live session.

## Run the bridge

From this folder:

```powershell
py -3.10 bridge_server.py
```

The bridge listens on:

```text
http://127.0.0.1:8765
```

The dashboard can call:

- `POST /start-session`
- `POST /stop-session`
- `GET /status`
- `GET /events?cursor=0`

## How the Windows flow works

1. The dashboard calls `bridge_server.py` on `http://127.0.0.1:8765`.
2. The bridge starts Docker for `app.py` and starts `capture.py` on Windows for webcam access.
3. `capture.py` saves a temporary detected face frame to `shared/input.jpg`.
4. `app.py` claims that image, converts it into a face embedding, deletes the temporary image, and appends matches to `shared/recognition-events.jsonl`.
5. The dashboard polls `/events` and writes each new recognition result to Firestore attendance.

## Manual run

If you want to test the two pieces separately:

```powershell
docker build -t faceroll-windows .
docker run --rm -i -e PYTHONUNBUFFERED=1 -v "${PWD}\shared:/app/shared" -v "${PWD}\embeddings:/app/embeddings" -v "$env:USERPROFILE\.deepface:/root/.deepface" --name faceroll-recognizer-windows faceroll-windows
```

In another PowerShell window:

```powershell
py -3.10 capture.py
```

Press `q` in the webcam window to quit capture.

## Student face enrollment

`enroll_student.py` stores face embeddings for a single student on the local machine. It does not copy enrollment photos into the recognition folder.

```powershell
py -3.10 enroll_student.py --student-id 12345 --first-name Jane --last-name Doe --images C:\path\to\front.jpg C:\path\to\left.jpg C:\path\to\right.jpg
```

This creates:

```text
embeddings/
  12345.json
students/
  12345/
    metadata.json
```

The JSON file contains numerical embedding vectors and student metadata, not viewable face images. The webcam still creates a temporary `shared/input.jpg` handoff frame during live recognition, but the recognizer deletes it after processing.

## Webcam enrollment

Use `webcam_enroll.py` to enroll students directly from the webcam without saving raw photos.

Single student:

```powershell
py -3.10 webcam_enroll.py --student-id 12345 --first-name Jane --last-name Doe --samples 3
```

Multiple students:

```powershell
py -3.10 webcam_enroll.py --samples 3
```

In interactive mode, enter a student ID, first name, and last name for each student. Leave Student ID blank when finished.

Controls:

- `Space`: capture one face embedding for the current student
- `n`: skip the current student
- `q`: quit enrollment

The preview draws a box around the detected face and shows the student's name above it. Captured enrollment data is written to `embeddings/<student-id>.json`.
