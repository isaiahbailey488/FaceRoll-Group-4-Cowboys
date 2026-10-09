'use strict';
// Run only against the isolated emulator described in README, never production.
const assert = require('node:assert/strict');
const project = 'demo-faceroll-location';
const base = `http://127.0.0.1:8181/v1/projects/${project}/databases/(default)/documents`;
function token(uid) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ sub: uid, user_id: uid,
    aud: project, iss: `https://securetoken.google.com/${project}`, iat: now, exp: now + 3600,
    firebase: { sign_in_provider: 'custom', identities: {} } }) + '.';
}
function value(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, item]) => [k, value(item)])) } };
}
async function put(path, data, auth = token('student')) {
  const response = await fetch(base + '/' + path, { method: 'PATCH', headers: {
    Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)])) }) });
  return { status: response.status, body: await response.text() };
}
(async () => {
  let count = 0;
  async function check(extra, expected) {
    const sessionId = 'location-test-' + Date.now() + '-' + count++;
    assert.equal((await put('sessions/' + sessionId, { courseId: 'course1', status: 'active' }, 'owner')).status, 200);
    const result = await put('attendance/' + sessionId + '_student', {
      uid: 'student', sessionId, courseId: 'course1', membershipId: 'course1_student', status: 'present', ...extra,
    });
    assert.equal(result.status, expected, result.body);
  }
  assert.equal((await put('enrollments/course1_student', { uid: 'student', courseId: 'course1', status: 'active' }, 'owner')).status, 200);
  for (const locationStatus of ['in_zone', 'outside_zone', 'not_required', 'not_checked']) {
    await check({ locationStatus }, 200);
  }
  await check({}, 200); // Existing mobile clients remain compatible.
  for (const field of ['latitude', 'longitude', 'accuracy', 'distance', 'coords', 'location', 'position']) {
    await check({ [field]: { latitude: 33.2, longitude: -97.1 } }, 403);
  }
  await check({ method: { latitude: 33.2 } }, 403);
  await check({ locationStatus: 'unknown-result' }, 403);
  assert.equal((await put('users/teacher', { role: 'instructor' }, 'owner')).status, 200);
  const recordId = 'teacher-location-test_student';
  assert.equal((await put('sessions/teacher-location-test', { courseId: 'course1', status: 'active' }, 'owner')).status, 200);
  const record = { uid: 'student', sessionId: 'teacher-location-test', courseId: 'course1', membershipId: 'course1_student', status: 'present', locationStatus: 'in_zone' };
  assert.equal((await put('attendance/' + recordId, record, token('teacher'))).status, 200);
  assert.equal((await put('attendance/' + recordId, { ...record, latitude: 33.2 }, token('teacher'))).status, 403);
  assert.equal((await put('attendance/' + recordId, { ...record, status: 'late' }, token('teacher'))).status, 200);
  console.log('Passed: zone statuses, legacy compatibility, coordinate rejection, nested-object rejection, and teacher overrides.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
