const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./session-policy');
const start = Date.parse('2026-10-29T15:00:00.000Z');
const session = settings => ({ status: 'active', ...policy.snapshot(settings, start) });

test('the same saved policy governs grace boundaries, late attendance and the final window', () => {
  const row = session({ gracePeriodMinutes: 5, attendanceWindowMinutes: 20, allowLate: true });
  assert.equal(policy.checkInDecision(row, start + 5 * 60000).status, 'present');
  assert.equal(policy.checkInDecision(row, start + 5 * 60000 + 1).status, 'late');
  assert.equal(policy.checkInDecision(row, start + 20 * 60000).allowed, true);
  assert.equal(policy.checkInDecision(row, start + 20 * 60000 + 1).code, 'attendance_window_closed');
  const noLate = session({ gracePeriodMinutes: 5, attendanceWindowMinutes: 20, allowLate: false });
  assert.equal(noLate.checkInClosesAtMs, start + 5 * 60000);
  assert.equal(policy.checkInDecision(noLate, start + 5 * 60000 + 1).code, 'attendance_late_disabled');
});

test('a shorter window wins, and zero removes only the window limit', () => {
  const shorter = session({ gracePeriodMinutes: 15, attendanceWindowMinutes: 3, allowLate: true });
  assert.equal(shorter.checkInClosesAtMs, start + 3 * 60000);
  assert.equal(policy.checkInDecision(shorter, start + 4 * 60000).allowed, false);
  const unlimited = session({ attendanceWindowMinutes: 0, allowLate: true });
  assert.equal(unlimited.checkInClosesAtMs, null);
  assert.equal(policy.checkInDecision(unlimited, start + 5 * 3600000).status, 'late');
  assert.equal(policy.checkInDecision(session({ attendanceWindowMinutes: 0 }), start + 11 * 60000).allowed, false);
});

test('closing, failed, future and malformed sessions never accept a check-in', () => {
  for (const status of ['starting', 'closing', 'closed', 'start_failed']) {
    assert.equal(policy.checkInDecision({ ...session({}), status }, start).allowed, false);
  }
  assert.equal(policy.checkInDecision(session({}), start - 1).allowed, false);
  assert.equal(policy.checkInDecision({ ...session({}), endTime: new Date(start).toISOString() }, start).allowed, false);
  assert.equal(policy.checkInDecision({ ...session({}), gracePeriodMinutes: -1 }, start).allowed, false);
});

test('legacy sessions retain their three-hour limit and late-enabled behavior', () => {
  const legacy = { status: 'active', startTime: new Date(start).toISOString(), gracePeriodMinutes: 5 };
  assert.equal(policy.checkInDecision(legacy, start + 6 * 60000).status, 'late');
  assert.equal(policy.checkInDecision(legacy, start + 181 * 60000).allowed, false);
});

test('settings reject fractional, missing-looking and out-of-range user inputs', () => {
  for (const value of [-1, 121, 0.5, NaN, '', '10']) assert.throws(() => policy.normalizeSettings({ gracePeriodMinutes: value }));
  for (const value of [-1, 241, 0.5, NaN]) assert.throws(() => policy.normalizeSettings({ attendanceWindowMinutes: value }));
  assert.throws(() => policy.normalizeSettings({ allowLate: 'false' }));
  assert.throws(() => policy.normalizeSettings({ defaultAttendance: 'unknown' }));
  assert.equal(policy.normalizeSettings({}).defaultAttendance, 'absent');
});

test('live dates use local calendar days rather than UTC calendar days', () => {
  const local = new Date(2026, 9, 29, 23, 59, 0);
  assert.equal(policy.localDate(local), '2026-10-29');
  assert.equal(policy.snapshot({}, local).date, '2026-10-29');
});
