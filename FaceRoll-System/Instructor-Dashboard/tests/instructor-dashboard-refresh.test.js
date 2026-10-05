'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../public/js/instructor-dashboard.js'),
  'utf8'
);

function createElement(tagName) {
  const element = {
    tagName: String(tagName || '').toUpperCase(),
    value: '',
    textContent: '',
    style: {},
    children: [],
    disabled: false,
    className: '',
    classList: { add() {}, remove() {} },
    addEventListener(event, handler) { this[event] = handler; },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    get firstElementChild() { return this.children[0] || null; },
    set innerHTML(value) {
      this.children = [];
      const cells = (String(value).match(/<td/g) || []).length;
      for (let index = 0; index < cells; index += 1) {
        const child = createElement('td');
        if (String(value).includes('status-badge') && index === 4) {
          child.appendChild(createElement('span'));
        }
        this.children.push(child);
      }
    },
  };
  return element;
}

test('a nonempty initial listener snapshot repairs an empty one-time dashboard read', async () => {
  const elements = {};
  const complete = {
    instructor: { uid: 'teacher' },
    users: [{ id: 'student-1', displayName: 'Student One', studentId: '1234567' }],
    courses: [{ id: 'course-1', courseId: 'course-1', courseName: 'Course One', instructorId: 'teacher' }],
    sessions: [{ id: 'session-1', sessionId: 'session-1', courseId: 'course-1', startTime: '2026-10-04' }],
    attendance: [{ id: 'attendance-1', uid: 'student-1', sessionId: 'session-1', status: 'present' }],
    enrollments: [],
  };
  const empty = { instructor: complete.instructor, users: [], courses: [], sessions: [], attendance: [], enrollments: [] };
  let reads = 0;

  const firebaseApi = {
    async waitForAuthUser() { return complete.instructor; },
    readCachedInstructorSnapshot() { return null; },
    async readInstructorSnapshot() {
      reads += 1;
      return reads === 1 ? empty : complete;
    },
    async subscribeQueryDocs(_collection, _options, onNext) {
      onNext(complete.courses);
      return function () {};
    },
    async subscribeQueryChunks(collection, _field, values, onNext) {
      const rows = values.length ? complete[collection] : [];
      onNext(rows);
      return function () {};
    },
  };

  vm.runInNewContext(source, {
    window: {
      FaceRollFirebase: firebaseApi,
      setTimeout,
      clearTimeout,
      addEventListener() {},
    },
    document: {
      getElementById(id) { return elements[id] ||= createElement(id); },
      querySelector() { return null; },
      createElement,
    },
    console,
    Date,
    Map,
    Set,
    JSON,
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.attendanceTbody.children[0].children[0].textContent,
    'Loading attendance records from Firestore...');
  assert.equal(elements.statTotal.textContent, 'Loading...');
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.equal(reads, 2);
  assert.equal(elements.firestoreStatus.textContent, 'Data loaded successfully.');
  assert.equal(elements.attendanceTbody.children.length, 1);
  assert.equal(elements.attendanceTbody.children[0].children[0].textContent, 'Student One');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(reads, 2, 'matching initial listener data must not create a refresh loop');
});
