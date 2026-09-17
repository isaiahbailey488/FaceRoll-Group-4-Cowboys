const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');

test('profile has one renderer and first save persists the selected attendance record', async () => {
  const html = fs.readFileSync(path.join(publicDir, 'student-profile.html'), 'utf8');
  assert.doesNotMatch(html, /src="[^" ]*student-profile-loader/);
  assert.equal((html.match(/src="[^" ]*student-screens/g) || []).length, 1);
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
    sessions: [], attendance: [{ id: 'a1', uid: 'u1', courseId: 'c1', status: 'present', time: '2026-09-17' }] };
  const writes = [];
  const window = { location: { search: '?studentId=u1' }, setTimeout() {},
    FaceRollFirebase: {
      async readCollectionDocs(name) { return data[name]; },
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
