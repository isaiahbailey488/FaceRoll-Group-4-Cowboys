"""Opt-in real Admin/Auth/transaction tests against an isolated demo project."""
import base64
import os
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests

from faceroll_recognition.attendance import RECEIPTS, now_ms
from faceroll_recognition.face_privacy import FacePrivacyService, FirebaseFaceProfiles
from faceroll_recognition.mobile_api import _firebase_app_options, _firestore_client, create_mobile_app
from faceroll_recognition.schemas import EnrollmentRecord
from faceroll_recognition.storage import MobileEnrollmentStore


@unittest.skipUnless(os.getenv('FACEROLL_STEP2_EMULATOR_TEST') == '1', 'Run npm run test:step2:emulator for isolated Firebase integration.')
class AttendanceEmulatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.environ['GCLOUD_PROJECT'] == 'demo-faceroll-step2'
        assert os.environ['FIRESTORE_EMULATOR_HOST'] == '127.0.0.1:8289'
        assert os.environ['FIREBASE_AUTH_EMULATOR_HOST'] == '127.0.0.1:9289'
        assert os.environ['FACEROLL_FIREBASE_MODE'] == 'emulator'
        import firebase_admin
        from firebase_admin import firestore
        try:
            firebase_admin.get_app()
        except ValueError:
            firebase_admin.initialize_app(options=_firebase_app_options())
        cls.db = _firestore_client(firestore)

    def setUp(self):
        from firebase_admin import auth
        tag = uuid.uuid4().hex
        self.uid, self.teacher = f'student_{tag}', f'teacher_{tag}'
        self.session_id, self.course_id = f'session_{tag}', f'course_{tag}'
        self.attendance_id = f'{self.session_id}_{self.uid}'
        password = 'Synthetic-step2-password-482'
        email = f'{tag}@example.test'
        auth.create_user(uid=self.uid, email=email, password=password)
        signed_in = requests.post('http://127.0.0.1:9289/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic-key',
            json={'email': email, 'password': password, 'returnSecureToken': True}, timeout=10)
        signed_in.raise_for_status()
        self.authorization = {'Authorization': 'Bearer ' + signed_in.json()['idToken']}
        instant = now_ms()
        self.db.collection('users').document(self.uid).set(dict(uid=self.uid, userId=self.uid, role='student', studentId='1234567',
            optOutFlag=False, faceEnrolled=True, faceConsentRevision=0,
            faceEnrollmentServers={'emulator-checkin-test': {'state': 'present', 'consentRevision': 0}}))
        self.db.collection('users').document(self.teacher).set({'role': 'instructor'})
        self.course_ref = self.db.collection('courses').document(self.course_id)
        self.course_ref.set(dict(courseId=self.course_id, instructorId=self.teacher,
            location={'enabled': True, 'latitude': 33, 'longitude': -97, 'radiusMeters': 15}))
        self.session_ref = self.db.collection('sessions').document(self.session_id)
        self.session_ref.set(dict(sessionId=self.session_id, courseId=self.course_id, status='active', policyVersion=1,
            startedAtMs=instant - 60000, gracePeriodMinutes=5, allowLate=True, attendanceWindowMinutes=30, defaultAttendance='absent'))
        self.db.collection('enrollments').document(f'{len(self.course_id)}_{self.course_id}_{self.uid}').set(
            dict(uid=self.uid, courseId=self.course_id, status='active'))
        self.temporary = tempfile.TemporaryDirectory()
        self.store = MobileEnrollmentStore(Path(self.temporary.name) / 'enrollments', encryption_key=b'2' * 32)
        embedding = np.zeros(512, dtype=np.float32); embedding[0] = 1
        self.store.save_mobile_enrollment(EnrollmentRecord.create(student_uid=self.uid,
            vectors=[embedding.tolist()] * 3), authenticated_uid=self.uid)
        self.privacy = FacePrivacyService(self.store, FirebaseFaceProfiles(), server_id='emulator-checkin-test')
        self.inference_hook = lambda: None
        def generate(_image):
            self.inference_hook()
            return embedding
        self.app = create_mobile_app(enrollment_store=self.store, privacy_service=self.privacy,
            image_decoder=lambda image: image, embedding_generator=generate)
        self.app.testing = True

    def tearDown(self):
        self.temporary.cleanup()

    def submit(self, **changes):
        body = dict(schemaVersion=1, sessionId=self.session_id, image=base64.b64encode(b'synthetic image').decode(),
            location={'latitude': 33, 'longitude': -97, 'accuracyMeters': 3, 'capturedAtMs': now_ms(), 'mocked': None}) | changes
        with self.app.test_client() as client:
            result = client.post('/attendance/check-in', json=body, headers=self.authorization, base_url='https://localhost')
            return result.status_code, result.get_json()

    def client_authorization(self, uid):
        """Real Auth emulator sessions, never an Admin/owner token for rule probes."""
        from firebase_admin import auth
        password = 'Synthetic-step5-password-482'
        email = f'{uid}@example.test'
        auth.create_user(uid=uid, email=email, password=password)
        result = requests.post('http://127.0.0.1:9289/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic-key',
            json={'email': email, 'password': password, 'returnSecureToken': True}, timeout=10)
        result.raise_for_status()
        return {'Authorization': 'Bearer ' + result.json()['idToken']}

    def document_name(self, path):
        return f'projects/demo-faceroll-step2/databases/(default)/documents/{path}'

    def client_commit(self, writes, authorization, expected=403):
        result = requests.post('http://127.0.0.1:8289/v1/projects/demo-faceroll-step2/databases/(default)/documents:commit',
            headers=authorization, json={'writes': writes}, timeout=20)
        self.assertEqual(result.status_code, expected, result.text)

    def client_update(self, path, data, authorization, expected=403):
        self.client_commit([self.update_write(path, data)], authorization, expected)

    def update_write(self, path, data):
        def field(value):
            if value is None:
                return {'nullValue': None}
            if isinstance(value, bool):
                return {'booleanValue': value}
            if isinstance(value, str):
                return {'stringValue': value}
            if isinstance(value, int):
                return {'integerValue': str(value)}
            if isinstance(value, float):
                return {'doubleValue': value}
            return {'mapValue': {'fields': {key: field(item) for key, item in value.items()}}}
        return {'update': {'name': self.document_name(path), 'fields': {key: field(value) for key, value in data.items()}},
            'updateMask': {'fieldPaths': list(data)}}

    def client_get(self, path, authorization, expected=403):
        result = requests.get(f'http://127.0.0.1:8289/v1/{self.document_name(path)}', headers=authorization, timeout=20)
        self.assertEqual(result.status_code, expected, result.text)
        return result

    def attendance_row(self, session_id=None, **changes):
        session_id = session_id or self.session_id
        return dict(id=f'{session_id}_{self.uid}', uid=self.uid, userId=self.uid, sessionId=session_id, courseId=self.course_id,
            membershipId=f'{len(self.course_id)}_{self.course_id}_{self.uid}', source='phone_face_verification',
            status='present', locationStatus='in_zone', method='Phone face verification', time='2026-11-05T12:00:00.000Z') | changes

    def test_real_token_and_firestore_finalize_once_and_retry_after_session_close(self):
        status, accepted = self.submit()
        self.assertEqual(status, 200, accepted)
        self.session_ref.update({'status': 'closed'})
        status, repeated = self.submit(location=None)
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated, accepted | {'duplicate': True})
        attendance = self.db.collection('attendance').document(self.attendance_id).get().to_dict()
        receipt = self.db.collection(RECEIPTS).document(self.attendance_id).get().to_dict()
        self.assertEqual(attendance['time'], receipt['recordedAt'])
        for data in (attendance, receipt):
            self.assertTrue(set(data).isdisjoint({'image', 'latitude', 'longitude', 'location', 'accuracyMeters', 'distance'}))

    def test_parallel_real_firestore_transactions_create_one_result(self):
        barrier = threading.Barrier(2)
        self.inference_hook = lambda: barrier.wait(timeout=20)
        failures = []
        def record_failure(*_args):
            # Diagnose dependency contention without recording request payloads
            # or changing the production endpoint's deliberately quiet logging.
            error = sys.exc_info()[1]
            failures.append((type(error).__name__, type(error.__cause__).__name__))
        with patch.object(self.app.logger, 'error', side_effect=record_failure):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: self.submit(), range(2)))
        self.assertTrue(all(status == 200 for status, _ in results), (results, failures))
        self.assertEqual(sorted(result['duplicate'] for _, result in results), [False, True])
        self.assertEqual(results[0][1]['recordedAt'], results[1][1]['recordedAt'])

    def test_current_zone_is_reloaded_after_inference_and_rejection_has_no_attendance(self):
        self.inference_hook = lambda: self.course_ref.update({'location.latitude': 34})
        status, rejected = self.submit()
        self.assertEqual(status, 403, rejected)
        self.assertEqual(rejected['error'], 'location_unverified')
        self.assertFalse(self.db.collection('attendance').document(self.attendance_id).get().exists)
        self.assertFalse(self.db.collection(RECEIPTS).document(self.attendance_id).get().exists)

    def test_auth_account_disabled_during_inference_is_rejected(self):
        from firebase_admin import auth
        self.inference_hook = lambda: auth.update_user(self.uid, disabled=True)
        status, rejected = self.submit()
        self.assertEqual(status, 401, rejected)
        self.assertFalse(self.db.collection('attendance').document(self.attendance_id).get().exists)

    def test_client_cannot_read_create_or_modify_backend_receipt(self):
        status, result = self.submit()
        self.assertEqual(status, 200, result)
        admin_uid = f'admin_{uuid.uuid4().hex}'
        self.db.collection('users').document(admin_uid).set({'role': 'admin'})
        original = self.db.collection(RECEIPTS).document(self.attendance_id).get().to_dict()
        for authorization in (self.authorization, self.client_authorization(self.teacher), self.client_authorization(admin_uid), {}):
            with self.subTest(authorization='signed-in' if authorization else 'anonymous'):
                self.client_get(f'{RECEIPTS}/{self.attendance_id}', authorization)
                self.client_get(RECEIPTS, authorization)
                self.client_update(f'{RECEIPTS}/{self.attendance_id}', {'uid': self.uid}, authorization)
                self.client_update(f'{RECEIPTS}/forged', {'uid': self.uid}, authorization)
                self.client_commit([{'delete': self.document_name(f'{RECEIPTS}/{self.attendance_id}')}], authorization)
        self.assertEqual(self.db.collection(RECEIPTS).document(self.attendance_id).get().to_dict(), original)

    def test_direct_student_creates_and_forged_sources_are_denied_even_with_valid_metadata(self):
        original_session = self.session_ref.get().to_dict()
        path = f'attendance/{self.attendance_id}'
        for location_enabled in (True, False):
            self.course_ref.update({'location.enabled': location_enabled})
            for source in ('phone_face_verification', 'phone_location_verification', 'classroom_camera', 'session_default', 'instructor_override', ''):
                with self.subTest(location_enabled=location_enabled, source=source):
                    self.client_update(path, self.attendance_row(source=source), self.authorization)
        # Omission of verification fields and old sessions without policyVersion
        # must not restore the legacy own-UID create permission.
        legacy = self.attendance_row()
        for key in ('source', 'locationStatus', 'method'):
            legacy.pop(key)
        self.session_ref.set({'courseId': self.course_id, 'status': 'active'})
        self.client_update(path, legacy, self.authorization)
        self.client_update(path, self.attendance_row(), {})
        self.assertFalse(self.db.collection('attendance').document(self.attendance_id).get().exists)
        self.assertFalse(self.db.collection(RECEIPTS).document(self.attendance_id).get().exists)
        self.session_ref.set(original_session)
        self.course_ref.update({'location.enabled': True})
        # The real Admin transaction still finalizes the same student's request.
        status, accepted = self.submit()
        self.assertEqual(status, 200, accepted)
        self.assertEqual(accepted['locationStatus'], 'in_zone')
        self.client_get(path, self.authorization, 200)

    def test_opt_out_location_only_is_finalized_by_server_without_enrollment_or_face_reads(self):
        self.db.collection('users').document(self.uid).update({'optOutFlag': True, 'faceEnrolled': False,
            'faceConsentRevision': 1, 'faceDataDeletionStatus': 'pending'})
        self.store.delete_enrollment(self.uid, authenticated_uid=self.uid)
        with (patch.object(self.store, 'load', side_effect=AssertionError('No face access permitted')),
              patch.object(self.privacy, 'check', side_effect=AssertionError('No facial permission check permitted'))):
            status, accepted = self.submit(image=None)
        self.assertEqual(status, 200, accepted)
        row = self.db.collection('attendance').document(self.attendance_id).get().to_dict()
        self.assertEqual(row['source'], 'phone_location_verification')
        self.client_get(f'attendance/{self.attendance_id}', self.authorization, 200)
        self.client_update(f'attendance/{self.attendance_id}', {'status': 'late'}, self.authorization)
        self.assertTrue(set(row).isdisjoint({'image', 'location', 'latitude', 'longitude', 'accuracyMeters'}))
        status, duplicate = self.submit(image=None)
        self.assertEqual(status, 200, duplicate)
        self.assertTrue(duplicate['duplicate'])

    def test_opted_in_student_cannot_bypass_face_using_null_photo_or_client_preference(self):
        status, rejected = self.submit(image=None)
        self.assertEqual(status, 403, rejected)
        self.assertEqual(rejected['error'], 'face_required')
        status, rejected = self.submit(image=None, optOutFlag=True)
        self.assertEqual(status, 400, rejected)
        self.assertFalse(self.db.collection('attendance').document(self.attendance_id).get().exists)

    def test_student_cannot_change_or_delete_server_attendance_and_reads_stay_private(self):
        status, accepted = self.submit()
        self.assertEqual(status, 200, accepted)
        ref = self.db.collection('attendance').document(self.attendance_id)
        original = ref.get().to_dict()
        path = f'attendance/{self.attendance_id}'
        for changes in ({'status': 'absent'}, {'source': 'instructor_override'}, {'locationStatus': 'in_zone'}, {'time': '2000-01-01T00:00:00.000Z'}):
            self.client_update(path, changes, self.authorization)
        self.client_commit([{'delete': self.document_name(path)}], self.authorization)
        self.assertEqual(ref.get().to_dict(), original)
        self.client_get(path, self.authorization, 200)
        other_uid = f'other_{uuid.uuid4().hex}'
        self.db.collection('users').document(other_uid).set({'role': 'student'})
        self.client_get(path, self.client_authorization(other_uid))
        base = 'http://127.0.0.1:8289/v1/projects/demo-faceroll-step2/databases/(default)/documents:runQuery'
        query = {'from': [{'collectionId': 'attendance'}], 'where': {'fieldFilter': {
            'field': {'fieldPath': 'uid'}, 'op': 'EQUAL', 'value': {'stringValue': self.uid}}}}
        result = requests.post(base, headers=self.authorization, json={'structuredQuery': query}, timeout=20)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIn(self.attendance_id, result.text)
        result = requests.post(base, headers=self.authorization, json={'structuredQuery': {'from': query['from']}}, timeout=20)
        self.assertEqual(result.status_code, 403, result.text)

    def test_denied_student_batch_cannot_partially_write_profile_or_fake_receipt(self):
        profile = self.db.collection('users').document(self.uid)
        original = profile.get().to_dict()
        self.client_commit([
            self.update_write(f'users/{self.uid}', {'firstName': 'Should not persist'}),
            self.update_write(f'attendance/{self.attendance_id}', self.attendance_row()),
            self.update_write(f'{RECEIPTS}/{self.attendance_id}', {'uid': self.uid, 'locationStatus': 'in_zone'}),
        ], self.authorization)
        self.assertEqual(profile.get().to_dict(), original)
        self.assertFalse(self.db.collection('attendance').document(self.attendance_id).get().exists)
        self.assertFalse(self.db.collection(RECEIPTS).document(self.attendance_id).get().exists)

    def test_instructor_camera_manual_defaults_and_admin_access_survive_without_cross_course_writes(self):
        teacher = self.client_authorization(self.teacher)
        other_teacher_uid, admin_uid = f'other_teacher_{uuid.uuid4().hex}', f'admin_{uuid.uuid4().hex}'
        self.db.collection('users').document(other_teacher_uid).set({'role': 'instructor'})
        self.db.collection('users').document(admin_uid).set({'role': 'admin'})
        other_teacher, administrator = self.client_authorization(other_teacher_uid), self.client_authorization(admin_uid)
        row = self.attendance_row(source='classroom_camera', method='Classroom camera recognition', locationStatus='not_checked')
        path = f'attendance/{self.attendance_id}'
        for extra in ({'latitude': 33}, {'location': {'latitude': 33, 'longitude': -97}},
            {'method': {'latitude': 33}}, {'attendanceEvidenceId': {'latitude': 33}}, {'image': 'private-photo'}):
            self.client_update(path, row | extra, teacher)
        self.client_update(path, row, other_teacher)
        self.client_update(path, row, teacher, 200)
        self.client_get(path, teacher, 200)
        self.client_get(path, other_teacher)
        self.client_update(path, {'status': 'late'}, other_teacher)
        self.client_update(path, {'status': 'late'}, teacher, 200)
        self.client_update(path, {'status': 'present'}, administrator, 200)
        for extra in ({'position': {'latitude': 33}}, {'sessionId': 'other-session'}, {'courseId': 'other-course'}, {'uid': 'other-student'}):
            self.client_update(path, extra, teacher)

        def new_session(suffix, status, **extra):
            session_id = f'{self.session_id}_{suffix}'
            self.db.collection('sessions').document(session_id).set({'courseId': self.course_id, 'status': status, **extra})
            return session_id, f'attendance/{session_id}_{self.uid}'

        self.db.collection('users').document(self.uid).update({'optOutFlag': True, 'faceEnrolled': False})
        session_id, path = new_session('opted-out', 'active')
        self.client_update(path, self.attendance_row(session_id, source='classroom_camera'), teacher)
        session_id, path = new_session('manual', 'closed')
        self.client_update(path, self.attendance_row(session_id, source='instructor_override', status='late', method='Instructor override', locationStatus='not_checked'), teacher, 200)
        for state in ('closing', 'closed'):
            session_id, path = new_session(state, state, defaultAttendance='absent')
            default = self.attendance_row(session_id, source='session_default', status='absent', method='Session default', locationStatus='not_checked')
            self.client_update(path, default, self.authorization)
            self.client_update(path, default, other_teacher)
            self.client_update(path, default | {'status': 'present'}, teacher)
            self.client_update(path, default, teacher, 200)
        self.client_commit([{'delete': self.document_name(path)}], other_teacher)
        self.client_commit([{'delete': self.document_name(path)}], teacher, 200)


if __name__ == '__main__':
    unittest.main()
