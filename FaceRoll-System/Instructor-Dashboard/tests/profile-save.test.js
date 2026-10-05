const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');
const courseRoster = require('../public/js/course-roster-sync.js');

test('profile has one renderer and first save persists the selected attendance record', async () => {
  const html = fs.readFileSync(path.join(publicDir, 'student-profile.html'), 'utf8');
  assert.doesNotMatch(html, /src="[^" ]*student-profile-loader/);
  assert.equal((html.match(/src="[^" ]*student-screens/g) || []).length, 1);
  assert.doesNotMatch(html, /Jane Doe|jane\.doe@example\.com|Course 1030|>93%<|>28<\/span>/);
  ['ix63k7g', 'iobn7gg', 'inpdknn', 'iaj9kju', 'iwzjofv', 'ip95okd', 'iq9g6ym']
    .forEach(id => assert.match(html, new RegExp(`id="${id}"[^>]*>Loading\\.\\.\\.<`)));
  assert.match(html, /id="profileEnrollmentList"/);
  assert.match(html, /Enrolled Courses/);
  const rosterHtml = fs.readFileSync(path.join(publicDir, 'student-roster.html'), 'utf8');
  assert.match(rosterHtml, />Enrollment<\/th>/);
  assert.doesNotMatch(rosterHtml, /Remove from Course|roster-membership-button/);
  assert.match(rosterHtml, /\.roster-membership-status\.status-present\s*\{[^}]*color:\s*#166534\s*!important;[^}]*background:\s*#dcfce7\s*!important;/s);
  assert.match(rosterHtml, /\.roster-membership-status\.status-absent\s*\{[^}]*color:\s*#b91c1c\s*!important;[^}]*background:\s*#fef2f2\s*!important;/s);
  const elements = {};
  function element() {
    return { dataset: {}, style: {}, children: [], classList: { add() {}, remove() {} },
      set innerHTML(value) {
        this.children = value.includes('<td></td>')
          ? Array.from({ length: 5 }, () => ({ firstElementChild: element() })) : [];
      },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return this.children; },
      querySelector() { return this.children[4].firstElementChild; } };
  }
  const data = { users: [{ id: 'u1', name: 'Student One' }], courses: [{ id: 'c1', name: 'Course' }],
    sessions: [], enrollments: [], attendance: [{ id: 'a1', uid: 'u1', courseId: 'c1', status: 'present', time: '2026-09-17' }] };
  const writes = [];
  const window = { location: { search: '?studentId=u1' }, setTimeout() {}, FaceRollCourseRoster: courseRoster,
    FaceRollFirebase: {
      async readInstructorSnapshot() { return { ...data, instructor: { uid: 'teacher' } }; },
      async waitForAuthUser() { return { uid: 'teacher' }; },
      async writeDocument(collection, id, update) {
        writes.push({ collection, id, status: update.status });
        Object.assign(data.attendance.find(row => row.id === id), update);
      },
    } };
  vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'js/student-screens.js'), 'utf8'), {
    window, URLSearchParams, console,
    document: { readyState: 'complete', body: { id: 'idhra3g' },
      getElementById(id) { return elements[id] ||= element(); }, createElement: element },
  });
  assert.equal(elements.profileSaveButton.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.profileSaveButton.disabled, false);
  elements.profileAttendanceBody.children[0].children[4].firstElementChild.value = 'Absent';
  const saving = elements.profileSaveButton.onclick();
  await window.FaceRollProfileSave(); // A duplicate invocation during save must be ignored.
  await saving;
  assert.deepEqual(writes, [{ collection: 'attendance', id: 'a1', status: 'absent' }]);
  assert.match(elements.profileSaveStatus.textContent, /saved to Firestore/);
  assert.equal(elements.profileAttendanceBody.children[0].children[2].firstElementChild.textContent, 'Absent');
});
