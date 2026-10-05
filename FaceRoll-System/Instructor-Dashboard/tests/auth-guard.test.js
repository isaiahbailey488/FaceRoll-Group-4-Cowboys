'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const guardSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'auth-guard.js'),
  'utf8'
);

function loadGuard() {
  const state = { redirectedTo: '', cleared: 0, authCallback: null, bodyProtected: true };
  const body = {
    getAttribute: function (name) {
      return name === 'data-auth-required' && state.bodyProtected ? 'true' : null;
    },
    removeAttribute: function (name) {
      if (name === 'data-auth-required') state.bodyProtected = false;
    },
  };
  const document = {
    body: body,
    visibilityState: 'visible',
    addEventListener: function () {},
  };
  const window = {
    document: document,
    location: { replace: function (url) { state.redirectedTo = url; } },
    FaceRollFirebase: {
      clearInstructorSnapshotCache: function () { state.cleared += 1; },
      subscribeAuthState: async function (callback) {
        state.authCallback = callback;
        return function () {};
      },
    },
    addEventListener: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
  };
  vm.runInNewContext(guardSource, { window: window, Promise: Promise, Set: Set }, {
    filename: 'auth-guard.js',
  });
  return { state: state };
}

async function settle() {
  await new Promise(function (resolve) { setImmediate(resolve); });
}

test('signed-out dashboard visitors are redirected without revealing protected content', async function () {
  const harness = loadGuard();
  await settle();
  harness.state.authCallback(null);
  await settle();
  assert.equal(harness.state.redirectedTo, './index.html');
  assert.equal(harness.state.bodyProtected, true);
  assert.equal(harness.state.cleared, 1);
});

test('a valid restored Firebase session reveals the protected page', async function () {
  const harness = loadGuard();
  await settle();
  harness.state.authCallback({ getIdToken: async function () { return 'valid-token'; } });
  await settle();
  assert.equal(harness.state.redirectedTo, '');
  assert.equal(harness.state.bodyProtected, false);
});

test('an expired Firebase token redirects back to login', async function () {
  const harness = loadGuard();
  await settle();
  harness.state.authCallback({
    getIdToken: async function () {
      const error = new Error('Token expired');
      error.code = 'auth/user-token-expired';
      throw error;
    },
  });
  await settle();
  assert.equal(harness.state.redirectedTo, './index.html');
  assert.equal(harness.state.bodyProtected, true);
});

test('a temporary network failure keeps a restored offline session available', async function () {
  const harness = loadGuard();
  await settle();
  harness.state.authCallback({
    getIdToken: async function () {
      const error = new Error('Network unavailable');
      error.code = 'auth/network-request-failed';
      throw error;
    },
  });
  await settle();
  assert.equal(harness.state.redirectedTo, '');
  assert.equal(harness.state.bodyProtected, false);
});
