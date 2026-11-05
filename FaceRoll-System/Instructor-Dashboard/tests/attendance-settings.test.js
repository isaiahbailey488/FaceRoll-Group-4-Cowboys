const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../public/js/session-policy');
const html = fs.readFileSync(path.join(__dirname, '../public/settings.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function page(settings) {
  const values = { 'default-attendance': 'absent', 'grace-period': '10', 'attendance-window': '30' };
  const elements = new Map(), writes = [];
  function el(id) {
    if (!elements.has(id)) elements.set(id, { value: values[id] || '', textContent: '', attrs: {}, handlers: {}, disabled: false,
      classList: { add() {}, remove() {} },
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
    });
    return elements.get(id);
  }
  const api = { waitForAuthUser: async () => ({ uid: 'teacher' }), readCollectionDocs() {},
    readDocument: async () => settings,
    writeDocument: async (collection, uid, data) => writes.push({ collection, uid, data }),
  };
  vm.runInNewContext(source, {
    window: { FaceRollSessionPolicy: policy, FaceRollFirebase: api,
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } } } },
    document: { readyState: 'complete', getElementById: el, addEventListener() {} },
    Date, setTimeout, console,
  });
  return { el, writes, save: () => el('save-settings-btn').handlers.click() };
}

test('settings load and save all four attendance controls for the authenticated instructor', async () => {
  const ui = page({ defaultAttendance: 'late', gracePeriodMinutes: 12, attendanceWindowMinutes: 0, allowLate: true });
  await flush();
  assert.equal(ui.el('default-attendance').value, 'late');
  assert.equal(ui.el('grace-period').value, '12');
  assert.equal(ui.el('attendance-window').value, '0');
  assert.equal(ui.el('allow-late-toggle').getAttribute('aria-checked'), 'true');
  await ui.save();
  assert.deepEqual(ui.writes[0], { collection: 'instructor_settings', uid: 'teacher', data: {
    defaultAttendance: 'late', gracePeriodMinutes: 12, attendanceWindowMinutes: 0, allowLate: true, updatedAt: 'SERVER_TIMESTAMP',
  } });
});

test('invalid, fractional and empty settings show an error without writing', async () => {
  const ui = page(null); await flush();
  for (const [id, value] of [['grace-period', '-1'], ['grace-period', '0.5'], ['grace-period', ''], ['attendance-window', '241']]) {
    ui.el('grace-period').value = '10'; ui.el('attendance-window').value = '30'; ui.el(id).value = value;
    await ui.save(); assert.equal(ui.writes.length, 0);
    assert.notEqual(ui.el('settings-status').textContent, 'Settings saved successfully.');
  }
});

test('the Allow Late switch persists false as well as true', async () => {
  const ui = page({ allowLate: true }); await flush();
  ui.el('allow-late-toggle').handlers.click(); await ui.save();
  assert.equal(ui.writes[0].data.allowLate, false);
});
