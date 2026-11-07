import base64
import copy
import json
import logging
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from faceroll_recognition.attendance import (
    AttendanceError, RECEIPTS, attendance_status, distance_meters, location_status,
)
from faceroll_recognition.checkin_contract import validate_check_in_success
from faceroll_recognition.errors import InvalidImageError, MultipleFacesDetectedError, NoFaceDetectedError
from faceroll_recognition.engine import verify_embedding
from faceroll_recognition.face_privacy import FacePrivacyService
from faceroll_recognition.mobile_api import AuthenticatedStudent, AuthenticationError, StudentAuthorizationError, create_mobile_app
from faceroll_recognition.schemas import EnrollmentRecord
from faceroll_recognition.storage import MobileEnrollmentStore
from .test_invitations import Store


NOW = 1_793_898_000_000
UID = 'student'
SESSION = 'session_test'
ATTENDANCE = f'{SESSION}_{UID}'
AUTH = {'Authorization': 'Bearer good'}


def vector(index=0):
    value = np.zeros(512, dtype=np.float32)
    value[index] = 1
    return value


def session(start=NOW - 60_000, **changes):
    return dict(status='active', sessionId=SESSION, courseId='COURSE', policyVersion=1,
        startedAtMs=start, startTime=datetime.fromtimestamp(start / 1000, timezone.utc).isoformat(),
        gracePeriodMinutes=5, attendanceWindowMinutes=30, allowLate=True,
        defaultAttendance='absent', **changes)


def position(**changes):
    return dict(latitude=33.0, longitude=-97.0, accuracyMeters=3,
        capturedAtMs=NOW, mocked=None) | changes


def course(**changes):
    return {'courseId': 'COURSE', 'instructorId': 'teacher',
        'location': {'enabled': True, 'latitude': 33.0, 'longitude': -97.0, 'radiusMeters': 15}} | changes


class AttendancePolicyTests(unittest.TestCase):
    def assert_code(self, code, callback):
        with self.assertRaises(AttendanceError) as raised:
            callback()
        self.assertEqual(raised.exception.code, code)

    def test_grace_and_window_boundaries_and_unlimited_window(self):
        row = session(start=NOW)
        self.assertEqual(attendance_status(row, NOW + 5 * 60000), 'present')
        self.assertEqual(attendance_status(row, NOW + 5 * 60000 + 1), 'late')
        self.assertEqual(attendance_status(row, NOW + 30 * 60000), 'late')
        self.assert_code('attendance_window_closed', lambda: attendance_status(row, NOW + 30 * 60000 + 1))
        row['allowLate'] = False
        self.assert_code('attendance_late_disabled', lambda: attendance_status(row, NOW + 5 * 60000 + 1))
        row.update(attendanceWindowMinutes=0, allowLate=True)
        self.assertEqual(attendance_status(row, NOW + 8 * 3600000), 'late')

    def test_shorter_window_wins_and_zero_grace_is_inclusive(self):
        row = session(start=NOW)
        row.update(attendanceWindowMinutes=1, gracePeriodMinutes=5)
        self.assert_code('attendance_window_closed', lambda: attendance_status(row, NOW + 60001))
        row.update(attendanceWindowMinutes=0, gracePeriodMinutes=0, allowLate=False)
        self.assertEqual(attendance_status(row, NOW), 'present')
        self.assert_code('attendance_late_disabled', lambda: attendance_status(row, NOW + 1))

    def test_non_active_future_ended_and_malformed_policy_fail_closed(self):
        for status in ('starting', 'closing', 'closed', 'start_failed', None):
            self.assert_code('attendance_session_closed', lambda: attendance_status(session() | {'status': status}, NOW))
        self.assert_code('attendance_session_closed', lambda: attendance_status(session() | {'endTime': 'ended'}, NOW))
        self.assert_code('attendance_session_not_started', lambda: attendance_status(session(start=NOW + 1), NOW))
        for fields in ({'policyVersion': True}, {'policyVersion': 2}, {'gracePeriodMinutes': True},
                       {'gracePeriodMinutes': -1}, {'gracePeriodMinutes': 0.5}, {'attendanceWindowMinutes': 241},
                       {'allowLate': 'false'}, {'defaultAttendance': 'unknown'}):
            self.assert_code('attendance_policy_invalid', lambda: attendance_status(session() | fields, NOW))

    def test_legacy_three_hour_policy_and_timestamp_formats(self):
        for start in (datetime.fromtimestamp(NOW / 1000, timezone.utc), '2026-11-05T17:00:00.000Z'):
            row = {'status': 'active', 'startTime': start, 'gracePeriodMinutes': 5}
            instant = start.timestamp() * 1000 if isinstance(start, datetime) else datetime.fromisoformat(start.replace('Z', '+00:00')).timestamp() * 1000
            self.assertEqual(attendance_status(row, instant + 6 * 60000), 'late')
            self.assert_code('attendance_window_closed', lambda: attendance_status(row, instant + 180 * 60000 + 1))
        self.assert_code('attendance_session_not_started', lambda: attendance_status({'status': 'active', 'startTime': 'bad'}, NOW))

    def test_location_freshness_future_mock_and_accuracy_boundaries(self):
        self.assertEqual(location_status(course(), position(capturedAtMs=NOW - 30000), NOW), 'in_zone')
        self.assertEqual(location_status(course(), position(capturedAtMs=NOW + 5000), NOW), 'in_zone')
        self.assertEqual(location_status(course(), position(accuracyMeters=15), NOW), 'in_zone')
        for code, sample in (
            ('location_required', None), ('location_stale', position(capturedAtMs=NOW - 30001)),
            ('location_future', position(capturedAtMs=NOW + 5001)), ('location_mocked', position(mocked=True)),
            ('location_inaccurate', position(accuracyMeters=15.001)),
            ('location_outside_zone', position(latitude=33.001)),
            # Centre is inside; the uncertainty circle extends outside the zone.
            ('location_uncertain', position(latitude=33.0001, accuracyMeters=5)),
        ):
            self.assert_code(code, lambda: location_status(course(), sample, NOW))

    def test_disabled_or_absent_location_and_invalid_enabled_configuration(self):
        self.assert_code('location_policy_invalid', lambda: location_status(course(location=None), None, NOW))
        self.assert_code('location_policy_invalid', lambda: location_status(course(location={'enabled': False}), None, NOW))
        for zone in ({}, False, {'enabled': 'false'}, {'enabled': True, 'latitude': True},
                     {'enabled': True, 'latitude': 33, 'longitude': -97, 'radiusMeters': 16},
                     {'enabled': True, 'latitude': 33, 'longitude': -97, 'radiusMeters': 1.5}):
            self.assert_code('location_policy_invalid', lambda: location_status(course(location=zone), position(), NOW))

    def test_distance_handles_antimeridian_poles_and_identical_coordinates(self):
        self.assertEqual(distance_meters(33, -97, 33, -97), 0)
        self.assertLess(distance_meters(0, 179.99999, 0, -179.99999), 3)
        self.assertLess(distance_meters(90, 0, 90, 180), 0.001)
        self.assertAlmostEqual(distance_meters(0, 0, 0, 1), 111195.08, places=1)


class LockedStore(Store):
    def __init__(self):
        super().__init__()
        self.lock = threading.RLock()

    def transact(self, operation):
        with self.lock:
            return super().transact(operation)


class DatabaseProfiles:
    def __init__(self, db):
        self.db = db

    def read(self, uid):
        with self.db.lock:
            return copy.deepcopy(self.db.data.get(('users', uid), {}))

    def mutate(self, uid, operation):
        with self.db.lock:
            self.db.data['users', uid].update(operation(self.read(uid)) or {})
            return self.read(uid)


class CheckInApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = MobileEnrollmentStore(Path(self.temporary.name) / 'enrollments', encryption_key=b'1' * 32)
        self.store.save_mobile_enrollment(EnrollmentRecord.create(student_uid=UID, vectors=[vector(index).tolist() for index in range(3)]), authenticated_uid=UID)
        self.db = LockedStore()
        self.db.data.update({
            ('users', UID): {'role': 'student', 'faceEnrolled': True, 'optOutFlag': False,
                'faceConsentRevision': 0, 'faceEnrollmentServers': {'test-server': {'state': 'present', 'consentRevision': 0}}},
            ('sessions', SESSION): session(), ('courses', 'different-document-id'): course(),
            ('enrollments', '6_COURSE_student'): {'uid': UID, 'courseId': 'COURSE', 'status': 'active'},
        })
        self.profiles = DatabaseProfiles(self.db)
        self.privacy = FacePrivacyService(self.store, self.profiles, server_id='test-server')
        self.current_time = NOW
        self.embedding_calls = 0
        self.embedding_hook = lambda: None
        self.verification_error = None
        self.token_calls = 0
        parent = self

        class Verifier:
            def verify(self, token):
                parent.token_calls += 1
                if token != 'good' or parent.verification_error:
                    raise AuthenticationError('Token invalid')
                profile = parent.profiles.read(UID)
                if profile.get('role') != 'student':
                    raise StudentAuthorizationError('Student required')
                return AuthenticatedStudent(uid=UID, consent_revision=profile.get('faceConsentRevision', 0),
                    opted_out=profile.get('optOutFlag', False), deletion_pending=profile.get('faceDataDeletionStatus') == 'pending')

        self.verifier = Verifier()

        def embedding(value):
            self.embedding_calls += 1
            self.embedding_hook()
            if value == 'no-face':
                raise NoFaceDetectedError('private image contents')
            if value == 'multiple-faces':
                raise MultipleFacesDetectedError('private image contents')
            if value == 'bad-image':
                raise InvalidImageError('private image contents')
            return vector(10 if value == 'different' else 0)

        self.app = create_mobile_app(enrollment_store=self.store, privacy_service=self.privacy,
            token_verifier=self.verifier, image_decoder=lambda value: base64.b64decode(value).decode(),
            embedding_generator=embedding, attendance_boundary=lambda: (self.db, self.db.transact),
            checkin_clock=lambda: self.current_time)
        self.app.testing = True
        self.client = self.app.test_client()

    def tearDown(self):
        self.temporary.cleanup()

    def body(self, **changes):
        return dict(schemaVersion=1, sessionId=SESSION, image=base64.b64encode(b'same').decode(), location=position()) | changes

    def post(self, body=None, client=None, **kwargs):
        return (client or self.client).post('/attendance/check-in', base_url='https://localhost',
            headers=AUTH, json=self.body() if body is None else body, **kwargs)

    def assert_rejected(self, code, body=None, status=None):
        before = copy.deepcopy(self.db.data)
        response = self.post(body)
        public_code = 'location_unverified' if code in ('location_outside_zone', 'location_uncertain', 'location_inaccurate') else code
        self.assertEqual(response.get_json()['error'], public_code, response.get_json())
        if status:
            self.assertEqual(response.status_code, status)
        self.assertEqual(self.db.data, before)
        return response

    def test_accepts_and_persists_only_normal_metadata_and_private_receipt(self):
        before = {path.name: path.read_bytes() for path in self.store.directory.iterdir()}
        response = self.post()
        self.assertEqual(response.status_code, 200, response.get_json())
        result = validate_check_in_success(response.get_json())
        self.assertEqual(result['status'], 'present')
        self.assertEqual(result['locationStatus'], 'in_zone')
        self.assertFalse(result['duplicate'])
        row = self.db.data['attendance', ATTENDANCE]
        self.assertEqual(row['uid'], UID)
        self.assertEqual(row['membershipId'], '6_COURSE_student')
        self.assertEqual(row['time'], result['recordedAt'])
        self.assertEqual(set(row), {'id', 'uid', 'userId', 'sessionId', 'courseId', 'membershipId', 'status',
            'locationStatus', 'source', 'method', 'time', 'createdAt'})
        self.assertEqual(self.db.data[RECEIPTS, ATTENDANCE]['attendanceId'], ATTENDANCE)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.store.directory.iterdir()})
        self.assertEqual(self.token_calls, 2)

    def test_default_face_pipeline_cleans_duplicates_for_enrollment_and_checkin_but_rejects_two_faces(self):
        results = []
        first = {'embedding': vector().tolist(), 'facial_area': {'x': 70, 'y': 80, 'w': 110, 'h': 140}}
        duplicate = {'embedding': (vector() + vector(1) * 0.1).tolist(),
                     'facial_area': {'x': 71, 'y': 81, 'w': 110, 'h': 140}}
        separate = {'embedding': vector(1).tolist(), 'facial_area': {'x': 250, 'y': 80, 'w': 110, 'h': 140}}
        detector = SimpleNamespace(represent=lambda **kwargs: list(results))
        app = create_mobile_app(enrollment_store=self.store, privacy_service=self.privacy,
            token_verifier=self.verifier, image_decoder=lambda value: np.ones((400, 400, 3), dtype=np.uint8),
            attendance_boundary=lambda: (self.db, self.db.transact), checkin_clock=lambda: self.current_time)
        app.testing = True
        client = app.test_client()
        with patch('faceroll_recognition.engine.DeepFace', detector):
            results[:] = [first, duplicate]
            enrolled = client.post('/enroll', json={'images': [self.body()['image']] * 3},
                headers=AUTH, base_url='https://localhost')
            self.assertEqual(enrolled.status_code, 200, enrolled.get_json())
            before = self.store.load(UID)
            results[:] = [first, separate]
            refused = self.post(client=client)
            self.assertEqual(refused.status_code, 422)
            self.assertEqual(refused.get_json()['error'], 'multiple_faces_detected')
            self.assertNotIn(('attendance', ATTENDANCE), self.db.data)
            refused = client.post('/enroll', json={'images': [self.body()['image']] * 3},
                headers=AUTH, base_url='https://localhost')
            self.assertEqual(refused.status_code, 422)
            self.assertEqual(refused.get_json()['error'], 'multiple_faces_detected')
            self.assertEqual(self.store.load(UID), before)
            results[:] = [first, duplicate]
            # A failed re-enrollment invalidates its receipt, even though the
            # encrypted record is preserved. Complete enrollment before retrying.
            enrolled = client.post('/enroll', json={'images': [self.body()['image']] * 3},
                headers=AUTH, base_url='https://localhost')
            self.assertEqual(enrolled.status_code, 200, enrolled.get_json())
            accepted = self.post(client=client)
            self.assertEqual(accepted.status_code, 200, accepted.get_json())
            self.assertEqual(accepted.get_json()['locationStatus'], 'in_zone')
            self.assertEqual(self.db.data['attendance', ATTENDANCE]['source'], 'phone_face_verification')

    def test_authentication_and_https_are_required(self):
        self.assertEqual(self.client.post('/attendance/check-in', json=self.body(), base_url='https://localhost').status_code, 401)
        self.assertEqual(self.client.post('/attendance/check-in', json=self.body(), headers={'Authorization': 'Bearer bad'}, base_url='https://localhost').status_code, 401)
        result = self.client.post('/attendance/check-in', json=self.body(), headers=AUTH)
        self.assertEqual(result.get_json()['error'], 'https_required')
        # Untrusted forwarded headers cannot manufacture a secure connection.
        result = self.client.post('/attendance/check-in', json=self.body(), headers=AUTH | {'X-Forwarded-Proto': 'https'})
        self.assertEqual(result.get_json()['error'], 'https_required')
        self.assertEqual(self.embedding_calls, 0)

    def test_contract_rejects_client_authority_invalid_locations_and_bad_json(self):
        for changes in ({'uid': 'other'}, {'courseId': 'OTHER'}, {'status': 'present'}, {'locationStatus': 'in_zone'},
                        {'schemaVersion': 2}, {'sessionId': '../bad'}, {'image': 'not-base64!'},
                        {'location': position(latitude=True)}, {'location': position(longitude=float('nan'))}):
            self.assert_rejected('invalid_check_in_request', self.body(**changes), 400)
        result = self.client.post('/attendance/check-in', data='{broken', content_type='application/json', headers=AUTH, base_url='https://localhost')
        self.assertEqual(result.status_code, 400)
        result = self.client.post('/attendance/check-in?latitude=33', json=self.body(), headers=AUTH, base_url='https://localhost')
        self.assertEqual(result.status_code, 400)
        self.assertEqual(self.embedding_calls, 0)

    def test_size_limit_and_image_character_limit_have_no_writes(self):
        self.app.config['MAX_CONTENT_LENGTH'] = 30
        self.assertEqual(self.post().status_code, 413)
        self.assertNotIn(('attendance', ATTENDANCE), self.db.data)

    def test_membership_missing_removed_dropped_or_mismatched_is_rejected_before_inference(self):
        key = ('enrollments', '6_COURSE_student')
        for record in (None, {'uid': UID, 'courseId': 'COURSE', 'status': 'removed'},
                       {'uid': UID, 'courseId': 'COURSE', 'status': 'dropped'},
                       {'uid': 'other', 'courseId': 'COURSE', 'status': 'active'},
                       {'uid': UID, 'courseId': 'OTHER', 'status': 'active'}):
            self.db.data.pop(key, None)
            if record:
                self.db.data[key] = record
            self.assert_rejected('membership_required', status=403)
        self.assertEqual(self.embedding_calls, 0)

    def test_session_and_course_unavailable_or_ambiguous_are_rejected(self):
        for status in ('starting', 'closing', 'closed', 'start_failed'):
            self.db.data['sessions', SESSION]['status'] = status
            self.assert_rejected('attendance_session_closed')
        self.db.data['sessions', SESSION]['status'] = 'active'
        self.db.data['courses', 'duplicate'] = course()
        self.assert_rejected('course_unavailable')
        self.db.data.pop(('courses', 'duplicate'))
        self.db.data.pop(('courses', 'different-document-id'))
        self.assert_rejected('course_unavailable')
        self.assertEqual(self.embedding_calls, 0)

    def test_bad_location_is_rejected_after_face_inference(self):
        for sample, code in ((None, 'location_required'), (position(mocked=True), 'location_mocked'),
                             (position(latitude=0), 'location_outside_zone'), (position(accuracyMeters=30), 'location_inaccurate'),
                             (position(capturedAtMs=NOW - 30001), 'location_stale')):
            self.assert_rejected(code, self.body(location=sample), 403)
        self.assertEqual(self.embedding_calls, 5)

    def test_embedding_comparison_precedes_zone_verification_and_face_failure_skips_it(self):
        events = []
        self.embedding_hook = lambda: events.append('embedding')

        def compare(*args, **kwargs):
            events.append('comparison')
            return verify_embedding(*args, **kwargs)

        def locate(*args, **kwargs):
            events.append('location')
            return location_status(*args, **kwargs)

        with patch('faceroll_recognition.mobile_api.verify_embedding', side_effect=compare), \
                patch('faceroll_recognition.attendance.location_status', side_effect=locate):
            self.assert_rejected('location_unverified', self.body(location=position(latitude=0)), 403)
            self.assertEqual(events, ['embedding', 'comparison', 'location'])
            events.clear()
            self.assert_rejected('face_not_recognized', self.body(
                image=base64.b64encode(b'different').decode(), location=position(latitude=0)), 403)
            self.assertEqual(events, ['embedding', 'comparison'])

    def test_session_zone_stays_fixed_after_the_course_zone_changes(self):
        original = copy.deepcopy(self.db.data['courses', 'different-document-id']['location'])
        self.db.data['sessions', SESSION].update(zonePolicyVersion=1, classroomZone=original)
        self.db.data['courses', 'different-document-id']['location']['latitude'] = 34
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['locationStatus'], 'in_zone')

    def test_new_session_zone_and_invalid_snapshot_versions_fail_closed(self):
        row = self.db.data['sessions', SESSION]
        row.update(zonePolicyVersion=1, classroomZone={**course()['location'], 'latitude': 34})
        self.assert_rejected('location_unverified', status=403)
        for version in (True, 2, '1'):
            self.db.data['sessions', SESSION]['zonePolicyVersion'] = version
            self.assert_rejected('location_policy_invalid', status=409)
        row = self.db.data['sessions', SESSION]
        row['zonePolicyVersion'] = 1
        del row['classroomZone']
        self.assert_rejected('location_policy_invalid', status=409)

    def test_both_modes_require_an_enabled_classroom_zone(self):
        for opted_out in (False, True):
            self.db.data['users', UID]['optOutFlag'] = opted_out
            for zone in (None, {'enabled': False}):
                self.db.data['courses', 'different-document-id']['location'] = zone
                self.assert_rejected('location_policy_invalid', self.body(image=None if opted_out else self.body()['image']), 409)
        self.assertEqual(self.embedding_calls, 2)

    def test_location_failures_never_expose_boundary_or_position_measurements(self):
        cases = (
            (position(latitude=33.0001, accuracyMeters=5), 'location_uncertain',
             dict(distanceMeters=12, accuracyMeters=5, radiusMeters=15)),
            (position(latitude=33.001), 'location_outside_zone',
             dict(distanceMeters=112, accuracyMeters=3, radiusMeters=15)),
            (position(accuracyMeters=16), 'location_inaccurate',
             dict(distanceMeters=0, accuracyMeters=16, radiusMeters=15)),
        )
        for opted_out in (False, True):
            self.db.data['users', UID]['optOutFlag'] = opted_out
            for sample, code, expected in cases:
                response = self.assert_rejected(code, self.body(location=sample,
                    image=None if opted_out else self.body()['image']), 403)
                self.assertEqual(response.get_json()['error'], 'location_unverified')
                self.assertEqual(set(response.get_json()), {'success', 'error', 'message'})
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                for field in ('latitude', 'longitude', 'capturedAtMs', 'image', 'uid'):
                    self.assertNotIn(field, response.get_data(as_text=True))
        self.assertEqual(self.embedding_calls, 3)

    def test_nonmatching_no_face_multiple_faces_and_corrupt_photo_do_not_write(self):
        for image, code in (('different', 'face_not_recognized'), ('no-face', 'no_face_detected'),
                            ('multiple-faces', 'multiple_faces_detected'), ('bad-image', 'invalid_face_image')):
            self.assert_rejected(code, self.body(image=base64.b64encode(image.encode()).decode()))

    def use_location_only(self):
        self.db.data['users', UID].update(optOutFlag=True, faceEnrolled=False, faceConsentRevision=1,
            faceDataDeletionStatus='pending', faceEnrollmentServers={})
        self.store.delete_enrollment(UID, authenticated_uid=UID)

    def test_location_only_needs_no_face_or_enrollment_even_during_deletion(self):
        self.use_location_only()
        with (patch.object(self.store, 'load', side_effect=AssertionError('Must not read a face')),
              patch.object(self.privacy, 'check', side_effect=AssertionError('Must not check facial enrollment'))):
            result = self.post(self.body(image=None))
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assertEqual(result.get_json()['locationStatus'], 'in_zone')
        row = self.db.data['attendance', ATTENDANCE]
        self.assertEqual(row['source'], 'phone_location_verification')
        self.assertEqual(row['method'], 'Phone location verification')
        self.assertEqual(self.embedding_calls, 0)
        self.assertGreaterEqual(self.token_calls, 2)

    def test_location_only_rejects_photo_and_location_failures_before_any_biometrics(self):
        self.use_location_only()
        self.assert_rejected('face_not_allowed', status=400)
        for sample, code in ((None, 'location_required'), (position(latitude=34), 'location_outside_zone'),
                (position(accuracyMeters=100), 'location_inaccurate'), (position(mocked=True), 'location_mocked'),
                (position(capturedAtMs=NOW - 60000), 'location_stale')):
            self.assert_rejected(code, self.body(image=None, location=sample), 403)
        self.assertEqual(self.embedding_calls, 0)

    def test_opted_in_student_cannot_skip_face_even_with_valid_location(self):
        self.assert_rejected('face_required', self.body(image=None), 403)
        self.db.data['users', UID]['faceEnrolled'] = False
        self.assert_rejected('not_enrolled', status=404)
        self.assertEqual(self.embedding_calls, 0)

    def test_location_only_rechecks_token_revocation_before_finalizing(self):
        self.use_location_only()
        original = self.verifier.verify
        def verify(token):
            if self.token_calls:
                raise AuthenticationError('Synthetic token revoked')
            return original(token)
        self.verifier.verify = verify
        self.assert_rejected('authentication_required', self.body(image=None), 401)

    def test_location_only_rechecks_consent_in_transaction_and_never_downgrades(self):
        self.use_location_only()
        original = self.db.transact
        def changed(operation):
            self.db.data['users', UID].update(optOutFlag=False, faceConsentRevision=2)
            return original(operation)
        self.db.transact = changed
        result = self.post(self.body(image=None))
        self.assertEqual(result.get_json()['error'], 'face_preference_changed')
        self.assertNotIn(('attendance', ATTENDANCE), self.db.data)
        self.assertEqual(self.embedding_calls, 0)

    def test_location_only_duplicate_preserves_original_and_does_not_reopen_inference(self):
        self.use_location_only()
        first = self.post(self.body(image=None)).get_json()
        self.db.data['sessions', SESSION]['status'] = 'closed'
        repeated = self.post(self.body(image=None, location=None))
        self.assertEqual(repeated.get_json(), first | {'duplicate': True})
        self.assertEqual(self.embedding_calls, 0)

    def test_missing_enrollment_opt_out_pending_deletion_and_old_receipt_are_rejected(self):
        profile = copy.deepcopy(self.db.data['users', UID])
        for changes, code in (({'optOutFlag': True}, 'face_not_allowed'),
                              ({'faceDataDeletionStatus': 'pending'}, 'face_deletion_pending'),
                              ({'faceConsentRevision': 1, 'faceEnrolled': False}, 'not_enrolled')):
            self.db.data['users', UID] = profile | changes
            self.assert_rejected(code)
        self.db.data['users', UID] = profile
        self.store.delete_enrollment(UID, authenticated_uid=UID)
        self.assert_rejected('not_enrolled', status=404)

    def test_inference_time_does_not_change_sample_receipt_freshness_but_controls_late_status(self):
        self.db.data['sessions', SESSION] = session(start=NOW - 5 * 60000)
        self.embedding_hook = lambda: setattr(self, 'current_time', NOW + 35000)
        result = self.post()
        self.assertEqual(result.status_code, 200, result.get_json())
        self.assertEqual(result.get_json()['status'], 'late')
        self.assertEqual(result.get_json()['recordedAt'], datetime.fromtimestamp((NOW + 35000) / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))

    def test_window_closing_during_inference_is_rejected(self):
        self.embedding_hook = lambda: setattr(self, 'current_time', NOW + 30 * 60000)
        self.assert_rejected('attendance_window_closed')

    def test_final_transaction_checks_enrollment_receipt_after_external_privacy_check(self):
        transact = self.db.transact
        calls = 0
        def change_before_commit(operation):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.db.data['users', UID]['faceEnrollmentServers']['test-server']['state'] = 'deleted'
            return transact(operation)
        self.db.transact = change_before_commit
        result = self.post()
        self.assertEqual(result.get_json()['error'], 'not_enrolled')
        self.assertNotIn(('attendance', ATTENDANCE), self.db.data)

    def test_transaction_retry_rechecks_consent_without_repeating_face_inference(self):
        transact = self.db.transact
        calls = 0
        def retry_after_consent_change(operation):
            nonlocal calls
            calls += 1
            if calls == 1:
                before = copy.deepcopy(self.db.data)
                transact(operation)
                # Simulate Firestore discarding a conflicted attempt and
                # invoking the callback again against the latest profile.
                self.db.data = before
                self.db.data['users', UID].update(optOutFlag=True, faceConsentRevision=1)
            return transact(operation)
        self.db.transact = retry_after_consent_change
        result = self.post()
        self.assertEqual(result.get_json()['error'], 'face_preference_changed')
        self.assertNotIn(('attendance', ATTENDANCE), self.db.data)
        self.assertNotIn((RECEIPTS, ATTENDANCE), self.db.data)
        self.assertEqual(self.embedding_calls, 1)

    def test_default_applied_during_inference_is_not_overwritten(self):
        expected = dict(uid=UID, sessionId=SESSION, courseId='COURSE', status='absent', source='session_default')
        self.embedding_hook = lambda: self.db.data.update({('attendance', ATTENDANCE): expected})
        result = self.post()
        self.assertEqual(result.get_json()['error'], 'attendance_already_recorded')
        self.assertEqual(self.db.data['attendance', ATTENDANCE], expected)
        self.assertNotIn((RECEIPTS, ATTENDANCE), self.db.data)

    def test_end_removal_role_consent_revocation_or_zone_changes_during_inference_are_rechecked(self):
        original = copy.deepcopy(self.db.data)
        cases = (
            (lambda: self.db.data['sessions', SESSION].update(status='closing'), 'attendance_session_closed'),
            (lambda: self.db.data['enrollments', '6_COURSE_student'].update(status='removed'), 'membership_required'),
            (lambda: self.db.data['users', UID].update(role='instructor'), 'student_required'),
            (lambda: self.db.data['users', UID].update(optOutFlag=True, faceConsentRevision=1), 'face_preference_changed'),
            (lambda: setattr(self, 'verification_error', True), 'authentication_required'),
            (lambda: self.db.data['courses', 'different-document-id']['location'].update(latitude=34), 'location_outside_zone'),
            (lambda: self.db.data.pop(('courses', 'different-document-id')), 'course_unavailable'),
            (lambda: self.db.data['sessions', SESSION].update(courseId='OTHER'), 'attendance_session_changed'),
        )
        for hook, code in cases:
            self.db.data = copy.deepcopy(original)
            self.verification_error = None
            self.embedding_hook = hook
            response = self.post()
            public_code = 'location_unverified' if code in ('location_outside_zone', 'location_uncertain', 'location_inaccurate') else code
            self.assertEqual(response.get_json()['error'], public_code, response.get_json())
            self.assertNotIn(('attendance', ATTENDANCE), self.db.data)
            self.assertNotIn((RECEIPTS, ATTENDANCE), self.db.data)

    def test_duplicate_returns_original_even_after_close_without_inference_or_overwrite(self):
        first = self.post().get_json()
        self.db.data['sessions', SESSION].update(status='closed')
        self.current_time += 3600000
        before = copy.deepcopy(self.db.data)
        repeated = self.post(self.body(location=None)).get_json()
        self.assertEqual(repeated, first | {'duplicate': True})
        self.assertEqual(self.db.data, before)
        self.assertEqual(self.embedding_calls, 1)

    def test_defaults_camera_overrides_and_forged_legacy_client_rows_are_never_overwritten(self):
        for source in ('session_default', 'classroom_camera', 'manual_override', 'phone_face_verification'):
            self.db.data['attendance', ATTENDANCE] = dict(uid=UID, sessionId=SESSION, courseId='COURSE', status='present',
                source=source, locationStatus='in_zone', verificationVersion=1)
            self.assert_rejected('attendance_already_recorded', status=409)
        self.assertEqual(self.embedding_calls, 0)

    def test_missing_or_mismatched_receipt_attendance_never_recreates_or_leaks_other_identity(self):
        self.post()
        self.db.data['attendance', ATTENDANCE]['uid'] = 'other'
        self.assert_rejected('attendance_record_conflict')
        self.db.data.pop(('attendance', ATTENDANCE))
        self.assert_rejected('attendance_record_conflict')

    def test_transaction_failure_rolls_back_attendance_and_receipt_and_can_retry(self):
        original = self.db.create
        def fail_second(ref, data):
            if ref.path[0] == RECEIPTS:
                raise RuntimeError('private coordinates, token or photo must not be logged')
            original(ref, data)
        self.db.create = fail_second
        self.assert_rejected('check_in_unavailable', status=503)
        self.db.create = original
        self.assertEqual(self.post().status_code, 200)

    def test_concurrent_requests_create_once_and_return_same_timestamp(self):
        barrier = threading.Barrier(2)
        self.embedding_hook = lambda: barrier.wait(timeout=5)
        def submit():
            with self.app.test_client() as client:
                response = self.post(client=client)
                return response.status_code, response.get_json()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: submit(), range(2)))
        self.assertTrue(all(status == 200 for status, _ in results), results)
        self.assertEqual(sorted(result['duplicate'] for _, result in results), [False, True])
        self.assertEqual(results[0][1]['recordedAt'], results[1][1]['recordedAt'])
        self.assertEqual(len([key for key in self.db.data if key[0] == 'attendance']), 1)
        self.assertEqual(len([key for key in self.db.data if key[0] == RECEIPTS]), 1)

    def test_logging_and_responses_never_include_payload_or_dependency_exception_details(self):
        secret = 'sensitive photo and coordinates -97.123456 33.654321'
        def fail():
            raise RuntimeError(secret)
        self.embedding_hook = fail
        with self.assertLogs(self.app.logger, logging.ERROR) as captured:
            response = self.post()
        self.assertNotIn(secret, json.dumps(response.get_json()))
        self.assertNotIn(secret, '\n'.join(captured.output))
        self.assertNotIn(self.body()['image'], '\n'.join(captured.output))


if __name__ == '__main__':
    unittest.main()
