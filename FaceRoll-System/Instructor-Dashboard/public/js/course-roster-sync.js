(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FaceRollCourseRoster = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;

  function value(record, keys) {
    for (const key of keys) {
      if (record && record[key] !== undefined && record[key] !== null) return record[key];
    }
    return '';
  }

  function activeRosterUids(memberships, courseId) {
    const selectedCourse = String(courseId || '').trim();
    if (!selectedCourse) return [];
    const uids = new Set();
    (Array.isArray(memberships) ? memberships : []).forEach(function (membership) {
      const membershipCourse = String(value(membership, ['courseId', 'course_id'])).trim();
      const status = String(value(membership, ['status'])).trim().toLowerCase();
      const uid = String(value(membership, ['uid', 'userId', 'studentUid'])).trim();
      if (membershipCourse === selectedCourse && status === 'active' && SAFE_UID.test(uid)) {
        uids.add(uid);
      }
    });
    return Array.from(uids).sort();
  }

  function rosterSignature(uids) {
    return (Array.isArray(uids) ? uids : []).slice().sort().join('\u0000');
  }

  function membershipId(courseId, uid) {
    const course = String(courseId || '').trim();
    const student = String(uid || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(course) || !SAFE_UID.test(student)) {
      throw new Error('Invalid course membership identity.');
    }
    return `${course.length}_${course}_${student}`;
  }

  async function processBridgeEvents(events, initialCursor, handler) {
    let cursor = Number(initialCursor || 0);
    let wroteAttendance = false;
    for (const event of Array.isArray(events) ? events : []) {
      wroteAttendance = await handler(event) || wroteAttendance;
      const eventCursor = Number(event && event.cursor);
      if (Number.isFinite(eventCursor)) cursor = Math.max(cursor, eventCursor);
    }
    return { cursor, wroteAttendance };
  }

  function membershipRosterRows(memberships, courses, users, instructorUid) {
    const ownedCourses = new Map();
    (Array.isArray(courses) ? courses : []).forEach(function (course) {
      const courseId = String(value(course, ['courseId', 'id'])).trim();
      if (courseId && course.instructorId === instructorUid) {
        ownedCourses.set(courseId, String(value(course, ['courseName', 'name']) || courseId));
      }
    });
    const usersByUid = new Map();
    (Array.isArray(users) ? users : []).forEach(function (user) {
      [user && user.id, value(user, ['uid']), value(user, ['userId'])]
        .filter(Boolean)
        .forEach(function (uid) { usersByUid.set(String(uid), user); });
    });
    return (Array.isArray(memberships) ? memberships : [])
      .map(function (membership) {
        const courseId = String(value(membership, ['courseId', 'course_id'])).trim();
        const uid = String(value(membership, ['uid', 'userId', 'studentUid'])).trim();
        const status = String(value(membership, ['status'])).trim().toLowerCase();
        if (!ownedCourses.has(courseId) || !SAFE_UID.test(uid) ||
            !['active', 'dropped', 'removed'].includes(status)) return null;
        return {
          membershipId: membershipId(courseId, uid),
          courseId,
          courseName: ownedCourses.get(courseId),
          uid,
          status,
          createdAt: value(membership, ['createdAt']),
          updatedAt: value(membership, ['updatedAt']),
          user: usersByUid.get(uid) || null,
        };
      })
      .filter(Boolean)
      .sort(function (left, right) {
        return left.courseName.localeCompare(right.courseName) || left.uid.localeCompare(right.uid);
      });
  }

  async function requestMembershipChange(baseUrl, user, courseId, studentUid, action, fetcher) {
    let url;
    try { url = new URL(baseUrl); }
    catch { throw new Error('The recognition server is not configured. Restart the demo.'); }
    if (url.protocol !== 'https:' || url.origin !== baseUrl || url.username || url.password) {
      throw new Error('Configure a trusted HTTPS recognition server address.');
    }
    if (!user) throw new Error('Sign in to manage course enrollments.');
    membershipId(courseId, studentUid);
    if (!['remove', 'restore'].includes(action)) throw new Error('Invalid enrollment action.');
    const send = fetcher || fetch;
    const response = await send(
      `${baseUrl}/courses/${encodeURIComponent(courseId)}/members/${encodeURIComponent(studentUid)}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${await user.getIdToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      }
    );
    const result = await response.json();
    if (!response.ok) {
      const messages = {
        course_owner_required: 'Only the course owner can manage this student.',
        membership_not_found: 'This course enrollment no longer exists.',
        active_session_exists: 'End the active session before changing this enrollment.',
      };
      throw new Error(messages[result.error] || 'Unable to update this course enrollment.');
    }
    if (result.success !== true || result.courseId !== courseId || result.uid !== studentUid ||
        result.status !== (action === 'remove' ? 'removed' : 'active')) {
      throw new Error('Unexpected course enrollment response.');
    }
    return result;
  }

  return {
    activeRosterUids,
    rosterSignature,
    membershipId,
    processBridgeEvents,
    membershipRosterRows,
    requestMembershipChange,
  };
});
