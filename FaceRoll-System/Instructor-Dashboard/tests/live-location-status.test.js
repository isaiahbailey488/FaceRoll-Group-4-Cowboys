'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/student-screens.js'), 'utf8');

test('Live Session displays only zone status and treats missing results as unchecked', async () => {
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
  const statuses = ['in_zone', 'outside_zone', 'not_required', undefined, 'unexpected'];
  const data = {
    courses: [{ id: 'course1', name: 'Test course' }], enrollments: [],
    users: statuses.map((_, i) => ({ uid: 'u' + i, displayName: ['Alice', 'Bob', 'Carol', 'Diana', 'Erin'][i] })),
  };
  vm.runInNewContext(source, {
    window: { addEventListener() {}, FaceRollCourseRoster: require('../public/js/course-roster-sync.js'), FaceRollFirebase: {
      waitForAuthUser: async () => ({ uid: 'teacher' }),
      readDocuments: async name => data[name] || [],
      subscribeQueryDocs: async (name, options, callback) => {
        callback(name === 'attendance' ? statuses.map((locationStatus, i) => ({ uid: 'u' + i, sessionId, courseId: 'course1', status: 'present', locationStatus, latitude: 33.123456789, longitude: -97.987654321, time: new Date().toISOString() })) : data[name] || []);
        return () => {};
      },
      readQueryDocs: async name => name === 'attendance'
        ? statuses.map((locationStatus, i) => ({ uid: 'u' + i, sessionId, courseId: 'course1', status: 'present', locationStatus, latitude: 33.123456789, longitude: -97.987654321, time: new Date().toISOString() }))
        : data[name] || [],
      writeDocument: async (collection, id) => { if (collection === 'sessions') sessionId = id; },
    } },
    document: { readyState: 'complete', body: { id: 'imsyg1' },
      getElementById(id) { return elements[id] ||= element(); }, createElement: element },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, events: [] }) }),
    setInterval() { return 1; }, clearInterval() {}, console,
  });
  await new Promise(resolve => setImmediate(resolve));
  elements.liveSessionCourseSelect.value = 'course1';
  elements.iq6lcg.click();
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  const rows = elements.liveSessionTbody.children;
  assert.deepEqual(rows.map(row => row.children[4].textContent), ['In zone', 'Outside zone', 'Not required', 'Not checked', 'Not checked']);
  assert.doesNotMatch(JSON.stringify(rows), /33\.123456789|-97\.987654321|latitude|longitude/);
});
