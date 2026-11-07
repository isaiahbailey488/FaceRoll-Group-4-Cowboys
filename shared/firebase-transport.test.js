const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('services/firebase.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function load(config, existingAuth = {}) {
  const calls = [];
  const app = {};
  const auth = existingAuth;
  const imports = {
    'firebase/app': { getApps: () => [], getApp: () => app, initializeApp: (_config, name) => { calls.push(['app', name]); return app; } },
    'firebase/auth': { initializeAuth: () => auth, getAuth: () => auth,
      connectAuthEmulator: (_auth, url) => calls.push(['auth', url]) },
    'firebase/firestore': { getFirestore: () => { calls.push(['production-firestore']); return {}; },
      initializeFirestore: (_app, settings) => { calls.push(['firestore', settings]); return {}; } },
    '@react-native-async-storage/async-storage': {}, './runtime-config': { runtimeConfig: config },
  };
  vm.runInNewContext(source, { exports: {}, require: name => imports[name], URL });
  return JSON.parse(JSON.stringify(calls));
}
const emulator = { mode: 'emulator', apiUrl: 'https://localhost:5055', authEmulatorUrl: 'https://localhost:9449', firestoreEmulatorUrl: 'https://localhost:8443' };

test('mobile Firebase uses HTTPS gateways and a separate emulator auth persistence namespace', () => {
  assert.deepEqual(load(emulator), [
    ['app', 'faceroll-emulator'], ['auth', 'https://localhost:9449'],
    ['firestore', { host: 'localhost:8443', ssl: true, experimentalForceLongPolling: true }],
  ]);
});
test('production initializes normal Firebase without any emulator connections', () => {
  assert.deepEqual(load({ mode: 'production' }), [['app', 'faceroll-production'], ['production-firestore']]);
});
test('hot reload cannot silently retain an old plaintext or mismatched Auth emulator connection', () => {
  assert.throws(() => load(emulator, { emulatorConfig: { protocol: 'http', host: 'localhost', port: 9099 } }), /Fully close/);
  assert.throws(() => load({ mode: 'production' }, { emulatorConfig: { protocol: 'https', host: 'localhost', port: 9449 } }), /Fully close/);
});
