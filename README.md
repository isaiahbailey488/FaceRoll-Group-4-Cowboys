# FaceRoll

FaceRoll is a facial-recognition attendance system for students and instructors. It combines a cross-platform student mobile app, a web-based instructor dashboard, Firebase services, and Python recognition tools so attendance can be recorded, monitored, corrected, and reported from one shared system.

## How FaceRoll Works

1. A student creates an account in the mobile app and enrolls their face.
2. An instructor manages courses and starts an attendance session from the web dashboard.
3. FaceRoll recognizes participating students and creates attendance records.
4. Firebase synchronizes users, courses, sessions, and attendance between the student and instructor experiences.
5. Students review recent activity, while instructors monitor sessions, correct records, and export reports.

Students who opt out of facial recognition remain visible in the instructor roster, and instructors can update their attendance manually.

## System Components

### Student Mobile App

The student-facing application handles account registration, profiles, facial enrollment, attendance check-in, and attendance activity. It is built with Expo SDK 57, React Native, TypeScript, and Expo Router.

### Instructor Dashboard

The web dashboard gives instructors access to courses, student rosters, live attendance sessions, attendance management, settings, and reports. It is built with HTML, CSS, JavaScript, and Firebase Hosting.

### Firebase Services

Firebase Authentication manages student and instructor accounts, while Cloud Firestore stores and synchronizes profiles, courses, sessions, settings, and attendance records across the system.

### Mobile Recognition API

The authenticated Python API under `FaceRoll-System/recognition` receives three-photo enrollment and one-photo verification requests from the mobile app. It uses the shared `Facenet512` core and stores only local embeddings.

### Instructor Recognition Bridge

The local Python bridge connects the instructor dashboard to the computer's webcam. It uses OpenCV, Docker, and DeepFace to recognize students and send live attendance events to the dashboard.

## Features

### Student Mobile App

- Register and sign in with Firebase Authentication
- Manage a profile and facial-recognition preferences
- Enroll a face using three guided device-camera captures
- Check in through authenticated one-to-one face verification
- View recent attendance activity

### Instructor Dashboard

- Register, sign in, and access an instructor workspace
- View attendance summaries and records
- Manage courses and student rosters
- Start and monitor live attendance sessions
- Track Present, Late, and Absent statuses
- Correct student attendance manually
- Review individual student attendance history
- Search by student name or ID
- Filter records by course, date, and status
- Export attendance reports as CSV files
- Configure grace-period and late-attendance settings

### Recognition System

- Create face embeddings without retaining enrollment photos in the local recognition workflow
- Identify students through the instructor computer's webcam
- Send recognition events to the dashboard through a local HTTP bridge
- Write recognized students to the shared Firestore attendance collection
- Support live instructor-side recognition on Windows
- Retain the former macOS prototype as archived reference code only

## Repository Structure

FaceRoll is maintained as a monorepo. The student mobile application was initially developed in a separate repository and was later integrated with the instructor dashboard and recognition services. The Expo project remains at the repository root so its existing configuration and commands continue to work.

```text
.
├── app/                         # Expo Router screens for the student app
├── assets/                      # Mobile images and branding
├── components/                  # Reusable React Native components
├── constants/                   # Mobile theme constants
├── services/                    # Firebase, authentication, and attendance services
├── backend/                     # Temporary legacy one-photo Flask API
├── Documentation/               # Architecture, user, design, and maintenance documents
├── Testing/                     # System test cases and recorded test results
├── firestore.rules              # Firestore rules used by the mobile project
└── FaceRoll-System/
    ├── Instructor-Dashboard/    # Instructor web app and Firebase configuration
    │   └── public/              # Dashboard HTML, CSS, JavaScript, and assets
    └── recognition/             # Shared Facenet512 core and authenticated mobile API
        ├── windows/             # Windows webcam recognition and bridge
        └── archived/mac/        # Unsupported archived macOS prototype
```

## Prerequisites

- Node.js 18+ and npm
- Expo Go, or an iOS/Android simulator or emulator
- Python 3.10+ and pip
- Firebase CLI
- Access to the FaceRoll Firebase project with Email/Password Authentication and Firestore enabled
- Docker Desktop and a webcam for instructor-side live recognition

## Firebase Configuration

The student and instructor applications must connect to the same Firebase project so they share authentication and Firestore data.

- Project ID: `rollcall-2669b`
- Firebase Console: <https://console.firebase.google.com/project/rollcall-2669b>

The student configuration is in `services/firebase.ts`. The instructor configuration is in `FaceRoll-System/Instructor-Dashboard/public/js/firebase-client.js`. Confirm that both contain valid Web SDK credentials for the same project.

Enable Email/Password sign-in in Firebase Authentication. Install the Firebase CLI and sign in:

```bash
npm install -g firebase-tools
firebase login
firebase use rollcall-2669b
```

To deploy the instructor dashboard's Firestore rules and indexes, run this from its directory:

```bash
firebase deploy --only firestore
```

## Run the Student Mobile App

Configure the authenticated recognition API before starting Expo. For an Android Studio emulator on Linux or Windows:

```bash
export EXPO_PUBLIC_RECOGNITION_API_URL=http://10.0.2.2:5055
npm install
npx expo start
```

The special Android emulator address `10.0.2.2` routes to the development computer's loopback interface. Copy `.env.example` to the ignored `.env` file if you prefer persistent local development configuration.

Physical devices must use an HTTPS API address trusted by the device. FaceRoll intentionally rejects plain LAN HTTP because recognition requests contain a Firebase token and temporary face photographs.

### Run the Mobile Recognition API

In another terminal, create and activate the shared recognition environment:

```bash
cd FaceRoll-System/recognition
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install -e '.[api,test]'
```

Configure Firebase Admin and start the API:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/firebase-service-account.json
python -m faceroll_recognition.mobile_api
```

The API defaults to `http://127.0.0.1:5055`. It derives student identity from the verified Firebase token, requires a Firestore student profile, accepts exactly three enrollment images, and never persists raw photographs. See [`Documentation/Mobile-Recognition-API.md`](Documentation/Mobile-Recognition-API.md) for emulator configuration and the complete endpoint contract.

## Run the Instructor Dashboard

Start the Firebase emulators from the dashboard directory:

```bash
cd FaceRoll-System/Instructor-Dashboard
firebase emulators:start
```

| Local service | Address |
|---|---|
| Instructor dashboard | `http://localhost:5001` |
| Authentication emulator | `http://localhost:9099` |
| Firestore emulator | `http://localhost:8080` |

To publish the dashboard, run this from the same directory:

```bash
firebase deploy --only hosting
```

## Run Instructor Webcam Recognition

The instructor dashboard communicates with a local bridge at `http://127.0.0.1:8765`. The current instructor webcam-recognition workflow supports Windows. From the repository root, open the Windows recognition directory:

```bash
cd FaceRoll-System/recognition/windows
```

Install the requirements and start the bridge:

```bash
python -m pip install -r requirements.txt
python bridge_server.py
```

Docker Desktop must be running before a live recognition session starts. See `FaceRoll-System/recognition/windows/README.md` for enrollment, Docker, camera, and troubleshooting instructions.

> **macOS status:** The previous macOS prototype is retained under `FaceRoll-System/recognition/archived/mac/` for historical reference. It is not currently supported, maintained, or included in the documented run procedure.

| Bridge endpoint | Purpose |
|---|---|
| `POST /start-session` | Start webcam capture and recognition |
| `POST /stop-session` | Stop the active recognition session |
| `GET /status` | Return the bridge and recognition status |
| `GET /events?cursor=0` | Return recognition events after a cursor position |

## Shared Firestore Data

| Collection | Purpose |
|---|---|
| `users/{uid}` | Student or instructor profile and role information |
| `courses/{courseId}` | Course metadata and instructor ownership |
| `sessions/{sessionId}` | Active and completed attendance sessions |
| `attendance/{recordId}` | Per-student attendance records and recognition details |
| `instructor_settings/{uid}` | Instructor attendance and session preferences |

Because every component uses this shared model, changes made by the student app or instructor dashboard can appear across the system in near real time.

## Documentation and Testing

Supporting project materials are organized in the following locations:

- [`Documentation/`](Documentation/README.md) contains the system architecture, user manual, and locations for the SRS, design documents, and maintenance plan.
- [`Testing/`](Testing/README.md) contains repeatable system test cases and the test-results log.

The current suite contains manual end-to-end tests because FaceRoll depends on cameras, mobile devices, Firebase, Docker, and platform-specific recognition services. Before a release or course submission, run the relevant cases in `Testing/Test-Cases.md` and record the environment and results in `Testing/Test-Results.md`. Tests that have not been executed must remain marked `Not Run`.

## Student App Routes

| Route | Purpose |
|---|---|
| `/(auth)/login` | Student sign-in |
| `/(auth)/register` | Student account creation |
| `/(tabs)/home` | Student home and recent attendance |
| `/(tabs)/profile` | Profile and enrollment settings |
| `/face-enrollment` | Facial-enrollment camera flow |
| `/attendance-checkin` | Attendance check-in camera flow |

## Instructor Dashboard Pages

| Page | Purpose |
|---|---|
| `index.html` | Instructor sign-in |
| `register.html` | Instructor account registration |
| `instructor-dashboard.html` | Attendance overview and dashboard |
| `live-session.html` | Live webcam-recognition session |
| `student-roster.html` | Student roster and search |
| `student-profile.html` | Student details and attendance overrides |
| `reports.html` | Attendance filters, summaries, and CSV export |
| `settings.html` | Instructor and attendance settings |

## Troubleshooting

### Firestore permission errors

- Confirm the app is using the intended Firebase project.
- Confirm the signed-in user has the correct role.
- Deploy the Firestore rules from the relevant Firebase directory.

### The mobile app cannot reach the recognition API

- Confirm `EXPO_PUBLIC_RECOGNITION_API_URL` was set before Expo started.
- Use `http://10.0.2.2:5055` from an Android Studio emulator.
- Confirm the shared API's `/health` endpoint is available on port `5055`.
- Use a device-trusted HTTPS endpoint for physical phones; plain LAN HTTP is blocked.

### The instructor live session cannot start

- Confirm `bridge_server.py` is running on port 8765.
- Confirm Docker Desktop is running.
- Grant camera access to Python or the terminal application.
- Follow `FaceRoll-System/recognition/windows/README.md` for the supported recognition workflow.

### Authentication fails

- Enable Email/Password sign-in in Firebase Authentication.
- Verify that both clients use valid configuration values for the same project.
- When using emulators, confirm all configured emulators are running.

## Course and Team Information

- **Project:** FaceRoll — Facial Recognition Attendance System
- **Course:** CSCE 4905.501 — Information Technology Capstone I
- **Team:** Cowboys (Group 4)

### Team Members

- Gabriel Oniyitan (Team Lead)
- Austin Woodruff
- Moses Ojo
- Cade Powell
- Isaiah Bailey
