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
