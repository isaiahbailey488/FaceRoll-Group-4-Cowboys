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
- Adjust the radius with a keyboard-accessible slider from 1–15 meters in 1-meter steps (default: 15 meters)

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

Open the dashboard at `http://127.0.0.1:5001`.

| Local service | Address |
|---|---|
| Firebase Hosting | `http://127.0.0.1:5001` |
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
  radiusMeters: 15,
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

Course Settings uses HERE Maps with English labels, controls, and address results. Use `http://127.0.0.1:5001/course-settings.html`; this origin is authorized by the current HERE key. Other browser origins, including different ports, must be added to the key's trusted domains. Rejected access displays an actionable message without switching map providers. Internet access is required.

Focus the location search field and choose **Current location** in Courses → Course Settings to request your browser location and center HERE Maps on a blue dot. The status shows the estimated accuracy. This one-time lookup also selects the location and updates the latitude and longitude fields. Save Classroom Location to persist it for the selected course. Location access requires browser permission and HTTPS or localhost.

### Student zone-result contract (instructor side)

Live Session displays only `attendance.locationStatus`: `in_zone` → In zone, `outside_zone` → Outside zone, `not_required` → Not required, and missing/unknown values → Not checked. It does not infer a passed location check from attendance or face recognition. Existing mobile clients can continue submitting records without this optional field.

The dashboard Firestore rules allow only attendance metadata and these optional status values. They reject latitude, longitude, location objects, accuracy, and other unlisted fields, including nested objects in the allowed text fields. The saved course location is the classroom's zone configuration, not a student's position.

Mobile integration is separate and has not been changed: it must perform a foreground check at check-in and send only the zone result, never student coordinates, distance, accuracy, or position history. Rules validate the record shape; they cannot prove that a client-supplied zone result is truthful. Deploy the dashboard rules with this update before relying on storage restrictions. The separate repository-root rules file is unchanged and does not contain these restrictions.

To verify the privacy rules locally, start a separate Firestore emulator using the cached emulator JAR with `--host 127.0.0.1 --port 8181 --websocket_port 9181 --project_id demo-faceroll-location --rules firestore.rules` from this dashboard directory. Then run `node scripts/test-location-rules.cjs`. The test is pinned to that isolated local project and exercises valid statuses, older clients without a status, rejected coordinate fields/nested objects, and instructor attendance overrides.
