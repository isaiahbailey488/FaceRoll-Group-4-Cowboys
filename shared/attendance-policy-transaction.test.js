const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const policy = require('./session-policy');
const source = ts.transpileModule(fs.readFileSync('services/attendance.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function harness(session, existing = false) {
  const writes = [];
  const exported = {};
  const firestore = {
    collection: (_db, name) => name, doc: (_db, collection, id) => ({ collection, id }),
    runTransaction: async (_db, callback) => callback({
      get: async ref => {
        const value = ref.collection === 'sessions' ? session : ref.collection === 'enrollments'
          ? { uid: 'student', courseId: 'course', status: 'active' } : existing ? (existing === true ? {} : existing) : null;
        return { exists: () => value !== null, data: () => value };
      },
      set: (ref, data) => writes.push({ ref, data }),
    }),
  };
  vm.runInNewContext(source, { exports: exported, Date, console, require: name => {
    if (name === 'firebase/firestore') return firestore;
    if (name === './firebase') return { db: {} };
    if (name === '../shared/session-access') return require('./session-access');
    if (name === '../shared/session-policy') return policy;
    throw new Error('Unexpected import ' + name);
  } });
  return { submit: () => exported.submitAttendance({ uid: 'student', sessionId: 'session', courseId: 'course', status: 'present' }), writes };
}

test('attendance writes compute status from the freshly read session, ignoring a caller-supplied present status', async () => {
  const row = { status: 'active', courseId: 'course', ...policy.snapshot({ gracePeriodMinutes: 1, allowLate: true }, Date.now() - 2 * 60000) };
  const h = harness(row);
  await h.submit();
  assert.equal(h.writes[0].data.status, 'late');
});

test('expired, late-disabled and closing sessions cannot create attendance', async () => {
  for (const fields of [
    { attendanceWindowMinutes: 1, allowLate: true },
    { attendanceWindowMinutes: 30, gracePeriodMinutes: 1, allowLate: false },
    { status: 'closing' },
  ]) {
    const row = { courseId: 'course', ...policy.snapshot(fields, Date.now() - 2 * 60000), status: fields.status || 'active' };
    const h = harness(row);
    await assert.rejects(h.submit);
    assert.equal(h.writes.length, 0);
  }
});

test('duplicate check-in never overwrites the original record', async () => {
  const h = harness({ status: 'closed' }, true);
  assert.equal((await h.submit()).duplicate, true);
  assert.equal(h.writes.length, 0);
});

test('a finalized default attendance record cannot be mistaken for a successful phone check-in', async () => {
  const h = harness({ status: 'closed' }, { source: 'session_default', status: 'absent' });
  await assert.rejects(h.submit, { code: 'attendance_session_closed' });
  assert.equal(h.writes.length, 0);
});
