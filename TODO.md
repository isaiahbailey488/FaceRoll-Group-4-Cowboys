# FaceRoll Project TODO

## Repository Cleanup

- [x] Update `.gitignore` with dependency, virtual-environment, generated recognition-data, and cache exclusions.
- [x] Confirm `backend/venv` and `backend/.venv` are not tracked.
- [x] Confirm generated embeddings, recognition events, model caches, and Python bytecode are not tracked.
- [x] Commit the shared `Facenet512` recognition work.
- [x] Verify `main` matches `origin/main`.

Git history currently contains no commits for `backend/venv` or `backend/.venv`. Do not rewrite history or force-push unless a future repository audit identifies a specific sensitive or oversized tracked object.

## Recognition Consolidation

- [x] Complete shared recognition Phases 1–4.
- [x] Add the canonical enrollment schema and safe local storage.
- [x] Add Windows setup and embedding-schema documentation.
- [x] Move the current roadmap into tracked documentation.
- [x] Implement the authenticated mobile recognition API.
- [x] Update mobile enrollment from one photograph to three guided photographs.
- [ ] Connect classroom recognition to the shared `Facenet512` core.
- [ ] Complete Docker and dashboard bridge integration.
- [ ] Complete functional, privacy, and security testing.

See [Documentation/Face-Recognition-Roadmap.md](Documentation/Face-Recognition-Roadmap.md) for the authoritative phased plan.

## Firestore Rules

- [ ] Combine the root `firestore.rules` and `FaceRoll-System/Instructor-Dashboard/firestore.rules` into one secure, authoritative ruleset.
- [ ] Preserve role-based access for students and instructors across `users`, `courses`, `sessions`, `attendance`, and `enrollments`.
- [ ] Add secure rules for `instructor_settings` and verify every instructor-dashboard operation.
- [ ] Prohibit raw face images and face embeddings from being stored in Firestore.
- [ ] Remove or deny the obsolete `facialEmbeddings` cloud-storage path.
- [ ] Remove the temporary public read/write rule that expires on December 31, 2026.
- [ ] Update `FaceRoll-System/Instructor-Dashboard/firebase.json` to deploy the shared authoritative rules file.
- [ ] Test student ownership, instructor permissions, attendance writes, and unauthorized access with the Firebase Emulator Suite.

## Configuration and Deployment

- [ ] Resolve the port conflict between the temporary mobile Flask backend and Firebase Hosting emulator, which both default to port `5001`.
- [ ] Assign stable, documented ports to Firebase Hosting, the dashboard bridge, and the future shared recognition API.
- [ ] Replace the mobile app's hard-coded recognition IP with paired runtime configuration.
- [ ] Update `app.json`, service configuration, Firebase configuration, and documentation after the final port design is selected.
- [ ] Remove comments from `FaceRoll-System/Instructor-Dashboard/firestore.indexes.json` and validate it as strict JSON.
- [ ] Validate environment-variable setup without committing `.env` secrets.

## Documentation Housekeeping

- [ ] Keep the recognition roadmap synchronized after every completed phase.
- [ ] Update `Documentation/recongtion_setup.md` as adapters migrate to the shared core.
- [ ] Optionally rename `recongtion_setup.md` to `recognition_setup.md` and update its links.
- [ ] Update the system architecture and root README after the old mobile backend is retired.
