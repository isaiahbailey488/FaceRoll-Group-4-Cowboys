'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/student-screens.js'), 'utf8');

test('Live Session displays the recorded method for both face paths, location-only and instructor records', async () => {
  const elements = {};
  let sessionId;
  function element() {
    const el = { value: '', textContent: '', children: [], style: {}, classList: { add() {} },
      selectedOptions: [{ textContent: 'Test course' }],
      addEventListener(event, callback) { this[event] = callback; },
      appendChild(child) { this.children.push(child); },
    };
    Object.defineProperty(el, 'innerHTML', { set(value) {
      this.children = value.startsWith('<td>')
        ? Array.from({ length: 5 }, () => ({ textContent: '', firstElementChild: { textContent: '', classList: { add() {} } } })) : [];
    } });
    return el;
  }
  const records = [
    { source: 'phone_face_verification', method: 'Phone face and location verification', locationStatus: 'in_zone' },
    { source: 'classroom_camera', method: 'Classroom camera recognition', locationStatus: 'not_checked' },
    // A known source wins over inconsistent legacy method text or location data.
    { source: 'phone_location_verification', method: 'Facial recognition', locationStatus: 'in_zone' },
    { source: 'instructor_override', method: 'Instructor override', locationStatus: 'in_zone' },
    { source: 'session_default', method: 'Session default', status: 'absent' },
    { method: 'Phone face verification' },
    { method: 'Phone location verification' },
    { locationStatus: 'in_zone' },
    { method: 'Manual attendance' },
  ];
  const attendance = () => records.map((record, i) => ({ ...record, uid: 'u' + i, sessionId, courseId: 'course1',
    status: record.status || 'present', latitude: 33.123456789, longitude: -97.987654321, time: new Date().toISOString() }));
  const data = {
    courses: [{ id: 'course1', name: 'Test course' }], enrollments: [],
    users: records.map((_, i) => ({ uid: 'u' + i, displayName: ['Alice', 'Bob', 'Carol', 'Diana', 'Erin', 'Frank', 'Grace', 'Henry', 'Isla'][i] })),
  };
  vm.runInNewContext(source, {
    window: { addEventListener() {}, FaceRollSessionPolicy: require('../public/js/session-policy.js'), FaceRollCourseRoster: require('../public/js/course-roster-sync.js'), FaceRollFirebase: {
      waitForAuthUser: async () => ({ uid: 'teacher' }),
      readDocuments: async name => data[name] || [],
      readDocument: async () => null,
      subscribeQueryDocs: async (name, options, callback) => {
        callback(name === 'attendance' ? attendance() : data[name] || []);
        return () => {};
      },
      readQueryDocs: async name => name === 'attendance'
        ? attendance()
        : data[name] || [],
      writeDocument: async (collection, id) => { if (collection === 'sessions') sessionId = id; },
      createSessionWithLocation: async (courseId, id, value) => { sessionId = id; return { ...value, zonePolicyVersion: 1, classroomZone: null }; },
    } },
    document: { readyState: 'complete', body: { id: 'imsyg1' },
      getElementById(id) { return elements[id] ||= element(); }, createElement: element },
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/start-session')
      ? { ok: true, status: { sessionId, courseId: 'course1', captureRunning: true, recognizerRunning: true } }
      : { ok: true, events: [] } }),
    AbortSignal,
    setInterval() { return 1; }, clearInterval() {}, console,
  });
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  elements.liveSessionCourseSelect.value = 'course1';
  elements.iq6lcg.click();
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  const rows = elements.liveSessionTbody.children;
  assert.deepEqual(rows.map(row => row.children[4].textContent), [
    'Facial recognition', 'Facial recognition', 'Location check', 'Instructor override', 'Session default',
    'Facial recognition', 'Location check', 'Not recorded', 'Manual attendance',
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /33\.123456789|-97\.987654321|latitude|longitude/);
});
