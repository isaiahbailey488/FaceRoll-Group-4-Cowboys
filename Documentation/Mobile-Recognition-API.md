# FaceRoll Mobile Recognition API

All phone-facing endpoints require trusted HTTPS. Emulator and production modes
cannot be mixed; raw emulator HTTP endpoints are loopback-only. Current check-in,
privacy, deployment and validation guidance is consolidated in the
[project README](../README.md#verified-attendance-check-in).

## Purpose

The API is the authenticated mobile adapter around the shared `Facenet512` recognition core. It supports student enrollment, private one-to-one verification, enrollment deletion, and backend-verified attendance check-in. It does not expose classroom recognition or session-control operations.

The mobile application uses this API for three-photo enrollment and attendance check-in: location only when opted out of facial recognition, face plus location when opted in. The old `backend/app.py` service remains temporarily available only for migration and must not create shared enrollment records.

The Expo app reads the API address from `EXPO_PUBLIC_RECOGNITION_API_URL`. It sends the current Firebase ID token automatically and never places a UID in an enrollment or recognition request body.

## Authentication and Identity

Every endpoint except `GET /health` requires this header:

```http
Authorization: Bearer <Firebase-ID-token>
```

The API verifies the token with Firebase Admin, loads `users/{firebaseUid}` from Firestore, and requires its `role` or `userType` to equal `student`. The verified Firebase UID is the enrollment owner and recognition identity. School student ID and display name are copied only as optional metadata from the trusted Firestore profile.

Requests must not include `uid`, `student_uid`, `studentUid`, or `userId`. Supplying one of those fields is rejected because the request body is not an identity authority.

## Endpoints

### `GET /health`

No authentication is required. The response reports the service version and the authoritative model, detector, distance metric, threshold, dimension, schema version, embedding version, and required enrollment sample count.

### `POST /enroll`

The request must contain exactly three base64-encoded images in the order forward, slightly left, and slightly right:

```json
{
  "images": [
    "<forward-base64>",
    "<slightly-left-base64>",
    "<slightly-right-base64>"
  ]
}
```

Each image must contain exactly one detectable face. The service generates and validates all three embeddings before it writes anything. It then atomically creates or replaces the authenticated student's enrollment file.

### `POST /recognize`

The request contains one live image:

```json
{
  "image": "<live-base64>"
}
```

The live embedding is compared only with the three samples owned by the authenticated student. A successful match returns that same verified Firebase UID. A nonmatch returns `uid: null`.

### `DELETE /enrollment`

No request body or UID path parameter is accepted. The endpoint deletes only the enrollment belonging to the verified Firebase UID. Repeating the request after deletion returns `404 not_enrolled`.

### `POST /attendance/check-in`

Accepts the versioned session/photo/location contract and atomically finalizes
attendance after backend authentication, membership, consent, session policy and
location checks. An enabled saved classroom zone is required in both modes.
Opted-in students also require enrollment and face verification; opted-out
students submit `image: null`, with no face reads/inference even during deletion.
Requires HTTPS and returns only attendance metadata. See the
[check-in summary](../README.md#verified-attendance-check-in) and canonical
[request/response schema](../FaceRoll-System/recognition/faceroll_recognition/checkin.schema.json).

## Local Storage and Privacy

- The default enrollment directory is `%USERPROFILE%\.local\share\faceroll\enrollments` on Windows and `~/.local/share/faceroll/enrollments` on Linux.
- Set `FACEROLL_ENROLLMENT_DIR` to use a different local directory.
- Enrollment files contain three validated 512-value embeddings plus schema and identity metadata.
- Raw images are decoded in request memory and are never written by the API.
- Embeddings, raw images and student coordinates are never sent to Firebase. The combined check-in endpoint reads authorization/session/course metadata and writes attendance plus a private idempotency receipt.
- Request bodies are limited to 25,000,000 bytes and each encoded image is limited to 8,000,000 characters.

## Runtime Configuration

The service recognizes these environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `FACEROLL_API_HOST` | `127.0.0.1` | Bind address |
| `FACEROLL_API_PORT` | `5055` | API port |
| `FACEROLL_ENROLLMENT_DIR` | User-local FaceRoll data directory | Enrollment storage |
| `DEEPFACE_HOME` | User home directory | Parent directory containing DeepFace's `.deepface/weights` cache |
| `GOOGLE_APPLICATION_CREDENTIALS` | None | Firebase Admin credential file |
| `FIREBASE_AUTH_EMULATOR_HOST` | None | Optional Authentication emulator address |
| `FIRESTORE_EMULATOR_HOST` | None | Optional Firestore emulator address |
| `GCLOUD_PROJECT` | None | Project ID required when using Firebase emulators |

The default loopback binding prevents accidental network exposure. Use the HTTPS LAN or Tailscale launcher for phone access. The combined check-in endpoint also rejects cleartext HTTP; production reverse proxies must supply trusted scheme information as described in the [production configuration](../README.md#production-configuration).

When both Firebase emulator variables are set, the API uses anonymous credentials only for the local Firestore emulator. Production Firestore access continues to require normal Firebase Admin credentials.

## Errors

Errors are JSON objects with `success: false`, a stable `error` code, and a controlled `message`. Expected status codes include:

| Status | Meaning |
|---:|---|
| `400` | Malformed JSON, forbidden identity field, or wrong image count |
| `401` | Missing, malformed, invalid, expired, or revoked Firebase token |
| `403` | Authenticated account is not a student |
| `404` | Authenticated student has no local enrollment |
| `413` | Request exceeds the configured request limit |
| `422` | Image is invalid, contains no face, or contains multiple faces |
| `500` | Controlled recognition or storage failure |
| `503` | Firebase Admin authentication dependency is unavailable |

## Automated Verification

The API tests use injected authentication and embedding boundaries, so they do not require Firebase credentials, network access, photographs, or model downloads. They verify authorization, exact sample count, atomic replacement, self-only recognition and deletion, raw-image exclusion, malformed requests, and size limits.
