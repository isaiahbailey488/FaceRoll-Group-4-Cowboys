// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Keep Expo's default package-export resolution. SDK 58's React Native
// runtime uses exported subpaths such as react-native/setup-env, and
// Firebase JS SDK 12+ supports this resolution strategy.

module.exports = config;
