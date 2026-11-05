(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FaceRollSessionPolicy = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    defaultAttendance: 'absent', gracePeriodMinutes: 10,
    attendanceWindowMinutes: 30, allowLate: false,
  });

  function minutes(value, fallback, maximum, label) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
      throw new Error(label + ' must be a whole number between 0 and ' + maximum + '.');
    }
    return value;
  }

  function normalizeSettings(value) {
    const settings = value || {};
    const status = settings.defaultAttendance === undefined ? DEFAULTS.defaultAttendance : settings.defaultAttendance;
    if (!['present', 'late', 'absent'].includes(status)) throw new Error('Choose a valid default attendance status.');
    if (settings.allowLate !== undefined && typeof settings.allowLate !== 'boolean') throw new Error('Choose whether late check-ins are allowed.');
    return {
      defaultAttendance: status,
      gracePeriodMinutes: minutes(settings.gracePeriodMinutes, 10, 120, 'Grace period'),
      attendanceWindowMinutes: minutes(settings.attendanceWindowMinutes, 30, 240, 'Attendance window'),
      allowLate: settings.allowLate === undefined ? false : settings.allowLate,
    };
  }

  function toMillis(value) {
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value && typeof value.toDate === 'function') return value.toDate().getTime();
    if (value === null || value === undefined || value === '') return NaN;
    return new Date(value).getTime();
  }

  function localDate(value) {
    const date = new Date(value === undefined ? Date.now() : value);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('-');
  }

  function settingsForSession(session) {
    if (session.policyVersion === 1) return normalizeSettings(session);
    // Existing sessions keep their original three-hour, late-enabled behavior.
    return normalizeSettings({ defaultAttendance: 'absent', allowLate: true,
      attendanceWindowMinutes: 180, gracePeriodMinutes: Number(session.gracePeriodMinutes ?? 10) });
  }

  function snapshot(settings, now) {
    const policy = normalizeSettings(settings);
    const startedAtMs = toMillis(now === undefined ? Date.now() : now);
    if (!Number.isFinite(startedAtMs)) throw new Error('The session start time is invalid.');
    const limits = [];
    if (policy.attendanceWindowMinutes > 0) limits.push(policy.attendanceWindowMinutes);
    if (!policy.allowLate) limits.push(policy.gracePeriodMinutes);
    return Object.assign({}, policy, {
      policyVersion: 1, startedAtMs: startedAtMs, startTime: new Date(startedAtMs).toISOString(),
      date: localDate(startedAtMs),
      checkInClosesAtMs: limits.length ? startedAtMs + Math.min.apply(null, limits) * 60000 : null,
    });
  }

  function checkInDecision(session, now) {
    if (!session || session.status !== 'active' || session.endTime) {
      return { allowed: false, code: 'attendance_session_closed', message: 'This attendance session has ended.' };
    }
    let policy;
    try { policy = settingsForSession(session); } catch (error) {
      return { allowed: false, code: 'attendance_policy_invalid', message: 'The session settings are invalid. Ask your instructor to restart the session.' };
    }
    const start = session.policyVersion === 1 ? session.startedAtMs : toMillis(session.startTime);
    const time = now === undefined ? Date.now() : toMillis(now);
    if (!Number.isFinite(start) || !Number.isFinite(time) || time < start) {
      return { allowed: false, code: 'attendance_session_not_started', message: 'This attendance session has not started.' };
    }
    const elapsed = time - start;
    if (policy.attendanceWindowMinutes > 0 && elapsed > policy.attendanceWindowMinutes * 60000) {
      return { allowed: false, code: 'attendance_window_closed', message: 'The attendance check-in window has closed.' };
    }
    const late = elapsed > policy.gracePeriodMinutes * 60000;
    if (late && !policy.allowLate) {
      return { allowed: false, code: 'attendance_late_disabled', message: 'The grace period has ended and late check-ins are disabled.' };
    }
    return { allowed: true, status: late ? 'late' : 'present' };
  }

  return { DEFAULTS, normalizeSettings, settingsForSession, snapshot, checkInDecision, localDate, toMillis };
});
