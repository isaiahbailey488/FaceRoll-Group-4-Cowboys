'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'firebase-client.js'),
  'utf8'
);

function initializationHarness(hostname, initialized = false) {
  const calls = [];
  const auth = {
    useEmulator: (url) => calls.push(['auth', url]),
    signInWithEmailAndPassword: async () => {
      calls.push(['signIn']);
      return { user: { uid: 'local-user' } };
    },
  };
  const firebase = {
    apps: initialized ? [{}] : [],
    app: function () {},
    initializeApp: function (config) { calls.push(['initialize', config.projectId]); this.apps.push({}); },
    auth: () => auth,
    firestore: () => ({ useEmulator: (host, port) => calls.push(['firestore', host, port]) }),
  };
  const window = { firebase, location: { hostname }, setTimeout, console: { info() {} } };
  vm.runInNewContext(clientSource, { window }, { filename: 'firebase-client.js' });
  return { window, calls };
}

test('local login initializes missing Hosting config and connects emulators before sign-in', async function () {
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const { window, calls } = initializationHarness(hostname);
    await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
    await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
    assert.deepEqual(calls, [
      ['initialize', 'rollcall-2669b'], ['auth', 'http://127.0.0.1:9099'],
      ['firestore', '127.0.0.1', 8080], ['signIn'], ['signIn'],
    ]);
  }
});

test('existing Hosting app is reused on localhost', async function () {
  const { window, calls } = initializationHarness('localhost', true);
  await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.equal(calls.some(([name]) => name === 'initialize'), false);
  assert.equal(calls[0][0], 'auth');
});

test('deployed dashboard does not initialize local fallback or connect emulators', async function () {
  const { window, calls } = initializationHarness('rollcall-2669b.web.app', true);
  await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.deepEqual(calls, [['signIn']]);
});

test('missing production Hosting config never receives a local fallback', async function () {
  const { window, calls } = initializationHarness('rollcall-2669b.web.app');
  let pending;
  window.setTimeout = (callback) => { pending = callback; };
  const login = window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.equal(typeof pending, 'function');
  assert.deepEqual(calls, []);
  // Finish the pending login with a subsequently loaded Hosting app.
  window.firebase.apps.push({});
  pending();
  await login;
  assert.deepEqual(calls, [['signIn']]);
});

function loadFirebaseClient(existingDocument) {
  const writes = [];
  const documentRef = { path: 'attendance/session_student' };
  const db = {
    collection: function () {
      return {
        doc: function () {
          return documentRef;
        },
      };
    },
    runTransaction: async function (handler) {
      return handler({
        get: async function (receivedRef) {
          assert.equal(receivedRef, documentRef);
          return { exists: existingDocument };
        },
        set: function (receivedRef, data) {
          writes.push({ ref: receivedRef, data: data });
        },
      });
    },
  };
  const firebase = {
    apps: [{}],
    app: function () {},
    firestore: function () {
      return db;
    },
  };
  const window = {
    firebase: firebase,
    location: { hostname: 'dashboard.test' },
    setTimeout: setTimeout,
  };

  vm.runInNewContext(clientSource, { window: window }, { filename: 'firebase-client.js' });
  return { api: window.FaceRollFirebase, writes: writes, documentRef: documentRef };
}

test('creates a deterministic attendance document when it does not exist', async function () {
  const harness = loadFirebaseClient(false);
  const attendance = {
    uid: 'student-uid',
    sessionId: 'session',
    source: 'classroom_camera',
  };

  const created = await harness.api.createDocumentIfAbsent(
    'attendance',
    'session_student-uid',
    attendance
  );

  assert.equal(created, true);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].ref, harness.documentRef);
  assert.deepEqual(harness.writes[0].data, attendance);
});

test('does not overwrite attendance that already exists', async function () {
  const harness = loadFirebaseClient(true);

  const created = await harness.api.createDocumentIfAbsent(
    'attendance',
    'session_student-uid',
    { source: 'classroom_camera' }
  );

  assert.equal(created, false);
  assert.equal(harness.writes.length, 0);
});
