import copy
import hashlib
import unittest
from datetime import datetime, timedelta, timezone
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

    def mutate(self, action='create', uid='teacher', course='COURSE', **kwargs):
        return mutate_invitation(uid, self.db, self.db.transact, course, action, now=self.now, **kwargs)

    def test_create_hash_index_and_private_reopening_token(self):
        result = self.mutate()
        token = result['qrPayload']['token']
        self.assertRegex(token, r'^[a-f0-9]{64}$')
        digest = hashlib.sha256(token.encode()).hexdigest()
        record = self.db.data['courseInvitations', digest]
        self.assertEqual(set(record), {'schemaVersion', 'courseId', 'createdBy', 'tokenHash', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'expiration'})
        self.assertEqual(record['expiresAt'], '2026-09-25T12:00:00.000Z')
        self.assertNotIn(token, str(record))
        self.assertEqual(self.db.data['courseInvitationHeads', 'COURSE']['token'], token)
        self.assertEqual(result['status'], 'active')
        self.assertTrue(result['canReopen'])

    def test_reopening_from_persisted_store_preserves_token_expiry_and_all_records(self):
        created = self.mutate()
        self.now += timedelta(hours=1)
        # A new request with no browser state needs only persisted server data.
        before = copy.deepcopy(self.db.data)
        reopened = self.mutate('view')
        self.assertEqual(reopened, created)
        self.assertEqual(self.db.data, before)

    def test_empty_view_does_not_create_invitation(self):
        before = copy.deepcopy(self.db.data)
        self.assertEqual(self.mutate('view')['status'], 'none')
        self.assertEqual(self.db.data, before)

    def test_short_expiry_update_and_renew_keep_same_qr_and_membership(self):
        created = self.mutate(expiration='2h')
        self.assertEqual(created['expiresAt'], '2026-09-24T14:00:00.000Z')
        self.db.data['enrollments', 'existing'] = {'status': 'active', 'courseId': 'COURSE'}
        head = copy.deepcopy(self.db.data['courseInvitationHeads', 'COURSE'])
        self.now += timedelta(hours=2)
        expired = self.mutate('view')
        self.assertEqual(expired['status'], 'expired')
        self.assertIsNone(expired['qrPayload'])
        with self.assertRaises(InvitationError) as error:
            self.mutate('update_expiration', expiration='never')
        self.assertEqual(error.exception.code, 'invitation_expired')
        renewed = self.mutate('renew', expiration='never')
        self.assertEqual(renewed['qrPayload'], created['qrPayload'])
        self.assertIsNone(renewed['expiresAt'])
        self.assertEqual(renewed['status'], 'active')
        self.now += timedelta(days=365)
        self.assertEqual(self.mutate('view'), renewed)
        updated = self.mutate('update_expiration', expiration='24h')
        self.assertEqual(updated['qrPayload'], created['qrPayload'])
        self.assertEqual(updated['expiresAt'], '2027-09-25T14:00:00.000Z')
        self.assertEqual(self.db.data['courseInvitationHeads', 'COURSE'], head)
        self.assertEqual(self.db.data['enrollments', 'existing']['status'], 'active')
        with self.assertRaises(InvitationError) as error:
            self.mutate('renew', expiration='2h')
        self.assertEqual(error.exception.code, 'invitation_not_expired')

    def test_legacy_invitation_is_not_silently_replaced(self):
        created = self.mutate()
        head = self.db.data['courseInvitationHeads', 'COURSE']
        head.pop('token')
        self.db.data['courseInvitations', head['tokenHash']].pop('expiration')
        before = copy.deepcopy(self.db.data)
        result = self.mutate('view')
        self.assertFalse(result['canReopen'])
        self.assertIsNone(result['qrPayload'])
        self.assertEqual(result['status'], 'active')
        self.assertEqual(self.db.data, before)
        with self.assertRaises(InvitationError):
            self.mutate('update_expiration', expiration='never')
        replacement = self.mutate('replace')
        self.assertNotEqual(replacement['qrPayload'], created['qrPayload'])
        self.assertTrue(self.mutate('view')['canReopen'])

    def test_mismatched_saved_token_is_never_returned(self):
        self.mutate()
        self.db.data['courseInvitationHeads', 'COURSE']['token'] = 'f' * 64
        viewed = self.mutate('view')
        self.assertFalse(viewed['canReopen'])
        self.assertIsNone(viewed['qrPayload'])

    def test_invalid_expirations_and_failed_update_preserve_state(self):
        self.mutate()
        before = copy.deepcopy(self.db.data)
        for expiration in [None, '', '1h', 2, True, [], {}]:
            with self.assertRaises(InvitationError) as error:
                self.mutate('update_expiration', expiration=expiration)
            self.assertEqual(error.exception.code, 'invalid_expiration')
            self.assertEqual(self.db.data, before)
        self.db.fail_write = True
        with self.assertRaises(RuntimeError):
            self.mutate('update_expiration', expiration='never')
        self.assertEqual(self.db.data, before)

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
            for action in ['view', 'create', 'replace', 'revoke', 'update_expiration', 'renew']:
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

    def test_http_owner_only_reopening_and_expiration_contract(self):
        self.db.data['users', 'other'] = {'role': 'instructor'}
        self.db.data['users', 'student'] = {'role': 'student'}
        def boundary(token):
            return token, self.db, self.db.transact
        app = Flask(__name__)
        app.register_blueprint(invitation_blueprint(boundary))
        client = app.test_client()
        url = '/courses/COURSE/invitations'
        headers = {'Authorization': 'Bearer teacher'}
        self.assertEqual(client.get(url).status_code, 401)
        for uid in ['other', 'student']:
            self.assertEqual(client.get(url, headers={'Authorization': 'Bearer ' + uid}).status_code, 403)
        self.assertEqual(client.get(url, headers=headers).json['status'], 'none')
        created = client.post(url, headers=headers, json={'action': 'create', 'expiration': 'never'})
        self.assertEqual(created.status_code, 200)
        before = copy.deepcopy(self.db.data)
        reopened = client.get(url, headers=headers)
        self.assertEqual(reopened.json, created.json)
        self.assertEqual(reopened.headers['Cache-Control'], 'no-store')
        self.assertEqual(self.db.data, before)
        for payload in [{'action': 'view'}, {'action': 'update_expiration'}, {'action': 'renew'},
                        {'action': 'revoke', 'expiration': 'never'},
                        {'action': 'update_expiration', 'expiration': None},
                        {'action': 'update_expiration', 'expiration': 'never', 'uid': 'teacher'}]:
            self.assertEqual(client.post(url, headers=headers, json=payload).status_code, 400)
        updated = client.post(url, headers=headers, json={'action': 'update_expiration', 'expiration': '2h'})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json['qrPayload'], created.json['qrPayload'])
        self.assertIsNotNone(updated.json['expiresAt'])
        client.post(url, headers=headers, json={'action': 'revoke'})
        self.assertEqual(client.get(url, headers=headers).json['status'], 'none')

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
            self.assertIn('GET', response.headers['Access-Control-Allow-Methods'])
            self.assertEqual(client.get(url, headers={'Origin': 'https://untrusted.example'}).status_code, 403)
            response = client.options(url, headers={'Origin': 'https://untrusted.example'})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn('Access-Control-Allow-Origin', response.headers)

    def test_configured_demo_network_origin_supports_authenticated_get_preflight(self):
        app = Flask(__name__)
        app.register_blueprint(invitation_blueprint())
        client = app.test_client()
        origin = 'http://192.168.1.71:5002'
        with patch.dict('os.environ', {'FACEROLL_DASHBOARD_ORIGINS': origin}, clear=True):
            response = client.options('/courses/COURSE/invitations', headers={
                'Origin': origin, 'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'authorization',
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], origin)
            self.assertIn('GET', response.headers['Access-Control-Allow-Methods'])
            self.assertEqual(client.options('/courses/COURSE/invitations', headers={
                'Origin': 'http://192.168.1.72:5002',
            }).status_code, 403)


if __name__ == '__main__':
    unittest.main()
