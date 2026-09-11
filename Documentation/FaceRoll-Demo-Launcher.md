# FaceRoll Emulator Demo Launcher

The capstone demo runs entirely against the local Firebase Emulator Suite. It
does not require a Firebase Admin service-account key and does not write accounts,
profiles, courses, sessions, or attendance to production Firebase.

## Daily command

From the repository root:

```bash
npm run demo
```

The launcher detects a private Wi-Fi address, validates the TLS certificate,
checks Docker and the recognition environment, starts Firebase, starts the mobile
recognition API and dashboard bridge, waits for their health checks, and then
starts Expo in LAN mode. Press `Ctrl+C` once to stop the complete stack. Firebase
Auth and Firestore data are exported automatically during a normal shutdown.

The classroom camera and recognition container start later when the instructor
selects a course and starts a session in the dashboard.

## One-time transition from manually started emulators

Before stopping an emulator that contains data you want to keep, export it to the
launcher's permanent directory.



Windows PowerShell:

```powershell
$data = Join-Path $env:LOCALAPPDATA "FaceRoll\firebase-emulator-data"
New-Item -ItemType Directory -Force $data | Out-Null
Set-Location FaceRoll-System\Instructor-Dashboard
firebase emulators:export --force $data
```

After the export succeeds, stop the manually running Firebase, recognition API,
bridge, and Expo processes. Return to the repository root and use `npm run demo`.

## Preflight only

This validates configuration without starting or stopping services:

```bash
npm run demo:check
```

## Optional configuration

The launcher normally needs no configuration. If automatic detection selects the
wrong network interface, copy `.env.demo.example` to `.env.demo` and set:

```dotenv
FACEROLL_DEMO_HOST=192.168.1.100
```

The selected address must be a private LAN address included in the TLS
certificate's Subject Alternative Names. Tailscale `100.x.x.x` addresses are not
selected automatically. `.env.demo` is ignored by Git.

The same file can override the Python executable, TLS files, model cache,
enrollment directory, or Firebase emulator export directory. It must contain
paths and non-secret local settings only.

## Emulator isolation

The launcher removes `GOOGLE_APPLICATION_CREDENTIALS` from all demo child
processes and sets these values internally:

```text
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
GCLOUD_PROJECT=rollcall-2669b
```

The phone receives the instructor computer's LAN address for Auth, Firestore,
and the HTTPS recognition API. The dashboard uses the same emulators through
localhost. If any required port is already occupied, the launcher stops with a
clear message instead of mixing manual and managed processes.

## Requirements

- Node and the root mobile dependencies
- Firebase CLI and Java
- Docker Desktop or Docker Engine
- The recognition `.venv` with API dependencies
- A trusted local TLS certificate containing the instructor computer's LAN IP
- Phone and instructor computer on the same network

The launcher does not use Tailscale and does not install dependencies or trust a
certificate automatically. Those remain one-time machine setup operations.
