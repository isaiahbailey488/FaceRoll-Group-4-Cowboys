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
- Configure a per-course classroom location and attendance radius with HERE Maps

## Directory Structure

```text
Instructor-Dashboard/
├── .env.example                # HERE API key template (copy to ignored .env)
├── package.json                # Config generation, checks, tests, and run commands
├── firebase.json               # Hosting, Firestore, and emulator configuration
├── firestore.indexes.json      # Firestore index definitions
├── firestore.rules             # Rules deployed by this Firebase configuration
├── scripts/                    # Generates ignored browser runtime configuration
├── tests/                      # Unit tests for dashboard location validation
└── public/
    ├── index.html              # Instructor login
    ├── register.html           # Instructor registration
    ├── instructor-dashboard.html
    ├── live-session.html
    ├── student-roster.html
    ├── student-profile.html
    ├── reports.html
    ├── course-settings.html    # Per-course attendance location setup
    ├── settings.html
    ├── css/                    # Shared styles
    └── js/                     # Authentication, Firebase, and page logic
```

## Prerequisites

- Firebase CLI
- JDK 21 or newer (required by current Firebase Emulator Suite releases)
- Access to the `rollcall-2669b` Firebase project
- Email/Password Authentication enabled in Firebase
- Cloud Firestore enabled
- A HERE project with a JavaScript/REST API key for the map and geocoding search
- Docker Desktop, Python 3.10+, and a webcam for Windows live recognition

## HERE Maps Configuration

The dashboard is a static browser application, so its HERE key is generated into an ignored runtime configuration file instead of being hard-coded in source control. Like every browser map credential, the value is visible to the browser at runtime; restrict the key to the dashboard's localhost and deployed website origins in the HERE project settings.

From `FaceRoll-System/Instructor-Dashboard`:

```bash
cp .env.example .env
```

Replace `your_here_api_key` in `.env`, then run `npm run build`. The build creates `public/js/runtime-config.js`, which is excluded by `.gitignore`. CI or hosting jobs may instead provide `HERE_API_KEY` directly in their environment:

```bash
HERE_API_KEY="your-key" npm run build
```

Do not commit `.env` or the generated runtime configuration. If the key is missing or invalid, Course Settings remains usable enough to show its configuration/error state, but map selection and HERE search are disabled.

## Run Locally

From the repository root:

```bash
cd FaceRoll-System/Instructor-Dashboard
cp .env.example .env
# Add the HERE_API_KEY value to .env
firebase login
firebase use rollcall-2669b
npm start
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
npm run deploy
```

Review the configured Firestore rules before deployment. This Firebase configuration deploys `FaceRoll-System/Instructor-Dashboard/firestore.rules`, which is separate from the mobile-oriented rules file at the repository root.

The Course Settings page merge-writes the following object to the selected `courses/{courseId}` document; no student coordinates are collected or retained by this page:

```js
location: {
  latitude: 33.2108,
  longitude: -97.1473,
  radiusMeters: 25,
  addressLabel: "Classroom Building, Denton, TX",
  enabled: true,
  updatedAt: serverTimestamp(),
  updatedBy: "firebase-auth-uid"
}
```

Dashboard Firestore rules allow course writes only for authenticated profiles with an instructor or administrator role and validate every stored location field. Before a production launch, assign privileged roles through trusted administration or Firebase custom claims rather than allowing public self-selection of privileged roles during registration.

## Course and Team

- **Project:** FaceRoll — Facial Recognition Attendance System
- **Course:** CSCE 4905.501 — Information Technology Capstone I
- **Team:** Cowboys (Group 4)
