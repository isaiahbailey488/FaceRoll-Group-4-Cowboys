import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import {
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

export default app;
