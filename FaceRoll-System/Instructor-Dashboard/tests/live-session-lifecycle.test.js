const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const policy = require('../public/js/session-policy');
const roster = require('../public/js/course-roster-sync');
const source = fs.readFileSync(path.join(__dirname, '../public/js/student-screens.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function backend() {
  return {
    now: new Date(2026, 9, 29, 23, 59).getTime(),
    courses: [{ id: 'course', courseId: 'course', name: 'Capstone', instructorId: 'teacher' }],
    users: ['student-a', 'student-b', 'student-c'].map((uid, i) => ({ id: uid, uid, displayName: uid, faceEnrolled: true, optOutFlag: i === 2 })),
    enrollments: ['student-a', 'student-b', 'student-c'].map(uid => ({ id: roster.membershipId('course', uid), uid, courseId: 'course', status: 'active' })),
    settings: { gracePeriodMinutes: 5, attendanceWindowMinutes: 30, allowLate: true, defaultAttendance: 'absent' },
    sessions: new Map(), attendance: new Map(), bridge: {}, events: [],
    starts: 0, stops: 0, writes: [], documentListeners: [], queryListeners: [],
  };
}

function page(data) {
  const elements = new Map(), events = {}, timers = [];
  const copy = value => value == null ? null : structuredClone(value);
  function element(tag = 'div') {
    let html = '';
    const node = { tagName: tag.toUpperCase(), value: '', textContent: '', children: [], style: {}, disabled: false,
      attrs: {}, handlers: {}, classList: { add() {}, remove() {} },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return this.attrs[key] ?? null; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      appendChild(child) { this.children.push(child); if (tag === 'select' && !this.value) this.value = child.value; },
      async click() { if (!this.disabled) return this.handlers.click?.(); },
      get selectedOptions() { return this.children.filter(child => child.value === this.value); },
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value; this.children = [];
        if (tag === 'select') this.value = '';
        if (tag === 'tr') this.children = Array.from({ length: 5 }, () => ({ textContent: '', firstElementChild: { textContent: '', classList: { add() {} } } }));
      },
    };
    return node;
  }
  function byId(id) {
    if (!elements.has(id)) {
      const tag = id === 'liveSessionCourseSelect' ? 'select' : id === 'liveSessionDate' ? 'input' : 'div';
      elements.set(id, element(tag));
    }
    return elements.get(id);
  }
  function rows(collection, options) {
    let values = collection === 'sessions' || collection === 'attendance' ? Array.from(data[collection].values()) : data[collection] || [];
    for (const filter of options?.filters || []) values = values.filter(row => filter.operator === 'in'
      ? filter.value.includes(row[filter.field]) : row[filter.field] === filter.value);
    return copy(values);
  }
  function notify(collection, id) {
    for (const listener of data.documentListeners.slice()) {
      if (listener.collection === collection && listener.id === id) queueMicrotask(() => listener.callback(copy(data[collection].get(id)), { fromCache: false }));
    }
    for (const listener of data.queryListeners.slice()) {
      if (listener.collection === collection) queueMicrotask(() => listener.callback(rows(collection, listener.options)));
    }
  }
  const api = {
    waitForAuthUser: async () => ({ uid: 'teacher' }),
    readDocument: async (collection, id) => collection === 'instructor_settings' ? copy(data.settings) : copy(data[collection].get(id)),
    readQueryDocs: async (collection, options) => rows(collection, options),
    readDocuments: async (collection, ids) => copy((data[collection] || []).filter(row => ids.includes(row.id))),
    writeDocument: async (collection, id, changes) => {
      if (data.failClose && changes.status === 'closing') throw new Error('write denied');
      data[collection].set(id, { ...(data[collection].get(id) || {}), ...copy(changes), id });
      data.writes.push({ collection, id, changes: copy(changes) }); notify(collection, id);
    },
    createSessionWithLocation: async (courseId, id, value) => {
      const course = data.courses.find(row => row.id === courseId);
      const next = { ...copy(value), zonePolicyVersion: 1, classroomZone: copy(course.location || null) };
      data.sessions.set(id, next); data.writes.push({ collection: 'sessions', id, changes: copy(next) }); return next;
    },
    createDocumentIfAbsent: async (collection, id, value) => {
      if (data.failDefault === value.uid) { data.failDefault = null; throw new Error('temporary default failure'); }
      if (data[collection].has(id)) return false;
      data[collection].set(id, copy(value)); data.writes.push({ collection, id, changes: copy(value) }); notify(collection, id); return true;
    },
    subscribeDocument: async (collection, id, callback) => {
      const item = { collection, id, callback }; data.documentListeners.push(item);
      const value = collection === 'users' ? data.users.find(row => row.id === id) : data[collection].get(id);
      callback(copy(value), { fromCache: false });
      return () => { data.documentListeners = data.documentListeners.filter(row => row !== item); };
    },
    subscribeQueryDocs: async (collection, options, callback) => {
      const item = { collection, options, callback }; data.queryListeners.push(item); callback(rows(collection, options));
      return () => { data.queryListeners = data.queryListeners.filter(row => row !== item); };
    },
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [data.now])); } static now() { return data.now; } }
  const context = {
    window: { FaceRollFirebase: api, FaceRollSessionPolicy: policy, FaceRollCourseRoster: roster,
      addEventListener(name, callback) { (events[name] ||= []).push(callback); } },
    document: { body: { id: 'imsyg1' }, readyState: 'complete', getElementById: byId, createElement: element },
    Date: Clock, AbortSignal, console: { error() {}, warn() {} },
    setInterval(callback, ms) { const timer = { callback, ms, active: true }; timers.push(timer); return timer; },
    clearInterval(timer) { if (timer) timer.active = false; },
    fetch: async (url, options = {}) => {
      const route = new URL(url);
      if (data.bridgeOffline) throw new Error('bridge offline');
      let result = { ok: true, status: copy(data.bridge) };
      if (route.pathname === '/start-session') {
        data.starts++;
        const configuration = JSON.parse(options.body);
        if (data.startConflict) data.bridge = data.startConflict;
        else data.bridge = { ...configuration, captureRunning: true, recognizerRunning: true };
        result.status = copy(data.bridge);
      } else if (route.pathname === '/stop-session') {
        data.stops++; data.bridge = {}; result.status = {};
      } else if (route.pathname === '/events') {
        result.events = copy(data.events.filter(row => row.cursor > Number(route.searchParams.get('cursor') || 0)));
        result.nextCursor = data.events.length;
      }
      return { ok: true, json: async () => result };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/session-policy.js'), 'utf8'), context);
  vm.runInContext(source, context);
  return { el: byId, api, timers,
    event: (name, value = {}) => events[name]?.forEach(callback => callback(value)),
    tick: () => timers.filter(timer => timer.active).forEach(timer => timer.callback()),
  };
}

function active(data, fields = {}) {
  const session = { ...policy.snapshot(data.settings, data.now - 300000), id: 'existing', sessionId: 'existing', courseId: 'course', status: 'active', ...fields };
  data.sessions.set(session.id, session);
  data.bridge = { sessionId: session.id, courseId: 'course', captureRunning: true, recognizerRunning: true };
  return session;
}

test('new live sessions use a local, read-only date and snapshot all instructor settings', async () => {
  const data = backend(), ui = page(data); await flush();
  assert.equal(ui.el('liveSessionDate').readOnly, true);
  assert.equal(ui.el('liveSessionDate').value, policy.localDate(data.now));
  await ui.el('iq6lcg').click(); await flush();
  const saved = [...data.sessions.values()][0];
  assert.equal(saved.status, 'active');
  assert.equal(saved.date, policy.localDate(data.now));
  assert.equal(saved.attendanceWindowMinutes, 30);
  assert.equal(saved.allowLate, true);
  assert.equal(saved.defaultAttendance, 'absent');
  assert.equal(data.starts, 1);
  assert.equal(ui.el('liveSessionCourseSelect').disabled, true);
});

test('refresh restores the same session, timer, course, attendance and stop button without starting another camera', async () => {
  const data = backend(); active(data);
  data.attendance.set('existing_student-a', { id: 'existing_student-a', uid: 'student-a', sessionId: 'existing', courseId: 'course', status: 'present', time: new Date(data.now).toISOString() });
  const ui = page(data); await flush();
  assert.equal(data.starts, 0);
  assert.equal(ui.el('iq6lcg').textContent, 'Stop Session');
  assert.equal(ui.el('liveSessionCourseSelect').value, 'course');
  assert.equal(ui.el('impi7gl').textContent, '05:00');
  assert.equal(ui.el('liveSessionTbody').children.length, 1);
});

test('navigation preserves the server session and replays only valid buffered recognition events', async () => {
  const data = backend(), first = page(data); await flush();
  await first.el('iq6lcg').click(); await flush();
  const saved = [...data.sessions.values()][0]; first.event('pagehide');
  assert.equal(data.documentListeners.length, 0);
  assert.equal(data.queryListeners.length, 0);
  data.now += 6 * 60000;
  data.events.push({ cursor: 1, uid: 'student-a', eventType: 'match', sessionId: saved.id, courseId: 'course', timestamp: new Date(data.now).toISOString() });
  const second = page(data); await flush();
  assert.equal(data.starts, 1);
  assert.equal(second.el('iq6lcg').textContent, 'Stop Session');
  assert.equal(data.attendance.get(saved.id + '_student-a').status, 'late');
  second.event('pagehide'); page(data); await flush();
  assert.equal(data.writes.filter(row => row.id === saved.id + '_student-a').length, 1);
});

test('ending applies defaults once to missing students, including opt-outs, and preserves existing records', async () => {
  const data = backend(); active(data);
  const present = { id: 'existing_student-a', uid: 'student-a', sessionId: 'existing', courseId: 'course', status: 'present', time: new Date(data.now).toISOString() };
  data.attendance.set(present.id, present);
  const ui = page(data); await flush();
  await ui.el('iq6lcg').click(); await flush();
  assert.deepEqual(data.attendance.get(present.id), present);
  for (const uid of ['student-b', 'student-c']) {
    assert.equal(data.attendance.get('existing_' + uid).status, 'absent');
    assert.equal(data.attendance.get('existing_' + uid).source, 'session_default');
  }
  assert.equal(data.sessions.get('existing').status, 'closed');
  assert.equal(data.sessions.get('existing').defaultsApplied, true);
  assert.equal(ui.el('liveSessionTbody').children.length, 3);
});

test('interrupted finalization survives refresh and retries without duplicate records', async () => {
  const data = backend(); active(data); data.failDefault = 'student-b';
  const first = page(data); await flush(); await first.el('iq6lcg').click(); await flush();
  assert.equal(data.sessions.get('existing').status, 'closing');
  assert.equal(first.el('iq6lcg').textContent, 'Finish Session');
  first.event('pagehide');
  const second = page(data); await flush();
  assert.equal(second.el('iq6lcg').textContent, 'Finish Session');
  await second.el('iq6lcg').click(); await flush();
  assert.equal(data.attendance.size, 3);
  assert.equal(data.sessions.get('existing').status, 'closed');
  for (const uid of ['student-a', 'student-b', 'student-c']) assert.equal(data.writes.filter(row => row.id === 'existing_' + uid).length, 1);
});

test('saved setting changes affect the next session, not an already-running session', async () => {
  const data = backend(); active(data); data.settings.defaultAttendance = 'late'; data.settings.allowLate = false;
  const ui = page(data); await flush(); await ui.el('iq6lcg').click(); await flush();
  assert.equal(data.attendance.get('existing_student-a').status, 'absent');
  data.now += 1;
  await ui.el('iq6lcg').click(); await flush();
  const next = [...data.sessions.values()].find(row => row.id !== 'existing');
  assert.equal(next.defaultAttendance, 'late'); assert.equal(next.allowLate, false);
});

test('recovery never stops or replaces a different instructor session', async () => {
  const data = backend(); data.bridge = { sessionId: 'other', courseId: 'other-course', captureRunning: true };
  const ui = page(data); await flush();
  assert.equal(ui.el('iq6lcg').disabled, true);
  assert.equal(data.starts, 0); assert.equal(data.stops, 0); assert.equal(data.sessions.size, 0);
});

test('a bridge race cannot stop another session or leave the failed new session active', async () => {
  const data = backend(), ui = page(data); await flush();
  data.startConflict = { sessionId: 'other', courseId: 'other-course', captureRunning: true };
  await ui.el('iq6lcg').click(); await flush();
  assert.equal(data.stops, 0);
  assert.equal([...data.sessions.values()][0].status, 'start_failed');
});

test('camera matches outside the window are ignored and idle dates advance at midnight', async () => {
  const data = backend(); data.settings.attendanceWindowMinutes = 1; active(data);
  data.events.push({ cursor: 1, uid: 'student-a', sessionId: 'existing', courseId: 'course', timestamp: new Date(data.now).toISOString() });
  const ui = page(data); await flush(); assert.equal(data.attendance.size, 0);
  await ui.el('iq6lcg').click(); await flush();
  data.now += 120000; ui.tick(); await flush();
  assert.equal(ui.el('liveSessionDate').value, policy.localDate(data.now));
});

test('failed closing writes retain session controls for a safe retry', async () => {
  const data = backend(); active(data); const ui = page(data); await flush(); data.failClose = true;
  await ui.el('iq6lcg').click(); await flush();
  assert.equal(ui.el('iq6lcg').textContent, 'Finish Session');
  assert.equal(data.sessions.get('existing').status, 'active');
  data.failClose = false; await ui.el('iq6lcg').click(); await flush();
  assert.equal(data.sessions.get('existing').status, 'closed');
});

test('resuming a start interrupted by navigation preserves the bridge start time', async () => {
  const data = backend(); active(data, { status: 'starting' });
  data.bridge.sessionStartedAt = (data.now - 240000) / 1000;
  const ui = page(data); await flush();
  assert.equal(data.sessions.get('existing').startedAtMs, data.now - 240000);
  assert.equal(ui.el('impi7gl').textContent, '04:00');
  assert.equal(data.starts, 0);
});

test('a disconnected bridge leaves the active session available to finish after reconnection', async () => {
  const data = backend(); active(data); const ui = page(data); await flush();
  data.bridgeOffline = true; await ui.el('iq6lcg').click(); await flush();
  assert.equal(data.sessions.get('existing').status, 'active');
  assert.equal(data.attendance.size, 0);
  data.bridgeOffline = false; await ui.el('iq6lcg').click(); await flush();
  assert.equal(data.sessions.get('existing').status, 'closed');
});

test('failure saving a final camera match cannot silently replace it with default attendance', async () => {
  const data = backend(); active(data); const ui = page(data); await flush();
  data.events.push({ cursor: 1, uid: 'student-a', sessionId: 'existing', courseId: 'course', timestamp: new Date(data.now).toISOString() });
  data.failDefault = 'student-a';
  await ui.el('iq6lcg').click(); await flush();
  assert.equal(data.sessions.get('existing').status, 'active');
  assert.equal(data.attendance.size, 0);
  ui.event('pagehide');
  const retry = page(data); await flush();
  await retry.el('iq6lcg').click(); await flush();
  assert.equal(data.attendance.get('existing_student-a').source, 'classroom_camera');
  assert.equal(data.sessions.get('existing').status, 'closed');
});
