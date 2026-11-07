const assert = require('node:assert/strict');
assert.equal(process.env.FACEROLL_STEP6_TEST, '1', 'Isolated Step 6 runner required.');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-faceroll-step6', 'Isolated project required.');
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
const metadata = JSON.parse(process.env.FACEROLL_STEP6_METADATA || '{}');
const allowed = new Set([metadata.apiUrl, metadata.authUrl, metadata.firestoreUrl]);
for (const value of allowed) {
  const url = new URL(value); assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, '127.0.0.1');
}
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = require('firebase/auth');
const lite = require('firebase/firestore/lite');
const nativeFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.ok(allowed.has(url.origin), 'A client attempted to leave the isolated HTTPS endpoints.');
  return nativeFetch(input, options);
};
const config = { apiKey: 'synthetic-step6-key', projectId: 'demo-faceroll-step6' };
const password = 'Synthetic-step6-only-password-482';
const checks = [], apps = [], privateLogs = [];
async function check(name, operation) {
  try { await operation(); checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'failed', code: error.code || error.name }); throw error; }
}
function load(file, stubs) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, __DEV__: true, Date, AbortController, setTimeout, clearTimeout,
    console: { info: (...args) => privateLogs.push(args) }, require: name => { assert.ok(Object.hasOwn(stubs, name), name); return stubs[name]; } });
  return module.exports;
}
function dashboard(app) {
  const window = { firebase: { apps: [app], app: () => app, auth: () => app.auth(), firestore: () => app.firestore() },
    location: { hostname: 'step6.invalid' }, setTimeout, clearTimeout, console: { info() {}, warn() {}, error() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../FaceRoll-System/Instructor-Dashboard/public/js/firebase-client.js'), 'utf8'),
    { window, console: window.console }, { filename: 'firebase-client.js' });
  return window.FaceRollFirebase;
}
// Node's compat SDK selects gRPC instead of the browser's HTTP transport.
// Adapt only the method shape; every read/write/transaction below goes to the
// real Firestore Lite SDK over the HTTPS gateway. No Firestore data is mocked.
function compatFirestore(database, app) {
  // The production browser has one JS realm. Normalize VM plain objects for
  // this Node harness while preserving SDK timestamps and field transforms.
  const nativeData = value => Array.isArray(value) ? Array.from(value, nativeData)
    : value && typeof value === 'object' && value.constructor && value.constructor.name === 'Object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nativeData(item)])) : value;
  const documentSnapshot = snapshot => ({ id: snapshot.id, ref: reference(snapshot.ref, true), exists: snapshot.exists(), data: () => snapshot.data(),
    metadata: { fromCache: false } });
  const reference = (native, document = false) => ({
    native, id: native.id,
    doc: id => reference(lite.doc(native, id), true),
    // Firestore uses instanceof Array; convert arrays crossing the VM boundary
    // into this realm without changing their values or query constraints.
    where: (field, operator, value) => reference(lite.query(native,
      lite.where(field, operator, Array.isArray(value) ? Array.from(value) : value))),
    orderBy: (...args) => reference(lite.query(native, lite.orderBy(...args))),
    limit: count => reference(lite.query(native, lite.limit(count))),
    get: async () => document ? documentSnapshot(await lite.getDoc(native))
      : { docs: (await lite.getDocs(native)).docs.map(documentSnapshot), metadata: { fromCache: false } },
    set: (data, options) => options ? lite.setDoc(native, nativeData(data), options) : lite.setDoc(native, nativeData(data)),
    update: data => lite.updateDoc(native, nativeData(data)),
    delete: () => lite.deleteDoc(native),
  });
  return { app, native: database, collection: name => reference(lite.collection(database, name)),
    runTransaction: operation => lite.runTransaction(database, transaction => operation({
      get: async ref => documentSnapshot(await transaction.get(ref.native)),
      set: (ref, data) => transaction.set(ref.native, nativeData(data)),
      update: (ref, data) => transaction.update(ref.native, nativeData(data)),
    })),
  };
}
const sample = extra => ({ latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null, ...extra });
const image = Buffer.from('match').toString('base64');
let auth, db, api, reads, teacher, teacherDb;
const body = (name, location = sample(), photo = image) => ({ schemaVersion: 1, sessionId: metadata.sessions[name].sessionId, image: photo, location });
const submit = (name, location = sample(), photo = image, options = {}) => api.checkInAttendance(body(name, location, photo), {
  expectedUid: metadata.uid, expectedCourseId: metadata.sessions[name].courseId, ...options,
});
const recordId = name => `${metadata.sessions[name].sessionId}_${metadata.uid}`;
const studentRecord = name => lite.getDoc(lite.doc(db, 'attendance', recordId(name)));
async function rawRequest(payload) {
  return fetch(metadata.apiUrl + '/attendance/check-in', { method: 'POST', redirect: 'error', headers: {
    Authorization: 'Bearer ' + await auth.currentUser.getIdToken(), 'Content-Type': 'application/json',
  }, body: JSON.stringify(payload) });
}
(async () => {
  const app = initializeApp(config, 'step6-student'); apps.push(() => deleteApp(app));
  auth = getAuth(app); connectAuthEmulator(auth, metadata.authUrl, { disableWarnings: true });
  db = lite.initializeFirestore(app, { host: new URL(metadata.firestoreUrl).host, ssl: true });
  const teacherApp = initializeApp(config, 'step6-teacher'); apps.push(() => deleteApp(teacherApp));
  const teacherAuth = getAuth(teacherApp); connectAuthEmulator(teacherAuth, metadata.authUrl, { disableWarnings: true });
  teacherDb = compatFirestore(lite.initializeFirestore(teacherApp, { host: new URL(metadata.firestoreUrl).host, ssl: true }), teacherApp);
  teacher = { name: teacherApp.name, options: teacherApp.options, auth: () => teacherAuth, firestore: () => teacherDb };
  await check('real student and instructor SDK sign-in through trusted HTTPS', async () => {
    await signInWithEmailAndPassword(auth, `${metadata.uid}@example.test`, password);
    await signInWithEmailAndPassword(teacherAuth, `${metadata.teacherUid}@example.test`, password);
    assert.equal(auth.currentUser.uid, metadata.uid);
  });
  const transport = require('../shared/transport-config').resolveTransportConfig({ mode: 'emulator', apiUrl: metadata.apiUrl,
    authEmulatorUrl: metadata.authUrl, firestoreEmulatorUrl: metadata.firestoreUrl }, true);
  api = load('services/recognition.ts', { './runtime-config': { runtimeConfig: transport }, './firebase': { auth },
    'expo/fetch': { fetch: global.fetch }, 'expo-file-system': { File: class {} },
    '../shared/checkin-contract': require('../shared/checkin-contract'), '../shared/checkin-location': require('../shared/checkin-location') });
  reads = load('services/attendance.ts', { 'firebase/firestore': lite, './firebase': { db },
    '../shared/session-access': require('../shared/session-access'), '../shared/session-policy': require('../shared/session-policy'),
    '../shared/checkin-location': require('../shared/checkin-location') });
  let accepted;
  await check('mobile adapter records Present and student/instructor reads agree', async () => {
    accepted = await submit('present'); assert.equal(accepted.status, 'present'); assert.equal(accepted.locationStatus, 'in_zone');
    const row = (await studentRecord('present')).data();
    assert.equal(row.time, accepted.recordedAt); assert.equal(row.status, accepted.status);
    const activity = await reads.getRecentActivity(metadata.uid, 50);
    assert.equal(activity.find(item => item.id === accepted.attendanceId).status, 'present');
    const snapshot = await dashboard(teacher).readInstructorSnapshot({ includeUsers: false });
    assert.equal(snapshot.attendance.find(item => item.id === accepted.attendanceId).time, accepted.recordedAt);
    assert.ok(snapshot.courses.every(item => item.instructorId === metadata.teacherUid));
    assert.ok(!snapshot.courses.some(item => item.courseId === metadata.courses.foreign));
    for (const field of ['image', 'embedding', 'location', 'latitude', 'longitude', 'accuracyMeters']) assert.ok(!Object.hasOwn(row, field));
  });
  await check('duplicate retry after instructor closes session preserves original record', async () => {
    await teacherDb.collection('sessions').doc(metadata.sessions.present.sessionId).update({ status: 'closed', endTime: new Date().toISOString() });
    const repeated = await submit('present'); assert.equal(repeated.duplicate, true); assert.equal(repeated.recordedAt, accepted.recordedAt);
    assert.equal((await studentRecord('present')).data().time, accepted.recordedAt);
  });
  await check('server computes Late and rejects a disabled classroom zone', async () => {
    assert.equal((await submit('late')).status, 'late');
    await assert.rejects(submit('disabled', null), { code: 'location_policy_invalid' });
    assert.equal((await studentRecord('disabled')).exists(), false);
  });
  await check('inside position with overlapping accuracy is rejected without boundary diagnostics', async () => {
    const location = sample({ latitude: 33.0001, accuracyMeters: 5 });
    await assert.rejects(submit('outside', location), error => error.code === 'location_unverified' &&
      !/inside|outside|radius|accuracy|\d/.test(error.message));
    const response = await rawRequest(body('outside', { ...location, capturedAtMs: Date.now() }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const failure = await response.json();
    assert.equal(failure.error, 'location_unverified');
    assert.deepEqual(Object.keys(failure).sort(), ['error', 'message', 'success']);
    assert.equal((await studentRecord('outside')).exists(), false);
  });
  for (const [name, location, code, photo] of [
    ['outside', sample({ latitude: 34 }), 'location_unverified'], ['inaccurate', sample({ accuracyMeters: 100 }), 'location_unverified'],
    ['mocked', sample({ mocked: true }), 'location_mocked'], ['mismatch', null, 'face_not_recognized', Buffer.from('mismatch').toString('base64')],
    ['closed', null, 'attendance_session_closed'], ['no-late', null, 'attendance_late_disabled'], ['expired', null, 'attendance_window_closed'],
  ]) await check('backend rejects ' + name + ' without recording attendance', async () => {
    // Metadata preflight runs first; opted-in requests compare faces before
    // making any location verdict, including outside positions.
    await assert.rejects(submit(name, name === 'mismatch' ? sample() : location ? { ...location, capturedAtMs: Date.now() } : null, photo), { code });
    assert.equal((await studentRecord(name)).exists(), false);
  });
  await check('a face mismatch is rejected before an outside location is evaluated', async () => {
    const response = await rawRequest(body('mismatch', sample({ latitude: 34 }), Buffer.from('mismatch').toString('base64')));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'face_not_recognized');
    assert.equal((await studentRecord('mismatch')).exists(), false);
  });
  await check('backend rejects stale/future fixes and client authority fields independently', async () => {
    for (const [name, capturedAtMs, code] of [['stale', Date.now() - 60000, 'location_stale'], ['future', Date.now() + 60000, 'location_future']]) {
      const response = await rawRequest(body(name, sample({ capturedAtMs })));
      assert.equal((await response.json()).error, code); assert.equal((await studentRecord(name)).exists(), false);
    }
    const response = await rawRequest({ ...body('outside'), uid: metadata.teacherUid, status: 'present' });
    assert.equal(response.status, 400);
  });
  await check('direct student attendance writes and private receipt reads stay denied over HTTPS', async () => {
    await assert.rejects(lite.setDoc(lite.doc(db, 'attendance', recordId('outside')), { id: recordId('outside'), uid: metadata.uid,
      userId: metadata.uid, ...metadata.sessions.outside, status: 'present', source: 'classroom_camera', locationStatus: 'in_zone',
      membershipId: `${metadata.courses.located.length}_${metadata.courses.located}_${metadata.uid}` }), { code: 'permission-denied' });
    await assert.rejects(lite.getDoc(lite.doc(db, 'attendanceCheckIns', accepted.attendanceId)), { code: 'permission-denied' });
  });
  await check('instructor default and manual records appear in student Recent Activity', async () => {
    const instructor = dashboard(teacher);
    for (const [name, source, status] of [['default', 'session_default', 'absent'], ['manual', 'instructor_override', 'late']]) {
      await instructor.createDocumentIfAbsent('attendance', recordId(name), { id: recordId(name), uid: metadata.uid,
        userId: metadata.uid, ...metadata.sessions[name], membershipId: `${metadata.courses.located.length}_${metadata.courses.located}_${metadata.uid}`,
        status, source, method: 'Instructor rehearsal', time: new Date().toISOString(), locationStatus: 'not_checked' });
    }
    const rows = await reads.getRecentActivity(metadata.uid, 50);
    assert.equal(rows.find(row => row.id === recordId('default')).status, 'absent');
    assert.equal(rows.find(row => row.id === recordId('manual')).status, 'late');
  });
  await check('removed membership is rejected using current server data', async () => {
    const membership = teacherDb.collection('enrollments').doc(`${metadata.courses.located.length}_${metadata.courses.located}_${metadata.uid}`);
    await membership.update({ status: 'removed' });
    await assert.rejects(submit('membership'), { code: 'membership_required' });
    await membership.update({ status: 'active' });
  });
  await check('cancelling an upload never applies success and a retry creates at most one record', async () => {
    const controller = new AbortController();
    const pending = submit('cancelled', sample(), Buffer.from('slow-match').toString('base64'), { signal: controller.signal });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(pending, { code: 'check_in_cancelled' });
    const recovered = await submit('cancelled'); assert.equal(recovered.success, true);
    const rows = await lite.getDocs(lite.query(lite.collection(db, 'attendance'), lite.where('uid', '==', metadata.uid)));
    assert.equal(rows.docs.filter(row => row.id === recovered.attendanceId).length, 1);
  });
  await check('backend uses changed saved zone rather than the phone previous zone', async () => {
    await teacherDb.collection('courses').doc(metadata.courses.located).update({ location: { enabled: true,
      latitude: 34, longitude: -97, radiusMeters: 15, addressLabel: 'Synthetic moved classroom',
      updatedBy: metadata.teacherUid, updatedAt: lite.serverTimestamp() } });
    await assert.rejects(submit('changed-zone'), { code: 'location_unverified' });
  });
  await check('opt-out blocks photo submissions and permits location only while deletion is pending', async () => {
    await lite.updateDoc(lite.doc(db, 'users', metadata.uid), { optOutFlag: true, faceEnrolled: false,
      faceConsentRevision: 1, faceDataDeletionStatus: 'pending', faceDeletionRequestedAt: lite.serverTimestamp() });
    await assert.rejects(submit('optout'), { code: 'face_not_allowed' });
    assert.equal((await studentRecord('optout')).exists(), false);
    const accepted = await submit('optout', sample({ latitude: 34 }), null);
    assert.equal(accepted.locationStatus, 'in_zone');
    const row = (await studentRecord('optout')).data();
    assert.equal(row.source, 'phone_location_verification');
    assert.equal(row.method, 'Phone location verification');
    assert.ok(!Object.hasOwn(row, 'image')); assert.ok(!Object.hasOwn(row, 'location'));
    const activity = await reads.getRecentActivity(metadata.uid, 50);
    assert.equal(activity.find(row => row.id === accepted.attendanceId).method, 'Phone location verification');
  });
  await check('location-only mode cannot bypass zone checks or create duplicates', async () => {
    const duplicate = await submit('optout', sample({ latitude: 34 }), null);
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(submit('outside', sample(), null), { code: 'location_unverified' });
    await assert.rejects(submit('disabled', sample(), null), { code: 'location_policy_invalid' });
    assert.equal((await studentRecord('outside')).exists(), false);
  });
  const zoneEditor = dashboard(teacher);
  let nextZoneSession;
  await check('versioned zone saves reject stale tabs and freeze legacy running sessions atomically', async () => {
    const course = (await zoneEditor.readQueryDocs('courses', { filters: [
      { field: 'courseId', operator: '==', value: metadata.courses.located },
      { field: 'instructorId', operator: '==', value: metadata.teacherUid },
    ] }))[0];
    assert.equal(course._documentId, metadata.courses.located);
    const saved = await zoneEditor.saveCourseLocation(course._documentId, course.courseId, course.location,
      { ...course.location, latitude: 35, updatedAt: lite.serverTimestamp(), updatedBy: metadata.teacherUid });
    assert.equal(saved.revision, 1);
    await assert.rejects(zoneEditor.saveCourseLocation(course._documentId, course.courseId, course.location,
      { ...course.location, updatedAt: lite.serverTimestamp() }), { code: 'zone_conflict' });
    const fixed = await submit('outside', sample({ latitude: 34 }), null);
    assert.equal(fixed.locationStatus, 'in_zone');
    const sid = 'step6-zone-next';
    nextZoneSession = await zoneEditor.createSessionWithLocation(course._documentId, sid, {
      id: sid, sessionId: sid, courseId: course.courseId, status: 'active', policyVersion: 1,
      startedAtMs: Date.now() - 1000, startTime: new Date(Date.now() - 1000).toISOString(),
      gracePeriodMinutes: 5, attendanceWindowMinutes: 30, allowLate: true, defaultAttendance: 'absent',
    });
    metadata.sessions['zone-next'] = { sessionId: sid, courseId: course.courseId };
    assert.equal(nextZoneSession.classroomZone.latitude, 35);
  });
  await check('new sessions use the edited zone and frozen snapshots cannot be changed or removed', async () => {
    await assert.rejects(submit('zone-next', sample({ latitude: 34 }), null), { code: 'location_unverified' });
    assert.equal((await submit('zone-next', sample({ latitude: 35 }), null)).locationStatus, 'in_zone');
    const ref = lite.doc(teacherDb.native || teacherDb, 'sessions', nextZoneSession.sessionId);
    await assert.rejects(lite.updateDoc(ref, { classroomZone: { ...nextZoneSession.classroomZone, latitude: 36 } }), { code: 'permission-denied' });
    await assert.rejects(lite.updateDoc(ref, { classroomZone: lite.deleteField(), zonePolicyVersion: lite.deleteField() }), { code: 'permission-denied' });
    const missingSnapshot = { ...nextZoneSession };
    delete missingSnapshot.classroomZone; delete missingSnapshot.zonePolicyVersion;
    await assert.rejects(lite.setDoc(lite.doc(teacherDb.native, 'sessions', 'step6-no-snapshot'), missingSnapshot), { code: 'permission-denied' });
  });
  await check('client debug output contains neither tokens nor photo/location payloads', async () => {
    const output = JSON.stringify(privateLogs);
    for (const secret of [image, await auth.currentUser.getIdToken(), 'latitude', 'longitude', 'accuracyMeters']) assert.ok(!output.includes(secret));
  });
})().catch(error => { console.error('Step 6 synthetic probe failed:', error.stack || error.code); process.exitCode = 1; })
  .finally(async () => {
    for (const dispose of apps.reverse()) await dispose();
    fs.writeFileSync(process.env.FACEROLL_STEP6_RESULT, JSON.stringify({ status: process.exitCode ? 'failed' : 'passed',
      tls: 'trusted CA accepted; untrusted CA, wrong host and plaintext rejected',
      dashboard: 'real data helper with HTTPS Firestore Lite method facade; browser DOM/cache not exercised', checks }, null, 2) + '\n');
  });
