"""Server-authoritative attendance. Photos and positions are never persisted."""
from __future__ import annotations

import math
import random
import re
import time
from datetime import datetime, timezone

from .checkin_contract import CheckInContractError, validate_check_in_request, validate_check_in_success
from .face_privacy import FacePrivacyError, consent_revision, require_face_permission


MAX_LOCATION_AGE_MS = 30_000
MAX_LOCATION_FUTURE_MS = 5_000
SAFE_ID = re.compile(r'[A-Za-z0-9_-]{1,200}')
SAFE_UID = re.compile(r'[A-Za-z0-9_-]{1,128}')
RECEIPTS = 'attendanceCheckIns'  # No client rule grants access to this collection.

MESSAGES = {
    'https_required': 'Check-in requires a secure HTTPS connection.',
    'student_required': 'Only authenticated student accounts may check in.',
    'course_unavailable': 'This course is unavailable. Ask your instructor for help.',
    'membership_required': 'You must be actively enrolled in this course.',
    'attendance_session_closed': 'This attendance session has ended or is unavailable.',
    'attendance_session_changed': 'This session changed. Refresh and try again.',
    'attendance_session_not_started': 'This attendance session has not started.',
    'attendance_policy_invalid': 'The session settings are invalid. Ask your instructor to restart it.',
    'attendance_window_closed': 'The attendance check-in window has closed.',
    'attendance_late_disabled': 'The grace period has ended and late check-ins are disabled.',
    'attendance_already_recorded': 'Attendance is already recorded. Refresh or ask your instructor for help.',
    'attendance_record_conflict': 'Attendance has changed. Refresh or ask your instructor for help.',
    'location_policy_invalid': 'Your instructor must enable and save a valid classroom zone before self check-in.',
    'location_required': 'A current location is required for this course.',
    'location_mocked': 'A simulated location cannot be used for check-in.',
    'location_stale': 'Your location is too old. Get a new location and try again.',
    'location_future': 'Your location time is invalid. Check your phone clock and try again.',
    'location_inaccurate': 'Your location is not accurate enough. Get a clearer signal and try again.',
    'location_outside_zone': 'Your location could not be confirmed inside the classroom zone.',
    'location_uncertain': 'Your reported position is inside the zone, but its accuracy estimate overlaps the boundary.',
    'face_not_recognized': 'The photo did not match your enrolled face. Try again or ask your instructor.',
    'face_required': 'Face verification is enabled. Enroll your face and submit a photo with your location.',
    'face_not_allowed': 'Facial recognition is off. Submit only your location, without a photo.',
}


class AttendanceError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(MESSAGES[code])


def now_ms():
    return time.time_ns() // 1_000_000


def _number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _minutes(value, maximum):
    if not _number(value) or int(value) != value or not 0 <= value <= maximum:
        raise AttendanceError(409, 'attendance_policy_invalid')
    return int(value)


def _timestamp_ms(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            return None
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.timestamp() * 1000
    return None


def attendance_status(session, instant):
    """Match the saved JS policy, with legacy sessions limited to three hours."""
    if not session or session.get('status') != 'active' or session.get('endTime'):
        raise AttendanceError(409, 'attendance_session_closed')
    version = session.get('policyVersion', 0)
    if type(version) is not int or version not in (0, 1):
        raise AttendanceError(409, 'attendance_policy_invalid')
    grace = _minutes(session.get('gracePeriodMinutes', 10), 120)
    if version == 1:
        window = _minutes(session.get('attendanceWindowMinutes', 30), 240)
        allow_late = session.get('allowLate', False)
        if type(allow_late) is not bool or session.get('defaultAttendance', 'absent') not in ('present', 'late', 'absent'):
            raise AttendanceError(409, 'attendance_policy_invalid')
        start = session.get('startedAtMs')
    else:
        window, allow_late = 180, True
        start = _timestamp_ms(session.get('startTime'))
    if not _number(start) or not _number(instant) or instant < start:
        raise AttendanceError(409, 'attendance_session_not_started')
    elapsed = instant - start
    if window > 0 and elapsed > window * 60000:
        raise AttendanceError(409, 'attendance_window_closed')
    late = elapsed > grace * 60000
    if late and not allow_late:
        raise AttendanceError(409, 'attendance_late_disabled')
    return 'late' if late else 'present'


def distance_meters(latitude, longitude, other_latitude, other_longitude):
    first, second = math.radians(latitude), math.radians(other_latitude)
    delta_lat = second - first
    delta_lon = math.radians(other_longitude - longitude)
    chord = math.sin(delta_lat / 2) ** 2 + math.cos(first) * math.cos(second) * math.sin(delta_lon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(math.sqrt(min(1, max(0, chord))))


def location_status(course, position, received_at_ms):
    """Evaluate only validated request coordinates, using the current saved zone."""
    zone = course.get('location')
    if zone is None:
        raise AttendanceError(409, 'location_policy_invalid')
    if not isinstance(zone, dict) or type(zone.get('enabled')) is not bool:
        raise AttendanceError(409, 'location_policy_invalid')
    if not zone['enabled']:
        raise AttendanceError(409, 'location_policy_invalid')
    lat, lon, radius = (zone.get(key) for key in ('latitude', 'longitude', 'radiusMeters'))
    if (not all(_number(value) for value in (lat, lon, radius)) or not -90 <= lat <= 90 or
            not -180 <= lon <= 180 or not 1 <= radius <= 15 or int(radius) != radius):
        raise AttendanceError(409, 'location_policy_invalid')
    if position is None:
        raise AttendanceError(403, 'location_required')
    if position['mocked'] is True:
        raise AttendanceError(403, 'location_mocked')
    age = received_at_ms - position['capturedAtMs']
    if age > MAX_LOCATION_AGE_MS:
        raise AttendanceError(403, 'location_stale')
    if age < -MAX_LOCATION_FUTURE_MS:
        raise AttendanceError(403, 'location_future')
    accuracy = position['accuracyMeters']
    distance = distance_meters(lat, lon, position['latitude'], position['longitude'])
    if accuracy > radius:
        raise AttendanceError(403, 'location_inaccurate')
    if distance > radius:
        raise AttendanceError(403, 'location_outside_zone')
    if distance + accuracy > radius:
        raise AttendanceError(403, 'location_uncertain')
    return 'in_zone'


def firebase_attendance_boundary():
    from firebase_admin import firestore
    from google.api_core.exceptions import Aborted
    from .mobile_api import _firestore_client
    client = _firestore_client(firestore)

    def transact(operation):
        # The SDK retries commits using the original transaction's queue slot.
        # Concurrent duplicate requests can exhaust those retries (notably in
        # the emulator). Retry confirmed aborts with a fresh transaction and
        # jitter, including aborts during reads that the SDK does not retry.
        # Do not replay ambiguous transport failures or application errors.
        for attempt in range(3):
            try:
                return firestore.transactional(operation)(client.transaction())
            except (Aborted, ValueError) as error:
                aborted = isinstance(error, Aborted) or isinstance(error.__cause__, Aborted)
                if not aborted or attempt == 2:
                    raise
                time.sleep(random.uniform(0.05, 0.15) * (attempt + 1))
    return client, transact


def _face_permission(profile, revision, server_id):
    require_face_permission(profile, revision)
    receipt = (profile.get('faceEnrollmentServers') or {}).get(server_id)
    if profile.get('faceEnrolled') is not True or not receipt or receipt.get('state') != 'present' or receipt.get('consentRevision') != revision:
        from .errors import EnrollmentNotFoundError
        raise EnrollmentNotFoundError('Fresh face enrollment is required.')


def check_in(student, payload, client, transact, verify_request, *, server_id, received_at_ms, clock=now_ms):
    """Preflight, verify outside transaction locks, then re-read and atomically create.

    verify_request refreshes identity and, only when opted in, verifies the face.
    The transaction callback performs no biometric work and is safe to retry.
    """
    payload = validate_check_in_request(payload)
    uid, session_id = student.uid, payload['sessionId']
    if not isinstance(uid, str) or not SAFE_UID.fullmatch(uid):
        raise AttendanceError(403, 'student_required')
    attendance_id = f'{session_id}_{uid}'
    session_ref = client.collection('sessions').document(session_id)
    profile_ref = client.collection('users').document(uid)
    attendance_ref = client.collection('attendance').document(attendance_id)
    receipt_ref = client.collection(RECEIPTS).document(attendance_id)

    def operation(tx, *, commit, expected_course=None):
        profile = profile_ref.get(transaction=tx).to_dict() or {}
        if (profile.get('role') or profile.get('userType')) != 'student':
            raise AttendanceError(403, 'student_required')
        opted_out = profile.get('optOutFlag')
        if type(opted_out) is not bool:
            raise FacePrivacyError('face_preference_unavailable')
        if opted_out != student.opted_out or consent_revision(profile) != student.consent_revision:
            raise FacePrivacyError('face_preference_changed')
        if opted_out:
            if payload['image'] is not None:
                raise AttendanceError(400, 'face_not_allowed')
        else:
            require_face_permission(profile, student.consent_revision)
            if payload['image'] is None:
                raise AttendanceError(403, 'face_required')
        session = session_ref.get(transaction=tx).to_dict() or {}
        course_id = session.get('courseId')
        if (not isinstance(course_id, str) or not SAFE_ID.fullmatch(course_id) or
                session.get('sessionId', session_id) != session_id):
            raise AttendanceError(409, 'attendance_session_closed')
        if expected_course is not None and course_id != expected_course:
            raise AttendanceError(409, 'attendance_session_changed')
        courses = list(client.collection('courses').where('courseId', '==', course_id).limit(2).stream(transaction=tx))
        if len(courses) != 1:
            raise AttendanceError(409, 'course_unavailable')
        course = courses[0].to_dict()
        owner = course.get('instructorId')
        if not isinstance(owner, str) or not SAFE_UID.fullmatch(owner):
            raise AttendanceError(409, 'course_unavailable')
        instructor = client.collection('users').document(owner).get(transaction=tx).to_dict() or {}
        if (instructor.get('role') or instructor.get('userType')) not in ('instructor', 'admin', 'administrator'):
            raise AttendanceError(409, 'course_unavailable')
        membership_id = f'{len(course_id)}_{course_id}_{uid}'
        membership = client.collection('enrollments').document(membership_id).get(transaction=tx).to_dict() or {}
        if membership.get('uid') != uid or membership.get('courseId') != course_id or membership.get('status') != 'active':
            raise AttendanceError(403, 'membership_required')
        attendance = attendance_ref.get(transaction=tx).to_dict()
        receipt = receipt_ref.get(transaction=tx).to_dict()
        if receipt is not None:
            # Private Admin-only receipts prevent a legacy client write from
            # impersonating a check-in accepted by this endpoint.
            if (receipt.get('uid') != uid or receipt.get('sessionId') != session_id or receipt.get('courseId') != course_id or
                    receipt.get('attendanceId') != attendance_id or not attendance or attendance.get('uid') != uid or
                    attendance.get('sessionId') != session_id or attendance.get('courseId') != course_id):
                raise AttendanceError(409, 'attendance_record_conflict')
            try:
                return validate_check_in_success({**{key: value for key, value in receipt.items() if key != 'uid'}, 'duplicate': True})
            except CheckInContractError:
                raise AttendanceError(409, 'attendance_record_conflict') from None
        if attendance is not None:
            # Camera, default and instructor records remain authoritative.
            raise AttendanceError(409, 'attendance_already_recorded')
        instant = clock()
        status = attendance_status(session, instant)
        if 'zonePolicyVersion' in session:
            if type(session['zonePolicyVersion']) is not int or session['zonePolicyVersion'] != 1 or 'classroomZone' not in session:
                raise AttendanceError(409, 'location_policy_invalid')
            zone_course = {'location': session['classroomZone']}
        else:
            zone_course = course  # Existing sessions keep their legacy behavior.
        if not opted_out:
            _face_permission(profile, student.consent_revision, server_id)
        if not commit:
            return course_id
        # Opted-in requests reach this transaction only after their photo's
        # embedding matches. Never make a location verdict before that match.
        # Receipt-time freshness and the frozen zone are still checked here.
        location = location_status(zone_course, payload['location'], received_at_ms)
        recorded_at = datetime.fromtimestamp(instant / 1000, tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        result = validate_check_in_success(dict(schemaVersion=1, success=True, attendanceId=attendance_id,
            sessionId=session_id, courseId=course_id, status=status, locationStatus=location, recordedAt=recorded_at, duplicate=False))
        # All reads above precede both writes; retries re-evaluate mutable policy.
        tx.create(attendance_ref, dict(id=attendance_id, uid=uid, userId=uid, sessionId=session_id,
            courseId=course_id, membershipId=membership_id, status=status, locationStatus=location,
            source='phone_location_verification' if opted_out else 'phone_face_verification',
            method='Phone location verification' if opted_out else 'Phone face and location verification', time=recorded_at,
            createdAt=recorded_at))
        tx.create(receipt_ref, {key: value for key, value in result.items() if key != 'duplicate'} | {'uid': uid})
        return result

    # Preliminary reads need no locks: the final transaction repeats every
    # authority/policy read. Holding read-write transactions here can contend
    # with another request's token/profile checks before either reaches inference.
    preflight = operation(None, commit=False)
    if isinstance(preflight, dict):
        return preflight
    if verify_request() is not True:
        raise AttendanceError(403, 'face_not_recognized')
    return transact(lambda tx: operation(tx, commit=True, expected_course=preflight))
