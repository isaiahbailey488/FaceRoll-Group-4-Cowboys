// Deliberately fixed to an isolated emulator project, never the running demo.
const assert = require('node:assert/strict');
const port = Number(process.argv[2] || 8185);
const project = 'demo-faceroll-session-policy';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid emulator port');
const database = `projects/${project}/databases/(default)/documents`;
const base = `http://127.0.0.1:${port}/v1/${database}`;
function token(uid) {
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ aud: project, iss: `https://securetoken.google.com/${project}`,
    sub: uid, user_id: uid, iat: now, exp: now + 3600, firebase: { sign_in_provider: 'custom', identities: {} },
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
async function request(path, uid, expected, body, method = 'POST') {
  const result = await fetch(base + path, { method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await result.text();
  assert.equal(result.status, expected, `${method} ${path} as ${uid}: ${text}`); assertions++;
  return text;
}
async function write(path, data, uid = 'owner', expected = 200) {
  return request(':commit', uid, expected, { writes: [{ update: { name: `${database}/${path}`, fields: fields(data) }, updateMask: { fieldPaths: Object.keys(data) } }] });
}
const read = (path, uid, expected = 200) => request('/' + path, uid, expected, null, 'GET');
const remove = (path, uid, expected = 200) => request(':commit', uid, expected, { writes: [{ delete: `${database}/${path}` }] });
const query = (name, uid, filters, expected = 200) => request(':runQuery', uid, expected, { structuredQuery: {
  from: [{ collectionId: name }], ...(filters ? { where: { compositeFilter: { op: 'AND', filters: Object.entries(filters).map(([name, value]) => ({ fieldFilter: { field: { fieldPath: name }, op: 'EQUAL', value: field(value) } })) } } } : {}),
} });

async function main() {
  for (const [uid, role] of [['teacher-a', 'instructor'], ['teacher-b', 'instructor'], ['administrator', 'admin'], ['student-a', 'student'], ['student-b', 'student']]) {
    await write('users/' + uid, { uid, userId: uid, role, studentId: '1234567', displayName: uid });
  }
  for (const letter of ['a', 'b']) {
    await write('courses/course-' + letter, { courseId: 'course-' + letter, instructorId: 'teacher-' + letter, name: letter });
    await write('sessions/session-' + letter, { courseId: 'course-' + letter, status: 'closed', startTime: '2026-10-01T10:00:00Z' });
    await write('enrollments/member-' + letter, { uid: 'student-' + letter, courseId: 'course-' + letter, status: 'removed' });
    await write('attendance/session-' + letter + '_student-' + letter, { uid: 'student-' + letter, sessionId: 'session-' + letter, courseId: 'course-' + letter, status: 'present' });
  }
  for (const collection of ['courses', 'sessions', 'enrollments', 'attendance']) {
    const id = collection === 'courses' ? 'course-b' : collection === 'sessions' ? 'session-b' : collection === 'enrollments' ? 'member-b' : 'session-b_student-b';
    await read(collection + '/' + id, 'teacher-b');
    await read(collection + '/' + id, 'teacher-a', 403);
    await query(collection, 'teacher-a', collection === 'courses' ? { instructorId: 'teacher-a' } : { courseId: 'course-a' });
    await query(collection, 'teacher-a', null, 403);
    await remove(collection + '/' + id, 'teacher-a', 403);
  }
  await write('attendance/session-b_student-b', { status: 'absent' }, 'teacher-a', 403);
  await write('attendance/session-a_student-a', { status: 'absent' }, 'teacher-a');
  await write('attendance/session-a_student-a', { courseId: 'course-b' }, 'teacher-a', 403);
  await write('attendance/session-a_student-a', { uid: 'student-b' }, 'teacher-a', 403);
  await write('sessions/session-b', { status: 'active' }, 'teacher-a', 403);
  await write('sessions/forged', { courseId: 'course-b', status: 'active' }, 'teacher-a', 403);
  await write('courses/course-b', { name: 'changed' }, 'teacher-a', 403);
  await write('enrollments/member-b', { status: 'active' }, 'teacher-a', 403);
  await write('enrollments/forged', { uid: 'student-b', courseId: 'course-b', status: 'active' }, 'teacher-a', 403);
  await write('enrollments/member-a', { courseId: 'course-b' }, 'teacher-a', 403);
  await write('enrollments/member-a', { status: 'active' }, 'teacher-a');

  await read('users/student-a', 'teacher-a', 403);
  const accessPath = 'instructorStudentAccess/teacher-a/students/student-a';
  await write(accessPath, { uid: 'student-a', courseId: 'course-a', membershipId: 'member-a' }, 'teacher-a');
  await read('users/student-a', 'teacher-a');
  await read('users/student-b', 'teacher-a', 403);
  await query('users', 'teacher-a', null, 403);
  await write('users/student-a', { displayName: 'changed' }, 'teacher-a', 403);
  await write('users/teacher-b', { role: 'student' }, 'teacher-a', 403);
  await write('instructorStudentAccess/teacher-a/students/student-b', { uid: 'student-b', courseId: 'course-b', membershipId: 'member-b' }, 'teacher-a', 403);
  await write('instructorStudentAccess/teacher-b/students/student-a', { uid: 'student-a', courseId: 'course-a', membershipId: 'member-a' }, 'teacher-a', 403);
  await write(accessPath, { uid: 'student-a', courseId: 'course-a', membershipId: 'member-b' }, 'teacher-a', 403);
  await write(accessPath, { uid: 'student-a', courseId: 'course-a', membershipId: 'missing' }, 'teacher-a', 403);
  await read('users/student-a', 'student-a');
  await read('users/student-b', 'student-a', 403);
  await read('attendance/session-a_student-a', 'student-a');
  await read('attendance/session-b_student-b', 'student-a', 403);
  await read('users/student-b', 'administrator');
  await query('users', 'administrator', null);
  await write('attendance/session-b_student-b', { status: 'absent' }, 'administrator');

  const override = { uid: 'student-a', userId: 'student-a', sessionId: 'session-missing', courseId: 'course-a', membershipId: 'member-a', source: 'instructor_override', method: 'Instructor override', status: 'late', time: '2026-10-02T10:00:00Z' };
  await write('sessions/session-missing', { courseId: 'course-a', status: 'closed' });
  await write('attendance/session-missing_student-a', override, 'teacher-b', 403);
  await write('attendance/session-missing_student-a', override, 'student-a', 403);
  await write('attendance/session-missing_student-a', override, 'teacher-a');
  await write('sessions/legacy', { courseId: 'course-a' });
  await write('attendance/legacy_student-a', { ...override, sessionId: 'legacy', membershipId: '', attendanceEvidenceId: 'session-a_student-a' }, 'teacher-a');
  await write('instructorStudentAccess/teacher-a/students/student-a', { uid: 'student-a', courseId: 'course-a', membershipId: '', attendanceId: 'session-a_student-a' }, 'teacher-a');
  await read('users/student-a', 'teacher-a');
  await write('courses/course-a', { instructorId: 'teacher-b' });
  await read('users/student-a', 'teacher-a', 403);
  await read('attendance/session-a_student-a', 'teacher-a', 403);
  await write(accessPath, { uid: 'student-a', courseId: 'course-a', membershipId: 'member-a' }, 'teacher-a', 403);
  console.log(`Passed ${assertions} course-ownership, profile-access and historical-override rule checks.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
