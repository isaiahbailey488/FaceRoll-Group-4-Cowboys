# FaceRoll Recognition Consolidation Roadmap

## Goal

Use one shared `Facenet512` recognition core for the student mobile app and instructor classroom camera.

The shared `faceroll_recognition` Python package is the authoritative implementation. The mobile API and classroom workflow are adapters around that core. Firebase stores authentication, profiles, courses, sessions, consent state, enrollment status, and attendance—but never raw face images or embeddings.

## Required Architecture

```text
Student mobile camera ──────┐
                            ├── Shared Facenet512 core
Instructor classroom camera ┘       ├── one model configuration
                                    ├── one embedding schema
                                    ├── one storage implementation
                                    └── one matching implementation

Instructor dashboard → controls sessions and displays attendance
Firebase → non-biometric application data only
```

## Enrollment Policy

- Students enroll only through the authenticated mobile app.
- Instructor dashboard and classroom-camera tools must not enroll students.
- Enrollment captures exactly three guided samples: forward, slightly left, and slightly right.
- Each sample produces a separate 512-value `Facenet512` embedding.
- Raw enrollment photographs are discarded after processing.
- Firebase UID is the authoritative identity.
- School student ID and display name are optional metadata and never drive matching.
- Mobile verification compares a live embedding with all three samples and uses the lowest valid cosine distance.

## Completed Phase 1: Shared Package and Configuration

- [x] Create the installable `faceroll_recognition` Python package.
- [x] Select `Facenet512` as the authoritative model.
- [x] Pin the core Python and DeepFace dependencies.
- [x] Define one immutable model, detector, metric, threshold, dimension, and version contract.
- [x] Add controlled recognition error types.
- [x] Add package configuration tests.

## Completed Phase 2: Recognition Engine

- [x] Decode base64 images without writing them to disk.
- [x] Load and validate file and in-memory images.
- [x] Generate 512-dimensional `Facenet512` embeddings.
- [x] Enforce one face for enrollment and mobile verification.
- [x] Support multiple detected faces for classroom recognition.
- [x] Validate numeric, finite, nonzero embedding vectors.
- [x] Implement cosine distance once in the shared core.
- [x] Implement 1:1 verification against multiple enrollment samples.
- [x] Implement 1:N classroom identification.
- [x] Test same-person, different-person, and multi-person photographs.

Validation results:

- Same person: recognized at distance `0.1516`.
- Different person: rejected at distance `0.8058`.
- Group photograph: enrolled face recognized and other person rejected.
- Cropped-edge false detection was rejected and did not create a false match.

## Completed Phase 3: Canonical Enrollment Schema

- [x] Define a versioned JSON enrollment schema.
- [x] Require Firebase UID as the authoritative identity.
- [x] Keep school ID and display name optional.
- [x] Require exactly three enrollment embeddings.
- [x] Include model, detector, metric, dimension, schema version, embedding version, IDs, and timestamps.
- [x] Reject legacy `Facenet` records explicitly.
- [x] Reject missing, malformed, incorrectly sized, non-finite, and zero vectors.
- [x] Reject duplicate embedding IDs and invalid timestamps.
- [x] Document the schema in `Documentation/Face-Embedding-Schema.md`.

## Completed Phase 4: Local Embedding Storage

- [x] Add read-only `EnrollmentReader` access for classroom recognition.
- [x] Add `MobileEnrollmentStore` mutations for the future authenticated mobile service.
- [x] Require the authenticated UID and enrollment owner UID to match.
- [x] Add safe Firebase UID filenames and path-traversal protection.
- [x] Add atomic JSON replacement and controlled re-enrollment.
- [x] Add safe, idempotent deletion for the enrollment owner.
- [x] Add POSIX `0700` directory and `0600` file permissions.
- [x] Reject symbolic links, oversized files, malformed JSON, incompatible models, and filename identity mismatches.
- [x] Allow bulk classroom loading to continue when one record is invalid.
- [x] Keep raw images out of the storage interface.

Current automated result: **73 recognition tests passing**.

## Completed Phase 5: Authenticated Mobile Recognition API

- [x] Add a mobile-facing service around the shared core.
- [x] Add `GET /health` with core and model information.
- [x] Add `POST /enroll` accepting exactly three images.
- [x] Add `POST /recognize` for authenticated 1:1 verification.
- [x] Add an authenticated enrollment-deletion endpoint.
- [x] Obtain a Firebase ID token from every mobile request.
- [x] Verify the Firebase token using Firebase Admin.
- [x] Derive the student UID from the verified token.
- [x] Never trust a UID supplied only in the request body.
- [x] Generate all three embeddings before saving anything.
- [x] Atomically save only when every capture is valid.
- [x] Discard all decoded images and temporary embeddings after processing.
- [x] Do not expose classroom session-control endpoints to mobile clients.
- [x] Add request-size limits, controlled errors, and API tests.

Completion gate:

- [x] Only an authenticated student can enroll, verify, replace, or delete their own enrollment.
- [x] The API stores exactly three validated `Facenet512` embeddings.
- [x] Failed enrollment never leaves a partial record.
- [x] Raw photographs are not persisted.

Current automated result: **92 recognition tests passing**, including mobile API and Firebase authorization-boundary tests.

Live emulator validation:

- Firebase Authentication token verification and Firestore student-role lookup passed.
- Three real photographs produced and atomically stored three `Facenet512` embeddings.
- A fourth same-person photograph was recognized at distance `0.1308` against threshold `0.3`.
- The stored record contained three 512-value vectors, no raw-image fields, and POSIX `0700`/`0600` permissions.
- Authenticated deletion removed the disposable enrollment successfully.

## Completed Phase 6: Connect the Mobile App

- [x] Change the existing one-photo enrollment screen into three guided captures.
- [x] Guide the student through forward, slightly left, and slightly right positions.
- [x] Hold captured images only temporarily in memory and delete Expo camera-cache files.
- [x] Allow the student to retake any individual position before resubmitting.
- [x] Send all three images in one authenticated enrollment request.
- [x] Add enrollment progress, review, success, and controlled error states.
- [x] Replace the hard-coded recognition address with environment-driven runtime configuration; secure pairing remains Phase 10.
- [x] Send the Firebase ID token with enrollment and recognition requests.
- [x] Perform phone check-in as private 1:1 verification.
- [x] Require the recognized UID to equal the authenticated Firebase UID.
- [x] Prevent another enrolled face from checking in the logged-in account.

Implementation validation:

- TypeScript strict-mode validation passes.
- Expo public configuration resolution passes.
- iOS production JavaScript bundling passes with Expo SDK 57.
- The app rejects non-loopback plain HTTP API addresses; physical-device endpoints must use HTTPS.
- Real-device camera and navigation validation remains part of the Phase 9 end-to-end test.

## Phase 7: Connect Classroom Recognition

- [ ] Replace private legacy `Facenet` logic in the classroom adapter.
- [ ] Import embedding generation and matching from `faceroll_recognition`.
- [ ] Load enrollments through the read-only `EnrollmentReader`.
- [ ] Use only compatible `Facenet512` records.
- [ ] Match only students authorized for the active course when roster filtering is available.
- [ ] Preserve multi-person processing and recognition cooldown behavior.
- [ ] Include the real Firebase UID in recognition events.
- [ ] Stop relying on student names as recognition identities.
- [ ] Record and safely ignore obvious clipped or invalid detections.

## Phase 8: Docker and Dashboard Bridge Integration

- [ ] Package the shared core into the classroom Docker image.
- [ ] Update the Docker build context and pinned dependencies.
- [ ] Preserve host webcam capture and mounted embedding storage.
- [ ] Preserve dashboard start, stop, status, and event endpoints.
- [ ] Keep classroom embedding access read-only during recognition.
- [ ] Confirm the dashboard starts and stops the shared `Facenet512` worker.

## Phase 9: Functional End-to-End Connection

- [ ] Enroll a test student only through the mobile app.
- [ ] Confirm three embeddings are saved locally under the Firebase UID.
- [ ] Restart the service and confirm enrollment remains available.
- [ ] Recognize the mobile-enrolled student with the classroom camera.
- [ ] Confirm the dashboard receives the correct Firebase UID.
- [ ] Confirm phone verification recognizes only the authenticated student.
- [ ] Confirm duplicate attendance is rejected.
- [ ] Confirm no face image or embedding reaches Firebase.
- [ ] Retire the old `backend/app.py` implementation only after replacement testing passes.
- [ ] Disable or remove instructor-side enrollment tools from production workflows.

## Phase 10: Secure Pairing and Transport

- [ ] Resolve the Firebase Hosting and recognition-service port conflict.
- [ ] Add a short-lived instructor-computer pairing session.
- [ ] Display a QR code containing the local address, public identity, session ID, and expiration.
- [ ] Allow the phone to verify and approve the instructor and course.
- [ ] Replace plain HTTP with authenticated encrypted transport.
- [ ] Restrict CORS and allowed clients.
- [ ] Add replay protection, expiration, request limits, and rate limits.
- [ ] Avoid permanently hard-coded LAN addresses.

## Phase 11: Encryption and Biometric Lifecycle

- [ ] Encrypt embeddings at rest.
- [ ] Store encryption keys in operating-system-protected storage.
- [ ] Never place encryption keys in Firebase or source control.
- [ ] Support authenticated student re-enrollment and consent withdrawal.
- [ ] Support approved course-retention deletion.
- [ ] Ensure logs, analytics, crash reports, and backups exclude biometric data.
- [ ] Keep a manual attendance option for students who opt out.

## Phase 12: Attendance Security and Final Validation

- [ ] Bind recognition results to the authenticated student, course, session, and time.
- [ ] Validate course membership and active-session status in a trusted service.
- [ ] Prevent replayed recognition results and arbitrary client attendance writes.
- [ ] Add liveness and anti-spoofing controls.
- [ ] Test printed-photo, screen-replay, wrong-account, expired-token, malformed-request, and service-unavailable scenarios.
- [ ] Complete real-device mobile, classroom, dashboard, privacy, and security testing.

## Definition of Done

- [ ] One authoritative `Facenet512` implementation serves mobile and classroom adapters.
- [ ] Enrollment is available only through the authenticated student mobile app.
- [ ] Every enrollment contains three compatible samples under the Firebase UID.
- [ ] Mobile verification is secure 1:1 verification.
- [ ] Classroom recognition is read-only and emits the correct Firebase UID.
- [ ] Dashboard session control and attendance reporting continue working.
- [ ] The old separate mobile recognition backend is removed.
- [ ] Raw images and embeddings never reach Firebase or other cloud storage.
- [ ] Biometric transport and storage are authenticated and encrypted.
- [ ] Consent, revocation, retention, and manual attendance are supported.
