const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/firebase-client.js'), 'utf8');
function harness(authorized = false) {
  let granted = authorized, cachedReads = 0, batchReads = 0;
  const writes = [], gets = [];
  const denied = () => Object.assign(new Error('No access'), { code: 'permission-denied' });
  function ref(collection, id) {
    return {
      collection: name => ({ doc: child => ref(collection + '/' + id + '/' + name, child) }),
      set: async data => { writes.push({ collection, id, data }); granted = true; },
      get: async options => {
        gets.push([collection, id]);
        if (options?.source === 'cache') { cachedReads++; return { exists: true, id, data: () => ({ name: 'Private cached profile' }) }; }
        if (collection === 'users' && id === 'student' && !granted) throw denied();
        return { exists: true, id, data: () => ({ uid: id, name: 'Student', role: id === 'teacher' ? 'instructor' : 'student' }) };
      },
    };
  }
  const db = { collection: name => ({ doc: id => ref(name, id), where() { batchReads++; throw new Error('Profiles must not use a batch query'); } }) };
  const firestore = () => db; firestore.FieldPath = { documentId: () => '__name__' };
  const firebase = { apps: [{}], app() {}, firestore, auth: () => ({ currentUser: { uid: 'teacher' } }) };
  const window = { firebase, location: { hostname: 'example.test' }, console: { info() {} } };
  vm.runInNewContext(source, { window });
  return { api: window.FaceRollFirebase, writes, gets, cachedReads: () => cachedReads, batchReads: () => batchReads };
}

test('a student profile read establishes membership-backed access only after Firestore denies an unlinked read', async () => {
  const h = harness();
  const rows = await h.api.readDocuments('users', ['student'], { enrollments: [{ id: 'member', uid: 'student', courseId: 'course' }] });
  assert.equal(rows[0].id, 'student');
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes)), [{ collection: 'instructorStudentAccess/teacher/students', id: 'student', data: { uid: 'student', courseId: 'course', membershipId: 'member' } }]);
  assert.equal(h.cachedReads(), 0); assert.equal(h.batchReads(), 0);
});

test('existing authorized profile reads do not rewrite access links', async () => {
  const h = harness(true); await h.api.readDocuments('users', ['student']);
  assert.equal(h.writes.length, 0);
});

test('unauthorized profile reads cannot fall back to old cached data or fabricate access', async () => {
  const h = harness();
  await assert.rejects(h.api.readDocuments('users', ['student'], { enrollments: [] }), { code: 'permission-denied' });
  assert.equal(h.cachedReads(), 0); assert.equal(h.writes.length, 0);
});

test('historical attendance can establish profile access when a legacy membership is missing', async () => {
  const h = harness();
  await h.api.readDocuments('users', ['student'], { attendance: [{ id: 'legacy-attendance', uid: 'student', courseId: 'course' }] });
  assert.equal(h.writes[0].data.attendanceId, 'legacy-attendance');
});
