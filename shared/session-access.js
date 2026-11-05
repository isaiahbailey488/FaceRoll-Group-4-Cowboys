'use strict';
const { checkInDecision } = require('./session-policy');

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
  return (sessions || []).filter(session => {
    return courses.has(String(session.courseId || '')) &&
      checkInDecision({ ...session, status: session.status || 'active' }, now).allowed;
  });
}

module.exports = { membershipId, activeCourseIds, accessibleActiveSessions };
