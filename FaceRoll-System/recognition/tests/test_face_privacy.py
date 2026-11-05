import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from faceroll_recognition import EnrollmentRecord, EnrollmentNotFoundError, MobileEnrollmentStore
from faceroll_recognition.face_privacy import FacePrivacyError, FacePrivacyService, POLICY_FILE
from .privacy_fakes import MemoryFaceProfiles
from .test_mobile_api import (
    AUTHORIZATION, TEST_KEY, FakeTokenVerifier, fake_decoder, fake_embedding_generator,
    unit_vector,
)
from faceroll_recognition.mobile_api import create_mobile_app


UID = 'firebase-uid-123'


class FacePrivacyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = MobileEnrollmentStore(Path(self.temporary.name) / 'a', encryption_key=TEST_KEY)
        self.profiles = MemoryFaceProfiles({UID: {'role': 'student', 'optOutFlag': False}})
        self.privacy = FacePrivacyService(self.store, self.profiles, server_id='a')

    def record(self):
        return EnrollmentRecord.create(student_uid=UID, vectors=[unit_vector(i).tolist() for i in range(3)])

    def enroll(self, service=None, revision=0):
        service = service or self.privacy
        service.begin_enrollment(UID, revision)
        service.save_enrollment(self.record(), revision)

    def client(self, generator=fake_embedding_generator):
        app = create_mobile_app(enrollment_store=self.store, privacy_service=self.privacy,
            token_verifier=FakeTokenVerifier(), image_decoder=fake_decoder, embedding_generator=generator)
        app.testing = True
        return app.test_client()

    def test_opt_out_deletes_encrypted_file_and_confirms_idempotently(self):
        self.enroll()
        self.profiles.opt_out(UID)
        self.assertEqual(self.privacy.delete(UID), (True, 'deleted'))
        self.assertFalse((self.store.directory / (UID + '.json')).exists())
        self.assertEqual(self.privacy.delete(UID), (False, 'deleted'))
        profile = self.profiles.read(UID)
        self.assertFalse(profile['faceEnrolled'])
        self.assertIsNotNone(profile['faceDeletionCompletedAt'])
        self.assertEqual(json.loads((self.store.directory / POLICY_FILE).read_text())['allowedUids'], [])

    def test_multiple_computers_stay_pending_until_offline_computer_reconnects(self):
        second_store = MobileEnrollmentStore(Path(self.temporary.name) / 'b', encryption_key=TEST_KEY)
        second = FacePrivacyService(second_store, self.profiles, server_id='b')
        self.enroll()
        self.enroll(second)
        self.profiles.opt_out(UID)
        self.assertEqual(self.privacy.delete(UID)[1], 'pending')
        self.assertTrue((second_store.directory / (UID + '.json')).exists())
        second.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'deleted')
        self.assertFalse((second_store.directory / (UID + '.json')).exists())

    def test_receipt_failure_recovers_after_restart_even_when_file_already_deleted(self):
        self.enroll()
        self.profiles.opt_out(UID)
        with patch.object(self.profiles, 'mutate', side_effect=ConnectionError('Offline')):
            with self.assertRaises(ConnectionError):
                self.privacy.delete(UID)
        self.assertFalse((self.store.directory / (UID + '.json')).exists())
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'pending')
        restarted = FacePrivacyService(self.store, self.profiles)
        self.assertEqual(restarted.server_id, 'a')
        restarted.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'deleted')

    def test_file_deletion_failure_never_acknowledges_deleted(self):
        self.enroll()
        self.profiles.opt_out(UID)
        with patch.object(self.store, 'delete_enrollment', side_effect=PermissionError('Locked')):
            with self.assertRaises(PermissionError):
                self.privacy.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'pending')
        with self.assertRaises(FacePrivacyError):
            self.privacy.check(UID, 1)
        self.privacy.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'deleted')

    def test_legacy_enrollment_is_registered_and_deleted(self):
        self.store.save_mobile_enrollment(self.record(), authenticated_uid=UID)
        self.privacy.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceEnrollmentServers']['a']['state'], 'present')
        self.profiles.opt_out(UID)
        self.privacy.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'deleted')

    def test_opt_back_in_cannot_reuse_old_file_or_revision(self):
        self.enroll()
        old_data = (self.store.directory / (UID + '.json')).read_bytes()
        self.profiles.opt_out(UID)
        self.privacy.delete(UID)
        self.profiles.values[UID].update(optOutFlag=False, faceConsentRevision=2)
        (self.store.directory / (UID + '.json')).write_bytes(old_data)
        with self.assertRaises(EnrollmentNotFoundError):
            self.privacy.check(UID, 2, existing=True)
        with self.assertRaises(FacePrivacyError):
            self.privacy.save_enrollment(self.record(), 0)
        self.privacy.reconcile()
        self.assertFalse((self.store.directory / (UID + '.json')).exists())
        self.enroll(revision=2)
        self.privacy.check(UID, 2, existing=True)
        self.assertTrue(self.profiles.read(UID)['faceEnrolled'])

    def test_opt_out_blocks_both_endpoints_before_image_processing(self):
        self.profiles.opt_out(UID)
        with patch(__package__ + '.test_mobile_api.fake_embedding_generator') as unused:
            client = self.client(unused)
            for endpoint, payload in [('/enroll', {'images': ['front', 'left', 'right']}),
                                       ('/recognize', {'image': 'same-person'})]:
                response = client.post(endpoint, json=payload, headers=AUTHORIZATION)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json['error'], 'facial_recognition_opted_out')
            unused.assert_not_called()

    def test_opt_out_while_generating_enrollment_never_persists_and_stops_further_samples(self):
        calls = []
        def generate(value):
            calls.append(value)
            self.profiles.opt_out(UID)
            return fake_embedding_generator(value)
        response = self.client(generate).post('/enroll',
            json={'images': ['front', 'left', 'right']}, headers=AUTHORIZATION)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(len(calls), 1)
        self.assertFalse((self.store.directory / (UID + '.json')).exists())
        self.privacy.reconcile()
        self.assertEqual(self.profiles.read(UID)['faceDataDeletionStatus'], 'deleted')

    def test_opt_out_while_recognizing_never_returns_identity(self):
        self.enroll()
        def generate(value):
            self.profiles.opt_out(UID)
            return fake_embedding_generator(value)
        response = self.client(generate).post('/recognize', json={'image': 'same-person'}, headers=AUTHORIZATION)
        self.assertEqual(response.status_code, 403)
        self.assertFalse(response.json['recognized'])
        self.assertIsNone(response.json.get('uid'))

    def test_opted_out_delete_without_enrollment_is_successful_and_repeatable(self):
        self.profiles.opt_out(UID)
        client = self.client()
        for _ in range(2):
            response = client.delete('/enrollment', headers=AUTHORIZATION)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['deletionStatus'], 'deleted')

    def test_unavailable_preferences_block_requests(self):
        self.profiles.available = False
        response = self.client().post('/recognize', json={'image': 'same-person'}, headers=AUTHORIZATION)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json['error'], 'face_preference_unavailable')

    def test_pending_deletion_cannot_enroll_even_if_opt_out_flag_is_cleared(self):
        self.profiles.values[UID].update(faceDataDeletionStatus='pending')
        response = self.client().post('/enroll', json={'images': ['front', 'left', 'right']}, headers=AUTHORIZATION)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json['error'], 'face_deletion_pending')
