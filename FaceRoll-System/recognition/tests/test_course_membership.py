import copy
import unittest
from datetime import datetime, timezone

from flask import Flask

from faceroll_recognition.invitations import (
    InvitationError,
    invitation_blueprint,
    mutate_membership,
)
from tests.test_invitations import Store


class CourseMembershipTests(unittest.TestCase):
    def setUp(self):
        self.db = Store()
        self.created_at = '2026-09-24T12:00:00.000Z'
        self.db.data['enrollments', '6_COURSE_student'] = {
            'schemaVersion': 1,
            'courseId': 'COURSE',
            'uid': 'student',
            'status': 'active',
            'createdAt': self.created_at,
            'updatedAt': self.created_at,
        }
        self.db.data['attendance', 'old-record'] = {
            'courseId': 'COURSE',
            'uid': 'student',
        }
        self.now = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)

    def mutate(self, action, uid='teacher'):
        return mutate_membership(
            uid,
            self.db,
            self.db.transact,
            'COURSE',
            'student',
            action,
            now=self.now,
        )

    def test_owner_removes_and_restores_membership_without_deleting_history(self):
        removed = self.mutate('remove')
        membership = self.db.data['enrollments', '6_COURSE_student']
        self.assertEqual(removed['status'], 'removed')
        self.assertTrue(removed['changed'])
        self.assertEqual(membership['createdAt'], self.created_at)
        self.assertEqual(membership['updatedAt'], '2026-09-30T12:00:00.000Z')
        self.assertIn(('attendance', 'old-record'), self.db.data)

        restored = self.mutate('restore')
        self.assertEqual(restored['status'], 'active')
        self.assertEqual(self.db.data['enrollments', '6_COURSE_student']['status'], 'active')

    def test_repeating_the_same_action_is_idempotent(self):
        self.assertTrue(self.mutate('remove')['changed'])
        self.assertFalse(self.mutate('remove')['changed'])

    def test_non_owner_student_and_missing_membership_are_rejected_atomically(self):
        self.db.data['users', 'other'] = {'role': 'instructor'}
        self.db.data['users', 'student'] = {'role': 'student'}
        before = copy.deepcopy(self.db.data)
        for uid in ('other', 'student'):
            with self.assertRaises(InvitationError):
                self.mutate('remove', uid=uid)
            self.assertEqual(self.db.data, before)
        del self.db.data['enrollments', '6_COURSE_student']
        with self.assertRaises(InvitationError) as error:
            self.mutate('remove')
        self.assertEqual(error.exception.code, 'membership_not_found')

    def test_http_requires_auth_and_accepts_only_the_action_body(self):
        def boundary(token):
            if token != 'valid':
                raise InvitationError(401, 'invalid_token')
            return 'teacher', self.db, self.db.transact

        app = Flask(__name__)
        app.register_blueprint(invitation_blueprint(boundary))
        client = app.test_client()
        url = '/courses/COURSE/members/student'
        self.assertEqual(client.post(url, json={'action': 'remove'}).status_code, 401)
        self.assertEqual(client.post(url, headers={'Authorization': 'Bearer valid'}, json={}).status_code, 400)
        response = client.post(
            url,
            headers={'Authorization': 'Bearer valid'},
            json={'action': 'remove'},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['status'], 'removed')


if __name__ == '__main__':
    unittest.main()
