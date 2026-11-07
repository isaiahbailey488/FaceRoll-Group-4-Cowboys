// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// SDK 58's Metro server reads server.tls for both HTTPS and WebSocket upgrades.
// --https only affects older bundlers; the demo launcher enables TLS explicitly.
if (process.env.FACEROLL_EXPO_TLS === '1') {
  const fs = require('node:fs');
  if (!process.env.FACEROLL_TLS_CERT || !process.env.FACEROLL_TLS_KEY) {
    throw new Error('HTTPS LAN requires FACEROLL_TLS_CERT and FACEROLL_TLS_KEY.');
  }
  config.server = {
    ...config.server,
    tls: {
      cert: fs.readFileSync(process.env.FACEROLL_TLS_CERT),
      key: fs.readFileSync(process.env.FACEROLL_TLS_KEY),
    },
  };
}

// Keep Expo's default package-export resolution. SDK 58's React Native
// runtime uses exported subpaths such as react-native/setup-env, and
// Firebase JS SDK 12+ supports this resolution strategy.

module.exports = config;
