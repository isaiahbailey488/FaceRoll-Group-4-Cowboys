const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const contracts = require('./checkin-contract');
const location = require('./checkin-location');
const flush = () => new Promise(setImmediate);
const now = Date.now();
const input = () => ({ schemaVersion: 1, sessionId: 'session', image: 'aW1hZ2U=',
  location: { latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: now, mocked: null } });
const result = changes => ({ schemaVersion: 1, success: true, attendanceId: 'session_student', sessionId: 'session',
  courseId: 'course', status: 'present', locationStatus: 'in_zone', recordedAt: new Date(now).toISOString(), duplicate: false, ...changes });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  const requests = [], logs = [], timers = new Map();
  let clock = now;
  const auth = { currentUser: { uid: 'student', getIdToken: options.token || (async () => 'private-token') } };
  const secureFetch = async (url, request) => {
    requests.push({ url, request });
    if (options.fetch) return options.fetch(url, request);
    return { ok: options.status === undefined || options.status < 400, status: options.status || 200,
      json: async () => options.payload === undefined ? result() : options.payload };
  };
  const stubs = {
    './runtime-config': { runtimeConfig: { apiUrl: 'https://recognition.example.test' } },
    './firebase': { auth }, 'expo-file-system': { File: class {} },
    'expo/fetch': { fetch: secureFetch },
    '../shared/checkin-contract': contracts, '../shared/checkin-location': location,
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../services/recognition.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  class Clock extends Date { static now() { return clock; } }
  vm.runInNewContext(code, { module, exports: module.exports, __DEV__: true, Date: Clock, AbortController,
    console: { info: (...args) => logs.push(args) },
    setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    fetch: () => { throw new Error('Recognition requests must use the redirect-enforcing Expo adapter.'); },
    require: name => { assert.ok(Object.hasOwn(stubs, name), name); return stubs[name]; },
  });
  return { auth, requests, logs, timers, api: module.exports,
    advance: value => { clock += value; }, timeout: () => [...timers.values()].forEach(callback => callback()),
    submit: (payload = input(), extra = {}) => module.exports.checkInAttendance(payload,
      { expectedUid: 'student', expectedCourseId: 'course', ...extra }),
  };
}

test('combined API sends one HTTPS bearer request with only the versioned photo/location contract', async () => {
  const h = harness(); const accepted = await h.submit();
  assert.equal(accepted.status, 'present'); assert.equal(h.requests.length, 1);
  const { url, request } = h.requests[0];
  assert.equal(url, 'https://recognition.example.test/attendance/check-in');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
  assert.equal(request.headers.Authorization, 'Bearer private-token');
  assert.deepEqual(JSON.parse(request.body), input());
  assert.equal(h.timers.size, 0);
  const logged = JSON.stringify(h.logs);
  for (const secret of ['private-token', 'aW1hZ2U=', 'latitude', 'longitude', 'accuracyMeters']) assert.ok(!logged.includes(secret), secret);
});

test('location-disabled course submits explicit null and displays the backend late/duplicate result unchanged', async () => {
  const accepted = result({ locationStatus: 'not_required', status: 'late', duplicate: true });
  const h = harness({ payload: accepted });
  assert.deepEqual(await h.submit({ ...input(), location: null }), accepted);
  assert.equal(JSON.parse(h.requests[0].request.body).location, null);
});

test('the native HTTPS adapter preserves existing three-photo enrollment and deletion contracts', async () => {
  const enrollment = harness({ payload: { success: true, uid: 'student', sample_count: 3, model: 'Facenet512' } });
  const images = ['first', 'second', 'third'];
  assert.equal((await enrollment.api.enrollFace(images)).sampleCount, 3);
  assert.equal(enrollment.requests[0].url, 'https://recognition.example.test/enroll');
  assert.deepEqual(JSON.parse(enrollment.requests[0].request.body), { images });
  assert.equal(enrollment.requests[0].request.redirect, 'error');
  const deletion = harness({ payload: { success: true, uid: 'student', deletionStatus: 'deleted' } });
  assert.equal(await deletion.api.deleteFaceEnrollment(), 'deleted');
  assert.equal(deletion.requests[0].url, 'https://recognition.example.test/enrollment');
  assert.equal(deletion.requests[0].request.method, 'DELETE');
  assert.equal(deletion.requests[0].request.body, undefined);
  assert.equal(deletion.requests[0].request.redirect, 'error');
});

test('client-supplied identity, course, status and zone claims never reach the network', async () => {
  for (const extra of [{ uid: 'other' }, { courseId: 'other' }, { status: 'present' }, { locationStatus: 'in_zone' }]) {
    const h = harness();
    await assert.rejects(h.submit({ ...input(), ...extra }), { code: 'invalid_check_in_request' });
    assert.equal(h.requests.length, 0);
  }
});

test('malformed or identity/session/course-mismatched responses never become attendance success', async () => {
  for (const [payload, code] of [
    [null, 'invalid_check_in_response'], [{ success: true }, 'invalid_check_in_response'],
    [result({ status: 'absent' }), 'invalid_check_in_response'],
    [result({ location: input().location }), 'invalid_check_in_response'],
    [result({ attendanceId: 'session_other' }), 'identity_mismatch'],
    [result({ sessionId: 'other' }), 'identity_mismatch'],
    [result({ courseId: 'other' }), 'identity_mismatch'],
  ]) {
    const h = harness({ payload }); await assert.rejects(h.submit(), { code });
  }
});

test('backend errors use controlled messages and never echo server payloads', async () => {
  for (const code of ['location_required', 'location_outside_zone', 'location_stale', 'attendance_window_closed',
    'attendance_already_recorded', 'membership_required', 'face_not_recognized', 'authentication_required']) {
    const h = harness({ status: 403, payload: { error: code, message: 'private-photo-coordinates' } });
    await assert.rejects(h.submit(), error => error.code === code && !error.message.includes('private-photo'));
    assert.ok(!JSON.stringify(h.logs).includes('private-photo'));
  }
  const h = harness({ status: 503, payload: { error: { latitude: 33, token: 'secret' }, message: 'sensitive' } });
  await assert.rejects(h.submit(), { code: 'http_503' });
  assert.ok(!JSON.stringify(h.logs).includes('secret'));
});

test('student location failures never display boundary measurements, including from older servers', async () => {
  for (const code of ['location_outside_zone', 'location_uncertain', 'location_inaccurate', 'location_unverified']) {
    const h = harness({ status: 403, payload: { error: code, message: 'private-server-message',
      locationDetails: { distanceMeters: 12, accuracyMeters: 5, radiusMeters: 15 } } });
    await assert.rejects(h.submit(), error => {
      assert.equal(error.code, code);
      assert.match(error.message, /Try checking in again/);
      assert.ok(!/12 m|5 m|15 m|inside|outside|boundary|radius/.test(error.message));
      assert.ok(!error.message.includes('private-server-message'));
      return true;
    });
    const logged = JSON.stringify(h.logs);
    for (const secret of ['locationDetails', 'distanceMeters', 'accuracyMeters', 'private-server-message', 'Phone position:']) {
      assert.ok(!logged.includes(secret), secret);
    }
  }
});

test('invalid or unrelated server diagnostics never enter the displayed error', async () => {
  const valid = { distanceMeters: 12, accuracyMeters: 5, radiusMeters: 15 };
  for (const locationDetails of [null, [], 'secret', {}, { ...valid, latitude: 'secret' },
    { ...valid, distanceMeters: '12' }, { ...valid, distanceMeters: -1 }, { ...valid, distanceMeters: Infinity },
    { ...valid, distanceMeters: 20_100_001 }, { ...valid, accuracyMeters: NaN },
    { ...valid, accuracyMeters: 10_001 }, { ...valid, accuracyMeters: true },
    { ...valid, radiusMeters: 16 }, { ...valid, radiusMeters: 1.5 }]) {
    const h = harness({ status: 403, payload: { error: 'location_uncertain', locationDetails } });
    await assert.rejects(h.submit(), error => error.code === 'location_uncertain' &&
      !error.message.includes('Phone position:') && !error.message.includes('secret'));
  }
  const h = harness({ status: 403, payload: { error: 'membership_required', locationDetails: valid } });
  await assert.rejects(h.submit(), error => !error.message.includes('Phone position:'));
  const empty = harness({ status: 403, payload: null });
  await assert.rejects(empty.submit(), { code: 'http_403' });
});

test('a rejected redirect or transport failure has no fallback request and no attendance success', async () => {
  const h = harness({ fetch: async () => { throw new Error('Native request rejected a redirect.'); } });
  await assert.rejects(h.submit(), { code: 'check_in_unavailable' });
  assert.equal(h.requests.length, 1);
});

test('stale coordinates are rejected after token retrieval, before uploading any photo', async () => {
  const token = deferred(); const h = harness({ token: () => token.promise });
  const pending = h.submit(); h.advance(16000); token.resolve('private-token');
  await assert.rejects(pending, { code: 'location_stale' });
  assert.equal(h.requests.length, 0);
});

test('account changes or cancellation while fetching a token prevent a late upload', async () => {
  for (const cancel of [false, true]) {
    const token = deferred(); const controller = new AbortController();
    const h = harness({ token: () => token.promise });
    const pending = h.submit(input(), { signal: controller.signal });
    if (cancel) controller.abort(); else h.auth.currentUser = { uid: 'other' };
    token.resolve('private-token');
    await assert.rejects(pending, { code: cancel ? 'check_in_cancelled' : 'identity_mismatch' });
    await flush(); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
  }
});

test('abort cancels an in-flight fetch and ignores a response that arrives afterward', async () => {
  const response = deferred(); const controller = new AbortController(); const h = harness({ fetch: () => response.promise });
  const pending = h.submit(input(), { signal: controller.signal }); await flush();
  controller.abort(); await assert.rejects(pending, { code: 'check_in_cancelled' });
  assert.equal(h.requests[0].request.signal.aborted, true);
  response.resolve({ ok: true, status: 200, json: async () => result() }); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
});

test('a response received after an account change cannot confirm attendance for the new account', async () => {
  const response = deferred(); const h = harness({ fetch: () => response.promise });
  const pending = h.submit(); await flush(); h.auth.currentUser = { uid: 'other' };
  response.resolve({ ok: true, status: 200, json: async () => result() });
  await assert.rejects(pending, { code: 'identity_mismatch' });
  assert.equal(h.requests.length, 1);
});

test('timeout cancels the fetch and reports uncertainty without retrying or creating a client record', async () => {
  const response = deferred(); const h = harness({ fetch: () => response.promise });
  const pending = h.submit(); await flush(); h.timeout();
  await assert.rejects(pending, error => error.code === 'check_in_timeout' && /original|not be replaced|Recent Activity/.test(error.message));
  assert.equal(h.requests[0].request.signal.aborted, true); assert.equal(h.requests.length, 1);
  response.resolve({ ok: true, status: 200, json: async () => result() }); await flush();
});
