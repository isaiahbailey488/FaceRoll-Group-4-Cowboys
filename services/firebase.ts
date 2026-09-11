import { initializeApp, getApps, getApp } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import {
  connectAuthEmulator,
  initializeAuth,
  // @ts-ignore
  getReactNativePersistence,
  getAuth,
} from 'firebase/auth';
import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey: 'AIzaSyC7-sfwN9Nh_6gUXMg8UtVLFSO5G0nf8zw',
  authDomain: 'rollcall-2669b.firebaseapp.com',
  projectId: 'rollcall-2669b',
  storageBucket: 'rollcall-2669b.firebasestorage.app',
  messagingSenderId: '635117933674',
  appId: '1:635117933674:web:47f7aaa4a4f30de87a2613',
  measurementId: 'G-97VJMSSGKJ',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

let _auth: any;
try {
  if (typeof getReactNativePersistence === 'function') {
    _auth = initializeAuth(app, {
      persistence: getReactNativePersistence(ReactNativeAsyncStorage),
    });
  } else {
    _auth = initializeAuth(app);
  }
} catch (e) {
  _auth = getAuth(app);
}

export const auth = _auth;
export const db = getFirestore(app);

type FaceRollGlobal = typeof globalThis & {
  __faceRollFirebaseEmulatorsConnected?: boolean;
};

function parseEmulatorPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function connectConfiguredEmulators(): void {
  const host = String(process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST || '').trim();
  if (!host) return;
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error(
      'EXPO_PUBLIC_FIREBASE_EMULATOR_HOST must be a hostname or IP address without http:// or a port.'
    );
  }

  const sharedGlobal = globalThis as FaceRollGlobal;
  if (sharedGlobal.__faceRollFirebaseEmulatorsConnected) return;

  const authPort = parseEmulatorPort(
    process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT,
    9099
  );
  const firestorePort = parseEmulatorPort(
    process.env.EXPO_PUBLIC_FIRESTORE_EMULATOR_PORT,
    8080
  );

  connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, firestorePort);
  sharedGlobal.__faceRollFirebaseEmulatorsConnected = true;
}

connectConfiguredEmulators();

export default app;
