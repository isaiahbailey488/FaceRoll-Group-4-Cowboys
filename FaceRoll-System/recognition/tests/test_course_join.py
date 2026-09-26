import copy
import unittest
from datetime import datetime, timedelta, timezone

from flask import Flask
from faceroll_recognition.invitations import (
    InvitationError, invitation_blueprint, mutate_invitation, redeem_invitation,
)
from tests.test_invitations import Store


class CourseJoinTests(unittest.TestCase):
    def setUp(self):
        self.db = Store()
        self.db.data['users', 'student'] = {'role': 'student'}
        self.now = datetime.now(timezone.utc)
        self.token = mutate_invitation('teacher', self.db, self.db.transact,
                                       'COURSE', 'create', now=self.now)['qrPayload']['token']

    def redeem(self, join=True, **kwargs):
        return redeem_invitation('student', self.db, self.db.transact, self.token,
                                 join=join, clock=lambda: self.now, **kwargs)

    def test_resolve_displays_course_without_writing_membership(self):
        self.db.data['users', 'teacher']['fullName'] = 'Example Instructor'
        before = copy.deepcopy(self.db.data)
        result = self.redeem(join=False)
        self.assertEqual(result['courseId'], 'COURSE')
        self.assertEqual(result['instructorName'], 'Example Instructor')
        self.assertFalse(result['alreadyJoined'])
        self.assertEqual(self.db.data, before)
        self.assertNotIn(self.token, str(result))

    def test_join_and_duplicate_preserve_one_record_and_timestamp(self):
        result = self.redeem()
        self.assertEqual(result['membershipId'], '6_COURSE_student')
        record = self.db.data['enrollments', result['membershipId']]
        self.assertEqual(record['uid'], 'student')
        self.assertEqual(record['status'], 'active')
        before = copy.deepcopy(self.db.data)
        self.now += timedelta(minutes=5)
        self.assertTrue(self.redeem()['alreadyJoined'])
        self.assertEqual(self.db.data, before)

    def test_wrong_roles_and_missing_profile_cannot_join(self):
        for profile in [{}, {'role': 'instructor'}, {'role': 'admin'}]:
            self.db.data['users', 'student'] = profile
            with self.assertRaises(InvitationError) as error:
                self.redeem()
            self.assertEqual(error.exception.status, 403)

    def test_invalid_unknown_expired_and_revoked_tokens(self):
        original = self.token
        for token in ['', '../bad', 'f' * 64]:
            self.token = token
            with self.assertRaises(InvitationError):
                self.redeem()
        self.token = original
        self.now += timedelta(hours=24)
        with self.assertRaises(InvitationError):
            self.redeem()
        self.now -= timedelta(hours=24)
        mutate_invitation('teacher', self.db, self.db.transact, 'COURSE', 'revoke')
        with self.assertRaises(InvitationError):
            self.redeem()

    def test_replaced_token_rejected_even_if_old_status_is_active(self):
        old = self.db.data['courseInvitationHeads', 'COURSE']['tokenHash']
        mutate_invitation('teacher', self.db, self.db.transact, 'COURSE', 'replace')
        self.db.data['courseInvitations', old]['status'] = 'active'
        with self.assertRaises(InvitationError):
            self.redeem()

    def test_removed_cannot_rejoin_dropped_can(self):
        self.redeem()
        record = self.db.data['enrollments', '6_COURSE_student']
        created = record['createdAt']
        record['status'] = 'removed'
        with self.assertRaises(InvitationError) as error:
            self.redeem()
        self.assertEqual(error.exception.code, 'membership_removed')
        self.db.data['enrollments', '6_COURSE_student']['status'] = 'dropped'
        self.now += timedelta(minutes=1)
        self.redeem()
        self.assertEqual(self.db.data['enrollments', '6_COURSE_student']['createdAt'], created)
        self.assertEqual(self.db.data['enrollments', '6_COURSE_student']['status'], 'active')

    def test_ownership_change_and_ambiguous_course_rejected(self):
        course = self.db.data['courses', 'different-document-id']
        course['instructorId'] = 'other'
        with self.assertRaises(InvitationError):
            self.redeem()
        self.db.data['courses', 'different-document-id']['instructorId'] = 'teacher'
        course = self.db.data['courses', 'different-document-id']
        self.db.data['courses', 'duplicate'] = copy.deepcopy(course)
        with self.assertRaises(InvitationError):
            self.redeem()

    def test_retry_after_concurrent_join_returns_existing_membership(self):
        # Model Firestore retrying our transaction after another join commits.
        before = copy.deepcopy(self.db.data)
        def retry(operation):
            self.db.transact(operation)
            self.db.data = copy.deepcopy(before)
            self.redeem()
            return self.db.transact(operation)
        result = redeem_invitation('student', self.db, retry, self.token, join=True,
                                   clock=lambda: self.now)
        self.assertTrue(result['alreadyJoined'])
        self.assertEqual(sum(c == 'enrollments' for c, _ in self.db.data), 1)

    def test_retry_after_revocation_does_not_commit_membership(self):
        before = copy.deepcopy(self.db.data)
        def retry(operation):
            self.db.transact(operation)
            self.db.data = copy.deepcopy(before)
            mutate_invitation('teacher', self.db, self.db.transact, 'COURSE', 'revoke')
            return self.db.transact(operation)
        with self.assertRaises(InvitationError):
            redeem_invitation('student', self.db, retry, self.token, join=True,
                              clock=lambda: self.now)
        self.assertFalse(any(c == 'enrollments' for c, _ in self.db.data))

    def test_failure_does_not_leave_partial_membership(self):
        self.db.fail_write = True
        before = copy.deepcopy(self.db.data)
        with self.assertRaises(RuntimeError):
            self.redeem()
        self.assertEqual(self.db.data, before)

    def test_http_requires_auth_and_rejects_identity_override(self):
        def boundary(token):
            if token != 'signed':
                raise InvitationError(401, 'invalid_token')
            return 'student', self.db, self.db.transact
        app = Flask(__name__)
        app.register_blueprint(invitation_blueprint(boundary))
        client = app.test_client()
        headers = {'Authorization': 'Bearer signed'}
        for action in ['resolve', 'join']:
            url = '/course-invitations/' + action
            self.assertEqual(client.post(url, json={'token': self.token}).status_code, 401)
            self.assertEqual(client.post(url, headers={'Authorization': 'Bearer bad'}, json={'token': self.token}).status_code, 401)
            for extra in ['uid', 'courseId', 'status']:
                self.assertEqual(client.post(url, headers=headers, json={'token': self.token, extra: 'spoof'}).status_code, 400)
            response = client.post(url, headers=headers, json={'token': self.token})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
