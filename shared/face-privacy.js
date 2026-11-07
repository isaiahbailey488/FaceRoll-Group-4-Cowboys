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

function checkInAccessState(profile) {
  if (!profile || typeof profile.optOutFlag !== 'boolean') return 'loading';
  if (profile.optOutFlag) return 'location_only';
  if (profile.faceDataDeletionStatus === 'pending') return 'deletion_pending';
  return profile.faceEnrolled === true ? 'face_location' : 'enrollment_required';
}

const LOCATION_CHECK_IN_PENDING = 'Facial recognition is off. Open Check-In for an active class. Your classroom location is collected automatically; tap Check In with Location to submit attendance without a photo or face enrollment. Your instructor must enable a valid classroom zone. Face data deletion does not block location-only check-in.';

module.exports = { faceAccessState, checkInAccessState, optOutUpdate, deletionMessage, LOCATION_CHECK_IN_PENDING };
