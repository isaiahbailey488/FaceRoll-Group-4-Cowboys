(function () {
  'use strict';

  function getFirstDefined(source, keys) {
    if (!source) return undefined;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
    return undefined;
  }

  function normalizeStatus(status) {
    const n = String(status || '').trim().toLowerCase();
    if (n === 'present') return 'Present';
    if (n === 'late') return 'Late';
    if (n === 'absent') return 'Absent';
    return 'Present';
  }

  function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value === 'object') {
      const seconds = value.seconds != null ? value.seconds : value._seconds;
      if (typeof seconds === 'number') return new Date(seconds * 1000);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDate(value) {
    const d = toDate(value);
    return d ? d.toISOString().slice(0, 10) : 'N/A';
  }

  function formatTime(value) {
    const d = toDate(value);
    return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
  }

  function getUserDisplayName(user) {
    const first = getFirstDefined(user, ['fname', 'firstName', 'first_name']) || '';
    const last = getFirstDefined(user, ['lname', 'lastName', 'last_name']) || '';
    return getFirstDefined(user, ['displayName', 'fullName', 'name']) || [first, last].filter(Boolean).join(' ') || getFirstDefined(user, ['email']) || 'Unknown Student';
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function statusClass(status) {
    const n = String(status || '').toLowerCase();
    if (n === 'present') return 'status-present';
    if (n === 'late') return 'status-late';
    if (n === 'absent') return 'status-absent';
    return '';
  }

  function updateSummary(history) {
    const present = history.filter(function (entry) { return entry.status === 'Present'; }).length;
    const late = history.filter(function (entry) { return entry.status === 'Late'; }).length;
    const absent = history.filter(function (entry) { return entry.status === 'Absent'; }).length;
    const rate = history.length ? Math.round(((present + late) / history.length) * 100) : 0;
    setText('iaj9kju', rate + '%');
    setText('iwzjofv', String(present));
    setText('ip95okd', String(late));
    setText('iq9g6ym', String(absent));
  }

  function renderProfile(student, history, sourceLabel) {
    const tbody = document.getElementById('profileAttendanceBody');
    if (!tbody) return;

    // Replace the static GrapesJS placeholder values with the selected student.
    setText('ix63k7g', student.name || 'Unknown Student');
    setText('iobn7gg', (student.courses || []).join(', ') || 'No courses found');
    setText('inpdknn', student.email || 'N/A');
    updateSummary(history);

    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="5">No attendance records found for this student.</td></tr>';
    } else {
      tbody.innerHTML = '';
      history.forEach(function (entry) {
        const row = document.createElement('tr');
        row.innerHTML = '<td></td><td></td><td><span class="status-badge"></span></td><td></td><td><select><option>No Change</option><option>Present</option><option>Late</option><option>Absent</option></select></td>';
        row.children[0].textContent = entry.date;
        row.children[1].textContent = entry.course;
        row.children[2].firstElementChild.textContent = entry.status;
        row.children[2].firstElementChild.classList.add(statusClass(entry.status));
        row.children[3].textContent = entry.recordedTime;
        tbody.appendChild(row);
      });
    }

    const status = document.getElementById('profileSaveStatus');
    if (status) status.textContent = sourceLabel || 'Student profile loaded.';
  }

  function renderUnavailable(studentId) {
    const params = new URLSearchParams(window.location.search);
    setText('ix63k7g', params.get('name') || studentId || 'Unknown Student');
    setText('iobn7gg', 'No courses found');
    setText('inpdknn', 'N/A');
    updateSummary([]);
    const tbody = document.getElementById('profileAttendanceBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">No attendance records found for this student.</td></tr>';
  }

  function getRequestedProfileKeys() {
    const params = new URLSearchParams(window.location.search);
    // The roster sends several possible identifiers because existing data has
    // used different names for the same concept across pages and Firestore docs.
    return ['studentId', 'docId', 'uid', 'userId', 'email', 'id']
      .map(function (key) { return params.get(key); })
      .filter(Boolean)
      .map(function (value) { return String(value); });
  }

  function tryRenderSample(studentId) {
    const api = window.FaceRollSampleData;
    if (!api || typeof api.getStudentByAnyId !== 'function') return false;
    const keys = getRequestedProfileKeys();
    // Sample data is only a fallback, but checking all URL keys keeps local
    // testing useful when the emulator has not loaded Firestore data yet.
    const student = keys.map(function (key) { return api.getStudentByAnyId(key); }).find(Boolean) || api.getStudentByAnyId(studentId);
    if (!student) return false;
    const history = api.getAttendanceHistory(student.studentId).map(function (entry) {
      return {
        date: entry.date,
        course: entry.course,
        status: normalizeStatus(entry.status),
        recordedTime: entry.recordedTime,
      };
    });
    renderProfile(student, history, 'Loaded sample profile data.');
    return true;
  }

  async function tryRenderFirestore(studentId) {
    const api = window.FaceRollFirebase;
    if (!api || typeof api.readCollectionDocs !== 'function') return false;

    // Read the page data as one snapshot so user, session, course, and attendance
    // rows are joined consistently for the profile view.
    const results = await Promise.all([
      api.readCollectionDocs('users'),
      api.readCollectionDocs('courses'),
      api.readCollectionDocs('sessions'),
      api.readCollectionDocs('attendance'),
    ]);
    const users = results[0], courses = results[1], sessions = results[2], attendance = results[3];
    const requestedKeys = getRequestedProfileKeys();
    if (studentId && !requestedKeys.includes(String(studentId))) requestedKeys.push(String(studentId));
    // Match against every likely user identifier so clicking View Profile works
    // even if the roster displayed studentId but attendance stored uid/userId.
    const user = users.find(function (u) {
      return [u.id, getFirstDefined(u, ['uid']), getFirstDefined(u, ['userId']), getFirstDefined(u, ['studentId']), getFirstDefined(u, ['email'])]
        .filter(Boolean)
        .some(function (value) { return requestedKeys.includes(String(value)); });
    });
    if (!user) return false;

    const keys = new Set([user.id, getFirstDefined(user, ['uid', 'userId', 'studentId', 'email'])].filter(Boolean).map(String));
    const courseMap = new Map();
    courses.forEach(function (c) {
      const id = String(getFirstDefined(c, ['courseId']) || c.id || '');
      if (id) courseMap.set(id, String(getFirstDefined(c, ['courseName', 'name', 'title', 'code']) || id));
    });
    const sessionMap = new Map();
    sessions.forEach(function (s) {
      const id = String(getFirstDefined(s, ['sessionId']) || s.id || '');
      if (id) sessionMap.set(id, s);
    });

    // Attendance rows only store ids, so enrich them here with session date and
    // course name before rendering the table.
    const history = attendance.filter(function (a) {
      return [getFirstDefined(a, ['uid', 'userId', 'studentId', 'email'])]
        .filter(Boolean)
        .some(function (value) { return keys.has(String(value)); });
    }).map(function (a) {
      const session = sessionMap.get(String(getFirstDefined(a, ['sessionId']) || '')) || null;
      const courseId = String(getFirstDefined(a, ['courseId']) || getFirstDefined(session, ['courseId']) || '');
      const status = normalizeStatus(getFirstDefined(a, ['status']));
      const dateValue = getFirstDefined(a, ['time', 'createdAt', 'date']) || getFirstDefined(session, ['startTime', 'date', 'createdAt']);
      return {
        date: formatDate(dateValue),
        course: courseMap.get(courseId) || courseId || 'Unknown Course',
        status: status,
        recordedTime: status === 'Absent' ? 'N/A' : formatTime(getFirstDefined(a, ['time', 'createdAt']) || dateValue),
        sortTime: toDate(dateValue) || new Date(0),
      };
    }).sort(function (a, b) {
      return b.sortTime.getTime() - a.sortTime.getTime();
    });

    const derivedCourses = Array.from(new Set(history.map(function (entry) { return entry.course; }))).filter(Boolean);
    renderProfile({
      name: getUserDisplayName(user),
      email: getFirstDefined(user, ['email']) || 'N/A',
      courses: derivedCourses,
    }, history, 'Loaded Firestore profile data.');
    return true;
  }

  function init() {
    if (!document.getElementById('profileAttendanceBody')) return;
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId') || params.get('docId') || params.get('uid') || 'student001';
    // Show the clicked student's name immediately, then replace it with the
    // Firestore-backed profile once the emulator request finishes.
    setText('ix63k7g', params.get('name') || studentId);
    setText('iobn7gg', 'Loading courses...');
    setText('inpdknn', 'Loading email...');
    updateSummary([]);
    tryRenderSample(studentId);

    window.setTimeout(async function () {
      try {
        const loaded = await tryRenderFirestore(studentId);
        if (!loaded && !tryRenderSample(studentId)) renderUnavailable(studentId);
      } catch (error) {
        console.error('Student profile fallback loader failed:', error);
        if (!tryRenderSample(studentId)) renderUnavailable(studentId);
      }
    }, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
