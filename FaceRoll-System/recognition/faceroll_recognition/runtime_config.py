"""Prevent mixing production authentication with an emulator database."""
import os


def firebase_environment(environment=None):
    values = os.environ if environment is None else environment
    auth = values.get('FIREBASE_AUTH_EMULATOR_HOST', '')
    firestore = values.get('FIRESTORE_EMULATOR_HOST', '')
    mode = values.get('FACEROLL_FIREBASE_MODE') or ('emulator' if auth or firestore else 'production')
    if mode not in ('emulator', 'production'):
        raise ValueError('FACEROLL_FIREBASE_MODE must be emulator or production.')
    if mode == 'production' and (auth or firestore or values.get('FACEROLL_DEMO_MODE') == '1'):
        raise ValueError('Production mode cannot include Firebase emulator configuration.')
    if mode == 'emulator':
        if not auth or not firestore:
            raise ValueError('Configure both Auth and Firestore emulators together.')
        if not any(values.get(name) for name in ('GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID')):
            raise ValueError('Emulator mode requires a Firebase project ID.')
    return mode
