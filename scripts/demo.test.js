'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const {
  selectNetworkMode,
  tailscaleConnection,
  configureTailscale,
  createDemoEnvironment,
  detectLanAddress,
  isPrivateLanAddress,
  parseEnvironmentFile,
  resolveCommand,
  waitForEmulators,
} = require('./demo.js');

test('network prompt defaults local, accepts Tailscale, and flags bypass prompting', async () => {
  assert.equal(await selectNetworkMode([], true, async () => ''), 'local');
  assert.equal(await selectNetworkMode([], true, async () => '2'), 'tailscale');
  const noPrompt = () => { throw new Error('Unexpected prompt'); };
  assert.equal(await selectNetworkMode(['--tailscale'], false, noPrompt), 'tailscale');
  assert.equal(await selectNetworkMode(['--check'], true, noPrompt), 'local');
  assert.equal(await selectNetworkMode([], false, noPrompt), 'local');
  await assert.rejects(selectNetworkMode(['--local', '--tailscale'], true, noPrompt), /either/);
});

const tailStatus = { BackendState: 'Running', TailscaleIPs: ['100.100.1.2'], Self: { DNSName: 'demo.tail123.ts.net.' } };
test('Tailscale uses detected addresses and rejects disconnected clients or existing Serve config', () => {
  assert.throws(() => tailscaleConnection({ BackendState: 'Stopped' }), /Connect/);
  assert.throws(() => tailscaleConnection({ ...tailStatus, Self: {} }), /MagicDNS/);
  const runner = (command, args) => ({ status: 0, stdout: JSON.stringify(args[0] === 'status' ? tailStatus : {}) });
  const config = configureTailscale({ lanAddress: '192.168.1.5' }, runner);
  const env = createDemoEnvironment(config);
  assert.equal(env.EXPO_PUBLIC_RECOGNITION_API_URL, 'https://demo.tail123.ts.net');
  assert.equal(env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST, '100.100.1.2');
  assert.equal(env.REACT_NATIVE_PACKAGER_HOSTNAME, '100.100.1.2');
  assert.equal(env.FACEROLL_API_HOST, '127.0.0.1');
  assert.equal(env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  assert.throws(() => configureTailscale({}, (command, args) => ({ status: 0,
    stdout: JSON.stringify(args[0] === 'status' ? tailStatus : { TCP: { 443: {} } }) })), /not be overwritten/);
});

test('waits for Hosting to register and reports its reassigned port', async function () {
  let requests = 0;
  const ready = { hosting: { port: 5002 }, auth: { port: 9099 }, firestore: { port: 8080 }, ui: { port: 4001 } };
  const server = http.createServer((request, response) => {
    requests += 1;
    response.end(JSON.stringify(requests === 1 ? { hub: { port: 4400 } } : ready));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await waitForEmulators(`http://127.0.0.1:${server.address().port}/emulators`, 2000, 1);
    assert.deepEqual(status, ready);
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fails instead of guessing a Hosting port when registration never completes', async function () {
  await assert.rejects(waitForEmulators('http://127.0.0.1:1', 0), /Timed out waiting for Firebase/);
});

test('Windows CLI launch preserves paths and arguments without a command shell', {
  skip: process.platform !== 'win32',
}, function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'FaceRoll CLI & spaces '));
  try {
    const entry = path.join(directory, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const args = ['emulators:export', 'C:\\demo data\\a & b', '%PATH%', '--force'];
    const invocation = resolveCommand('firebase.cmd', args, { Path: directory });
    const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
