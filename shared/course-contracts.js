'use strict';

// Pure boundary validation. Authorization and persistence belong to the service.
const MEMBERSHIP_STATUSES = Object.freeze(['active', 'dropped', 'removed']);

function fail(field) {
  throw new TypeError(`Invalid course contract field: ${field}`);
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('record');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail('fields');
  if (value.schemaVersion !== 1) fail('schemaVersion');
}

function identifier(value, field, max = 128) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) fail(field);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(field);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(field);
  return time;
}

function chronology(value) {
  const created = timestamp(value.createdAt, 'createdAt');
  if (timestamp(value.updatedAt, 'updatedAt') < created) fail('updatedAt');
  return created;
}

function membershipId(courseId, uid) {
  identifier(courseId, 'courseId', 200);
  identifier(uid, 'uid');
  // Length prefix avoids collisions when either identifier contains underscores.
  return `${courseId.length}_${courseId}_${uid}`;
}

function validateMembership(value) {
  object(value, ['schemaVersion', 'courseId', 'uid', 'status', 'createdAt', 'updatedAt']);
  membershipId(value.courseId, value.uid);
  if (!MEMBERSHIP_STATUSES.includes(value.status)) fail('status');
  chronology(value);
  return { ...value };
}

function validateInvitation(value) {
  object(value, ['schemaVersion', 'courseId', 'createdBy', 'tokenHash', 'status', 'createdAt', 'updatedAt', 'expiresAt']);
  identifier(value.courseId, 'courseId', 200);
  identifier(value.createdBy, 'createdBy');
  if (typeof value.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenHash)) fail('tokenHash');
  if (!['active', 'revoked'].includes(value.status)) fail('status');
  const created = chronology(value);
  if (timestamp(value.expiresAt, 'expiresAt') <= created) fail('expiresAt');
  return { ...value };
}

function validateQrPayload(value) {
  object(value, ['schemaVersion', 'type', 'token']);
  if (value.type !== 'course-invitation') fail('type');
  if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) fail('token');
  return { ...value };
}

function validateRecognitionServer(value) {
  object(value, ['schemaVersion', 'serverId', 'instructorUid', 'baseUrl', 'status', 'createdAt', 'updatedAt']);
  identifier(value.serverId, 'serverId');
  identifier(value.instructorUid, 'instructorUid');
  if (!['active', 'disabled'].includes(value.status)) fail('status');
  if (typeof value.baseUrl !== 'string' || value.baseUrl !== value.baseUrl.trim()) fail('baseUrl');
  let url;
  try { url = new URL(value.baseUrl); } catch { fail('baseUrl'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' || value.baseUrl !== url.origin) fail('baseUrl');
  chronology(value);
  return { ...value };
}

module.exports = {
  MEMBERSHIP_STATUSES,
  membershipId,
  validateMembership,
  validateInvitation,
  validateQrPayload,
  validateRecognitionServer,
};
