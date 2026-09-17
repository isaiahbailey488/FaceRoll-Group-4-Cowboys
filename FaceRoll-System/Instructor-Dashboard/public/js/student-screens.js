(function () {
  'use strict';

  const firebaseApi = window.FaceRollFirebase || null;
  const sampleDataApi = window.FaceRollSampleData || null;
  const PROFILE_OVERRIDE_STORAGE_KEY = 'faceroll-profile-overrides';
  const FACEROLL_BRIDGE_URL = 'http://127.0.0.1:8765';
  window.FaceRollProfileSave = null;

  // ---------- Helpers ----------

  function normalizeStatus(status) {
    const n = String(status || '').trim().toLowerCase();
    if (n === 'present') return 'Present';
    if (n === 'late') return 'Late';
    if (n === 'absent') return 'Absent';
    return '';
  }

  function getFirstDefined(source, keys) {
    if (!source) return undefined;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        return source[key];
      }
    }
    return undefined;
  }

  function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value.toDate === 'function') {
      const d = value.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'object') {
      const seconds = value.seconds != null ? value.seconds : value._seconds;
      if (typeof seconds === 'number') return new Date(seconds * 1000);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDateDisplay(value) {
    const d = toDate(value);
    return d ? d.toISOString().slice(0, 10) : 'N/A';
  }

  function formatTimeDisplay(value) {
    const d = toDate(value);
    if (!d) return 'N/A';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function normalizeLookupKey(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9@.]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function stripEnrollmentPhotoNumber(value) {
    // Treat multiple enrollment photos as the same student name.
    return normalizeLookupKey(value)
      .replace(/\s+\d+$/, '')
      .replace(/([a-z])\d+$/, '$1')
      .trim();
  }

  function getIdentityCandidates(event) {
    // Build every likely lookup key from the recognizer event.
    const rawValues = [
      event && event.uid,
      event && event.userId,
      event && event.studentId,
      event && event.identityLabel,
      event && event.identity,
    ];
    const candidates = new Set();

    rawValues.filter(Boolean).forEach(function (value) {
      const raw = String(value);
      [raw, raw.split(/[\\/]/).pop(), raw.split(/[\\/]/).slice(-2, -1)[0]]
        .filter(Boolean)
        .forEach(function (part) {
          const normalized = normalizeLookupKey(part);
          if (normalized) {
            candidates.add(normalized);
            candidates.add(stripEnrollmentPhotoNumber(normalized));
          }
        });
    });

    return Array.from(candidates).filter(Boolean);
  }

  function getRecognitionLabel(event) {
    const label =
      getFirstDefined(event, ['identityLabel', 'studentName', 'displayName', 'name']) ||
      String(getFirstDefined(event, ['identity']) || '').split(/[\\/]/).pop() ||
      'Recognized Student';
    return stripEnrollmentPhotoNumber(label) || 'Recognized Student';
  }

  function formatRecognitionName(label) {
    if (!label) return '';
    return String(label)
      .split(' ')
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }

  function getRecognitionUid(event) {
    const preferred = getRecognitionLabel(event);
    return 'recognition_' + preferred.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function getCanonicalStudentKey(name, uid) {
    const cleanedName = stripEnrollmentPhotoNumber(name);
    if (cleanedName) return cleanedName;
    return String(uid || '').trim().toLowerCase() || 'unknown_student';
  }

  async function requestBridge(path, options) {
    // Talks to recognition/windows/bridge_server.py on the instructor laptop.
    const response = await fetch(FACEROLL_BRIDGE_URL + path, Object.assign({
      mode: 'cors',
      cache: 'no-store',
    }, options || {}));
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || ('Bridge request failed: ' + response.status));
    }
    return payload;
  }

  function getStatusClass(status) {
    const n = String(status || '').toLowerCase();
    if (n === 'present') return 'status-present';
    if (n === 'late') return 'status-late';
    if (n === 'absent') return 'status-absent';
    return '';
  }

  function formatDuration(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function getUserDisplayName(user) {
    if (!user) return 'Unknown Student';
    const first = getFirstDefined(user, ['fname', 'firstName', 'first_name']) || '';
    const last = getFirstDefined(user, ['lname', 'lastName', 'last_name']) || '';
    const joined = [first, last].filter(Boolean).join(' ').trim();
    return (
      getFirstDefined(user, ['displayName', 'fullName', 'name']) ||
      joined ||
      getFirstDefined(user, ['email']) ||
      'Unknown Student'
    );
  }

  function populateCourseDropdown(selectEl, courseOptions, placeholder) {
    // Used by roster, reports, and live session filters.
    if (!selectEl) return;
    selectEl.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = placeholder || 'All Courses';
    selectEl.appendChild(allOpt);
    (courseOptions || []).forEach(function (course) {
      const opt = document.createElement('option');
      opt.value = course.name;
      opt.textContent = course.name;
      selectEl.appendChild(opt);
    });
  }

  function getStudentProfileOverrides(studentId) {
    try {
      const raw = localStorage.getItem(PROFILE_OVERRIDE_STORAGE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      return all[studentId] || {};
    } catch (e) {
      return {};
    }
  }

  function saveStudentProfileOverrides(studentId, overrides) {
    try {
      const raw = localStorage.getItem(PROFILE_OVERRIDE_STORAGE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[studentId] = overrides;
      localStorage.setItem(PROFILE_OVERRIDE_STORAGE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function buildHistoryEntryKey(entry) {
    return [entry.date, entry.course, entry.recordedTime].join('|');
  }

  function applyOverridesToHistory(studentId, history) {
    const overridesByEntryKey = getStudentProfileOverrides(studentId);
    return (history || []).map(function (entry) {
      const entryKey = entry.entryKey || buildHistoryEntryKey(entry);
      const overrideStatus = normalizeStatus(overridesByEntryKey[entryKey]);
      return {
        documentId: entry.documentId || '',
        date: entry.date,
        course: entry.course,
        status: overrideStatus || normalizeStatus(entry.status) || 'Present',
        recordedTime: entry.recordedTime,
        entryKey: entryKey,
      };
    });
  }

  function buildProfileSummary(history) {
    const totalSessions = history.length;
    const present = history.filter(function (entry) { return entry.status === 'Present'; }).length;
    const late = history.filter(function (entry) { return entry.status === 'Late'; }).length;
    const absent = history.filter(function (entry) { return entry.status === 'Absent'; }).length;
    return {
      attendanceRate: totalSessions ? Math.round(((present + late) / totalSessions) * 100) : 0,
      sessionsAttended: present,
      lateArrivals: late,
      totalAbsences: absent,
    };
  }

  function updateProfileSummary(summary) {
    const rate = document.getElementById('iaj9kju');
    const attended = document.getElementById('iwzjofv');
    const late = document.getElementById('ip95okd');
    const absent = document.getElementById('iq9g6ym');
    if (rate) rate.textContent = String(summary.attendanceRate) + '%';
    if (attended) attended.textContent = String(summary.sessionsAttended);
    if (late) late.textContent = String(summary.lateArrivals);
    if (absent) absent.textContent = String(summary.totalAbsences);
  }

  function setProfileSaveStatus(message, isError) {
    const statusElement = document.getElementById('profileSaveStatus');
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.style.color = isError ? '#b91c1c' : '#475569';
  }

  function applyStatusBadge(statusElement, status) {
    statusElement.textContent = status || 'Present';
    statusElement.classList.remove('status-present', 'status-late', 'status-absent');
    const statusClass = getStatusClass(status);
    if (statusClass) statusElement.classList.add(statusClass);
  }

  function renderProfileHistoryRows(historyBody, history) {
    historyBody.innerHTML = '';
    if (!history.length) {
      historyBody.innerHTML = '<tr><td colspan="5">No attendance records found for this student.</td></tr>';
      return;
    }

    history.forEach(function (entry) {
      const row = document.createElement('tr');
      row.innerHTML = [
        '<td></td>',
        '<td></td>',
        '<td><span class="status-badge student-status"></span></td>',
        '<td></td>',
        '<td><select><option>No Change</option><option>Present</option><option>Late</option><option>Absent</option></select></td>',
      ].join('');
      row.children[0].textContent = entry.date;
      row.children[1].textContent = entry.course;
      row.children[3].textContent = entry.recordedTime;
      row.dataset.entryKey = entry.entryKey;
      row.dataset.documentId = entry.documentId || '';
      applyStatusBadge(row.children[2].firstElementChild, entry.status);
      row.children[4].firstElementChild.value = 'No Change';
      historyBody.appendChild(row);
    });
  }

  function getUserEmail(user, fallbackStudent) {
    return (
      getFirstDefined(user, ['email']) ||
      getFirstDefined(fallbackStudent, ['email']) ||
      'N/A'
    );
  }

  async function loadProfileDataFromFirestore(requestedStudentId) {
    if (!firebaseApi) return null;

    const results = await Promise.all([
      firebaseApi.readCollectionDocs('users'),
      firebaseApi.readCollectionDocs('courses'),
      firebaseApi.readCollectionDocs('sessions'),
      firebaseApi.readCollectionDocs('attendance'),
    ]);
    const users = results[0], courses = results[1], sessions = results[2], attendance = results[3];

    const params = new URLSearchParams(window.location.search);
    const requestedKeys = ['studentId', 'docId', 'uid', 'userId', 'email', 'id']
      .map(function (key) { return params.get(key); })
      .filter(Boolean)
      .map(function (value) { return String(value); });
    if (requestedStudentId && !requestedKeys.includes(String(requestedStudentId))) {
      requestedKeys.push(String(requestedStudentId));
    }
    const studentUser = users.find(function (user) {
      return [
        user.id,
        getFirstDefined(user, ['uid']),
        getFirstDefined(user, ['userId']),
        getFirstDefined(user, ['studentId']),
        getFirstDefined(user, ['email']),
      ].filter(Boolean).some(function (value) { return requestedKeys.includes(String(value)); });
    }) || null;
    if (!studentUser) return null;

    const studentKeys = new Set([
      studentUser.id,
      getFirstDefined(studentUser, ['uid', 'userId', 'studentId', 'email']),
    ].filter(Boolean).map(function (value) { return String(value); }));

    const courseMap = new Map();
    courses.forEach(function (course) {
      const id = String(getFirstDefined(course, ['courseId']) || course.id || '');
      if (id) courseMap.set(id, course);
    });

    const sessionMap = new Map();
    sessions.forEach(function (session) {
      const id = String(getFirstDefined(session, ['sessionId']) || session.id || '');
      if (id) sessionMap.set(id, session);
    });

    const studentAttendance = attendance.filter(function (entry) {
      return [
        getFirstDefined(entry, ['uid', 'userId', 'studentId', 'email']),
      ].filter(Boolean).some(function (value) { return studentKeys.has(String(value)); });
    });

    const history = studentAttendance.map(function (entry) {
      const sessionId = String(getFirstDefined(entry, ['sessionId']) || '');
      const session = sessionMap.get(sessionId) || null;
      const courseId = String(getFirstDefined(entry, ['courseId']) || getFirstDefined(session, ['courseId']) || '');
      const course = courseMap.get(courseId) || null;
      const entryDate = getFirstDefined(entry, ['time', 'createdAt', 'date']) || getFirstDefined(session, ['startTime', 'date', 'createdAt']);
      const status = normalizeStatus(getFirstDefined(entry, ['status'])) || 'Present';
      const recordedTimeValue = getFirstDefined(entry, ['time', 'createdAt']);

      return {
        documentId: entry.id,
        date: formatDateDisplay(entryDate),
        course: String(getFirstDefined(course, ['courseName', 'name', 'title', 'code']) || courseId || 'Unknown Course'),
        status: status,
        recordedTime: status === 'Absent' ? 'N/A' : formatTimeDisplay(recordedTimeValue || entryDate),
        entryKey: String(entry.id || buildHistoryEntryKey({
          date: formatDateDisplay(entryDate),
          course: courseId || 'Unknown Course',
          recordedTime: formatTimeDisplay(recordedTimeValue || entryDate),
        })),
        timeValue: toDate(entryDate) || new Date(0),
      };
    }).sort(function (left, right) {
      return right.timeValue.getTime() - left.timeValue.getTime();
    }).map(function (entry) {
      delete entry.timeValue;
      return entry;
    });

    const fallbackStudent = sampleDataApi ? sampleDataApi.getStudentByAnyId(requestedStudentId) : null;
    const derivedCourses = Array.from(new Set(history.map(function (entry) { return entry.course; }).filter(Boolean)));
    const studentId = String(getFirstDefined(studentUser, ['studentId', 'userId', 'uid']) || studentUser.id || requestedStudentId);

    return {
      student: {
        studentId: studentId,
        name: getUserDisplayName(studentUser),
        email: getUserEmail(studentUser, fallbackStudent),
        courses: derivedCourses.length ? derivedCourses : (fallbackStudent ? fallbackStudent.courses : ['No courses found']),
      },
      history: applyOverridesToHistory(studentId, history),
    };
  }

  function buildFallbackProfileData(requestedStudentId) {
    if (!sampleDataApi) return null;
    const student = sampleDataApi.getStudentByAnyId(requestedStudentId);
    if (!student) return null;
    return {
      student: student,
      history: applyOverridesToHistory(student.studentId, sampleDataApi.getAttendanceHistory(student.studentId)),
    };
  }

  // ---------- Roster ----------

  async function renderRosterPage() {
    // Student roster page: combines users, courses, sessions, and attendance.
    const tbody = document.getElementById('rosterTbody');
    const courseFilter = document.getElementById('rosterCourseFilter');
    const searchInput = document.getElementById('rosterSearchInput');
    if (!tbody || !courseFilter || !searchInput) return;

    function renderEmpty(msg) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="color:#0f172a;font-weight:400;">' +
        (msg || 'No students found.') + '</td></tr>';
    }

    if (!firebaseApi) {
      renderEmpty('Firestore unavailable.');
      return;
    }

    tbody.innerHTML = '<tr><td colspan="6">Loading students...</td></tr>';

    let users = [], courses = [], sessions = [], attendance = [];
    try {
      const results = await Promise.all([
        firebaseApi.readCollectionDocs('users'),
        firebaseApi.readCollectionDocs('courses'),
        firebaseApi.readCollectionDocs('sessions'),
        firebaseApi.readCollectionDocs('attendance'),
      ]);
      users = results[0]; courses = results[1]; sessions = results[2]; attendance = results[3];
    } catch (e) {
      console.error('Roster load failed:', e);
      renderEmpty('Unable to load roster.');
      return;
    }

    const courseMap = new Map();
    courses.forEach(function (c) {
      const id = String(getFirstDefined(c, ['courseId']) || c.id || '');
      const name = String(getFirstDefined(c, ['courseName', 'name', 'title']) || id || 'Unknown Course');
      if (id) courseMap.set(id, name);
    });

    const sessionMap = new Map();
    sessions.forEach(function (s) {
      const id = String(getFirstDefined(s, ['sessionId']) || s.id || '');
      const courseId = String(getFirstDefined(s, ['courseId']) || '');
      if (id) sessionMap.set(id, courseId);
    });

    const courseOptions = Array.from(new Set(Array.from(courseMap.values()))).map(function (n) {
      return { name: n };
    });
    populateCourseDropdown(courseFilter, courseOptions, 'All Courses');

    const students = users
      .filter(function (u) {
        const role = String(getFirstDefined(u, ['role', 'userType']) || '').toLowerCase();
        return role === 'student' || role === 'learner' || Boolean(getFirstDefined(u, ['studentId']));
      })
      .map(function (u) {
        const keys = new Set(
          [u.id, getFirstDefined(u, ['uid', 'userId', 'studentId'])]
            .filter(Boolean).map(function (v) { return String(v); })
        );
        const my = attendance.filter(function (a) {
          const uid = getFirstDefined(a, ['uid', 'userId']);
          return uid && keys.has(String(uid));
        });
        const present = my.filter(function (a) { return normalizeStatus(getFirstDefined(a, ['status'])) === 'Present'; }).length;
        const late = my.filter(function (a) { return normalizeStatus(getFirstDefined(a, ['status'])) === 'Late'; }).length;
        const absent = my.filter(function (a) { return normalizeStatus(getFirstDefined(a, ['status'])) === 'Absent'; }).length;
        const total = my.length;
        const rate = total ? Math.round(((present + late) / total) * 100) : 0;
        const enrolled = Array.from(new Set(my.map(function (a) {
          const sid = String(getFirstDefined(a, ['sessionId']) || '');
          const cid = sessionMap.get(sid) || String(getFirstDefined(a, ['courseId']) || '');
          return courseMap.get(cid) || null;
        }).filter(Boolean)));
        return {
          name: getUserDisplayName(u),
          studentId: String(getFirstDefined(u, ['studentId', 'userId']) || u.id || 'N/A'),
          // Keep every stable identifier we know about so the profile page can
          // still find the student if Firestore uses doc id, uid, or studentId.
          docId: String(u.id || ''),
          uid: String(getFirstDefined(u, ['uid', 'userId']) || ''),
          email: String(getFirstDefined(u, ['email']) || 'N/A'),
          attendanceRate: rate,
          totalAbsences: absent,
          courses: enrolled,
        };
      });

    function renderRows() {
      const search = String(searchInput.value || '').trim().toLowerCase();
      const course = String(courseFilter.value || '').trim();
      const filtered = students.filter(function (s) {
        const ms = !search || String(s.name).toLowerCase().includes(search) || String(s.studentId).toLowerCase().includes(search);
        const mc = !course || (Array.isArray(s.courses) && s.courses.includes(course));
        return ms && mc;
      });
      if (!filtered.length) { renderEmpty('No students found.'); return; }
      tbody.innerHTML = '';
      filtered.forEach(function (s) {
        const row = document.createElement('tr');
        row.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td><a class="student-action-link">View Profile</a></td>';
        row.children[0].textContent = s.name;
        row.children[1].textContent = s.studentId;
        row.children[2].textContent = s.email;
        row.children[3].textContent = String(s.attendanceRate) + '%';
        row.children[4].textContent = String(s.totalAbsences);
        // Pass redundant lookup keys to avoid the profile page depending on one
        // Firestore field name. The profile loader tries all of these values.
        const profileParams = new URLSearchParams();
        profileParams.set('studentId', s.studentId);
        if (s.docId) profileParams.set('docId', s.docId);
        if (s.uid) profileParams.set('uid', s.uid);
        if (s.email && s.email !== 'N/A') profileParams.set('email', s.email);
        if (s.name) profileParams.set('name', s.name);
        row.children[5].firstElementChild.href = './student-profile.html?' + profileParams.toString();
        tbody.appendChild(row);
      });
    }

    courseFilter.addEventListener('change', renderRows);
    searchInput.addEventListener('input', renderRows);
    renderRows();
  }

  // ---------- Live Session ----------

  function renderLiveSessionPage() {
    // Live session page: starts the bridge, polls recognition events, and writes attendance.
    const tbody = document.getElementById('liveSessionTbody');
    const startButton = document.getElementById('iq6lcg');
    const durationElement = document.getElementById('impi7gl');
    const sessionDateInput = document.getElementById('liveSessionDate');
    const courseSelect = document.getElementById('liveSessionCourseSelect');
    const recognizedElement = document.getElementById('i2ojcf');
    const lateElement = document.getElementById('imevvg');
    if (!tbody) return;

    let sessionStatusValue = document.getElementById('liveSessionStatus');
    if (!sessionStatusValue) {
      const label = Array.from(document.querySelectorAll('.filter-field .filter-label'))
        .find(function (l) { return String(l.textContent || '').trim() === 'Session Status'; });
      if (label && label.parentElement) sessionStatusValue = label.parentElement.querySelector('span');
    }

    let timerHandle = null;
    let livePollHandle = null;
    let bridgePollHandle = null;
    let bridgeEventCursor = 0;
    const writtenBridgeEvents = new Set();
    let sessionStartedAt = null;
    let activeSessionDocId = null;
    let activeCourseId = '';
    let activeCourseName = '';
    let activeGracePeriodMinutes = 10;

    function setSessionStatus(t) { if (sessionStatusValue) sessionStatusValue.textContent = t; }
    function setStartButtonState(started, busy) {
      if (!startButton) return;
      startButton.textContent = busy ? 'Working...' : started ? 'Stop Session' : 'Start Session';
      startButton.disabled = Boolean(busy);
      startButton.style.opacity = busy ? '0.75' : '1';
      startButton.style.cursor = busy ? 'wait' : 'pointer';
    }
    function renderEmpty() {
      tbody.innerHTML = '<tr><td colspan="4">No check-ins yet for this session.</td></tr>';
      if (recognizedElement) recognizedElement.textContent = '0';
      if (lateElement) lateElement.textContent = '0';
    }
    function updateDuration(startMs) {
      if (!durationElement) return;
      const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      durationElement.textContent = formatDuration(s);
    }
    function beginTimer(startMs) {
      if (timerHandle) clearInterval(timerHandle);
      updateDuration(startMs);
      timerHandle = setInterval(function () { updateDuration(startMs); }, 1000);
    }
    function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }
    function stopPoller() { if (livePollHandle) { clearInterval(livePollHandle); livePollHandle = null; } }
    function stopBridgePoller() {
      if (bridgePollHandle) {
        clearInterval(bridgePollHandle);
        bridgePollHandle = null;
      }
    }

    function resetIdle() {
      sessionStartedAt = null;
      activeSessionDocId = null;
      activeCourseId = '';
      activeCourseName = '';
      activeGracePeriodMinutes = 10;
      bridgeEventCursor = 0;
      writtenBridgeEvents.clear();
      setSessionStatus('Not Started');
      stopTimer(); stopPoller(); stopBridgePoller();
      if (durationElement) durationElement.textContent = '00:00';
      setStartButtonState(false, false);
      renderEmpty();
    }

    function renderLiveRows(rows) {
      if (!rows.length) { renderEmpty(); return; }
      const recognized = rows.filter(function (r) { return r.status !== 'Absent'; }).length;
      const late = rows.filter(function (r) { return r.status === 'Late'; }).length;
      if (recognizedElement) recognizedElement.textContent = String(recognized);
      if (lateElement) lateElement.textContent = String(late);
      tbody.innerHTML = '';
      rows.forEach(function (e) {
        const row = document.createElement('tr');
        row.innerHTML = '<td></td><td></td><td><span class="status-badge live-status"></span></td><td></td>';
        row.children[0].textContent = e.studentName;
        row.children[1].textContent = e.course;
        row.children[2].firstElementChild.textContent = e.status;
        const cls = getStatusClass(e.status);
        if (cls) row.children[2].firstElementChild.classList.add(cls);
        row.children[3].textContent = e.recordedTime;
        tbody.appendChild(row);
      });
    }

    async function loadCourses() {
      if (!courseSelect) return;
      if (!firebaseApi) {
        courseSelect.innerHTML = '<option value="">Firestore unavailable</option>';
        return;
      }
      try {
        const courses = await firebaseApi.readCollectionDocs('courses');
        courseSelect.innerHTML = '';
        if (!courses.length) {
          courseSelect.innerHTML = '<option value="">No courses found</option>';
          return;
        }
        courses.forEach(function (c) {
          const opt = document.createElement('option');
          const id = String(getFirstDefined(c, ['courseId']) || c.id || '');
          const name = String(getFirstDefined(c, ['courseName', 'name', 'title', 'code']) || id);
          opt.value = id;
          opt.textContent = name;
          courseSelect.appendChild(opt);
        });
      } catch (e) {
        console.error('Failed to load courses:', e);
        courseSelect.innerHTML = '<option value="">Unable to load courses</option>';
      }
    }

    async function loadCourseRosterUids(courseId) {
      // The enrollments collection is optional during migration. A null result
      // means no roster data exists yet; an empty array means a roster exists
      // but the selected course currently has no authorized students.
      const enrollments = await firebaseApi.readCollectionDocs('enrollments');
      if (!enrollments.length) return null;

      const uids = new Set();
      enrollments.forEach(function (entry) {
        const entryCourseId = String(getFirstDefined(entry, ['courseId', 'course_id']) || '');
        const status = String(getFirstDefined(entry, ['status']) || 'active').toLowerCase();
        if (entryCourseId !== String(courseId) || ['dropped', 'inactive', 'removed'].includes(status)) {
          return;
        }
        const uid = String(getFirstDefined(entry, ['uid', 'userId', 'studentUid']) || '').trim();
        if (uid) uids.add(uid);
      });
      return Array.from(uids);
    }

    async function fetchRows() {
      if (!firebaseApi || !activeSessionDocId) return;
      try {
        const results = await Promise.all([
          firebaseApi.readCollectionDocs('attendance'),
          firebaseApi.readCollectionDocs('users'),
          firebaseApi.readCollectionDocs('courses'),
        ]);
        const att = results[0], users = results[1], courses = results[2];
        const userMap = new Map();
        users.forEach(function (u) {
          [u.id, getFirstDefined(u, ['uid', 'userId', 'studentId', 'email'])]
            .filter(Boolean).forEach(function (k) { userMap.set(String(k), u); });
        });
        const courseMap = new Map();
        courses.forEach(function (c) {
          courseMap.set(
            String(getFirstDefined(c, ['courseId']) || c.id || ''),
            String(getFirstDefined(c, ['courseName', 'name', 'title', 'code']) || '')
          );
        });
        const rowMap = new Map();
        att
          .filter(function (d) { return String(getFirstDefined(d, ['sessionId']) || '') === String(activeSessionDocId); })
          .forEach(function (d) {
            const uid = String(getFirstDefined(d, ['uid', 'userId']) || '');
            const user = userMap.get(uid) || null;
            const cid = String(getFirstDefined(d, ['courseId']) || '');
            const fallbackName = getFirstDefined(d, ['studentName', 'displayName', 'recognitionLabel']);
            const recognitionName = formatRecognitionName(stripEnrollmentPhotoNumber(fallbackName));
            const displayName = recognitionName || (user ? getUserDisplayName(user) : 'Recognized Student');
            const row = {
              studentName: displayName,
              course: courseMap.get(cid) || activeCourseName || 'Unknown Course',
              status: normalizeStatus(getFirstDefined(d, ['status']) || 'present') || 'Present',
              recordedTime: formatTimeDisplay(getFirstDefined(d, ['time', 'createdAt'])),
              timeValue: toDate(getFirstDefined(d, ['time', 'createdAt'])) || new Date(0),
            };
            const key = getCanonicalStudentKey(displayName, uid) + '||' + cid;
            const existing = rowMap.get(key);
            if (!existing || row.timeValue > existing.timeValue) rowMap.set(key, row);
          });
        const rows = Array.from(rowMap.values())
          .sort(function (a, b) { return String(a.recordedTime).localeCompare(String(b.recordedTime)); });
        renderLiveRows(rows);
      } catch (e) { console.error('Live refresh failed:', e); }
    }

    function startPoller() {
      stopPoller(); fetchRows();
      livePollHandle = setInterval(fetchRows, 3000);
    }

    function buildUserLookup(users) {
      // Match recognition labels to Firestore users by id, email, or display name.
      const lookup = new Map();
      users.forEach(function (user) {
        const displayName = getUserDisplayName(user);
        [
          user.id,
          getFirstDefined(user, ['uid', 'userId', 'studentId', 'email']),
          getFirstDefined(user, ['studentNumber', 'schoolId']),
          getFirstDefined(user, ['name', 'displayName', 'fullName']),
          displayName,
          [getFirstDefined(user, ['firstName']), getFirstDefined(user, ['lastName'])].filter(Boolean).join(' '),
        ].filter(Boolean).forEach(function (value) {
          const key = normalizeLookupKey(value);
          if (key && !lookup.has(key)) lookup.set(key, user);
        });
      });
      return lookup;
    }

    async function writeAttendanceFromBridgeEvent(event) {
      // Convert one bridge recognition event into one Firestore attendance record.
      if (!firebaseApi || !activeSessionDocId || !activeCourseId || !event) return false;
      if (event.eventType && event.eventType !== 'match') return false;
      const eventSessionId = String(getFirstDefined(event, ['sessionId']) || '');
      const eventCourseId = String(getFirstDefined(event, ['courseId']) || '');
      if (eventSessionId && eventSessionId !== String(activeSessionDocId)) return false;
      if (eventCourseId && eventCourseId !== String(activeCourseId)) return false;

      const eventKey = String(getFirstDefined(event, ['cursor', 'timestamp', 'identity']) || '');
      if (eventKey && writtenBridgeEvents.has(eventKey)) return false;

      const users = await firebaseApi.readCollectionDocs('users');
      const userLookup = buildUserLookup(users);
      const authoritativeUid = String(getFirstDefined(event, ['uid']) || '').trim();
      if (!authoritativeUid) return false;
      const user = userLookup.get(normalizeLookupKey(authoritativeUid)) || null;
      if (!user) {
        console.warn('Ignoring recognition event for an unknown Firebase UID.');
        return false;
      }

      const recognitionLabel = getRecognitionLabel(event);
      const uid = authoritativeUid;
      if (!uid) return false;
      const studentName = getUserDisplayName(user);

      const eventTime = toDate(getFirstDefined(event, ['timestamp', 'time', 'createdAt'])) || new Date();
      const sessionStart = sessionStartedAt || Date.now();
      const isLate = Number.isFinite(activeGracePeriodMinutes)
        ? eventTime.getTime() - sessionStart > activeGracePeriodMinutes * 60 * 1000
        : false;
      const attendanceId = activeSessionDocId + '_' + uid;

      const attendanceDoc = {
        // These fields are read by dashboard, reports, roster, and live session.
        id: attendanceId,
        uid: uid,
        userId: uid,
        studentName: studentName,
        displayName: studentName,
        sessionId: activeSessionDocId,
        courseId: activeCourseId,
        status: isLate ? 'late' : 'present',
        time: eventTime.toISOString(),
        createdAt: eventTime.toISOString(),
        source: 'classroom_camera',
        method: 'Classroom camera recognition',
        matchedUser: Boolean(user),
        recognitionIdentity: String(getFirstDefined(event, ['identity']) || ''),
        recognitionLabel: recognitionLabel,
      };
      const confidence = getFirstDefined(event, ['confidence']);
      const distance = getFirstDefined(event, ['distance']);
      if (confidence !== undefined) attendanceDoc.recognitionConfidence = confidence;
      if (distance !== undefined) attendanceDoc.recognitionDistance = distance;

      const created = await firebaseApi.createDocumentIfAbsent(
        'attendance',
        attendanceId,
        attendanceDoc
      );

      if (eventKey) writtenBridgeEvents.add(eventKey);
      return created;
    }

    async function pollBridgeEvents() {
      // Cursor prevents the same bridge event from being processed twice.
      if (!activeSessionDocId) return;
      try {
        const payload = await requestBridge('/events?cursor=' + encodeURIComponent(String(bridgeEventCursor)));
        bridgeEventCursor = Number(payload.nextCursor || bridgeEventCursor || 0);
        const events = Array.isArray(payload.events) ? payload.events : [];
        let wroteAttendance = false;
        for (const event of events) {
          wroteAttendance = await writeAttendanceFromBridgeEvent(event) || wroteAttendance;
        }
        if (wroteAttendance) fetchRows();
      } catch (e) {
        console.error('Bridge event poll failed:', e);
      }
    }

    function startBridgePoller() {
      stopBridgePoller();
      pollBridgeEvents();
      bridgePollHandle = setInterval(pollBridgeEvents, 2000);
    }

    async function readGrace() {
      try {
        if (!window.firebase || typeof window.firebase.auth !== 'function') return 10;
        const cu = window.firebase.auth().currentUser;
        const uid = cu && cu.uid;
        if (!uid || !window.firebase.firestore) return 10;
        const snap = await window.firebase.firestore().collection('instructor_settings').doc(uid).get();
        if (!snap.exists) return 10;
        const v = Number.parseInt((snap.data() || {}).gracePeriodMinutes, 10);
        return Number.isFinite(v) && v >= 0 ? v : 10;
      } catch (e) { return 10; }
    }

    async function handleStart() {
      // Create the Firestore session first, then start the local recognition bridge.
      if (!firebaseApi) { setSessionStatus('Firestore unavailable'); return; }
      const selectedId = courseSelect ? String(courseSelect.value || '').trim() : '';
      if (!selectedId) { setSessionStatus('Select a course first'); return; }
      const selectedLabel = courseSelect && courseSelect.selectedOptions[0]
        ? String(courseSelect.selectedOptions[0].textContent || selectedId) : selectedId;
      setStartButtonState(false, true);
      let pendingSessionDocId = null;
      try {
        const now = new Date();
        const sid = 'session_' + now.getTime();
        const grace = await readGrace();
        const allowedUids = await loadCourseRosterUids(selectedId);
        pendingSessionDocId = sid;
        await firebaseApi.writeDocument('sessions', sid, {
          id: sid, sessionId: sid, courseId: selectedId,
          startTime: now.toISOString(), gracePeriodMinutes: grace, status: 'active',
        });
        const bridgeSession = { sessionId: sid, courseId: selectedId };
        if (allowedUids !== null) bridgeSession.allowedUids = allowedUids;
        await requestBridge('/start-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bridgeSession),
        });
        sessionStartedAt = now.getTime();
        activeSessionDocId = sid;
        activeCourseId = selectedId;
        activeCourseName = selectedLabel;
        activeGracePeriodMinutes = grace;
        setSessionStatus('Started');
        setStartButtonState(true, false);
        beginTimer(sessionStartedAt);
        startPoller();
        startBridgePoller();
      } catch (e) {
        console.error('Start failed:', e);
        try {
          await requestBridge('/stop-session', { method: 'POST' });
        } catch (stopError) {
          console.error('Bridge cleanup after failed start failed:', stopError);
        }
        if (pendingSessionDocId) {
          try {
            await firebaseApi.writeDocument('sessions', pendingSessionDocId, {
              status: 'start_failed', endTime: new Date().toISOString(),
            });
          } catch (writeError) {
            console.error('Failed to mark session start failure:', writeError);
          }
        }
        setSessionStatus('Start failed');
        setStartButtonState(false, false);
      }
    }

    async function handleStop() {
      setStartButtonState(true, true);
      try {
        await requestBridge('/stop-session', { method: 'POST' });
      } catch (e) {
        console.error('Bridge stop failed:', e);
      }
      try {
        if (firebaseApi && activeSessionDocId) {
          await firebaseApi.writeDocument('sessions', activeSessionDocId, {
            status: 'closed', endTime: new Date().toISOString(),
          });
        }
      } catch (e) { console.error('Stop failed:', e); }
      resetIdle();
    }

    if (sessionDateInput && !sessionDateInput.value) {
      sessionDateInput.value = new Date().toISOString().slice(0, 10);
    }
    resetIdle();
    loadCourses();
    window.addEventListener('faceroll:courses-updated', loadCourses);

    if (startButton) {
      startButton.addEventListener('click', function () {
        if (sessionStartedAt !== null) handleStop();
        else handleStart();
      });
    }
  }

  // ---------- Reports ----------

  async function renderReportsPage() {
    // Reports page: groups attendance by student and course.
    const tbody = document.getElementById('reportsTbody');
    if (!tbody) return;

    const courseFilter = document.getElementById('reportsCourseFilter');
    const fromDateInput = document.getElementById('reportsFromDate');
    const toDateInput = document.getElementById('reportsToDate');
    const statusFilter = document.getElementById('reportsStatusFilter');
    const avgEl = document.getElementById('ikkzfr');
    const totSessEl = document.getElementById('i8cefo');
    const totStuEl = document.getElementById('injzav');
    const exportBtn = document.getElementById('iaq1jh-2');
    const exportStatus = document.getElementById('reportsExportStatus');

    function resetExport(message) {
      if (exportBtn) { exportBtn.disabled = true; exportBtn.onclick = null; }
      if (exportStatus) exportStatus.textContent = message;
    }
    resetExport('Loading attendance data...');

    function renderEmpty(msg) {
      resetExport(msg || 'No attendance records match the selected filters.');
      tbody.innerHTML =
        '<tr><td colspan="6" style="color:#0f172a;font-weight:400;">' +
        (msg || 'No attendance records match the selected filters.') + '</td></tr>';
      if (avgEl) avgEl.textContent = '0%';
      if (totSessEl) totSessEl.textContent = '0';
      if (totStuEl) totStuEl.textContent = '0';
    }

    if (!firebaseApi) { renderEmpty('Firestore unavailable.'); return; }

    tbody.innerHTML = '<tr><td colspan="6">Loading reports...</td></tr>';

    let users = [], courses = [], sessions = [], attendance = [];
    try {
      const results = await Promise.all([
        firebaseApi.readCollectionDocs('users'),
        firebaseApi.readCollectionDocs('courses'),
        firebaseApi.readCollectionDocs('sessions'),
        firebaseApi.readCollectionDocs('attendance'),
      ]);
      users = results[0]; courses = results[1]; sessions = results[2]; attendance = results[3];
    } catch (e) {
      console.error('Reports load failed:', e);
      renderEmpty('Unable to load reports.');
      return;
    }

    const courseMap = new Map();
    courses.forEach(function (c) {
      const id = String(getFirstDefined(c, ['courseId']) || c.id || '');
      const name = String(getFirstDefined(c, ['courseName', 'name', 'title']) || id || 'Unknown Course');
      if (id) courseMap.set(id, name);
    });

    const sessionMap = new Map();
    sessions.forEach(function (s) {
      const id = String(getFirstDefined(s, ['sessionId']) || s.id || '');
      const courseId = String(getFirstDefined(s, ['courseId']) || '');
      const date = toDate(getFirstDefined(s, ['startTime', 'date', 'createdAt']));
      if (id) sessionMap.set(id, { courseId: courseId, date: date });
    });

    const userMap = new Map();
    users.forEach(function (u) {
      [u.id, getFirstDefined(u, ['uid', 'userId', 'studentId'])]
        .filter(Boolean)
        .forEach(function (k) { userMap.set(String(k), u); });
    });

    const courseOptions = Array.from(new Set(Array.from(courseMap.values()))).map(function (n) {
      return { name: n };
    });
    populateCourseDropdown(courseFilter, courseOptions, 'All Courses');

    function renderRows() {
      resetExport('Updating report...');
      const courseSel = String((courseFilter && courseFilter.value) || '').trim();
      const fromVal = fromDateInput && fromDateInput.value ? new Date(fromDateInput.value + 'T00:00:00') : null;
      const toVal = toDateInput && toDateInput.value ? new Date(toDateInput.value + 'T23:59:59.999') : null;
      const statusSel = String((statusFilter && statusFilter.value) || '').trim().toLowerCase();
      if (fromVal && toVal && fromVal > toVal) {
        renderEmpty('From Date must be on or before To Date.');
        return;
      }

      // Filter attendance
      const filtered = attendance.filter(function (a) {
        const sid = String(getFirstDefined(a, ['sessionId']) || '');
        const sessionInfo = sessionMap.get(sid) || { courseId: String(getFirstDefined(a, ['courseId']) || ''), date: toDate(getFirstDefined(a, ['time', 'createdAt'])) };
        const courseName = courseMap.get(sessionInfo.courseId) || '';
        const recordDate = sessionInfo.date || toDate(getFirstDefined(a, ['time', 'createdAt']));
        const normStatus = normalizeStatus(getFirstDefined(a, ['status']));

        if (courseSel && courseName !== courseSel) return false;
        if (statusSel && normStatus.toLowerCase() !== statusSel) return false;
        if ((fromVal || toVal) && !recordDate) return false;
        if (fromVal && recordDate && recordDate < fromVal) return false;
        if (toVal) {
          const toEnd = new Date(toVal);
          toEnd.setHours(23, 59, 59, 999);
          if (recordDate && recordDate > toEnd) return false;
        }
        return true;
      });

      // Group by student+course
      const groupMap = new Map();
      filtered.forEach(function (a) {
        const uid = String(getFirstDefined(a, ['uid', 'userId', 'studentId']) || '');
        const sid = String(getFirstDefined(a, ['sessionId']) || '');
        const sessionInfo = sessionMap.get(sid) || { courseId: String(getFirstDefined(a, ['courseId']) || '') };
        const courseName = courseMap.get(sessionInfo.courseId) || 'Unknown Course';
        const user = userMap.get(uid);
        const fallbackName = getFirstDefined(a, ['studentName', 'displayName', 'recognitionLabel']);
        const recognitionName = formatRecognitionName(stripEnrollmentPhotoNumber(fallbackName));
        const studentName = recognitionName || (user ? getUserDisplayName(user) : 'Recognized Student');
        const studentId = String(getFirstDefined(user, ['studentId']) || getFirstDefined(a, ['studentId']) || uid);
        const key = (uid || studentId || getCanonicalStudentKey(studentName, uid)) + '||' + sessionInfo.courseId;
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            studentName: studentName,
            studentId: studentId,
            course: courseName,
            attended: 0,
            missed: 0,
            late: 0,
            total: 0,
          });
        }
        const g = groupMap.get(key);
        const ns = normalizeStatus(getFirstDefined(a, ['status']));
        g.total += 1;
        if (ns === 'Present') g.attended += 1;
        else if (ns === 'Late') { g.attended += 1; g.late += 1; }
        else if (ns === 'Absent') g.missed += 1;
      });

      const rows = Array.from(groupMap.values()).sort(function (a, b) {
        return a.course.localeCompare(b.course) || a.studentName.localeCompare(b.studentName);
      });

      // Summary cards
      const totalSessionsInFilter = new Set(filtered.map(function (a) {
        return String(getFirstDefined(a, ['sessionId']) || '');
      })).size;
      const totalStudentsInFilter = new Set(filtered.map(function (a) {
        return String(getFirstDefined(a, ['uid', 'userId']) || '');
      })).size;
      const sumAttended = rows.reduce(function (s, r) { return s + r.attended; }, 0);
      const sumTotal = rows.reduce(function (s, r) { return s + r.total; }, 0);
      const avg = sumTotal ? Math.round((sumAttended / sumTotal) * 100) : 0;
      if (avgEl) avgEl.textContent = String(avg) + '%';
      if (totSessEl) totSessEl.textContent = String(totalSessionsInFilter);
      if (totStuEl) totStuEl.textContent = String(totalStudentsInFilter);

      if (!rows.length) { renderEmpty(); return; }

      // Use local calendar dates, matching the report's date filters.
      const reportDates = filtered.map(function (record) {
        const session = sessionMap.get(String(record.sessionId || ''));
        const date = (session && session.date) || toDate(getFirstDefined(record, ['time', 'createdAt']));
        if (!date || Number.isNaN(date.getTime())) return '';
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
      }).filter(Boolean).sort();
      const reportCourses = Array.from(new Set(rows.map(function (row) { return row.course; })));
      const filenameCourse = (courseSel || (reportCourses.length === 1 ? reportCourses[0] : 'All Courses'))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .replace(/\s+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 100) || 'All-Courses';
      const filenameFrom = (fromDateInput && fromDateInput.value) || reportDates[0] || 'unknown-start';
      const filenameTo = (toDateInput && toDateInput.value) || reportDates[reportDates.length - 1] || 'unknown-end';
      const exportFilename = filenameCourse + '-attendance-' + filenameFrom + '-to-' + filenameTo + '.csv';


      tbody.innerHTML = '';
      rows.forEach(function (r) {
        const rate = r.total ? Math.round((r.attended / r.total) * 100) : 0;
        const row = document.createElement('tr');
        row.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td>';
        row.children[0].textContent = r.studentName;
        row.children[1].textContent = r.course;
        row.children[2].textContent = String(r.attended);
        row.children[3].textContent = String(r.missed);
        row.children[4].textContent = String(r.late);
        row.children[5].textContent = String(rate) + '%';
        tbody.appendChild(row);
      });

      // Export
      if (exportBtn) {
        exportBtn.disabled = false;
        if (exportStatus) exportStatus.textContent = rows.length + ' student/course summaries ready to export. Current filters apply. Late arrivals count as attended.';
        exportBtn.onclick = function () {
          function csvCell(value) {
            let text = String(value == null ? '' : value);
            // Keep spreadsheet applications from interpreting names as formulas.
            if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
          }
          const header = ['Student Name', 'Student ID', 'Course', 'Total Sessions', 'Attended', 'Absent', 'Late', 'Attendance Rate'];
          const lines = [header.map(csvCell).join(',')];
          rows.forEach(function (r) {
            const rate = r.total ? Math.round((r.attended / r.total) * 100) : 0;
            lines.push([
              r.studentName,
              r.studentId,
              r.course,
              r.total, r.attended, r.missed, r.late, rate + '%',
            ].map(csvCell).join(','));
          });
          try {
            const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = exportFilename;
            try {
              document.body.appendChild(a);
              a.click();
            } finally {
              if (a.parentNode) a.parentNode.removeChild(a);
              window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            }
            if (exportStatus) exportStatus.textContent = 'CSV download started: ' + rows.length + ' student/course summaries.';
          } catch (error) {
            console.error('Report export failed:', error);
            if (exportStatus) exportStatus.textContent = 'Unable to download the CSV. Please try again.';
          }
        };
      }
    }

    if (courseFilter) courseFilter.addEventListener('change', renderRows);
    if (fromDateInput) fromDateInput.addEventListener('change', renderRows);
    if (toDateInput) toDateInput.addEventListener('change', renderRows);
    if (statusFilter) statusFilter.addEventListener('change', renderRows);
    renderRows();
  }

  // ---------- Profile ----------

  async function renderProfilePage() {
    const params = new URLSearchParams(window.location.search);
    const requestedStudentId = params.get('studentId') || 'student001';
    const historyBody = document.getElementById('profileAttendanceBody');
    const saveButton = document.getElementById('profileSaveButton') || document.querySelector('#i3wlx77 .gjs-t-button');
    if (!historyBody) return;

    if (saveButton) saveButton.disabled = true;

    historyBody.innerHTML = '<tr><td colspan="5">Loading student profile...</td></tr>';
    setProfileSaveStatus('Loading attendance history...');

    let profileData = null;
    let dataSource = 'firestore';
    try {
      profileData = await loadProfileDataFromFirestore(requestedStudentId);
    } catch (error) {
      console.error('Failed to load student profile from Firestore:', error);
    }

    if (!profileData) {
      profileData = buildFallbackProfileData(requestedStudentId);
      dataSource = 'sample';
    }

    if (!profileData) {
      const nameEl = document.getElementById('ix63k7g');
      const coursesEl = document.getElementById('iobn7gg');
      const emailEl = document.getElementById('inpdknn');
      if (nameEl) nameEl.textContent = requestedStudentId;
      if (coursesEl) coursesEl.textContent = 'No courses found';
      if (emailEl) emailEl.textContent = 'N/A';
      updateProfileSummary(buildProfileSummary([]));
      historyBody.innerHTML = '<tr><td colspan="5">Unable to load this student profile.</td></tr>';
      setProfileSaveStatus('Unable to find this student in Firestore or sample data.', true);
      return;
    }

    const student = profileData.student;
    let history = profileData.history || [];
    const nameEl = document.getElementById('ix63k7g');
    const coursesEl = document.getElementById('iobn7gg');
    const emailEl = document.getElementById('inpdknn');
    if (nameEl) nameEl.textContent = student.name;
    if (coursesEl) coursesEl.textContent = (student.courses || []).join(', ') || 'No courses found';
    if (emailEl) emailEl.textContent = student.email;

    updateProfileSummary(buildProfileSummary(history));
    renderProfileHistoryRows(historyBody, history);
    setProfileSaveStatus(
      dataSource === 'firestore'
        ? 'Connected to Firestore. Select a new status and click Save override.'
        : 'Using sample profile data. Saves will stay local until Firestore data is available.',
      false
    );

    if (!saveButton) return;

    window.FaceRollProfileSave = async function () {
      if (saveButton.disabled) return;
      const rows = Array.from(historyBody.querySelectorAll('tr'));
      const writes = [];
      let localChanges = 0;
      const overridesByEntryKey = getStudentProfileOverrides(student.studentId);

      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
      setProfileSaveStatus('Saving attendance override...');

      rows.forEach(function (row) {
        const select = row.querySelector('select');
        const nextStatus = normalizeStatus(select && select.value);
        const entryKey = row.dataset.entryKey;
        const documentId = row.dataset.documentId;

        if (!entryKey || !select || !nextStatus) return;

        if (dataSource === 'firestore' && firebaseApi && documentId) {
          writes.push(firebaseApi.writeDocument('attendance', documentId, { status: nextStatus.toLowerCase() }));
        } else {
          overridesByEntryKey[entryKey] = nextStatus;
          localChanges += 1;
        }
      });

      try {
        if (writes.length) {
          await Promise.all(writes);
          const refreshedProfileData = await loadProfileDataFromFirestore(student.studentId);
          if (refreshedProfileData) {
            history = refreshedProfileData.history || [];
          }
        } else if (localChanges) {
          saveStudentProfileOverrides(student.studentId, overridesByEntryKey);
          history = applyOverridesToHistory(student.studentId, history);
        }

        renderProfileHistoryRows(historyBody, history);
        updateProfileSummary(buildProfileSummary(history));
        const appliedChanges = writes.length || localChanges;
        saveButton.textContent = appliedChanges > 0 ? 'Override saved' : 'No changes selected';
        setProfileSaveStatus(
          appliedChanges > 0
            ? dataSource === 'firestore'
              ? 'Attendance override saved to Firestore.'
              : 'Attendance override saved locally.'
            : 'No changes were selected.',
          false
        );
      } catch (error) {
        console.error('Failed to save attendance override:', error);
        saveButton.textContent = 'Save failed';
        setProfileSaveStatus('Save failed: ' + (error && error.message ? error.message : 'Unknown error'), true);
      } finally {
        saveButton.disabled = false;
        window.setTimeout(function () {
          saveButton.textContent = 'Save override';
        }, 1400);
      }
    };

    saveButton.onclick = window.FaceRollProfileSave;
    saveButton.disabled = false;
  }

  // ---------- Page dispatcher ----------

  function init() {
    const bodyId = document.body ? document.body.id : '';
    switch (bodyId) {
      case 'imwtil':
        renderRosterPage();
        break;
      case 'imsyg1':
        renderLiveSessionPage();
        break;
      case 'iw11pz':
        renderReportsPage();
        break;
      case 'idhra3g':
        renderProfilePage();
        break;
      default:
        break;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
