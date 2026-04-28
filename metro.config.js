// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// CRITICAL: Firebase JS SDK 10.x + Expo SDK 54 (Metro w/ package exports
// enabled by default) cause "Component auth has not been registered yet"
// because Metro's exports-map resolution can pick the wrong build of
// @firebase/auth, which then registers its component on a different
// @firebase/component instance than the one used at lookup time.
//
// Disabling unstable_enablePackageExports forces Metro to use the legacy
// `react-native` and `browser` field resolution, which Firebase ships
// correctly for React Native consumers.
config.resolver.unstable_enablePackageExports = false;

// Firebase auth ships some files as .cjs in newer SDK builds. Adding 'cjs'
// to source extensions ensures Metro can resolve them when needed.
if (!config.resolver.sourceExts.includes('cjs')) {
  config.resolver.sourceExts.push('cjs');
}

module.exports = config;
