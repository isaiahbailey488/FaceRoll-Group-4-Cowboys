# Face Recognition Prototype - Windows

This folder is the Windows version of the Mac recognition workflow.

- `capture.py` opens the Windows webcam with OpenCV DirectShow, detects faces, and auto-saves a frame as `shared/input.jpg`
- `app.py` polls for `shared/input.jpg` and runs `DeepFace.find(...)`
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
3. `capture.py` saves a detected face to `shared/input.jpg`.
4. `app.py` claims that image, runs DeepFace, and appends matches to `shared/recognition-events.jsonl`.
5. The dashboard polls `/events` and writes each new recognition result to Firestore attendance.

## Manual run

If you want to test the two pieces separately:

```powershell
docker build -t faceroll-windows .
docker run --rm -i -e PYTHONUNBUFFERED=1 -v "${PWD}\shared:/app/shared" -v "${PWD}\database:/app/database" -v "$env:USERPROFILE\.deepface:/root/.deepface" --name faceroll-recognizer-windows faceroll-windows
```

In another PowerShell window:

```powershell
py -3.10 capture.py
```

Press `q` in the webcam window to quit capture.

## Student photo storage

`enroll_student.py` stores multiple enrollment photos for a single student on the local machine.

```powershell
py -3.10 enroll_student.py --student-id 12345 --first-name Jane --last-name Doe --images C:\path\to\front.jpg C:\path\to\left.jpg C:\path\to\right.jpg
```

This creates:

```text
students/
  12345/
    metadata.json
    photos/
      photo_001.jpg
      photo_002.jpg
      photo_003.jpg
```
