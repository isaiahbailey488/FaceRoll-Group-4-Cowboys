(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FaceRollAttendanceHistory = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function millis(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value === 'object' && typeof (value.seconds ?? value._seconds) === 'number') return (value.seconds ?? value._seconds) * 1000;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parts = value.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
    }
    return new Date(value).getTime();
  }

  function sessionTime(session) {
    return millis(session.startTime || session.date || session.createdAt || session.endTime);
  }

  function isCompleted(session, now) {
    const time = sessionTime(session), status = String(session.status || '').toLowerCase();
    if (!Number.isFinite(time) || time > now || ['starting', 'closing', 'start_failed', 'cancelled', 'canceled', 'draft'].includes(status)) return false;
    const end = millis(session.endTime);
    if (Number.isFinite(end)) return end <= now;
    if (['closed', 'completed', 'ended'].includes(status)) return true;
    // Old navigation failures left sessions active indefinitely. Their original
    // three-hour limit establishes when check-ins stopped being possible.
    return session.policyVersion !== 1 && (!status || status === 'active') && now - time > 3 * 3600000;
  }

  function completeAttendance(snapshot, now) {
    const currentTime = now === undefined ? Date.now() : millis(now);
    const courses = new Set((snapshot.courses || []).map(course => String(course.courseId || course.id || '')));
    const users = new Map();
    (snapshot.users || []).forEach(user => {
      const uid = String(user.id || user.uid || user.userId || '');
      [user.id, user.uid, user.userId, user.studentId, user.email].filter(Boolean).forEach(key => users.set(String(key), uid));
    });
    const canonicalUid = value => users.get(String(value || '')) || String(value || '');
    const sessions = new Map();
    (snapshot.sessions || []).forEach(session => {
      const id = String(session.sessionId || session.id || '');
      const value = { ...session, sessionId: id };
      if (id) sessions.set(id, value);
      if (session.id) sessions.set(String(session.id), value);
    });
    const records = new Map(), baselines = new Map(), evidence = new Map();
    (snapshot.attendance || []).forEach((entry, index) => {
      const session = sessions.get(String(entry.sessionId || ''));
      const sessionId = session?.sessionId || String(entry.sessionId || '');
      const courseId = String(session?.courseId || entry.courseId || '');
      const uid = canonicalUid(entry.uid || entry.userId || entry.studentId);
      const status = String(entry.status || '').toLowerCase();
      if (!uid || !courses.has(courseId) || !['present', 'late', 'absent'].includes(status)) return;
      const key = uid + '|' + courseId + '|' + (sessionId || entry.id || 'unlinked-' + index);
      const row = { ...entry, uid, courseId, sessionId, status };
      const previous = records.get(key);
      const canonicalId = sessionId + '_' + uid;
      if (!previous || (row.id === canonicalId && previous.id !== canonicalId)
          || (previous.id !== canonicalId && millis(row.time || row.createdAt) > millis(previous.time || previous.createdAt))) records.set(key, row);
      const studentCourse = uid + '|' + courseId;
      const time = session ? sessionTime(session) : millis(row.time || row.createdAt);
      if (status !== 'absent' && Number.isFinite(time) && (!baselines.has(studentCourse) || time < baselines.get(studentCourse))) baselines.set(studentCourse, time);
      if (row.id && !evidence.has(studentCourse)) evidence.set(studentCourse, row.id);
    });

    const memberships = new Map();
    (snapshot.enrollments || []).forEach(member => {
      const uid = canonicalUid(member.uid || member.userId || member.studentUid);
      const courseId = String(member.courseId || member.course_id || '');
      if (uid && courses.has(courseId) && ['active', 'removed', 'dropped'].includes(member.status)) memberships.set(uid + '|' + courseId, { ...member, uid, courseId });
    });
    // Some legacy records have no membership document at all. A recorded
    // check-in still establishes the earliest date that can be assessed.
    baselines.forEach((_time, key) => {
      if (!memberships.has(key)) {
        const separator = key.indexOf('|');
        memberships.set(key, { uid: key.slice(0, separator), courseId: key.slice(separator + 1), status: 'active' });
      }
    });

    memberships.forEach((member, studentCourse) => {
      let periods;
      if (Array.isArray(member.attendancePeriods)) {
        periods = member.attendancePeriods.map(period => ({ start: millis(period.start), end: period.end == null ? Infinity : millis(period.end) }));
      } else {
        const created = millis(member.joinedAt || member.createdAt);
        const updated = millis(member.updatedAt);
        const knownStart = member.status === 'active' && !member.joinedAt && Number.isFinite(created)
          && Number.isFinite(updated) && updated > created ? updated : created;
        const start = Number.isFinite(knownStart) ? knownStart : baselines.get(studentCourse);
        const end = member.status === 'active' ? Infinity : millis(member.leftAt || member.updatedAt);
        periods = [{ start, end }];
      }
      const eligible = periods.filter(period => Number.isFinite(period.start) && (Number.isFinite(period.end) || period.end === Infinity) && period.end >= period.start);
      if (!eligible.length) return;
      new Set(sessions.values()).forEach(session => {
        if (String(session.courseId) !== member.courseId || !isCompleted(session, currentTime)) return;
        const time = sessionTime(session);
        if (!eligible.some(period => time >= period.start && time < period.end)) return;
        const key = member.uid + '|' + member.courseId + '|' + session.sessionId;
        if (records.has(key)) return;
        records.set(key, {
          id: session.sessionId + '_' + member.uid, uid: member.uid, userId: member.uid,
          courseId: member.courseId, sessionId: session.sessionId, membershipId: member.id || '',
          attendanceEvidenceId: evidence.get(studentCourse) || '', status: 'absent',
          source: 'historical_inference', method: 'No recorded check-in', inferred: true,
          time: new Date(time).toISOString(),
        });
      });
    });
    return Array.from(records.values());
  }

  return { completeAttendance, isCompleted, millis };
});
