const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../public/js/attendance-history');
const now = Date.parse('2026-10-29T15:00:00Z');
const date = day => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`;
function fixture() {
  return { courses: [{ id: 'course' }], users: [{ id: 'student', studentId: '1234567' }],
    sessions: [1, 2, 3, 4].map(day => ({ id: 's' + day, courseId: 'course', status: 'closed', startTime: date(day) })),
    enrollments: [{ id: 'member', uid: 'student', courseId: 'course', status: 'active', createdAt: date(1) }],
    attendance: [{ id: 's1_student', uid: 'student', sessionId: 's1', courseId: 'course', status: 'present', time: date(1) }],
  };
}

test('historical missing records count as absent without modifying stored input', () => {
  const input = fixture(), before = structuredClone(input);
  input.attendance.push({ id: 's2_student', uid: 'student', sessionId: 's2', courseId: 'course', status: 'late' });
  before.attendance = structuredClone(input.attendance);
  const rows = history.completeAttendance(input, now);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter(row => ['present', 'late'].includes(row.status)).length / rows.length, 0.5);
  assert.deepEqual(rows.filter(row => row.inferred).map(row => row.sessionId), ['s3', 's4']);
  assert.deepEqual(input, before);
});

test('membership dates exclude sessions before a student joined', () => {
  const input = fixture(); input.enrollments[0].createdAt = date(3); input.attendance = [];
  assert.deepEqual(history.completeAttendance(input, now).map(row => row.sessionId), ['s3', 's4']);
});

test('undated membership starts at the first recorded check-in, not the first course session', () => {
  const input = fixture(); delete input.enrollments[0].createdAt;
  input.attendance[0].sessionId = 's2'; input.attendance[0].id = 's2_student';
  assert.deepEqual(history.completeAttendance(input, now).map(row => row.sessionId), ['s2', 's3', 's4']);
  input.attendance = [];
  assert.deepEqual(history.completeAttendance(input, now), []);
});

test('legacy check-ins without a membership still establish a conservative baseline', () => {
  const input = fixture(); input.enrollments = [];
  input.attendance[0].sessionId = 's3'; input.attendance[0].id = 'legacy-record';
  const rows = history.completeAttendance(input, now);
  assert.equal(rows.length, 2); assert.equal(rows[1].attendanceEvidenceId, 'legacy-record');
});

test('removed students are not penalized after removal, or during recorded enrollment gaps', () => {
  const input = fixture(); input.attendance = [];
  Object.assign(input.enrollments[0], { status: 'removed', updatedAt: date(3) });
  assert.deepEqual(history.completeAttendance(input, now).map(row => row.sessionId), ['s1', 's2']);
  Object.assign(input.enrollments[0], { status: 'active', attendancePeriods: [
    { start: date(1), end: date(2) }, { start: date(4), end: null },
  ] });
  assert.deepEqual(history.completeAttendance(input, now).map(row => row.sessionId), ['s1', 's4']);
});

test('unknown departure dates cannot fabricate absences after the last known enrollment', () => {
  const input = fixture(); input.enrollments[0].status = 'removed';
  assert.equal(history.completeAttendance(input, now).length, 1);
});

test('running, closing, future, failed and cancelled sessions never generate missing absences', () => {
  const input = fixture(); input.attendance = [];
  input.sessions = ['active', 'closing', 'starting', 'start_failed', 'cancelled'].map((status, index) => ({
    id: 'state' + index, courseId: 'course', status, startTime: date(1), policyVersion: 1,
  }));
  input.sessions.push({ id: 'future', courseId: 'course', status: 'closed', startTime: '2026-11-01T10:00:00Z' });
  assert.deepEqual(history.completeAttendance(input, now), []);
});

test('old sessions abandoned by navigation expire after their original three-hour window', () => {
  const input = fixture(); input.attendance = []; input.sessions[0].status = 'active';
  assert.equal(history.completeAttendance(input, now).some(row => row.sessionId === 's1'), true);
  input.sessions[0].policyVersion = 1;
  assert.equal(history.completeAttendance(input, now).some(row => row.sessionId === 's1'), false);
});

test('one student/session is counted once, with canonical overrides preferred to old duplicates', () => {
  const input = fixture(); input.enrollments = []; input.sessions = input.sessions.slice(0, 1);
  input.attendance.push({ id: 'duplicate-photo', uid: '1234567', courseId: 'course', sessionId: 's1', status: 'late', time: date(4) });
  const rows = history.completeAttendance(input, now);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'present');
});

test('real defaults and manual overrides remain authoritative', () => {
  const input = fixture(); input.attendance[0].source = 'session_default';
  input.attendance.push({ id: 's2_student', uid: 'student', courseId: 'course', sessionId: 's2', status: 'late', source: 'instructor_override' });
  const rows = history.completeAttendance(input, now);
  assert.equal(rows[0].status, 'present'); assert.equal(rows[1].status, 'late');
  assert.equal(rows[1].inferred, undefined);
});

test('students with the same name and separate sessions on the same day retain distinct records', () => {
  const input = fixture(); input.users.push({ id: 'second-student', name: 'Same Name' });
  input.sessions[1].startTime = date(1);
  input.enrollments.push({ id: 'second-member', uid: 'second-student', courseId: 'course', status: 'active', createdAt: date(1) });
  assert.equal(history.completeAttendance(input, now).length, 8);
});
