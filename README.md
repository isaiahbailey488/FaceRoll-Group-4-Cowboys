# FaceRoll

FaceRoll is a facial-recognition attendance system for students and instructors. It combines a cross-platform student mobile app, a web-based instructor dashboard, Firebase services, and Python recognition tools so attendance can be recorded, monitored, corrected, and reported from one shared system.

## How FaceRoll Works

1. A student creates an account, joins a course, and chooses whether to use facial recognition. Face enrollment is required only when facial recognition is enabled.
2. An instructor manages courses and starts an attendance session from the web dashboard.
3. Students check in with face plus classroom location, or location only when opted out. Instructor classroom-camera recognition and manual attendance are also available.
4. Firebase synchronizes users, courses, sessions, and attendance between the student and instructor experiences.
5. Students review recent activity, while instructors monitor sessions, correct records, and export reports.

Students who opt out need no face enrollment or check-in photo. Both mobile modes require an enabled classroom zone; instructors can correct attendance manually.

## System Components

### Student Mobile App

The student-facing application handles account registration, profiles, facial enrollment, attendance check-in, and attendance activity. It is built with Expo SDK 58, React Native, TypeScript, and Expo Router. Use an SDK 58-compatible Expo Go app when testing on a physical phone.

### Instructor Dashboard

The web dashboard gives instructors access to courses, student rosters, live attendance sessions, attendance management, settings, and reports. It is built with HTML, CSS, JavaScript, and Firebase Hosting.

### Firebase Services

Firebase Authentication manages student and instructor accounts, while Cloud Firestore stores and synchronizes profiles, courses, sessions, settings, and attendance records across the system.

### Mobile Recognition API

The authenticated Python API under `FaceRoll-System/recognition` handles three-photo enrollment and backend-verified attendance check-in. It uses the shared `Facenet512` core, keeps encrypted embeddings locally, and stores attendance metadata in Firestore without raw photos or student coordinates.

### Instructor Recognition Bridge

The local Python bridge connects the instructor dashboard to the computer's webcam. It uses OpenCV, Docker, and DeepFace to recognize students and send live attendance events to the dashboard.

## Features

### Student Mobile App

- Register and sign in with Firebase Authentication
- Manage a profile and facial-recognition preferences
- Enroll a face using three guided device-camera captures
- Check in with authenticated face plus location verification, or location only when opted out
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

- Node.js 22.13+ (22.x LTS) or 24.3+ (24.x LTS), and npm
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

Use the HTTPS LAN development launcher with the laptop and phone on the same Wi-Fi:

```bash
npm install
npm run demo -- --local
```

The launcher configures HTTPS for recognition, Firebase Auth, Firestore and Expo/Metro, including secure WebSockets. It prints a secure `exps://` QR code. The phone must trust the local certificate authority; see [LAN certificate setup](scripts/DEMO.md). Raw Firebase emulators bind only to laptop loopback. `npm run demo -- --tailscale` remains available when local certificate trust or campus Wi-Fi prevents a LAN connection.

### Verified Attendance Check-In

| Saved preference | Mobile check-in requirements |
|---|---|
| Facial recognition off | Active course membership/session and a fresh verified classroom location. No face enrollment, camera prompt or photo, including while face-data deletion is pending. |
| Facial recognition on | The same location/session requirements plus face enrollment and a matching photo. |

- Open Check-In and choose the course under the student name. Location is collected automatically once the session and saved preference are ready. A bounded foreground collection uses only new readings, settles briefly for better accuracy, and stops before the reading is used. A still-fresh reading can be reused for face retakes; the next Check In attempt automatically replaces an expired or rejected reading. There is no manual location refresh, idle polling or background tracking.
- Face enrollment captures Forward, Slightly Left and Slightly Right, then submits all three photos. Camera screens share a fixed oval and a blocking, scrollable **Before you scan** popup. The full photo is used; cropping to the oval is not implemented. Check-in keeps the camera open for retryable face errors and stops it on success, exit, backgrounding or consent/account changes. Resuming after backgrounding is explicit; enrollment stops the camera after the third capture for review.
- `POST /attendance/check-in` requires HTTPS and a Firebase bearer token. The strict version-1 body contains only `schemaVersion`, `sessionId`, `image` and `location`; opted-out students send `image: null`. The canonical request/response schema is [checkin.schema.json](FaceRoll-System/recognition/faceroll_recognition/checkin.schema.json), shared by the JavaScript and Python validators. The backend derives identity, course, consent, status and zone from trusted data rather than client claims.
- For opted-in students, the backend compares the photo embedding with that student's enrollment before evaluating classroom-zone admission. The final Firestore transaction rechecks membership, consent and session policy, then records attendance atomically. Duplicate receipts preserve the original accepted result; instructor, classroom-camera and session-default records are not overwritten. Students cannot create, update or delete attendance directly under either Firestore rule set.
- Instructors position the HERE map pin and save an enabled zone; address text is only a label. The current radius is 1?15 metres, and admission requires the unrounded distance plus reported accuracy to fit inside it. Sessions freeze the saved zone at start; edits apply to the next session and the editor explains this. Saves reject stale edits from other tabs. Indoor location may not satisfy the zone and cannot reliably distinguish adjacent classrooms or floors; instructor manual corrections remain available.
- The client accepts samples for 15 seconds; the server independently checks 30-second receipt freshness, accuracy, clock tolerance and reported mock-location status. Collection is bounded to 25 seconds with a three-second settling period. Students receive simple retry/settings guidance without distance, accuracy or boundary measurements. Phone-reported GPS and photos are not device attestation or face-liveness checks.
- Photos, query embeddings and coordinates are temporary verification data, never attendance fields or application logs. Enrollment embeddings remain encrypted locally. Face opt-out disables recognition immediately and requests deletion; re-enabling waits for deletion and requires fresh enrollment. Method labels show **Facial recognition**, **Location check**, or the instructor/default method as appropriate.

Instructor sessions restore after refresh/navigation and use local calendar dates. Attendance settings are captured when a session starts; the default attendance status applies at session end only to students without a record. Instructors are restricted to their own courses. Historical attendance percentages use membership dates, or the student's first recorded check-in for legacy memberships without a date.

### Production Configuration

Use `.env.example` for development and `.env.production.example` when preparing a native production build. Set `EXPO_PUBLIC_FIREBASE_MODE=production` with a trusted HTTPS API URL and no emulator URLs/legacy host. Set backend `FACEROLL_FIREBASE_MODE=production`, remove `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` and `FACEROLL_DEMO_MODE`, and use normal Firebase Admin credentials/workload identity. Release builds reject emulator mode.

Keep Admin credentials, embedding keys and TLS private keys out of `EXPO_PUBLIC` variables. Restrict the WSGI backend port and correctly configure the trusted HTTPS reverse proxy if TLS terminates there; arbitrary client-forwarded headers must not bypass HTTPS enforcement. Keep both checked-in rule files consistent, reload the current rules in emulators, and explicitly deploy/review the intended Firebase project's rules before production. Emulator testing does not verify the deployed rules or production phone connectivity.

### Check-In Validation

| Check | Command from repository root |
|---|---|
| Mobile regression checks | `node --test shared/*.test.js` |
| TypeScript | `npx tsc --noEmit` |
| Recognition backend (activate its virtual environment first) | `python -m pytest FaceRoll-System/recognition/tests -q` |
| Isolated backend transactions and both rule sets | `npm run test:step2:emulator` |
| Auth/Firestore HTTPS SDK transport | `npm run test:step1:https` |
| Real Metro HTTPS/bundle/WSS | `npm run test:lan:https` |
| Combined HTTPS/Firebase rehearsal | `npm run test:step6` |

The isolated Firebase checks require Java and the Firebase CLI, use disposable test data and synthetic face/location inputs, and leave saved demo records alone. Generated reports belong under ignored `build/` output rather than committed documentation. The latest recorded mobile run passed 199 tests and TypeScript; the recorded backend run passed 269 tests with 12 skips. These are separate runs, not proof of a physical-phone or production pass.

On iPhone, trusted Safari health access, Expo Go login/course loading and location-only attendance succeeded. Rehearse the updated face-plus-location flow, wrong face and retakes, denied/reduced permissions and services off, stale readings, outside/uncertain locations, duplicates, session closure, Present/Late/default/manual results, and cancellation on background/navigation/account/consent changes. Check native camera/location behavior and agreement between Recent Activity and the dashboard. Use a new session for negative admission tests: an existing accepted receipt may return without repeating face/location checks. Keep any recorded outcomes free of photos, coordinates, tokens and embeddings. Physical checks of the latest automatic flow and a production smoke test remain pending; staff-registration and password-reset changes remain deferred for the local demo.

### Mobile Visual Theme

The mobile app uses the approved instructor-dashboard palette: blue
buttons (`#2C5282`), green headings (`#2E7D42`), off-white cards (`#FCFCFD`),
and a light-gray background (`#F6F7F9`). Recent Activity displays a green check
for Present, an amber L for Late, and a red X for Absent, with a visible legend
and screen-reader status labels. The shared palette in `constants/Colors.ts`
also styles sign-in, registration, Profile & Settings, Help & FAQ, course joining,
facial-privacy gates, camera permission prompts, and scanning tips. The updated
logo is shared by Home, sign-in, and registration.

Camera previews retain dark backgrounds and white capture guides, with lighter
green/red feedback for contrast. Their primary actions use the same blue as the
rest of the app. Native splash/adaptive-icon backgrounds use the off-white surface;
these native configuration changes require a new app build (Expo Go does not
rebuild the native launch screen).

Run `node --test shared/mobile-theme.test.js` to verify palette consistency,
screen styles, attendance indicators, and text contrast.

Use the demo launcher's secure QR for phone testing. Standalone `npm start`
requires the trusted HTTPS application endpoints to be configured beforehand;
never substitute plaintext phone endpoints. Sign in to review Home, Check-In,
Join a Course, Profile & Settings, and Help & FAQ. Native permission/plugin changes
require a new installed build; Expo Go uses its own native permission prompts.

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

Direct API startup defaults to loopback `http://127.0.0.1:5055` for local tools; phone access and attendance check-in require the trusted HTTPS launcher or a correctly configured HTTPS deployment. It derives student identity from the verified Firebase token, requires a Firestore student profile, accepts exactly three enrollment images, and never persists raw photographs. See [`Documentation/Mobile-Recognition-API.md`](Documentation/Mobile-Recognition-API.md) for emulator configuration and the complete endpoint contract.

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

Automated checks are listed under [Check-In Validation](#check-in-validation). Manual end-to-end tests also remain necessary because FaceRoll depends on cameras, mobile devices, Firebase, Docker, and platform-specific recognition services. Before a release or course submission, run the relevant cases in `Testing/Test-Cases.md` and record the environment and results in `Testing/Test-Results.md`. Tests that have not been executed must remain marked `Not Run`.

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
- Configure explicit emulator/production mode and trusted HTTPS URLs; legacy HTTP simulator URLs are rejected.
- Confirm the shared API's `/health` endpoint is available on port `5055`.
- For HTTPS LAN, trust the local CA and allow ports 5055, 9449, 8443 and 8081 from the phone. For Tailscale, keep it connected and allow ports 443, 9449, 8443 and 8081.

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
