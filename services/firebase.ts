import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeFirestore, getFirestore } from 'firebase/firestore';
import { runtimeConfig } from './runtime-config';
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

// Separate persistence keys prevent emulator sessions being restored in production.
const appName = `faceroll-${runtimeConfig.mode}`;
const app = getApps().some(existing => existing.name === appName)
  ? getApp(appName) : initializeApp(firebaseConfig, appName);

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
if (auth.emulatorConfig) {
  const existing = auth.emulatorConfig;
  const origin = `${existing.protocol}://${existing.host}${existing.port ? ':' + existing.port : ''}`;
  if (runtimeConfig.mode !== 'emulator' || origin !== runtimeConfig.authEmulatorUrl) {
    throw new Error('Firebase transport settings changed. Fully close the app and restart Expo.');
  }
}
if (runtimeConfig.mode === 'emulator' && !auth.emulatorConfig) {
  connectAuthEmulator(auth, runtimeConfig.authEmulatorUrl!, { disableWarnings: true });
}

// connectFirestoreEmulator disables TLS for ordinary hosts. Use the documented
// custom-host settings for the HTTPS gateway; real Auth emulator tokens are sent.
export const db = runtimeConfig.mode === 'emulator'
  ? initializeFirestore(app, {
      host: new URL(runtimeConfig.firestoreEmulatorUrl!).host,
      ssl: true,
      experimentalForceLongPolling: true,
    })
  : getFirestore(app);

export default app;
