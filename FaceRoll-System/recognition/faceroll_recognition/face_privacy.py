"""Consent enforcement and durable, per-computer enrollment deletion receipts."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from .errors import EnrollmentNotFoundError, StorageError

SAFE_UID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
POLICY_FILE = '.face-privacy-policy'
POLICY_SECONDS = 8


class FacePrivacyError(Exception):
    def __init__(self, code='facial_recognition_opted_out'):
        self.code = code
        super().__init__(code)


def consent_revision(profile):
    value = profile.get('faceConsentRevision', 0)
    if type(value) is not int or value < 0:
        raise FacePrivacyError('face_preference_unavailable')
    return value


def require_face_permission(profile, revision=None):
    if not profile or (profile.get('role') or profile.get('userType')) != 'student':
        raise FacePrivacyError('face_preference_unavailable')
    if profile.get('optOutFlag', False) is not False:
        raise FacePrivacyError()
    if profile.get('faceDataDeletionStatus') == 'pending':
        raise FacePrivacyError('face_deletion_pending')
    current = consent_revision(profile)
    if revision is not None and revision != current:
        raise FacePrivacyError('face_preference_changed')
    return current


class FirebaseFaceProfiles:
    """All receipts are written by Admin SDK, never by an untrusted client."""
    def _client(self):
        import firebase_admin
        from firebase_admin import firestore
        from .mobile_api import _firebase_app_options, _firestore_client
        try:
            firebase_admin.get_app()
        except ValueError:
            firebase_admin.initialize_app(options=_firebase_app_options())
        return _firestore_client(firestore)

    def read(self, uid):
        return self._client().collection('users').document(uid).get().to_dict() or {}

    def read_many(self, uids):
        client = self._client()
        refs = [client.collection('users').document(uid) for uid in uids]
        return {snapshot.id: snapshot.to_dict() or {} for snapshot in client.get_all(refs)} if refs else {}

    def mutate(self, uid, operation):
        from firebase_admin import firestore
        client = self._client()
        ref = client.collection('users').document(uid)

        @firestore.transactional
        def transaction(tx):
            profile = ref.get(transaction=tx).to_dict() or {}
            changes = operation(profile)
            if changes:
                tx.update(ref, changes)
            return {**profile, **(changes or {})}
        return transaction(client.transaction())


class FacePrivacyService:
    """One service per enrollment directory; serializes local writes and cleanup."""
    def __init__(self, store, profiles, *, server_id=None):
        self.store, self.profiles = store, profiles
        self._mutex = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._state_path = store.directory / '.face-privacy-state'
        store._ensure_directory_for_write()
        if self._state_path.is_symlink():
            raise StorageError('Privacy state must not be a symbolic link.')
        if self._state_path.exists():
            state = json.loads(self._state_path.read_text(encoding='utf-8'))
            self.server_id = state['serverId']
            self._tracked = set(state['trackedUids'])
        else:
            self.server_id = server_id or uuid.uuid4().hex
            self._tracked = set()
        if not SAFE_UID.fullmatch(self.server_id) or any(not SAFE_UID.fullmatch(uid) for uid in self._tracked):
            raise StorageError('Invalid local privacy state.')
        self._persist()

    def _atomic_json(self, path, payload):
        if path.is_symlink():
            raise StorageError('Privacy files must not be symbolic links.')
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('x', encoding='utf-8') as stream:
                json.dump(payload, stream)
                stream.flush()
                os.fsync(stream.fileno())
            if os.name == 'posix':
                temporary.chmod(0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _persist(self):
        self._atomic_json(self._state_path, {'serverId': self.server_id, 'trackedUids': sorted(self._tracked)})

    def _track(self, uid):
        if not SAFE_UID.fullmatch(uid):
            raise FacePrivacyError('face_preference_unavailable')
        if uid not in self._tracked:
            self._tracked.add(uid)
            self._persist()

    def _receipt(self, uid, state, *, revision=None, enrolled=False):
        def update(profile):
            if revision is not None:
                require_face_permission(profile, revision)
            if not profile:
                raise FacePrivacyError('face_preference_unavailable')
            current = consent_revision(profile)
            servers = dict(profile.get('faceEnrollmentServers') or {})
            servers[self.server_id] = {'state': state, 'consentRevision': current}
            changes = {'faceEnrollmentServers': servers}
            if enrolled:
                changes['faceEnrolled'] = True
                changes['faceDataDeletionStatus'] = 'none'
            if state == 'deleted':
                changes['faceEnrolled'] = False
                if profile.get('optOutFlag') is True:
                    complete = all(item.get('state') == 'deleted' and item.get('consentRevision') == current
                                   for item in servers.values())
                    changes['faceDataDeletionStatus'] = 'deleted' if complete else 'pending'
                    if complete:
                        if profile.get('faceDataDeletionStatus') != 'deleted':
                            from datetime import datetime, timezone
                            changes['faceDeletionCompletedAt'] = datetime.now(timezone.utc)
            if all(profile.get(key) == value for key, value in changes.items()):
                return {}
            return changes
        return self.profiles.mutate(uid, update)

    def begin_enrollment(self, uid, revision):
        with self._mutex:
            self._track(uid)
            # Register before creating data, so opt-out knows this computer exists.
            self._receipt(uid, 'enrolling', revision=revision)

    def save_enrollment(self, record, revision):
        with self._mutex:
            require_face_permission(self.profiles.read(record.student_uid), revision)
            self.store.save_mobile_enrollment(record, authenticated_uid=record.student_uid)
            try:
                self._receipt(record.student_uid, 'present', revision=revision, enrolled=True)
            except Exception:
                self.store.delete_enrollment(record.student_uid, authenticated_uid=record.student_uid)
                raise

    def check(self, uid, revision, *, existing=False):
        profile = self.profiles.read(uid)
        require_face_permission(profile, revision)
        if existing:
            if revision > 0 and profile.get('faceEnrolled') is not True:
                raise EnrollmentNotFoundError('Fresh face enrollment is required.')
            receipt = (profile.get('faceEnrollmentServers') or {}).get(self.server_id)
            if revision == 0 and receipt is None:
                with self._mutex:
                    self._track(uid)
                    self._receipt(uid, 'present', revision=0)
            elif not receipt or receipt.get('state') != 'present' or receipt.get('consentRevision') != revision:
                raise EnrollmentNotFoundError('Fresh face enrollment is required.')

    def delete(self, uid, *, publish=True):
        with self._mutex:
            self._track(uid)
            # Keep the durable UID even if the file is gone and the cloud receipt fails.
            profile = self.profiles.read(uid)
            if not profile:
                raise FacePrivacyError('face_preference_unavailable')
            deleted = self.store.delete_enrollment(uid, authenticated_uid=uid)
            profile = self._receipt(uid, 'deleted')
            if publish:
                self.publish_policy()
            return deleted, profile.get('faceDataDeletionStatus', 'pending') if profile.get('optOutFlag') is True else 'none'

    def publish_policy(self):
        with self._mutex:
            uids = self._tracked | {path.stem for path in self.store.directory.glob('*.json') if SAFE_UID.fullmatch(path.stem)}
            profiles = self.profiles.read_many(uids)
            allowed = []
            for uid, profile in profiles.items():
                try:
                    revision = require_face_permission(profile)
                    receipt = (profile.get('faceEnrollmentServers') or {}).get(self.server_id)
                    if (revision == 0 and receipt is None) or (receipt and receipt.get('state') == 'present' and receipt.get('consentRevision') == revision):
                        allowed.append(uid)
                except FacePrivacyError:
                    pass
            self._atomic_json(self.store.directory / POLICY_FILE,
                              {'allowedUids': allowed, 'validUntil': time.time() + POLICY_SECONDS})

    def reconcile(self):
        with self._mutex:
            local = {path.stem for path in self.store.directory.glob('*.json') if SAFE_UID.fullmatch(path.stem)}
            uids = local | self._tracked
            profiles = self.profiles.read_many(uids)
            for uid in uids:
                profile = profiles.get(uid, {})
                if not profile:
                    continue
                if profile.get('optOutFlag') is True:
                    receipt = (profile.get('faceEnrollmentServers') or {}).get(self.server_id, {})
                    if uid in local or receipt.get('state') != 'deleted' or receipt.get('consentRevision') != consent_revision(profile):
                        self.delete(uid, publish=False)
                elif uid in local:
                    revision = consent_revision(profile)
                    receipt = (profile.get('faceEnrollmentServers') or {}).get(self.server_id)
                    if revision == 0 and receipt is None:
                        self._track(uid)
                        self._receipt(uid, 'present', revision=0)
                    elif not receipt or receipt.get('state') != 'present' or receipt.get('consentRevision') != revision:
                        self.delete(uid, publish=False)
            self.publish_policy()

    def start(self):
        def run():
            while not self._stop.is_set():
                try:
                    self.reconcile()
                except Exception:
                    # A stale/missing policy disables classroom matching; no private data is logged.
                    try:
                        self._atomic_json(self.store.directory / POLICY_FILE, {'allowedUids': [], 'validUntil': 0})
                    except Exception:
                        pass
                self._stop.wait(2)
        self._thread = threading.Thread(target=run, name='face-privacy-cleanup', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
