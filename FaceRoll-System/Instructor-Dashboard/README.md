# FaceRoll Instructor Dashboard

The FaceRoll Instructor Dashboard is the instructor-facing part of the FaceRoll facial-recognition attendance system. It is a Firebase-hosted web application built with HTML, CSS, and JavaScript. The dashboard shares Firebase Authentication and Cloud Firestore data with the FaceRoll student mobile app.

For the complete project overview, mobile setup, system architecture, and shared data model, see the repository's root `README.md`.

## Instructor Features

- Register and sign in with Firebase Authentication
- View attendance summaries and records
- Manage courses and student rosters
- Start and monitor live attendance sessions
- View Present, Late, and Absent statuses
- Correct attendance records manually
- Review individual student attendance history
- Identify students who have opted out of facial recognition
- Search for students by name or ID
- Filter attendance by course, date, and status
- Export filtered attendance reports as CSV files
- Configure grace-period and late-attendance behavior

## Directory Structure

```text
Instructor-Dashboard/
├── firebase.json               # Hosting, Firestore, and emulator configuration
├── firestore.indexes.json      # Firestore index definitions
├── firestore.rules             # Rules deployed by this Firebase configuration
└── public/
    ├── index.html              # Instructor login
    ├── register.html           # Instructor registration
    ├── instructor-dashboard.html
    ├── live-session.html
    ├── student-roster.html
    ├── student-profile.html
    ├── reports.html
    ├── settings.html
    ├── css/                    # Shared styles
    └── js/                     # Authentication, Firebase, and page logic
```

## Prerequisites

- Firebase CLI
- Access to the `rollcall-2669b` Firebase project
- Email/Password Authentication enabled in Firebase
- Cloud Firestore enabled
- Docker Desktop, Python 3.10+, and a webcam for Windows live recognition

## Run Locally

From the repository root:

```bash
cd FaceRoll-System/Instructor-Dashboard
firebase login
firebase use rollcall-2669b
firebase emulators:start
```

Open the dashboard at `http://localhost:5001`.

| Local service | Address |
|---|---|
| Firebase Hosting | `http://localhost:5001` |
| Authentication | `http://localhost:9099` |
| Cloud Firestore | `http://localhost:8080` |

## Run Live Recognition

Instructor-side webcam recognition currently supports Windows. In a separate terminal, run:

```bash
cd FaceRoll-System/recognition/windows
python -m pip install -r requirements.txt
python bridge_server.py
```

The local bridge listens on `http://127.0.0.1:8765`. Docker Desktop must be running before the instructor starts a live session.

The former macOS prototype under `FaceRoll-System/recognition/archived/mac/` is archived reference code and is not currently supported.

## Deploy

From `FaceRoll-System/Instructor-Dashboard`, deploy the required Firebase resources:

```bash
firebase deploy --only firestore,hosting
```

Review the configured Firestore rules before deployment. This Firebase configuration deploys `FaceRoll-System/Instructor-Dashboard/firestore.rules`, which is separate from the mobile-oriented rules file at the repository root.

## Course and Team

- **Project:** FaceRoll — Facial Recognition Attendance System
- **Course:** CSCE 4905.501 — Information Technology Capstone I
- **Team:** Cowboys (Group 4)
