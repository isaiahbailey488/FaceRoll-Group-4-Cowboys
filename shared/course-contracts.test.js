'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('./course-contracts');

const dates = { createdAt: '2026-09-24T12:00:00.000Z', updatedAt: '2026-09-24T12:00:00.000Z' };
const membership = { schemaVersion: 1, courseId: 'CAPSTONE-4', uid: 'firebase_uid', status: 'active', ...dates };
const invitation = { schemaVersion: 1, courseId: membership.courseId, createdBy: 'instructor_uid', tokenHash: 'a'.repeat(64), status: 'active', ...dates, expiresAt: '2026-09-25T12:00:00.000Z' };
const qr = { schemaVersion: 1, type: 'course-invitation', token: 'b'.repeat(64) };
const server = { schemaVersion: 1, serverId: 'classroom-1', instructorUid: 'instructor_uid', baseUrl: 'https://classroom.example.edu', status: 'active', ...dates };
const cases = [
  ['membership', contracts.validateMembership, membership],
  ['invitation', contracts.validateInvitation, invitation],
  ['QR', contracts.validateQrPayload, qr],
  ['server', contracts.validateRecognitionServer, server],
];

for (const [name, validate, fixture] of cases) {
  test(`${name}: accepts canonical record without mutating input`, () => {
    assert.deepEqual(validate(Object.freeze({ ...fixture })), fixture);
  });
  test(`${name}: rejects missing fields, unknown fields and unsupported versions`, () => {
    for (const key of Object.keys(fixture)) {
      const incomplete = { ...fixture };
      delete incomplete[key];
      assert.throws(() => validate(incomplete), TypeError);
    }
    for (const extra of ['embeddings', 'images', 'uidOverride', 'endpoint']) {
      assert.throws(() => validate({ ...fixture, [extra]: 'unexpected' }), TypeError);
    }
    for (const invalid of [null, [], 'record', { ...fixture, schemaVersion: 2 }]) {
      assert.throws(() => validate(invalid), TypeError);
    }
  });
}

test('membership IDs are deterministic and distinguish ambiguous underscore pairs', () => {
  assert.equal(contracts.membershipId('course', 'uid'), '6_course_uid');
  assert.notEqual(contracts.membershipId('a_b', 'c'), contracts.membershipId('a', 'b_c'));
  for (const id of ['', ' ', '../student', 'a/b', 'a\nb', 'a'.repeat(201)]) {
    assert.throws(() => contracts.membershipId(id, 'uid'), TypeError);
    assert.throws(() => contracts.membershipId('course', id), TypeError);
  }
});

test('membership accepts only explicitly supported states', () => {
  for (const status of contracts.MEMBERSHIP_STATUSES) contracts.validateMembership({ ...membership, status });
  for (const status of ['', 'pending', 'ACTIVE', null]) {
    assert.throws(() => contracts.validateMembership({ ...membership, status }), TypeError);
  }
});

test('records require real UTC timestamps and ordered updates', () => {
  for (const [, validate, fixture] of cases.filter(([, , f]) => f.createdAt)) {
    for (const createdAt of ['2026-02-30T12:00:00.000Z', 'yesterday', 0, '2026-09-24T12:00:00']) {
      assert.throws(() => validate({ ...fixture, createdAt }), TypeError);
    }
    assert.throws(() => validate({ ...fixture, updatedAt: '2025-01-01T00:00:00.000Z' }), TypeError);
  }
});

test('invitation requires expiration after creation; revocation is a valid stored state', () => {
  contracts.validateInvitation({ ...invitation, status: 'revoked' });
  assert.throws(() => contracts.validateInvitation({ ...invitation, expiresAt: dates.createdAt }), TypeError);
  assert.throws(() => contracts.validateInvitation({ ...invitation, status: 'expired' }), TypeError);
});

test('token and hash formats reject malformed values and raw tokens cannot enter stored invitations', () => {
  for (const token of ['', 'a'.repeat(63), 'g'.repeat(64), 123]) {
    assert.throws(() => contracts.validateQrPayload({ ...qr, token }), TypeError);
    assert.throws(() => contracts.validateInvitation({ ...invitation, tokenHash: token }), TypeError);
  }
  assert.throws(() => contracts.validateInvitation({ ...invitation, token: qr.token }), TypeError);
  assert.throws(() => contracts.validateQrPayload({ ...qr, type: 'attendance' }), TypeError);
});

test('server requires a canonical HTTPS origin without credentials, paths or redirects in query', () => {
  for (const baseUrl of ['http://classroom.example.edu', 'javascript:alert(1)', 'https://user:pass@example.edu',
    'https://example.edu/api', 'https://example.edu?next=evil', 'https://example.edu#fragment',
    ' https://example.edu', 'https://example.edu/']) {
    assert.throws(() => contracts.validateRecognitionServer({ ...server, baseUrl }), TypeError);
  }
  contracts.validateRecognitionServer({ ...server, status: 'disabled', baseUrl: 'https://classroom.example.edu:5055' });
});
