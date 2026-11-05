const { test } = require('node:test');
const assert = require('node:assert/strict');
const { faceAccessState, optOutUpdate, deletionMessage, LOCATION_CHECK_IN_PENDING } = require('./face-privacy');

test('camera consent waits for a profile and denies opt-out or pending cleanup', () => {
  assert.equal(faceAccessState(null), 'loading');
  assert.equal(faceAccessState({ optOutFlag: true }), 'opted_out');
  assert.equal(faceAccessState({ optOutFlag: false, faceDataDeletionStatus: 'pending' }), 'deletion_pending');
  assert.equal(faceAccessState({ optOutFlag: false }), 'ready');
  assert.equal(faceAccessState({}), 'opted_out');
});

test('opt-out atomically revokes previous enrollment and requests deletion', () => {
  assert.deepEqual(optOutUpdate({ optOutFlag: false, faceEnrolled: true }, true, 'server-time'), {
    optOutFlag: true, faceEnrolled: false, faceConsentRevision: 1,
    faceDataDeletionStatus: 'pending', faceDeletionRequestedAt: 'server-time',
  });
  assert.deepEqual(optOutUpdate({ optOutFlag: true }, true, 'now'), {});
});

test('re-enabling waits for confirmed deletion and requires fresh enrollment', () => {
  assert.throws(() => optOutUpdate({ optOutFlag: true, faceDataDeletionStatus: 'pending' }, false), { code: 'face_deletion_pending' });
  assert.deepEqual(optOutUpdate({ optOutFlag: true, faceConsentRevision: 1, faceDataDeletionStatus: 'deleted' }, false), {
    optOutFlag: false, faceEnrolled: false, faceConsentRevision: 2,
  });
});

test('invalid revisions are rejected and pending copy never claims completed deletion', () => {
  assert.throws(() => optOutUpdate({ optOutFlag: false, faceConsentRevision: -1 }, true));
  assert.match(deletionMessage('pending'), /pending/);
  assert.match(deletionMessage('deleted'), /have been deleted/);
  assert.match(LOCATION_CHECK_IN_PENDING, /not available yet/);
});
