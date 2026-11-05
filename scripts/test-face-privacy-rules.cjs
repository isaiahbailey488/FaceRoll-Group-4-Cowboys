// Run against an isolated Firestore emulator; never accepts a hosted URL.
const assert = require('node:assert/strict');
const port = Number(process.argv[2] || 8183);
const project = 'demo-faceroll-optout';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid emulator port');
const base = `http://127.0.0.1:${port}/v1/projects/${project}/databases/(default)/documents`;
const name = path => `projects/${project}/databases/(default)/documents/${path}`;
function token(uid) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    aud: project, iss: `https://securetoken.google.com/${project}`, sub: uid,
    user_id: uid, iat: now, exp: now + 3600,
    firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`;
}
function field(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (typeof value === 'string') return { stringValue: value };
  return { mapValue: { fields: fields(value) } };
}
const fields = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)]));
let assertions = 0;
async function write(path, data, user = 'owner', expected = 200, requestedAt = false) {
  const update = { update: { name: name(path), fields: fields(data) }, updateMask: { fieldPaths: Object.keys(data) } };
  if (requestedAt) update.updateTransforms = [{ fieldPath: 'faceDeletionRequestedAt', setToServerValue: 'REQUEST_TIME' }];
  const response = await fetch(`${base}:commit`, {
    method: 'POST', headers: { Authorization: `Bearer ${user === 'owner' ? 'owner' : token(user)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [update] }), signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, expected, `${path}: ${await response.text()}`);
  assertions++;
}
async function main() {
  await write('users/student', { uid: 'student', userId: 'student', role: 'student', studentId: '1234567', optOutFlag: false, faceEnrolled: true });
  await write('users/teacher', { uid: 'teacher', role: 'instructor' });
  await write('courses/course', { instructorId: 'teacher' });
  await write('sessions/session', { courseId: 'course', status: 'active' });
  await write('enrollments/member', { uid: 'student', courseId: 'course', status: 'active' });
  await write('users/student', { firstName: 'Example' }, 'student');
  await write('users/student', { optOutFlag: true, faceEnrolled: false }, 'student', 403);
  await write('users/student', { optOutFlag: true, faceEnrolled: false, faceConsentRevision: 1, faceDataDeletionStatus: 'pending' }, 'student', 200, true);
  const attendance = { uid: 'student', sessionId: 'session', courseId: 'course', membershipId: 'member', source: 'phone_face_verification', status: 'present' };
  await write('attendance/session_student', attendance, 'student', 403);
  await write('attendance/session_student', { ...attendance, source: 'classroom_camera' }, 'teacher', 403);
  await write('users/student', { faceDataDeletionStatus: 'deleted' }, 'student', 403);
  await write('users/student', { faceEnrollmentServers: { fake: { state: 'deleted', consentRevision: 1 } } }, 'student', 403);
  await write('users/student', { optOutFlag: false, faceConsentRevision: 2, faceEnrolled: false }, 'student', 403);
  await write('users/student', { faceConsentRevision: 0 }, 'student', 403);
  await write('users/student', { faceDataDeletionStatus: 'deleted' });
  await write('users/student', { optOutFlag: false, faceConsentRevision: 2, faceEnrolled: false }, 'student');
  await write('attendance/session_student', attendance, 'student', 403);
  await write('users/student', { faceEnrolled: true }, 'student', 403);
  await write('users/student', { faceEnrolled: true, faceDataDeletionStatus: 'none' });
  await write('attendance/session_student', attendance, 'student');
  console.log(`Passed ${assertions} opt-out rule checks on emulator port ${port}.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
