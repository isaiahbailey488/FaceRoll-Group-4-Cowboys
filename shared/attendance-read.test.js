const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const policy = require('./session-policy');

// Exercise the real mobile read service. Any attempt to import a Firestore
// write primitive fails, rather than mocking writes as successful check-ins.
function harness(records) {
  const calls = [];
  const firestore = new Proxy({
    collection: (_db, name) => name,
    where: (field, operator, value) => ({ field, operator, value }),
    limit: value => ({ limit: value }),
    query: (name, ...filters) => ({ name, filters }),
    getDocs: async query => {
      calls.push(query);
      let rows = records[query.name] || [];
      for (const filter of query.filters) {
        if (filter.field) {
          assert.equal(filter.operator, '==');
          rows = rows.filter(row => row[filter.field] === filter.value);
        } else rows = rows.slice(0, filter.limit);
      }
      return { size: rows.length, empty: rows.length === 0, docs: rows.map(row => ({ id: row.id, data: () => row })) };
    },
  }, { get: (object, name) => {
    assert.ok(Object.hasOwn(object, name), `Mobile attendance must not import Firestore writes: ${String(name)}`);
    return object[name];
  } });
  const stubs = { 'firebase/firestore': firestore, './firebase': { db: {} },
    '../shared/session-access': require('./session-access'), '../shared/session-policy': policy,
    '../shared/checkin-location': require('./checkin-location') };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync('services/attendance.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Date, require: name => {
    assert.ok(Object.hasOwn(stubs, name), name); return stubs[name];
  } });
  return { api: module.exports, calls };
}

test('both Firestore deployment entry points keep the same attendance security boundary', () => {
  const normalize = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(normalize('firestore.rules'), normalize('FaceRoll-System/Instructor-Dashboard/firestore.rules'));
});

test('mobile reads backend attendance with a UID filter, sorts newest first and keeps server status', async () => {
  const h = harness({
    attendance: [
      { id: 'old', uid: 'student', courseId: 'course', sessionId: 'session', time: '2026-10-02T10:00:00.000Z', status: 'present' },
      { id: 'recent', uid: 'student', courseId: 'course', sessionId: 'session', time: '2026-10-03T10:00:00.000Z', status: 'late', method: 'Phone face verification' },
      { id: 'private-other', uid: 'other', courseId: 'course', time: '2026-10-04T10:00:00.000Z', status: 'absent' },
    ],
    sessions: [{ id: 'session', sessionId: 'session', courseId: 'course' }],
    courses: [{ id: 'course', courseId: 'course', courseName: 'Capstone' }],
  });
  const rows = await h.api.getRecentActivity('student', 1);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'recent'); assert.equal(rows[0].status, 'late');
  assert.equal(rows[0].courseName, 'Capstone'); assert.equal(rows[0].method, 'Phone face verification');
  assert.deepEqual(h.calls[0], { name: 'attendance', filters: [{ field: 'uid', operator: '==', value: 'student' }] });
  assert.equal(h.api.submitAttendance, undefined); assert.equal(h.api.buildAttendanceDocumentId, undefined);
});

test('mobile session reads preserve active membership filtering and saved course location requirements', async () => {
  const session = (courseId, extra = {}) => ({ id: `s-${courseId}`, sessionId: `s-${courseId}`, courseId,
    ...policy.snapshot({}, Date.now() - 60000), status: 'active', ...extra });
  const h = harness({
    sessions: [session('course'), session('dropped'), session('other'), session('closed', { status: 'closed' })],
    enrollments: [
      { uid: 'student', courseId: 'course', status: 'active' }, { uid: 'student', courseId: 'dropped', status: 'dropped' },
      { uid: 'other', courseId: 'other', status: 'active' }, { uid: 'student', courseId: 'closed', status: 'active' },
    ],
    courses: [{ id: 'course', courseId: 'course', courseName: 'Capstone',
      location: { enabled: true, latitude: 33, longitude: -97, radiusMeters: 15 } }],
  });
  const sessions = await h.api.getActiveSessions('student');
  assert.equal(sessions.length, 1); assert.equal(sessions[0].courseId, 'course');
  assert.equal(sessions[0].locationRequirement.kind, 'required'); assert.equal(sessions[0].locationRequirement.radiusMeters, 15);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.api.getActiveSessionForUser('student'))), { sessionId: 's-course', courseId: 'course' });
});

test('mobile uses the frozen session zone instead of later course edits and rejects unknown zone versions', async () => {
  const create = (id, version, zone) => ({ id, sessionId: id, courseId: 'course', ...policy.snapshot({}, Date.now() - 1000),
    status: 'active', zonePolicyVersion: version, classroomZone: zone });
  const h = harness({ sessions: [
    create('fixed', 1, { enabled: true, latitude: 33, longitude: -97, radiusMeters: 10 }),
    create('bad-version', 2, { enabled: true, latitude: 33, longitude: -97, radiusMeters: 10 }),
  ], enrollments: [{ uid: 'student', courseId: 'course', status: 'active' }],
  courses: [{ id: 'course', courseId: 'course', location: { enabled: true, latitude: 34, longitude: -97, radiusMeters: 15 } }] });
  const sessions = await h.api.getActiveSessions('student');
  assert.equal(sessions.find(row => row.sessionId === 'fixed').locationRequirement.radiusMeters, 10);
  assert.equal(sessions.find(row => row.sessionId === 'bad-version').locationRequirement.kind, 'unavailable');
});
