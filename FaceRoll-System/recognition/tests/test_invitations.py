import copy
import hashlib
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from flask import Flask
from faceroll_recognition.invitations import InvitationError, firebase_boundary, invitation_blueprint, mutate_invitation


class Snapshot:
    def __init__(self, data, reference=None):
        self.data = copy.deepcopy(data)
        self.exists = data is not None
        self.reference = reference

    def to_dict(self):
        return self.data


class Ref:
    def __init__(self, db, path):
        self.db, self.path = db, path

    def get(self, transaction):
        if transaction.writing:
            raise AssertionError('Read after write')
        return Snapshot(self.db.data.get(self.path), self)


class Collection:
    def __init__(self, db, name):
        self.db, self.name = db, name

    def document(self, key):
        return Ref(self.db, (self.name, key))

    def where(self, field, operator, value):
        self.field, self.value = field, value
        return self

    def limit(self, count):
        self.count = count
        return self

    def stream(self, transaction):
        if transaction.writing:
            raise AssertionError('Read after write')
        return [Snapshot(v, Ref(self.db, (collection, key))) for (collection, key), v in self.db.data.items()
                if collection == self.name and v.get(self.field) == self.value][:self.count]


class Store:
    def __init__(self):
        self.data = {('users', 'teacher'): {'role': 'instructor'},
                     ('courses', 'different-document-id'): {'courseId': 'COURSE', 'instructorId': 'teacher'}}
        self.writing = False
        self.fail_write = False

    def collection(self, name):
        return Collection(self, name)

    def transact(self, operation):
        original = copy.deepcopy(self.data)
        self.writing = False
        try:
            return operation(self)
        except Exception:
            self.data = original
            raise

    def set(self, ref, data):
        self.writing = True
        if self.fail_write:
            raise RuntimeError('Storage failure')
        self.data[ref.path] = copy.deepcopy(data)

    def create(self, ref, data):
        if ref.path in self.data:
            raise AssertionError('Overwrite')
        self.set(ref, data)

    def update(self, ref, data):
        self.set(ref, {**self.data[ref.path], **data})

    def delete(self, ref):
        self.writing = True
        self.data.pop(ref.path, None)


class InvitationTests(unittest.TestCase):
    def setUp(self):
        self.db = Store()
        self.now = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)

    def mutate(self, action='create', uid='teacher', course='COURSE'):
        return mutate_invitation(uid, self.db, self.db.transact, course, action, now=self.now)

    def test_create_hash_only_and_contract(self):
        result = self.mutate()
        token = result['qrPayload']['token']
        self.assertRegex(token, r'^[a-f0-9]{64}$')
        digest = hashlib.sha256(token.encode()).hexdigest()
        record = self.db.data['courseInvitations', digest]
        self.assertEqual(set(record), {'schemaVersion', 'courseId', 'createdBy', 'tokenHash', 'status', 'createdAt', 'updatedAt', 'expiresAt'})
        self.assertEqual(record['expiresAt'], '2026-09-25T12:00:00.000Z')
        self.assertNotIn(token, str(self.db.data))

    def test_duplicate_create_does_not_change_existing_invitation(self):
        self.mutate()
        before = copy.deepcopy(self.db.data)
        with self.assertRaises(InvitationError) as error:
            self.mutate()
        self.assertEqual(error.exception.code, 'invitation_exists')
        self.assertEqual(self.db.data, before)

    def test_replace_revokes_old_and_points_to_new(self):
        self.mutate()
        old = self.db.data['courseInvitationHeads', 'COURSE']['tokenHash']
        self.mutate('replace')
        new = self.db.data['courseInvitationHeads', 'COURSE']['tokenHash']
        self.assertNotEqual(old, new)
        self.assertEqual(self.db.data['courseInvitations', old]['status'], 'revoked')
        self.assertEqual(self.db.data['courseInvitations', new]['status'], 'active')

    def test_revoke_is_idempotent(self):
        self.mutate()
        self.assertTrue(self.mutate('revoke')['revoked'])
        self.assertFalse(self.mutate('revoke')['revoked'])
        self.assertNotIn(('courseInvitationHeads', 'COURSE'), self.db.data)

    def test_unauthorized_roles_and_other_instructors(self):
        for role in ['student', 'instructor', 'administrator']:
            self.db.data['users', 'outsider'] = {'role': role}
            before = copy.deepcopy(self.db.data)
            for action in ['create', 'replace', 'revoke']:
                with self.assertRaises(InvitationError) as error:
                    self.mutate(action, uid='outsider')
                self.assertEqual(error.exception.status, 403)
                self.assertEqual(self.db.data, before)

    def test_missing_ambiguous_and_invalid_courses(self):
        for course in ['MISSING', '../bad', '']:
            with self.assertRaises(InvitationError):
                self.mutate(course=course)
        self.db.data['courses', 'duplicate'] = {'courseId': 'COURSE', 'instructorId': 'teacher'}
        with self.assertRaises(InvitationError) as error:
            self.mutate()
        self.assertEqual(error.exception.code, 'ambiguous_course')

    def test_failed_replacement_rolls_back(self):
        self.mutate()
        before = copy.deepcopy(self.db.data)
        original = self.db.create
        def fail(ref, data):
            raise RuntimeError('Failure after old invitation update')
        self.db.create = fail
        with self.assertRaises(RuntimeError):
            self.mutate('replace')
        self.assertEqual(self.db.data, before)
        self.db.create = original

    def test_collision_does_not_overwrite(self):
        with patch('faceroll_recognition.invitations.secrets.token_hex', return_value='a' * 64):
            self.mutate()
            before = copy.deepcopy(self.db.data)
            with self.assertRaises(InvitationError) as error:
                self.mutate('replace')
            self.assertEqual(error.exception.code, 'token_collision')
            self.assertEqual(self.db.data, before)

    def test_transaction_retry_rechecks_changed_ownership(self):
        before = copy.deepcopy(self.db.data)
        def retry(operation):
            self.db.transact(operation)
            self.db.data = copy.deepcopy(before)
            self.db.data['courses', 'different-document-id']['instructorId'] = 'new-owner'
            return self.db.transact(operation)
        with self.assertRaises(InvitationError) as error:
            mutate_invitation('teacher', self.db, retry, 'COURSE', 'create', now=self.now)
        self.assertEqual(error.exception.code, 'course_owner_required')
        self.assertFalse(any(collection == 'courseInvitations' for collection, key in self.db.data))

    def test_http_auth_validation_and_no_store(self):
        def boundary(token):
            if token != 'valid':
                raise InvitationError(401, 'invalid_token')
            return 'teacher', self.db, self.db.transact
        app = Flask(__name__)
        app.register_blueprint(invitation_blueprint(boundary))
        client = app.test_client()
        url = '/courses/COURSE/invitations'
        headers = {'Authorization': 'Bearer valid'}
        self.assertEqual(client.post(url, json={'action': 'create'}).status_code, 401)
        self.assertEqual(client.post(url, headers={'Authorization': 'Bearer bad'}, json={'action': 'create'}).status_code, 401)
        for payload in [{'action': 'create', 'uid': 'teacher'}, {}, [], {'action': 'unknown'}]:
            self.assertEqual(client.post(url, headers=headers, json=payload).status_code, 400)
        self.assertEqual(client.post(url, headers=headers, data='x' * 1025).status_code, 413)
        response = client.post(url, headers=headers, json={'action': 'create'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.db.fail_write = True
        response = client.post(url, headers=headers, json={'action': 'replace'})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('Storage failure', response.get_data(as_text=True))

    def test_firebase_boundary_verifies_revocation_and_uses_token_identity(self):
        with patch('firebase_admin.get_app'), \
             patch('firebase_admin.auth.verify_id_token', return_value={'uid': 'teacher'}) as verify, \
             patch('faceroll_recognition.mobile_api._firestore_client', return_value=self.db):
            uid, client, transact = firebase_boundary('signed-token')
            verify.assert_called_once_with('signed-token', check_revoked=True)
            self.assertEqual(uid, 'teacher')
            self.assertIs(client, self.db)
        with patch('firebase_admin.get_app'), \
             patch('firebase_admin.auth.verify_id_token', side_effect=ValueError('expired')):
            with self.assertRaises(InvitationError) as error:
                firebase_boundary('expired-token')
            self.assertEqual(error.exception.status, 401)

    def test_browser_origins_are_restricted_and_preflight_needs_no_token(self):
        app = Flask(__name__)
        app.register_blueprint(invitation_blueprint())
        client = app.test_client()
        with patch.dict('os.environ', {'FACEROLL_DASHBOARD_ORIGINS': 'https://dashboard.example'}, clear=True):
            url = '/courses/COURSE/invitations'
            response = client.options(url, headers={'Origin': 'https://dashboard.example'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://dashboard.example')
            response = client.options(url, headers={'Origin': 'https://untrusted.example'})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn('Access-Control-Allow-Origin', response.headers)


if __name__ == '__main__':
    unittest.main()
