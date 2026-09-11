'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDemoEnvironment,
  detectLanAddress,
  isPrivateLanAddress,
  parseEnvironmentFile,
} = require('./demo.js');

test('parses the optional demo environment file', function () {
  assert.deepEqual(parseEnvironmentFile('A=one\nB="two words"\n# ignored\n'), {
    A: 'one',
    B: 'two words',
  });
});

test('selects a private Wi-Fi address instead of a tunnel address', function () {
  const interfaces = {
    tailscale0: [{ family: 'IPv4', internal: false, address: '100.102.5.82' }],
    eno1: [{ family: 'IPv4', internal: false, address: '192.168.1.223' }],
  };
  assert.equal(detectLanAddress(interfaces), '192.168.1.223');
  assert.equal(isPrivateLanAddress('172.20.4.2'), true);
  assert.equal(isPrivateLanAddress('100.102.5.82'), false);
});

test('demo environment removes cloud credentials and forces every client local', function () {
  const previousCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/secret/cloud-key.json';
  try {
    const environment = createDemoEnvironment({
      lanAddress: '192.168.1.223',
      tlsCert: '/tls/server.pem',
      tlsKey: '/tls/server.key',
      enrollmentDirectory: '/data/enrollments',
      deepfaceHome: '/data/models',
    });
    assert.equal(environment.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(environment.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
    assert.equal(environment.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
    assert.equal(environment.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST, '192.168.1.223');
    assert.equal(environment.EXPO_PUBLIC_RECOGNITION_API_URL, 'https://192.168.1.223:5055');
  } finally {
    if (previousCredential === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredential;
  }
});
