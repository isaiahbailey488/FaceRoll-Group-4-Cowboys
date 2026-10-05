'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTerminalAuthError } = require('./auth-session');

test('expired, revoked, disabled, and deleted Firebase sessions are terminal', function () {
  [
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/invalid-user-token',
    'auth/user-disabled',
    'auth/user-not-found',
    'auth/user-token-expired',
  ].forEach(function (code) {
    assert.equal(isTerminalAuthError({ code }), true, code);
  });
});

test('temporary connection failures do not end an offline session', function () {
  assert.equal(isTerminalAuthError({ code: 'auth/network-request-failed' }), false);
  assert.equal(isTerminalAuthError(new Error('connection interrupted')), false);
  assert.equal(isTerminalAuthError(null), false);
});
