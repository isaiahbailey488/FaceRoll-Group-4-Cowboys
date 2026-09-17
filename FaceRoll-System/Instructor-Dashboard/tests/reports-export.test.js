'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/student-screens.js'), 'utf8');

async function harness(fail = false) {
  const elements = {};
  const filenames = [];
  function element() {
    return { value: '', children: Array.from({ length: 6 }, () => ({})),
      appendChild() {}, removeChild() {}, click() { filenames.push(this.download); },
      addEventListener(event, fn) { this[event] = fn; } };
  }
  const downloads = [];
  const data = {
    users: [{ id: 'u1', studentId: 'S12345', displayName: 'Zoë, "Smith"' }],
    courses: [{ id: 'c1', name: '=Example, Course' }],
    sessions: [{ id: 's1', courseId: 'c1', startTime: '2026-09-17T23:30:00' }],
    attendance: [{ uid: 'u1', sessionId: 's1', status: 'Late' }],
  };
  vm.runInNewContext(source, {
    window: { FaceRollFirebase: { async readCollectionDocs(name) {
      if (fail) throw new Error('offline');
      return data[name];
    } }, setTimeout() {} },
    document: { readyState: 'complete', body: Object.assign(element(), { id: 'iw11pz' }),
      getElementById(id) { return elements[id] ||= element(); }, createElement: element },
    Blob, URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    console: { error() {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, downloads, filenames };
}

test('CSV exports readable filtered totals, Unicode, escaped cells and safe formula text', async () => {
  const { elements: e, downloads } = await harness();
  e.reportsFromDate.value = '2026-09-17';
  e.reportsToDate.value = '2026-09-17';
  e.reportsToDate.change();
  assert.equal(e['iaq1jh-2'].disabled, false);
  e['iaq1jh-2'].onclick();
  const bytes = new Uint8Array(await downloads[0].arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [239, 187, 191]);
  const csv = await downloads[0].text();
  assert.equal(csv.split('\r\n')[0], '"Student Name","Student ID","Course","Total Sessions","Attended","Absent","Late","Attendance Rate"');
  assert.match(csv, /"Zoë, ""Smith""","S12345","'=Example, Course","1","1","0","1","100%"\r\n/);
});

test('empty filters clear the previous download handler and recover when cleared', async () => {
  const { elements: e } = await harness();
  e.reportsStatusFilter.value = 'absent';
  e.reportsStatusFilter.change();
  assert.equal(e['iaq1jh-2'].disabled, true);
  assert.equal(e['iaq1jh-2'].onclick, null);
  e.reportsStatusFilter.value = '';
  e.reportsStatusFilter.change();
  assert.equal(e['iaq1jh-2'].disabled, false);
});

test('filename includes course and inferred or selected date boundaries', async () => {
  const { elements: e, filenames } = await harness();
  e['iaq1jh-2'].onclick();
  assert.equal(filenames[0], '=Example,-Course-attendance-2026-09-17-to-2026-09-17.csv');
  e.reportsCourseFilter.value = '=Example, Course';
  e.reportsFromDate.value = '2026-09-01';
  e.reportsToDate.value = '2026-09-30';
  e.reportsToDate.change();
  e['iaq1jh-2'].onclick();
  assert.equal(filenames[1], '=Example,-Course-attendance-2026-09-01-to-2026-09-30.csv');
});

test('invalid date ranges and failed loads disable export', async () => {
  const { elements: e } = await harness();
  e.reportsFromDate.value = '2026-09-18';
  e.reportsToDate.value = '2026-09-17';
  e.reportsFromDate.change();
  assert.equal(e['iaq1jh-2'].onclick, null);
  assert.match(e.reportsExportStatus.textContent, /From Date/);
  const failed = await harness(true);
  assert.equal(failed.elements['iaq1jh-2'].disabled, true);
  assert.match(failed.elements.reportsExportStatus.textContent, /Unable to load/);
});
