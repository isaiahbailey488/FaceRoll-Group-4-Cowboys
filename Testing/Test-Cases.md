# FaceRoll Test Cases

## Authentication and Profiles

### FR-TC-001 — Student registration

**Preconditions:** Firebase Authentication is available and the email is not registered.

**Steps:**

1. Open mobile registration.
2. Enter valid student information and a valid password.
3. Submit the form.

**Expected:** Firebase creates the account, FaceRoll creates a student profile in `users`, and the student enters the authenticated application.

### FR-TC-002 — Student login validation

**Preconditions:** A student account exists.

**Steps:**

1. Attempt to sign in with an incorrect password.
2. Attempt again with the correct password.

**Expected:** The incorrect attempt shows an error without opening the app; the correct attempt opens the student home screen.

### FR-TC-003 — Instructor authentication and authorization

**Preconditions:** Student and instructor accounts exist.

**Steps:**

1. Sign in to the dashboard as the instructor.
2. Verify access to instructor pages and Firestore operations.
3. Attempt the same protected operations as the student.

**Expected:** The instructor can perform authorized management operations; the student cannot perform instructor-only writes.

## Mobile Recognition and Attendance

### FR-TC-004 — Facial enrollment

**Preconditions:** The mobile recognition API is running and a student is signed in.

**Steps:**

1. Open facial enrollment.
2. Capture a clear image containing one face.
3. Submit the image.

**Expected:** The API reports success, stores an embedding for the authenticated user, and the student's profile indicates enrollment.

### FR-TC-005 — Enrollment with no detectable face

**Preconditions:** The mobile recognition API is running.

**Steps:** Submit an image that contains no face.

**Expected:** Enrollment is rejected with a useful message, and no embedding is created.

### FR-TC-006 — Successful mobile check-in

**Preconditions:** The student is enrolled and an eligible course session is active.

**Steps:**

1. Open attendance check-in.
2. Capture the enrolled student's face.
3. Submit the check-in.

**Expected:** Recognition succeeds, one attendance record is created for the student and session, and recent activity displays it.

### FR-TC-007 — Duplicate mobile check-in

**Preconditions:** FR-TC-006 has passed.

**Steps:** Repeat check-in for the same student, session, and course.

**Expected:** FaceRoll does not create a second attendance record.

### FR-TC-008 — Unrecognized face

**Preconditions:** An attendance session is active.

**Steps:** Submit a face that does not match the expected enrolled student.

**Expected:** Recognition fails safely and no attendance record is created.

## Instructor Dashboard

### FR-TC-009 — Course management

**Preconditions:** An instructor is signed in.

**Steps:**

1. Create a course with valid information.
2. Refresh the dashboard.
3. Open the course selector for a live session.

**Expected:** The course persists in Firestore and appears wherever courses are selected or displayed.

### FR-TC-010 — Live webcam session

**Preconditions:** Docker Desktop and the platform bridge are running; a course and enrolled test student exist.

**Steps:**

1. Start a live session for the course.
2. Present the enrolled test student to the webcam.
3. Stop the session.

**Expected:** The bridge starts and stops successfully, recognition produces one event, and Firestore contains the linked session and attendance record.

### FR-TC-011 — Attendance status and grace period

**Preconditions:** An instructor grace period is configured.

**Steps:**

1. Check in one student during the grace period.
2. Check in another student after the grace period.

**Expected:** FaceRoll records the first student as Present and applies the configured late behavior to the second student.

### FR-TC-012 — Manual attendance correction

**Preconditions:** An attendance record exists and an instructor is signed in.

**Steps:** Change the attendance status from the student's profile and reload the page.

**Expected:** The updated status persists in Firestore and appears consistently in the profile, dashboard, and reports.

### FR-TC-013 — Roster search and recognition opt-out

**Preconditions:** The roster includes an opted-out test student.

**Steps:**

1. Search by the student's name.
2. Search by the student's ID.
3. Review their recognition preference.

**Expected:** Both searches find the same student, and the opt-out status is clearly displayed.

### FR-TC-014 — Report filtering and CSV export

**Preconditions:** Attendance exists across multiple courses, dates, and statuses.

**Steps:**

1. Apply course, date, and status filters.
2. Compare displayed rows with the filter criteria.
3. Export the result as CSV.

**Expected:** Only matching records appear, and the CSV contains the same filtered records with useful column headings.

## Reliability and Security

### FR-TC-015 — Firestore access control

**Preconditions:** Deployed Firestore rules and separate student and instructor accounts are available.

**Steps:** Verify that a student can access their own profile and attendance but cannot modify another student, courses, or sessions.

**Expected:** Authorized operations succeed and unauthorized reads or writes are rejected.

### FR-TC-016 — Service unavailable handling

**Preconditions:** The student app and dashboard are running.

**Steps:**

1. Stop the mobile recognition API and attempt enrollment or check-in.
2. Stop the local bridge and attempt to start a live instructor session.

**Expected:** Both clients display actionable errors and remain usable without creating incomplete attendance records.

### FR-TC-017 — Biometric-data cleanup

**Preconditions:** A synthetic test user has been enrolled.

**Steps:** Delete the enrollment using the supported deletion flow or API, then list or inspect enrolled users.

**Expected:** The embedding is removed, raw submitted images are not retained, and later recognition cannot match the deleted enrollment.

