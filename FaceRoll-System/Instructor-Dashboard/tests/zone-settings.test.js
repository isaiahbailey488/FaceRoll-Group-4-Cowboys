const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/firebase-client.js'), 'utf8');
const zone = () => ({ enabled: true, latitude: 33, longitude: -97, radiusMeters: 15,
  addressLabel: 'Classroom', updatedAt: { seconds: 10, nanoseconds: 0 }, updatedBy: 'teacher' });
function harness(id = 'COURSE') {
  const rows = new Map([['courses/' + id, { courseId: 'COURSE', instructorId: 'teacher', location: zone() }],
    ['sessions/legacy', { courseId: 'COURSE', status: 'active' }]]);
  const writes = [], refs = new Map();
  const ref = key => {
    if (!refs.has(key)) refs.set(key, { key });
    return refs.get(key);
  };
  const snapshot = key => ({ exists: rows.has(key), ref: ref(key), id: key.split('/')[1],
    data: () => structuredClone(rows.get(key)) });
  const db = { collection: name => ({ doc: id => ref(name + '/' + id),
    where: (field, operator, value) => ({ get: async () => ({ docs: [...rows].filter(([key, data]) => key.startsWith(name + '/') && data[field] === value).map(([key]) => snapshot(key)) }) }),
  }), runTransaction: async callback => {
    const pending = [];
    const result = await callback({ get: async reference => snapshot(reference.key),
      update: (reference, data) => pending.push([reference.key, data]),
      set: (reference, data) => pending.push([reference.key, data]) });
    for (const [key, data] of pending) { rows.set(key, { ...(rows.get(key) || {}), ...structuredClone(data) }); writes.push(key); }
    return result;
  } };
  const firebase = { apps: [{}], app() {}, firestore: () => db, auth: () => ({ currentUser: { uid: 'teacher' } }) };
  const window = { firebase, location: { hostname: 'dashboard.test' }, setTimeout, clearTimeout };
  vm.runInNewContext(source, { window });
  return { api: window.FaceRollFirebase, rows, writes };
}

test('saving a zone freezes legacy running sessions, increments revision and preserves other course fields', async () => {
  const h = harness(), expected = zone();
  const saved = await h.api.saveCourseLocation('COURSE', 'COURSE', expected, { ...expected, latitude: 34 });
  assert.equal(saved.revision, 1);
  assert.equal(h.rows.get('courses/COURSE').location.latitude, 34);
  assert.equal(h.rows.get('courses/COURSE').instructorId, 'teacher');
  assert.equal(h.rows.get('sessions/legacy').zonePolicyVersion, 1);
  assert.equal(h.rows.get('sessions/legacy').classroomZone.latitude, 33);
});

test('stale tabs cannot overwrite a newer zone or freeze sessions using stale settings', async () => {
  const h = harness(), stale = zone();
  h.rows.get('courses/COURSE').location = { ...zone(), latitude: 34, revision: 1 };
  await assert.rejects(h.api.saveCourseLocation('COURSE', 'COURSE', stale, zone()), { code: 'zone_conflict' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.rows.get('sessions/legacy').zonePolicyVersion, undefined);
});

test('legacy document IDs are used directly instead of creating another course document', async () => {
  const h = harness('old-firestore-id');
  await h.api.saveCourseLocation('old-firestore-id', 'COURSE', zone(), { ...zone(), radiusMeters: 10 });
  assert.equal(h.rows.has('courses/COURSE'), false);
  assert.equal(h.rows.get('courses/old-firestore-id').location.radiusMeters, 10);
});

test('new sessions freeze the current zone, while later course edits apply to the next session', async () => {
  const h = harness();
  const first = await h.api.createSessionWithLocation('COURSE', 'one', { courseId: 'COURSE', status: 'starting' });
  await h.api.saveCourseLocation('COURSE', 'COURSE', zone(), { ...zone(), latitude: 34 });
  const next = await h.api.createSessionWithLocation('COURSE', 'two', { courseId: 'COURSE', status: 'starting' });
  assert.equal(first.zonePolicyVersion, 1); assert.equal(first.classroomZone.latitude, 33);
  assert.equal(h.rows.get('sessions/one').classroomZone.latitude, 33);
  assert.equal(next.classroomZone.latitude, 34);
});

test('zone transactions reject changed ownership, missing courses and duplicate sessions', async () => {
  const h = harness();
  h.rows.get('courses/COURSE').instructorId = 'other';
  await assert.rejects(h.api.saveCourseLocation('COURSE', 'COURSE', zone(), zone()));
  await assert.rejects(h.api.createSessionWithLocation('COURSE', 'one', { courseId: 'COURSE' }));
  h.rows.get('courses/COURSE').instructorId = 'teacher';
  await h.api.createSessionWithLocation('COURSE', 'one', { courseId: 'COURSE' });
  await assert.rejects(h.api.createSessionWithLocation('COURSE', 'one', { courseId: 'COURSE' }));
  await assert.rejects(h.api.createSessionWithLocation('missing', 'two', { courseId: 'COURSE' }));
});
