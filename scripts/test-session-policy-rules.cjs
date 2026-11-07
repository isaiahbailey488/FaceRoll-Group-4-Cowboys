// Uses a dedicated local emulator project. Never writes to the running demo or a hosted database.
const assert = require('node:assert/strict');
const policy = require('../shared/session-policy');
const port = Number(process.argv[2] || 8185);
const project = 'demo-faceroll-session-policy';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid emulator port');
const database = `projects/${project}/databases/(default)/documents`;
const base = `http://127.0.0.1:${port}/v1/${database}`;
function token(uid) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ aud: project,
    iss: `https://securetoken.google.com/${project}`, sub: uid, user_id: uid,
    iat: now, exp: now + 3600, firebase: { sign_in_provider: 'custom', identities: {} },
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
async function write(path, data, uid = 'owner', expected = 200) {
  const result = await fetch(`${base}:commit`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{ update: { name: `${database}/${path}`, fields: fields(data) }, updateMask: { fieldPaths: Object.keys(data) } }] }),
  });
  assert.equal(result.status, expected, `${path} as ${uid}: ${await result.text()}`);
  assertions++;
}
async function session(id, settings = {}, extra = {}) {
  await write('sessions/' + id, { ...policy.snapshot(settings, Date.now() - 5 * 60000), courseId: 'course', status: 'active', ...extra });
}
async function attendance(id, status, uid = 'student', expected = 200, extra = {}) {
  await write(`attendance/${id}_student`, {
    uid: 'student', courseId: 'course', sessionId: id, membershipId: '6_course_student',
    source: 'phone_face_verification', status, ...extra,
  }, uid, expected);
}
async function main() {
  await write('users/teacher', { uid: 'teacher', role: 'instructor' });
  await write('users/other-teacher', { uid: 'other-teacher', role: 'instructor' });
  await write('users/student', { uid: 'student', role: 'student', studentId: '1234567', optOutFlag: false, faceEnrolled: true });
  await write('courses/course', { instructorId: 'teacher' });
  await write('enrollments/6_course_student', { uid: 'student', courseId: 'course', status: 'active' });

  await session('present'); await attendance('present', 'late', 'student', 403); await attendance('present', 'present', 'student', 403);
  await attendance('present', 'present', 'teacher', 200, { source: 'classroom_camera' });
  await session('late', { gracePeriodMinutes: 1, allowLate: true });
  await attendance('late', 'present', 'student', 403); await attendance('late', 'late', 'student', 403);
  await attendance('late', 'late', 'teacher', 200, { source: 'classroom_camera' });
  await session('no-late', { gracePeriodMinutes: 1, allowLate: false });
  await attendance('no-late', 'late', 'student', 403); await attendance('no-late', 'present', 'student', 403);
  await session('expired', { attendanceWindowMinutes: 1, allowLate: true });
  await attendance('expired', 'late', 'student', 403, { time: new Date(Date.now() - 5 * 60000).toISOString() });
  await session('unlimited', { attendanceWindowMinutes: 0, allowLate: true }, policy.snapshot({ attendanceWindowMinutes: 0, allowLate: true }, Date.now() - 4 * 3600000));
  await attendance('unlimited', 'late', 'student', 403);
  await attendance('unlimited', 'late', 'teacher', 200, { source: 'classroom_camera' });
  await session('unlimited-no-late', { attendanceWindowMinutes: 0, gracePeriodMinutes: 1, allowLate: false });
  await attendance('unlimited-no-late', 'late', 'student', 403);
  await session('future', {}, policy.snapshot({}, Date.now() + 3600000));
  await attendance('future', 'present', 'student', 403);
  await session('starting', {}, { status: 'starting' }); await attendance('starting', 'present', 'student', 403);
  await session('closing', {}, { status: 'closing', endTime: new Date().toISOString() });
  await attendance('closing', 'present', 'student', 403);
  await attendance('closing', 'absent', 'student', 403, { source: 'session_default' });
  await attendance('closing', 'absent', 'other-teacher', 403, { source: 'session_default' });
  await attendance('closing', 'present', 'teacher', 403, { source: 'session_default' });
  await attendance('closing', 'absent', 'teacher', 403, { source: 'classroom_camera' });
  await attendance('closing', 'absent', 'teacher', 200, { source: 'session_default' });
  await session('closed', { defaultAttendance: 'late' }, { status: 'closed', endTime: new Date().toISOString() });
  await attendance('closed', 'late', 'student', 403); await attendance('closed', 'late', 'teacher', 200, { source: 'session_default' });
  await session('opted-out', {}, { status: 'closing', endTime: new Date().toISOString() });
  await write('users/student', { optOutFlag: true });
  await attendance('opted-out', 'absent', 'teacher', 200, { source: 'session_default' });
  await session('dropped', {}, { status: 'closing', endTime: new Date().toISOString() });
  await write('enrollments/6_course_student', { status: 'dropped' });
  await attendance('dropped', 'absent', 'teacher', 403, { source: 'session_default' });
  console.log(`Passed ${assertions} session-policy rule checks on isolated emulator port ${port}.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
