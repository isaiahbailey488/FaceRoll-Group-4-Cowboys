# Facial recognition opt-out

Students use **Profile & Settings → Opt Out of Facial Recognition**. Confirmation saves their preference, clears enrollment status, increments the consent revision, and requests embedding deletion. Phone enrollment and face check-in require a verified server preference before opening the camera and before uploading a photograph. Pending deletion blocks facial processing. The app discards unsent enrollment captures when access is revoked.

The recognition API checks consent before processing, between enrollment samples, and before saving enrollment or returning a match. An operation already running cannot undo computation completed before opt-out arrives; its enrollment or match is rejected when consent is rechecked. Firestore rules also reject new facial attendance for opted-out students, including a delayed match from an active classroom session. Existing attendance history is preserved.

## Deletion and reconnecting

Each recognition computer registers a stable ID in the student's non-biometric profile before saving embeddings. Its API removes that student's encrypted enrollment file and records a deletion receipt. The app confirms deletion only after every registered computer has acknowledged the current request. It shows **pending** for an offline computer or a failed deletion; students can retry without undoing opt-out. The API automatically retries while running, including after restart. A student with no saved enrollment can also complete deletion.

The private enrollment directory contains `.face-privacy-state` (computer ID and retry UIDs) and `.face-privacy-policy` (a short-lived list of permitted UIDs). Preserve the state file when restarting or moving the same enrollment directory. It contains no embedding vectors or photographs. Run one recognition API process per enrollment directory. Do not share one directory between independent API processes or use multiple WSGI workers.

The classroom worker intersects the active course roster with the permission file, which expires after eight seconds. Missing, invalid, or expired policy disables identification; policy refresh runs about every two seconds while Firebase is available. The API must run alongside classroom recognition. Firestore independently checks the current preference when attendance is written. Shared classroom cameras can still capture frames containing an opted-out person; their enrollment is excluded from identification. This is not a promise that a shared camera never sees their face.

Completion covers enrolled data on **registered recognition computers**. Old installations that have not yet run this update cannot be discovered remotely. Start the updated API on every existing recognition computer to register and reconcile legacy files. Separately managed backups and exported copies are outside this deletion process and require their own retention/deletion procedure; do not restore them over an enrollment directory without reconciliation.

Opting back in is blocked until deletion is confirmed. It increments the revision again and leaves enrollment disabled until fresh enrollment succeeds. Old receipts or restored files from an earlier revision cannot authorize recognition. The instructor's Students roster displays **Facial recognition off**. Live camera rosters also follow preference changes.

## Running the update

1. Load the updated Firestore rules into the development emulator. For a hosted release, deploy the rules from the dashboard's existing Firebase configuration along with the dashboard assets. Both maintained rules files contain the opt-out safeguards.
2. Restart the mobile recognition API and Windows bridge, using the same Firebase project and enrollment directory. Start each existing recognition computer once to reconcile its legacy enrollment files.
3. Start a new classroom session. The bridge uses `faceroll-recognition:0.4.0`, forcing an updated worker image to be built instead of reusing the earlier cached version.
4. Reload the mobile app and dashboard. Verify opt-out, pending deletion while another registered computer is offline, cleanup after reconnecting, and fresh enrollment after opting back in.

No production deployment is performed automatically by these source changes. Mobile geofence check-in and manual attendance improvements remain separate work. The mobile app explicitly states that location check-in is not yet available.

## Automated checks

From the repository root:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --test shared/face-privacy.test.js shared/face-privacy-screens.test.js FaceRoll-System/Instructor-Dashboard/tests/*.test.js
& FaceRoll-System/recognition/.venv/Scripts/python.exe -m pytest FaceRoll-System/recognition/tests -q
```

`scripts/test-face-privacy-rules.cjs` runs twenty real rules checks against a separately started Firestore emulator for `demo-faceroll-optout`, bound to localhost on the port supplied as its argument (default 8183). It seeds only that demo project's synthetic records and must not target shared development data. Start the emulator with either maintained rules file to verify each deployment configuration. Tests cover consent transitions, forged receipts, pending deletion, and facial attendance before and after fresh enrollment.
