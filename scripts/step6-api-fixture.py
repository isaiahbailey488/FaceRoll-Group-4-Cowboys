"""Disposable, loopback-only HTTPS API; synthetic inference, real Firebase emulators."""
import base64
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

# Refuse other environments before importing Firebase or creating any data.
assert os.getenv('FACEROLL_STEP6_TEST') == '1', 'Isolated Step 6 runner required.'
assert os.getenv('GCLOUD_PROJECT') == 'demo-faceroll-step6', 'Isolated project required.'
assert os.getenv('FACEROLL_FIREBASE_MODE') == 'emulator', 'Emulator mode required.'
assert os.getenv('FIREBASE_AUTH_EMULATOR_HOST') == '127.0.0.1:9389', 'Isolated Auth required.'
assert os.getenv('FIRESTORE_EMULATOR_HOST') == '127.0.0.1:8389', 'Isolated Firestore required.'

import firebase_admin
import numpy as np
from firebase_admin import auth, firestore
from werkzeug.serving import WSGIRequestHandler, make_server

from faceroll_recognition.face_privacy import FacePrivacyService, FirebaseFaceProfiles
from faceroll_recognition.mobile_api import _firebase_app_options, _firestore_client, create_mobile_app
from faceroll_recognition.schemas import EnrollmentRecord
from faceroll_recognition.storage import MobileEnrollmentStore

firebase_admin.initialize_app(options=_firebase_app_options())
db = _firestore_client(firestore)
student, teacher, other = 'step6_student', 'step6_teacher', 'step6_other_teacher'
password = 'Synthetic-step6-only-password-482'
for uid, role in ((student, 'student'), (teacher, 'instructor'), (other, 'instructor')):
    auth.create_user(uid=uid, email=f'{uid}@example.test', password=password)
    profile = dict(uid=uid, userId=uid, role=role, studentId='1234567', displayName=uid,
        optOutFlag=False, faceEnrolled=role == 'student', faceConsentRevision=0, faceDataDeletionStatus='none')
    if role == 'student':
        profile['faceEnrollmentServers'] = {'step6-test': {'state': 'present', 'consentRevision': 0}}
    db.collection('users').document(uid).set(profile)

instant = int(time.time() * 1000)
courses = {'located': 'step6-located', 'disabled': 'step6-disabled', 'foreign': 'step6-foreign'}
for kind, course_id in courses.items():
    db.collection('courses').document(course_id).set(dict(courseId=course_id, courseName=f'Synthetic {kind}',
        instructorId=other if kind == 'foreign' else teacher,
        location=dict(enabled=kind != 'disabled', latitude=33, longitude=-97, radiusMeters=15,
            addressLabel='Synthetic classroom', updatedBy=teacher, updatedAt=datetime.now(timezone.utc))))
    db.collection('enrollments').document(f'{len(course_id)}_{course_id}_{student}').set(
        dict(uid=student, courseId=course_id, status='active'))

sessions = {}
for name in ('present', 'late', 'disabled', 'outside', 'inaccurate', 'stale', 'future', 'mocked',
    'mismatch', 'closed', 'no-late', 'expired', 'membership', 'changed-zone', 'optout', 'cancelled', 'default', 'manual', 'foreign'):
    course_id = courses['disabled' if name == 'disabled' else 'foreign' if name == 'foreign' else 'located']
    session_id = f'step6-{name}'
    old = name in ('late', 'no-late', 'expired')
    started = instant - (5 if old else 1) * 60000
    status = 'closed' if name in ('closed', 'manual') else 'closing' if name == 'default' else 'active'
    row = dict(sessionId=session_id, courseId=course_id, status=status, policyVersion=1,
        startedAtMs=started, startTime=datetime.fromtimestamp(started / 1000, tz=timezone.utc).isoformat(),
        gracePeriodMinutes=1 if old else 5, allowLate=name != 'no-late',
        attendanceWindowMinutes=1 if name == 'expired' else 30, defaultAttendance='absent')
    if status != 'active':
        row['endTime'] = datetime.now(timezone.utc).isoformat()
    db.collection('sessions').document(session_id).set(row)
    sessions[name] = {'sessionId': session_id, 'courseId': course_id}

directory = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='step6-storage-', dir=directory) as storage:
    store = MobileEnrollmentStore(Path(storage) / 'enrollments', encryption_key=os.urandom(32))
    matched = np.zeros(512, dtype=np.float32)
    matched[0] = 1
    store.save_mobile_enrollment(EnrollmentRecord.create(student_uid=student, vectors=[matched.tolist()] * 3), authenticated_uid=student)
    privacy = FacePrivacyService(store, FirebaseFaceProfiles(), server_id='step6-test')

    def generate(image):
        if image == b'slow-match':
            time.sleep(0.4)
        if image == b'mismatch':
            different = np.zeros(512, dtype=np.float32)
            different[1] = 1
            return different
        return matched

    app = create_mobile_app(enrollment_store=store, privacy_service=privacy,
        image_decoder=base64.b64decode, embedding_generator=generate)

    class QuietHandler(WSGIRequestHandler):
        def log(self, *_args, **_kwargs):
            pass

    server = make_server('127.0.0.1', 0, app, threaded=True,
        ssl_context=(str(directory / 'server.pem'), str(directory / 'server.key')), request_handler=QuietHandler)
    print(json.dumps(dict(apiUrl=f'https://127.0.0.1:{server.server_port}', uid=student,
        teacherUid=teacher, otherTeacherUid=other, courses=courses, sessions=sessions)), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
