from copy import deepcopy
import threading

class MemoryFaceProfiles:
    def __init__(self, profiles=None):
        self.values = profiles or {}
        self.lock = threading.RLock()
        self.available = True

    def read(self, uid):
        if not self.available:
            raise ConnectionError('Offline')
        with self.lock:
            return deepcopy(self.values.get(uid, {}))

    def read_many(self, uids):
        return {uid: self.read(uid) for uid in uids}

    def mutate(self, uid, operation):
        with self.lock:
            changes = operation(self.read(uid))
            self.values[uid].update(deepcopy(changes or {}))
            return self.read(uid)

    def opt_out(self, uid):
        with self.lock:
            profile = self.values[uid]
            profile.update(optOutFlag=True, faceEnrolled=False,
                faceConsentRevision=profile.get('faceConsentRevision', 0) + 1,
                faceDataDeletionStatus='pending')
