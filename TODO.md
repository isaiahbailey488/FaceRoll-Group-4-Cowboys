- [x] Update .gitignore with venv/cache ignores
- [ ] Untrack backend/venv and backend/.venv from index
- [ ] Commit cleanup changes
- [ ] Rewrite git history to remove large venv files
- [ ] Force push cleaned main branch

## Firestore Rules

- [ ] Combine the root `firestore.rules` and `FaceRoll-System/Instructor-Dashboard/firestore.rules` into one secure, authoritative ruleset.
- [ ] Preserve role-based access for students and instructors across `users`, `courses`, `sessions`, `attendance`, `facialEmbeddings`, and `enrollments`.
- [ ] Add secure rules for `instructor_settings` and verify all instructor-dashboard operations.
- [ ] Remove the temporary public read/write rule that expires on December 31, 2026.
- [ ] Update `FaceRoll-System/Instructor-Dashboard/firebase.json` to deploy the shared authoritative rules file.
- [ ] Test student ownership restrictions, instructor permissions, and unauthorized access with the Firebase Emulator Suite before deployment.

## Configuration and Deployment

- [ ] Resolve the port conflict between the mobile Flask recognition backend and the Firebase Hosting emulator, which both currently default to port `5001`.
- [ ] After selecting separate ports, update `backend/app.py`, `app.json`, `services/attendance.ts`, `FaceRoll-System/Instructor-Dashboard/firebase.json`, and all README instructions so they agree.
- [ ] Remove the comments from `FaceRoll-System/Instructor-Dashboard/firestore.indexes.json` and validate it as strict JSON before Firebase deployment.
