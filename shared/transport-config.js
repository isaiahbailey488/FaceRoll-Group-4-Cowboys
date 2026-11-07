'use strict';

function httpsOrigin(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) throw new Error(`${label} must be an HTTPS origin.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS origin.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an HTTPS origin without credentials, paths, or query parameters.`);
  }
  return url.origin;
}

function resolveTransportConfig(values, development = false) {
  const mode = values.mode;
  if (!['emulator', 'production'].includes(mode)) throw new Error('Set EXPO_PUBLIC_FIREBASE_MODE to emulator or production.');
  if (!development && mode === 'emulator') throw new Error('Release builds cannot connect to Firebase emulators.');
  if (values.legacyEmulatorHost) throw new Error('Plain HTTP emulator configuration is no longer supported. Configure the HTTPS emulator URLs.');
  const config = { mode, apiUrl: httpsOrigin(values.apiUrl, 'Recognition API URL') };
  if (mode === 'production') {
    if (values.authEmulatorUrl || values.firestoreEmulatorUrl) throw new Error('Production mode cannot include emulator endpoints.');
    return Object.freeze(config);
  }
  return Object.freeze({ ...config,
    authEmulatorUrl: httpsOrigin(values.authEmulatorUrl, 'Auth emulator URL'),
    firestoreEmulatorUrl: httpsOrigin(values.firestoreEmulatorUrl, 'Firestore emulator URL'),
  });
}

module.exports = { httpsOrigin, resolveTransportConfig };
