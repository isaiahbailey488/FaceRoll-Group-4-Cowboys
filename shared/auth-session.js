'use strict';

const TERMINAL_AUTH_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-user-token',
  'auth/user-disabled',
  'auth/user-not-found',
  'auth/user-token-expired',
]);

function isTerminalAuthError(error) {
  return TERMINAL_AUTH_CODES.has(String(error && error.code || '').toLowerCase());
}

module.exports = { isTerminalAuthError };
