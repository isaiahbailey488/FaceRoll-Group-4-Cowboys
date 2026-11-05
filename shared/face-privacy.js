'use strict';

function faceAccessState(profile) {
  if (!profile) return 'loading';
  if (profile.optOutFlag !== false) return 'opted_out';
  if (profile.faceDataDeletionStatus === 'pending') return 'deletion_pending';
  return 'ready';
}

function optOutUpdate(profile, optOut, timestamp) {
  if (typeof optOut !== 'boolean' || !profile) throw new Error('Your preference could not be verified. Try again.');
  if (Boolean(profile.optOutFlag) === optOut) return {};
  if (!optOut && profile.faceDataDeletionStatus !== 'deleted') {
    const error = new Error('Your saved facial data must finish deleting before you can enable facial recognition again.');
    error.code = 'face_deletion_pending';
    throw error;
  }
  const revision = profile.faceConsentRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Your face preference could not be verified.');
  return {
    optOutFlag: optOut,
    faceEnrolled: false,
    faceConsentRevision: revision + 1,
    ...(optOut ? { faceDataDeletionStatus: 'pending', faceDeletionRequestedAt: timestamp } : {}),
  };
}

function deletionMessage(status) {
  return status === 'deleted'
    ? 'Facial recognition is off. Your saved facial embeddings have been deleted from registered recognition computers.'
    : 'Facial recognition is off. Deletion is pending until your recognition computers reconnect. You can retry deletion here.';
}

const LOCATION_CHECK_IN_PENDING = 'Location-based check-in is still under development and is not available yet.';

module.exports = { faceAccessState, optOutUpdate, deletionMessage, LOCATION_CHECK_IN_PENDING };
