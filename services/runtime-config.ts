import { resolveTransportConfig } from '../shared/transport-config';

// Expo inlines EXPO_PUBLIC variables only when accessed through literal names.
// Validate before initializing Firebase so a bad configuration sends no tokens.
export const runtimeConfig = resolveTransportConfig({
  mode: process.env.EXPO_PUBLIC_FIREBASE_MODE,
  apiUrl: process.env.EXPO_PUBLIC_RECOGNITION_API_URL,
  authEmulatorUrl: process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_URL,
  firestoreEmulatorUrl: process.env.EXPO_PUBLIC_FIRESTORE_EMULATOR_URL,
  legacyEmulatorHost: process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST,
}, __DEV__);
