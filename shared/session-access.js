'use strict';

function membershipId(courseId, uid) {
  const course = String(courseId || '');
  const student = String(uid || '');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(course) || !/^[A-Za-z0-9_-]{1,128}$/.test(student)) {
    throw new Error('Invalid course membership identity.');
  }
  return `${course.length}_${course}_${student}`;
}

function activeCourseIds(enrollments, uid) {
  return new Set((enrollments || [])
    .filter(row => row && row.uid === uid && row.status === 'active')
    .map(row => String(row.courseId || ''))
    .filter(Boolean));
}

function accessibleActiveSessions(sessions, enrollments, uid, now = Date.now()) {
  const courses = activeCourseIds(enrollments, uid);
  const maxAge = 3 * 60 * 60 * 1000;
  return (sessions || []).filter(session => {
    const start = new Date(session.startTime).getTime();
    return courses.has(String(session.courseId || '')) &&
      String(session.status || 'active').toLowerCase() !== 'closed' && !session.endTime &&
      Number.isFinite(start) && now - start <= maxAge && now - start >= -60000;
  });
}

module.exports = { membershipId, activeCourseIds, accessibleActiveSessions };
