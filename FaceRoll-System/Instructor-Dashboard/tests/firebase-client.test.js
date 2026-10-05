'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'firebase-client.js'),
  'utf8'
);

function initializationHarness(hostname, initialized = false, autoConfigured = false, persistence = false) {
  const calls = [];
  const auth = {
    emulatorConfig: autoConfigured ? { host: '127.0.0.1', port: 9099, protocol: 'http:' } : null,
    useEmulator: (url) => calls.push(['auth', url]),
    signInWithEmailAndPassword: async () => {
      calls.push(['signIn']);
      return { user: { uid: 'local-user' } };
    },
  };
  const firestore = {
    _delegate: { _settings: { host: autoConfigured ? '127.0.0.1:8080' : 'firestore.googleapis.com' } },
    useEmulator: (host, port) => calls.push(['firestore', host, port]),
  };
  if (persistence) {
    firestore.enablePersistence = async function (options) {
      calls.push(['persistence', options.synchronizeTabs]);
    };
  }
  const firebase = {
    apps: initialized ? [{}] : [],
    app: function () {},
    initializeApp: function (config) { calls.push(['initialize', config.projectId]); this.apps.push({}); },
    auth: () => auth,
    firestore: () => firestore,
  };
  const window = { firebase, location: { hostname }, setTimeout, console: { info() {} } };
  vm.runInNewContext(clientSource, { window }, { filename: 'firebase-client.js' });
  return { window, calls, auth, firestore };
}

test('local login initializes missing Hosting config and connects emulators before sign-in', async function () {
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const { window, calls } = initializationHarness(hostname);
    await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
    await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
    assert.deepEqual(calls, [
      ['initialize', 'rollcall-2669b'], ['auth', 'http://127.0.0.1:9099'],
      ['firestore', '127.0.0.1', 8080], ['signIn'], ['signIn'],
    ]);
  }
});

test('existing Hosting app is reused after Hosting configures local emulators', async function () {
  const { window, calls } = initializationHarness('localhost', true, true);
  await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.deepEqual(calls, [['signIn']]);
});

test('Firestore persistence initializes once and synchronizes dashboard tabs', async function () {
  const { window, calls } = initializationHarness('localhost', true, true, true);
  await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.deepEqual(calls, [
    ['persistence', true], ['signIn'], ['signIn'],
  ]);
});

test('private network dashboard addresses are forced onto local emulators', async function () {
  for (const hostname of ['192.168.1.193', '10.0.0.12', '172.22.160.1', '100.90.80.70']) {
    const { window, calls } = initializationHarness(hostname, true);
    await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
    assert.deepEqual(calls, [
      ['auth', 'http://127.0.0.1:9099'],
      ['firestore', '127.0.0.1', 8080],
      ['signIn'],
    ]);
  }
});

test('local-only mode refuses authentication if emulator configuration fails', async function () {
  const harness = initializationHarness('192.168.1.193', true);
  harness.auth.useEmulator = function () { throw new Error('auth already used against production'); };

  await assert.rejects(
    harness.window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password'),
    /already used against production/
  );
  assert.equal(harness.calls.some(function (call) { return call[0] === 'signIn'; }), false);
});

test('every dashboard page requests automatic Firebase emulator configuration', function () {
  const publicDir = path.join(__dirname, '../public');
  const pages = fs.readdirSync(publicDir).filter(function (name) { return name.endsWith('.html'); });
  assert.ok(pages.length > 0);
  pages.forEach(function (name) {
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    if (!html.includes('/__/firebase/init.js')) return;
    assert.match(html, /\/__\/firebase\/init\.js\?useEmulator=true/);
  });
});

test('deployed dashboard does not initialize local fallback or connect emulators', async function () {
  const { window, calls } = initializationHarness('rollcall-2669b.web.app', true);
  await window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.deepEqual(calls, [['signIn']]);
});

test('missing production Hosting config never receives a local fallback', async function () {
  const { window, calls } = initializationHarness('rollcall-2669b.web.app');
  let pending;
  window.setTimeout = (callback) => { pending = callback; };
  const login = window.FaceRollFirebase.signInWithEmail('test@example.test', 'test-password');
  assert.equal(typeof pending, 'function');
  assert.deepEqual(calls, []);
  // Finish the pending login with a subsequently loaded Hosting app.
  window.firebase.apps.push({});
  pending();
  await login;
  assert.deepEqual(calls, [['signIn']]);
});

function loadFirebaseClient(existingDocument) {
  const writes = [];
  const documentRef = { path: 'attendance/session_student' };
  const db = {
    collection: function () {
      return {
        doc: function () {
          return documentRef;
        },
      };
    },
    runTransaction: async function (handler) {
      return handler({
        get: async function (receivedRef) {
          assert.equal(receivedRef, documentRef);
          return { exists: existingDocument };
        },
        set: function (receivedRef, data) {
          writes.push({ ref: receivedRef, data: data });
        },
      });
    },
  };
  const firebase = {
    apps: [{}],
    app: function () {},
    firestore: function () {
      return db;
    },
  };
  const window = {
    firebase: firebase,
    location: { hostname: 'dashboard.test' },
    setTimeout: setTimeout,
  };

  vm.runInNewContext(clientSource, { window: window }, { filename: 'firebase-client.js' });
  return { api: window.FaceRollFirebase, writes: writes, documentRef: documentRef };
}

test('creates a deterministic attendance document when it does not exist', async function () {
  const harness = loadFirebaseClient(false);
  const attendance = {
    uid: 'student-uid',
    sessionId: 'session',
    source: 'classroom_camera',
  };

  const created = await harness.api.createDocumentIfAbsent(
    'attendance',
    'session_student-uid',
    attendance
  );

  assert.equal(created, true);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].ref, harness.documentRef);
  assert.deepEqual(harness.writes[0].data, attendance);
});

test('does not overwrite attendance that already exists', async function () {
  const harness = loadFirebaseClient(true);

  const created = await harness.api.createDocumentIfAbsent(
    'attendance',
    'session_student-uid',
    { source: 'classroom_camera' }
  );

  assert.equal(created, false);
  assert.equal(harness.writes.length, 0);
});

function loadStudentIdHarness(profile) {
  const writes = [];
  const userRef = { collection: 'users', id: 'legacy-student' };
  const firestore = function () { return db; };
  const db = {
    collection: function (name) {
      return {
        doc: function (id) {
          return name === 'users' ? userRef : { collection: name, id: id };
        },
      };
    },
    runTransaction: async function (handler) {
      return handler({
        get: async function (ref) {
          assert.equal(ref, userRef);
          return { exists: true, data: function () { return profile; } };
        },
        set: function (ref, data, options) {
          writes.push({ ref: ref, data: data, options: options });
        },
      });
    },
  };
  const firebase = { apps: [{}], app: function () {}, firestore: firestore };
  const window = { firebase: firebase, location: { hostname: 'dashboard.test' }, setTimeout: setTimeout };
  vm.runInNewContext(clientSource, { window: window, Math: Math }, { filename: 'firebase-client.js' });
  return { api: window.FaceRollFirebase, writes: writes, userRef: userRef };
}

test('upgrades a legacy student profile with a seven-digit ID on the user document', async function () {
  const harness = loadStudentIdHarness({
    uid: 'legacy-student', role: 'student', studentId: 'legacy-student',
  });

  const studentId = await harness.api.ensureSevenDigitStudentId('legacy-student');

  assert.match(studentId, /^\d{7}$/);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].ref, harness.userRef);
  assert.equal(harness.writes[0].data.studentId, studentId);
  assert.equal(harness.writes[0].options.merge, true);
});

test('keeps an existing seven-digit student ID unchanged', async function () {
  const harness = loadStudentIdHarness({
    uid: 'legacy-student', role: 'student', studentId: '4827316',
  });

  const studentId = await harness.api.ensureSevenDigitStudentId('legacy-student');

  assert.equal(studentId, '4827316');
  assert.equal(harness.writes.length, 0);
});

function loadQueryHarness(options) {
  const settings = options || {};
  const calls = [];
  const sessionValues = settings.sessionValues || new Map();
  const documents = [{ id: 'course-a', data: function () { return { name: 'Course A' }; } }];
  const query = {
    where: function (field, operator, value) { calls.push(['where', field, operator, value]); return this; },
    orderBy: function (field, direction) { calls.push(['orderBy', field, direction]); return this; },
    limit: function (value) { calls.push(['limit', value]); return this; },
    get: async function () { calls.push(['get']); return { docs: documents }; },
    onSnapshot: function (next) { calls.push(['onSnapshot']); next({ docs: documents }); return function () {}; },
  };
  const documentRef = {
    onSnapshot: function (next) {
      calls.push(['documentSnapshot']);
      next({ exists: true, id: 'instructor-a', data: function () { return { role: 'instructor' }; },
        metadata: { fromCache: true, hasPendingWrites: false } });
      return function () {};
    },
  };
  const db = { collection: function () { return Object.assign(Object.create(query), { doc: function () { return documentRef; } }); } };
  const firestore = function () { return db; };
  if (settings.withDocumentIdFieldPath) {
    firestore.FieldPath = { documentId: function () { return '__name__'; } };
  }
  const firebase = { apps: [{}], app: function () {}, firestore: firestore };
  if (settings.withAuth) {
    firebase.auth = function () { return { currentUser: { uid: 'instructor-a' } }; };
  }
  const window = { firebase: firebase, location: { hostname: 'dashboard.test' }, setTimeout: setTimeout,
    sessionStorage: {
      getItem: function (key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
      setItem: function (key, value) { sessionValues.set(key, String(value)); },
      removeItem: function (key) { sessionValues.delete(key); },
    } };
  vm.runInNewContext(clientSource, { window: window }, { filename: 'firebase-client.js' });
  return { api: window.FaceRollFirebase, calls: calls, sessionValues: sessionValues };
}

test('cached instructor snapshots are scoped to the signed-in instructor', function () {
  const harness = loadQueryHarness();
  harness.sessionValues.set('faceroll.instructor-snapshot.v1', JSON.stringify({
    instructorUid: 'teacher-a',
    savedAt: Date.now(),
    snapshot: {
      instructor: { uid: 'teacher-a', email: 'teacher@example.test' },
      users: [{ id: 'student-a', firstName: 'Student', faceEmbedding: [1, 2, 3] }],
      courses: [{ id: 'course-a' }], sessions: [],
      attendance: [
        { id: 'attendance-a', courseId: 'course-a', createdAt: '2026-10-04T12:00:00Z', status: 'present' },
        { id: 'attendance-b', courseId: 'course-b', createdAt: '2026-10-05T12:00:00Z', status: 'late' },
      ],
      enrollments: [],
    },
  }));

  const cached = harness.api.readCachedInstructorSnapshot('teacher-a');
  assert.equal(cached.instructor.uid, 'teacher-a');
  assert.equal(cached.courses[0].id, 'course-a');
  assert.equal(cached.users[0].faceEmbedding, undefined);
  assert.equal(cached.attendance.length, 2);
  assert.equal(harness.api.readCachedAttendance('teacher-a', {
    courseIds: ['course-a'], date: '2026-10-04',
  })[0].id, 'attendance-a');
  assert.equal(harness.sessionValues.has(
    'faceroll.instructor-cache.v2.teacher-a.attendance-course-a~2026-10-04'
  ), true);
  assert.equal(harness.sessionValues.has('faceroll.instructor-cache.v2.teacher-a.users'), true);
  assert.equal(harness.sessionValues.has('faceroll.instructor-snapshot.v1'), false);
  assert.equal(harness.api.readCachedAuthUserSummary().uid, 'teacher-a');
  assert.equal(harness.api.readCachedInstructorSnapshot('teacher-b'), null);
  harness.api.clearInstructorSnapshotCache();
  assert.equal(harness.api.readCachedInstructorSnapshot('teacher-a'), null);
  assert.equal(harness.api.readCachedAuthUserSummary(), null);
});

test('reads referenced documents in a batched document ID query', async function () {
  const harness = loadQueryHarness({ withDocumentIdFieldPath: true });
  const rows = await harness.api.readDocuments('users', ['student-a', 'student-b']);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'course-a');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls)), [
    ['where', '__name__', 'in', ['student-a', 'student-b']],
    ['get'],
  ]);
});

test('instructor snapshot loads sessions, enrollments, and attendance by course', async function () {
  const harness = loadQueryHarness({ withAuth: true });
  await harness.api.readInstructorSnapshot({ includeUsers: false });
  const filters = harness.calls.filter(function (call) { return call[0] === 'where'; });

  assert.equal(filters[0][1], 'instructorId');
  assert.equal(filters[0][3], 'instructor-a');
  assert.equal(filters.filter(function (call) {
    return call[1] === 'courseId' && call[2] === '==' && call[3] === 'course-a';
  }).length, 3);
  assert.equal(filters.some(function (call) { return call[1] === 'sessionId'; }), false);
});

test('reads a filtered ordered and limited Firestore query', async function () {
  const harness = loadQueryHarness();
  const rows = await harness.api.readQueryDocs('courses', {
    filters: [{ field: 'instructorId', operator: '==', value: 'instructor-a' }],
    orderBy: { field: 'name', direction: 'desc' },
    limit: 25,
  });
  assert.deepEqual(harness.calls, [
    ['where', 'instructorId', '==', 'instructor-a'],
    ['orderBy', 'name', 'desc'],
    ['limit', 25],
    ['get'],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'course-a');
  assert.equal(rows[0].name, 'Course A');
});

test('deduplicates matching Firestore reads that are already in flight', async function () {
  const harness = loadQueryHarness();
  const queryOptions = {
    filters: [{ field: 'instructorId', operator: '==', value: 'instructor-a' }],
  };
  const rows = await Promise.all([
    harness.api.readQueryDocs('courses', queryOptions),
    harness.api.readQueryDocs('courses', queryOptions),
  ]);

  assert.equal(rows[0][0].id, 'course-a');
  assert.equal(rows[1][0].id, 'course-a');
  assert.equal(harness.calls.filter(function (call) { return call[0] === 'get'; }).length, 1);
});

test('stale-while-revalidate reads cached query data before Firestore responds', async function () {
  const sharedSession = new Map();
  const firstPage = loadQueryHarness({ sessionValues: sharedSession, withAuth: true });
  const queryOptions = {
    filters: [{ field: 'instructorId', operator: '==', value: 'instructor-a' }],
  };
  await firstPage.api.readQueryDocs('courses', queryOptions);
  sharedSession.delete('faceroll.shared-data-cache.v1');

  const nextPage = loadQueryHarness({ sessionValues: sharedSession, withAuth: true });
  const updates = [];
  await nextPage.api.readQueryDocsSWR('courses', queryOptions, function (rows, info) {
    updates.push({ id: rows[0].id, source: info.source });
  });

  assert.deepEqual(updates, [{ id: 'course-a', source: 'cache' }]);
  assert.equal(nextPage.calls.filter(function (call) { return call[0] === 'get'; }).length, 1);
});

test('filtered subscriptions and document subscriptions return normalized data', async function () {
  const harness = loadQueryHarness();
  let courses;
  let profile;
  let profileInfo;
  await harness.api.subscribeQueryDocs('courses', {
    filters: [{ field: 'instructorId', operator: '==', value: 'instructor-a' }],
  }, function (rows) { courses = rows; });
  await harness.api.subscribeDocument('users', 'instructor-a', function (value, info) {
    profile = value;
    profileInfo = info;
  });
  assert.equal(courses.length, 1);
  assert.equal(courses[0].id, 'course-a');
  assert.equal(courses[0].name, 'Course A');
  assert.equal(profile.id, 'instructor-a');
  assert.equal(profile.role, 'instructor');
  assert.equal(profileInfo.fromCache, true);
  assert.equal(profileInfo.hasPendingWrites, false);
  assert.deepEqual(harness.calls, [
    ['where', 'instructorId', '==', 'instructor-a'],
    ['onSnapshot'],
    ['documentSnapshot'],
  ]);
});
