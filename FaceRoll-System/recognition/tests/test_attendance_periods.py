from datetime import datetime, timedelta, timezone

from faceroll_recognition.invitations import attendance_periods, mutate_membership
from tests.test_invitations import Store


def test_removal_and_restoration_preserve_exact_enrollment_gap():
    store = Store()
    joined = '2026-10-01T10:00:00.000Z'
    removed = datetime(2026, 10, 3, 10, tzinfo=timezone.utc)
    restored = removed + timedelta(days=4)
    path = ('enrollments', '6_COURSE_student')
    store.data[path] = dict(schemaVersion=1, uid='student', courseId='COURSE', status='active',
                            createdAt=joined, updatedAt=joined,
                            attendancePeriods=[{'start': joined, 'end': None}])
    mutate_membership('teacher', store, store.transact, 'COURSE', 'student', 'remove', now=removed)
    assert store.data[path]['attendancePeriods'] == [{'start': joined, 'end': '2026-10-03T10:00:00.000Z'}]
    mutate_membership('teacher', store, store.transact, 'COURSE', 'student', 'restore', now=restored)
    assert store.data[path]['attendancePeriods'] == [
        {'start': joined, 'end': '2026-10-03T10:00:00.000Z'},
        {'start': '2026-10-07T10:00:00.000Z', 'end': None},
    ]
    mutate_membership('teacher', store, store.transact, 'COURSE', 'student', 'restore', now=restored + timedelta(days=1))
    assert len(store.data[path]['attendancePeriods']) == 2


def test_legacy_restoration_retains_departure_and_starts_new_period():
    member = dict(status='removed', createdAt='2026-10-01T10:00:00.000Z', updatedAt='2026-10-03T10:00:00.000Z')
    assert attendance_periods(member, '2026-10-07T10:00:00.000Z', True) == [
        {'start': member['createdAt'], 'end': member['updatedAt']},
        {'start': '2026-10-07T10:00:00.000Z', 'end': None},
    ]


def test_new_enrollment_period_starts_at_join_time():
    assert attendance_periods(None, '2026-10-01T10:00:00.000Z', True) == [
        {'start': '2026-10-01T10:00:00.000Z', 'end': None},
    ]
