(function () {
  'use strict';

  const firebaseApi = window.FaceRollFirebase || null;
  const sampleDataApi = window.FaceRollSampleData || null;

  function completedAttendance(snapshot) {
    if (!window.FaceRollAttendanceHistory) throw new Error('Attendance history did not load. Reload the page.');
    return window.FaceRollAttendanceHistory.completeAttendance(snapshot);
  }

  function bindLatest(element, eventName, key, handler) {
    if (!element) return;
    const handlerKey = '__facerollHandler_' + key;
    const boundKey = '__facerollBound_' + key;
    element[handlerKey] = handler;
    if (element[boundKey]) return;
    element[boundKey] = true;
    element.addEventListener(eventName, function (event) {
      if (typeof element[handlerKey] === 'function') element[handlerKey](event);
    });
  }
  const PROFILE_OVERRIDE_STORAGE_KEY = 'faceroll-profile-overrides';
  const FACEROLL_BRIDGE_URL = 'http://127.0.0.1:8765';
  window.FaceRollProfileSave = null;

  function renderRetryRow(tbody, columnCount, message) {
    if (!tbody) return;
    tbody.innerHTML = '';
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columnCount;
    cell.textContent = message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    if (retry.style) retry.style.marginLeft = '0.75rem';
    retry.addEventListener('click', function () {
      retry.disabled = true;
      if (window.location && typeof window.location.reload === 'function') window.location.reload();
    });
    cell.appendChild(retry);
    row.appendChild(cell);
    tbody.appendChild(row);
  }

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

  async function upgradeLegacyStudentIds(users) {
    if (!firebaseApi || typeof firebaseApi.ensureSevenDigitStudentId !== 'function') return;
    if (typeof firebaseApi.getCurrentAuthUser !== 'function') return;
    const authUser = await firebaseApi.getCurrentAuthUser();
    const profile = authUser && await firebaseApi.readDocument('users', authUser.uid);
    if (!profile || !['admin', 'administrator'].includes(profile.role)) return;

    await Promise.all(users.map(async function (user) {
      const role = String(getFirstDefined(user, ['role', 'userType']) || '').toLowerCase();
      if (role !== 'student' && role !== 'learner') return;
      if (/^\d{7}$/.test(String(user.studentId || ''))) return;

      try {
        const studentId = await firebaseApi.ensureSevenDigitStudentId(user.id);
        if (studentId) user.studentId = studentId;
      } catch (error) {
        console.error('Student ID upgrade failed for ' + String(user.id || 'unknown user') + ':', error);
      }
    }));
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
    return d ? [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-') : 'N/A';
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
        ...entry,
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
      sessionsAttended: present + late,
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
      if (entry.inferred) row.children[2].firstElementChild.title = 'No recorded check-in for this completed session';
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

  async function loadProfileDataFromFirestore(requestedStudentId, forceRefresh) {
    if (!firebaseApi) return null;

    const results = !forceRefresh && typeof firebaseApi.readInstructorSnapshotSWR === 'function'
      ? await firebaseApi.readInstructorSnapshotSWR({})
      : await firebaseApi.readInstructorSnapshot();
    const users = results.users, courses = results.courses, sessions = results.sessions,
      attendance = completedAttendance(results), memberships = results.enrollments,
      instructor = results.instructor;
    if (!instructor) throw new Error('Sign in to view student enrollment details.');

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
      const entryDate = getFirstDefined(session, ['startTime', 'date', 'createdAt']) || getFirstDefined(entry, ['time', 'createdAt', 'date']);
      const status = normalizeStatus(getFirstDefined(entry, ['status'])) || 'Present';
      const recordedTimeValue = getFirstDefined(entry, ['time', 'createdAt']);

      return {
        documentId: entry.id,
        inferred: entry.inferred === true,
        overrideDocument: entry.inferred ? {
          id: entry.id, uid: entry.uid, userId: entry.uid, sessionId: sessionId, courseId: courseId,
          membershipId: entry.membershipId || '', attendanceEvidenceId: entry.attendanceEvidenceId || '',
          source: 'instructor_override', method: 'Instructor override', time: entry.time,
          createdAt: new Date().toISOString(),
        } : null,
        date: formatDateDisplay(entryDate),
        course: String(getFirstDefined(course, ['courseName', 'name', 'title', 'code']) || courseId || 'Unknown Course'),
        status: status,
        recordedTime: status === 'Absent' ? 'N/A' : entry.source === 'instructor_override' ? 'Instructor override' : formatTimeDisplay(recordedTimeValue || entryDate),
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
    const enrollmentRows = window.FaceRollCourseRoster
      ? window.FaceRollCourseRoster.membershipRosterRows(memberships, courses, users, instructor.uid)
        .filter(function (row) { return studentKeys.has(row.uid); })
      : [];
    const derivedCourses = Array.from(new Set(enrollmentRows
      .filter(function (row) { return row.status === 'active'; })
      .map(function (row) { return row.courseName; })));
    const studentId = String(getFirstDefined(studentUser, ['studentId', 'userId', 'uid']) || studentUser.id || requestedStudentId);

    return {
      student: {
        studentId: studentId,
        name: getUserDisplayName(studentUser),
        email: getUserEmail(studentUser, fallbackStudent),
        courses: derivedCourses.length ? derivedCourses : (fallbackStudent ? fallbackStudent.courses : ['No courses found']),
      },
      history: history,
      enrollments: enrollmentRows,
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

  async function renderLegacyRosterPage() {
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
      await upgradeLegacyStudentIds(users);
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

  async function renderRosterPage(options) {
    const backgroundRefresh = Boolean(options && options.background);
    const tbody = document.getElementById('rosterTbody');
    const courseFilter = document.getElementById('rosterCourseFilter');
    const searchInput = document.getElementById('rosterSearchInput');
    if (!tbody || !courseFilter || !searchInput) return;
    function renderEmpty(message) {
      tbody.innerHTML = '<tr><td colspan="8"></td></tr>';
      tbody.firstElementChild.firstElementChild.textContent = message || 'No course memberships found.';
    }

    if (!firebaseApi || !window.FaceRollCourseRoster) {
      renderEmpty('Course enrollment service unavailable.');
      return;
    }
    if (!backgroundRefresh) tbody.innerHTML = '<tr><td colspan="8">Loading course enrollments...</td></tr>';

    let users, courses, sessions, attendance, memberships, instructor;
    try {
      const snapshot = !backgroundRefresh && typeof firebaseApi.readInstructorSnapshotSWR === 'function'
        ? await firebaseApi.readInstructorSnapshotSWR({})
        : await firebaseApi.readInstructorSnapshot();
      users = snapshot.users;
      courses = snapshot.courses;
      sessions = snapshot.sessions;
      attendance = completedAttendance(snapshot);
      memberships = snapshot.enrollments;
      instructor = snapshot.instructor;
      if (!instructor) throw new Error('Sign in to manage your course roster.');
      await upgradeLegacyStudentIds(users);
    } catch (error) {
      console.error('Roster load failed:', error);
      if (!backgroundRefresh) {
        renderRetryRow(tbody, 8, 'Unable to load course enrollments. ' +
          (error && error.message ? error.message : 'Check the emulator connection.'));
      }
      return;
    }

    const rows = window.FaceRollCourseRoster.membershipRosterRows(
      memberships,
      courses,
      users,
      instructor.uid
    );
    const sessionCourse = new Map();
    sessions.forEach(function (session) {
      sessionCourse.set(
        String(getFirstDefined(session, ['sessionId']) || session.id || ''),
        String(getFirstDefined(session, ['courseId']) || '')
      );
    });

    const ownedCourses = courses
      .filter(function (course) { return course.instructorId === instructor.uid; })
      .map(function (course) {
        const courseId = String(getFirstDefined(course, ['courseId']) || course.id || '');
        return {
          id: courseId,
          name: String(getFirstDefined(course, ['courseName', 'name']) || courseId),
        };
      })
      .filter(function (course) { return course.id; })
      .sort(function (left, right) { return left.name.localeCompare(right.name); });
    courseFilter.innerHTML = '<option value="">All Courses</option>';
    ownedCourses.forEach(function (course) {
      const option = document.createElement('option');
      option.value = course.id;
      option.textContent = course.name;
      courseFilter.appendChild(option);
    });

    rows.forEach(function (row) {
      const user = row.user || {};
      row.name = row.user ? getUserDisplayName(user) : 'Unknown student';
      row.studentId = String(getFirstDefined(user, ['studentId', 'userId']) || row.uid);
      row.email = String(getFirstDefined(user, ['email']) || 'N/A');
      const records = attendance.filter(function (entry) {
        const uid = String(getFirstDefined(entry, ['uid', 'userId']) || '');
        const sessionId = String(getFirstDefined(entry, ['sessionId']) || '');
        const courseId = String(getFirstDefined(entry, ['courseId']) || sessionCourse.get(sessionId) || '');
        return uid === row.uid && courseId === row.courseId;
      });
      const present = records.filter(function (entry) {
        return ['Present', 'Late'].includes(normalizeStatus(getFirstDefined(entry, ['status'])));
      }).length;
      row.absences = records.filter(function (entry) {
        return normalizeStatus(getFirstDefined(entry, ['status'])) === 'Absent';
      }).length;
      row.attendanceRate = records.length ? Math.round((present / records.length) * 100) : 0;
    });

    function renderRows() {
      const search = String(searchInput.value || '').trim().toLowerCase();
      const selectedCourse = String(courseFilter.value || '');
      const filtered = rows.filter(function (row) {
        const matchesSearch = !search || [row.name, row.studentId, row.email]
          .some(function (value) { return String(value).toLowerCase().includes(search); });
        return matchesSearch && (!selectedCourse || row.courseId === selectedCourse);
      });
      if (!filtered.length) {
        renderEmpty(rows.length ? 'No enrollments match these filters.' : 'No students have joined your courses yet.');
        return;
      }
      tbody.innerHTML = '';
      filtered.forEach(function (rowData) {
        const row = document.createElement('tr');
        row.innerHTML = [
          '<td></td><td></td><td></td><td></td>',
          '<td><span class="status-badge roster-membership-status"></span></td>',
          '<td></td><td></td>',
          '<td><div class="roster-actions"><a class="student-action-link">View Profile</a></div></td>',
        ].join('');
        row.children[0].textContent = rowData.name;
        if (rowData.user && rowData.user.optOutFlag === true) {
          const privacyLabel = document.createElement('small');
          privacyLabel.textContent = 'Facial recognition off';
          privacyLabel.style.display = 'block';
          row.children[0].appendChild(privacyLabel);
        }
        row.children[1].textContent = rowData.studentId;
        row.children[2].textContent = rowData.email;
        row.children[3].textContent = rowData.courseName;
        const badge = row.children[4].firstElementChild;
        badge.textContent = rowData.status === 'active' ? 'Enrolled' : rowData.status === 'removed' ? 'Removed' : 'Dropped';
        badge.classList.add(rowData.status === 'active' ? 'status-present' : 'status-absent');
        row.children[5].textContent = String(rowData.attendanceRate) + '%';
        row.children[6].textContent = String(rowData.absences);
        const profile = row.children[7].querySelector('a');
        const params = new URLSearchParams({ studentId: rowData.studentId, uid: rowData.uid });
        if (rowData.email !== 'N/A') params.set('email', rowData.email);
        profile.href = './student-profile.html?' + params.toString();
        tbody.appendChild(row);
      });
    }

    bindLatest(courseFilter, 'change', 'rosterCourse', renderRows);
    bindLatest(searchInput, 'input', 'rosterSearch', renderRows);
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
    const policyApi = window.FaceRollSessionPolicy;
    if (!policyApi) { tbody.textContent = 'Reload the page to load attendance settings.'; return; }

    let sessionStatusValue = document.getElementById('liveSessionStatus');
    if (!sessionStatusValue) {
      const label = Array.from(document.querySelectorAll('.filter-field .filter-label'))
        .find(function (l) { return String(l.textContent || '').trim() === 'Session Status'; });
      if (label && label.parentElement) sessionStatusValue = label.parentElement.querySelector('span');
    }

    let timerHandle = null;
    let liveAttendanceUnsubscribe = null;
    let bridgePollHandle = null;
    let bridgePollInFlight = false;
    let rosterUnsubscribe = null;
    let rosterSyncPromise = null;
    let pendingRosterRows = null;
    let liveRowsGeneration = 0;
    let activeRosterSignature = '';
    let activeRosterUids = new Set();
    const consentListeners = new Map();
    const liveConsentProfiles = new Map();
    let consentListenerGeneration = 0;
    let currentRosterRows = [];
    let bridgeEventCursor = 0;
    const writtenBridgeEvents = new Set();
    let sessionStartedAt = null;
    let activeSessionDocId = null;
    let activeCourseId = '';
    let activeCourseName = '';
    let activeSessionRecord = null;
    let ownedCourses = new Map();
    let sessionActionBusy = false;
    let disposed = false;
    let sessionUnsubscribe = null;
    let sessionGeneration = 0;
    let bridgePollPromise = null;
    let dateRefreshTimer = null;

    function setSessionStatus(t) { if (sessionStatusValue) sessionStatusValue.textContent = t; }
    function setStartButtonState(started, busy) {
      if (!startButton) return;
      startButton.textContent = busy ? 'Working...' : started ? 'Stop Session' : 'Start Session';
      startButton.disabled = Boolean(busy);
      startButton.style.opacity = busy ? '0.75' : '1';
      startButton.style.cursor = busy ? 'wait' : 'pointer';
      if (courseSelect) courseSelect.disabled = started || busy;
      if (sessionDateInput) sessionDateInput.readOnly = true;
    }
    function renderEmpty() {
      tbody.innerHTML = '<tr><td colspan="5">No check-ins yet for this session.</td></tr>';
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
    function stopPoller() {
      if (typeof liveAttendanceUnsubscribe === 'function') liveAttendanceUnsubscribe();
      liveAttendanceUnsubscribe = null;
    }
    function stopRosterListener() {
      consentListenerGeneration += 1;
      consentListeners.forEach(subscription => { if (typeof subscription.unsubscribe === 'function') subscription.unsubscribe(); });
      consentListeners.clear();
      liveConsentProfiles.clear();
      currentRosterRows = [];
      if (typeof rosterUnsubscribe === 'function') rosterUnsubscribe();
      rosterUnsubscribe = null;
    }
    function stopBridgePoller() {
      if (bridgePollHandle) {
        clearInterval(bridgePollHandle);
        bridgePollHandle = null;
      }
    }

    function stopSessionListener() {
      sessionGeneration += 1;
      if (typeof sessionUnsubscribe === 'function') sessionUnsubscribe();
      sessionUnsubscribe = null;
    }

    function resetIdle(options) {
      const keepAttendance = options && options.keepAttendance;
      stopSessionListener();
      sessionStartedAt = null;
      activeSessionDocId = null;
      activeSessionRecord = null;
      activeCourseId = '';
      activeCourseName = '';
      bridgeEventCursor = 0;
      activeRosterSignature = '';
      activeRosterUids = new Set();
      rosterSyncPromise = null;
      pendingRosterRows = null;
      bridgePollInFlight = false;
      liveRowsGeneration += 1;
      writtenBridgeEvents.clear();
      setSessionStatus('Not Started');
      stopTimer(); stopPoller(); stopRosterListener(); stopBridgePoller();
      if (!keepAttendance && durationElement) durationElement.textContent = '00:00';
      if (sessionDateInput) sessionDateInput.value = policyApi.localDate();
      setStartButtonState(false, false);
      if (!keepAttendance) renderEmpty();
    }

    function liveAttendanceMethod(entry) {
      // Use the recorded source, never the student's current privacy preference
      // or a successful location result, to describe how this entry was made.
      const labels = {
        phone_face_verification: 'Facial recognition',
        classroom_camera: 'Facial recognition',
        phone_location_verification: 'Location check',
        instructor_override: 'Instructor override',
        session_default: 'Session default',
      };
      const source = String(entry.source || '').trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(labels, source)) return labels[source];
      const method = typeof entry.method === 'string' ? entry.method.trim() : '';
      switch (method.toLowerCase()) {
        case 'phone face verification':
        case 'phone face and location verification':
        case 'classroom camera recognition':
        case 'face recognition':
        case 'facial recognition': return 'Facial recognition';
        case 'phone location verification':
        case 'location check': return 'Location check';
        default: return method || 'Not recorded';
      }
    }

    function renderLiveRows(rows) {
      if (!rows.length) { renderEmpty(); return; }
      const recognized = rows.filter(function (r) { return r.source !== 'session_default' && r.status !== 'Absent'; }).length;
      const late = rows.filter(function (r) { return r.source !== 'session_default' && r.status === 'Late'; }).length;
      if (recognizedElement) recognizedElement.textContent = String(recognized);
      if (lateElement) lateElement.textContent = String(late);
      tbody.innerHTML = '';
      rows.forEach(function (e) {
        const row = document.createElement('tr');
        row.innerHTML = '<td></td><td></td><td><span class="status-badge live-status"></span></td><td></td><td></td>';
        row.children[0].textContent = e.studentName;
        row.children[1].textContent = e.course;
        row.children[2].firstElementChild.textContent = e.status;
        if (e.source === 'session_default') row.children[2].firstElementChild.title = 'Applied from the session default';
        const cls = getStatusClass(e.status);
        if (cls) row.children[2].firstElementChild.classList.add(cls);
        row.children[3].textContent = e.recordedTime;
        row.children[4].textContent = liveAttendanceMethod(e);
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
        const user = await firebaseApi.waitForAuthUser();
        if (!user) throw new Error('Sign in to load courses.');
        const queryOptions = {
          filters: [{ field: 'instructorId', operator: '==', value: user.uid }],
        };
        const renderCourses = function (courses) {
          ownedCourses = new Map(courses.map(function (course) {
            return [String(course.courseId || course.id), course];
          }));
          const previousCourseId = activeCourseId || courseSelect.value;
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
          if (courses.some(function (course) {
            return String(getFirstDefined(course, ['courseId']) || course.id || '') === previousCourseId;
          })) courseSelect.value = previousCourseId;
        };
        renderCourses(await firebaseApi.readQueryDocs('courses', queryOptions));
      } catch (e) {
        console.error('Failed to load courses:', e);
        courseSelect.innerHTML = '<option value="">Unable to load courses</option>';
        throw e;
      }
    }

    async function loadCourseRosterUids(courseId) {
      // No roster means no authorized recognition candidates.
      const enrollments = await firebaseApi.readQueryDocs('enrollments', {
        filters: [
          { field: 'courseId', operator: '==', value: courseId },
          { field: 'status', operator: '==', value: 'active' },
        ],
      });
      if (!window.FaceRollCourseRoster) throw new Error('Course roster validation is unavailable.');
      return facialRosterUids(enrollments, courseId);
    }

    async function facialRosterUids(enrollments, courseId) {
      const uids = window.FaceRollCourseRoster.activeRosterUids(enrollments, courseId);
      const users = uids.length ? await firebaseApi.readDocuments('users', uids, { enrollments: enrollments }) : [];
      return window.FaceRollCourseRoster.facialRosterUids(enrollments, courseId,
        users.map(user => liveConsentProfiles.has(user.id) ? liveConsentProfiles.get(user.id) : user).filter(Boolean));
    }

    async function syncCourseRoster(enrollmentRows) {
      if (!activeSessionDocId || !activeCourseId) return;
      if (rosterSyncPromise) {
        if (Array.isArray(enrollmentRows)) pendingRosterRows = enrollmentRows;
        return rosterSyncPromise;
      }
      const sessionId = activeSessionDocId;
      const courseId = activeCourseId;
      const operation = (async function () {
        const allowedUids = Array.isArray(enrollmentRows)
          ? await facialRosterUids(enrollmentRows, courseId)
          : await loadCourseRosterUids(courseId);
        if (disposed || sessionId !== activeSessionDocId || courseId !== activeCourseId) return;
        activeRosterUids = new Set(allowedUids);
        const signature = window.FaceRollCourseRoster.rosterSignature(allowedUids);
        if (signature === activeRosterSignature) return;
        await requestBridge('/update-roster', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId,
            courseId: courseId,
            allowedUids: allowedUids,
          }),
        });
        if (sessionId === activeSessionDocId && courseId === activeCourseId) {
          activeRosterSignature = signature;
        }
      })();
      rosterSyncPromise = operation;
      try {
        await operation;
      } catch (error) {
        console.error('Course roster sync failed:', error);
      } finally {
        if (rosterSyncPromise === operation) rosterSyncPromise = null;
        if (pendingRosterRows) {
          const pending = pendingRosterRows;
          pendingRosterRows = null;
          syncCourseRoster(pending);
        }
      }
    }

    async function fetchRows(attendanceRows) {
      if (!firebaseApi || !activeSessionDocId) return;
      const generation = ++liveRowsGeneration;
      const sessionId = activeSessionDocId;
      try {
        const att = Array.isArray(attendanceRows) ? attendanceRows :
          await firebaseApi.readQueryDocs('attendance', {
            filters: [{ field: 'sessionId', operator: '==', value: activeSessionDocId },
              { field: 'courseId', operator: '==', value: activeCourseId }],
          });
        const users = await firebaseApi.readDocuments('users', att.map(function (row) {
          return getFirstDefined(row, ['uid', 'userId']);
        }), { attendance: att });
        const courses = activeCourseId ? [{ id: activeCourseId, courseId: activeCourseId,
          courseName: activeCourseName }] : [];
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
              method: d.method,
              source: d.source,
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
        if (!disposed && generation === liveRowsGeneration && sessionId === activeSessionDocId) {
          renderLiveRows(rows);
        }
      } catch (e) { console.error('Live refresh failed:', e); }
    }

    async function startPoller() {
      stopPoller();
      const sessionId = activeSessionDocId;
      try {
        const unsubscribe = await firebaseApi.subscribeQueryDocs('attendance', {
          filters: [{ field: 'sessionId', operator: '==', value: sessionId },
            { field: 'courseId', operator: '==', value: activeCourseId }],
        }, function (rows) {
          if (!disposed && sessionId === activeSessionDocId) fetchRows(rows);
        }, function (error) {
          console.error('Live attendance subscription failed:', error);
          setSessionStatus('Attendance connection interrupted');
        });
        if (!disposed && sessionId === activeSessionDocId) liveAttendanceUnsubscribe = unsubscribe;
        else if (typeof unsubscribe === 'function') unsubscribe();
      } catch (error) {
        console.error('Unable to start live attendance subscription:', error);
        setSessionStatus('Unable to load attendance');
      }
    }

    async function startRosterListener() {
      stopRosterListener();
      const sessionId = activeSessionDocId;
      const courseId = activeCourseId;
      try {
        const unsubscribe = await firebaseApi.subscribeQueryDocs('enrollments', {
          filters: [
            { field: 'courseId', operator: '==', value: courseId },
            { field: 'status', operator: '==', value: 'active' },
          ],
        }, function (rows) {
          if (!disposed && sessionId === activeSessionDocId && courseId === activeCourseId) {
            currentRosterRows = rows;
            const generation = consentListenerGeneration;
            const uids = new Set(window.FaceRollCourseRoster.activeRosterUids(rows, courseId));
            consentListeners.forEach((subscription, uid) => {
              if (!uids.has(uid)) {
                if (typeof subscription.unsubscribe === 'function') subscription.unsubscribe();
                consentListeners.delete(uid);
                liveConsentProfiles.delete(uid);
              }
            });
            uids.forEach(uid => {
              if (consentListeners.has(uid)) return;
              const subscription = { unsubscribe: null };
              consentListeners.set(uid, subscription);
              firebaseApi.subscribeDocument('users', uid, profile => {
                if (generation !== consentListenerGeneration || consentListeners.get(uid) !== subscription) return;
                liveConsentProfiles.set(uid, profile);
                syncCourseRoster(currentRosterRows);
              }, () => {
                if (generation !== consentListenerGeneration || consentListeners.get(uid) !== subscription) return;
                liveConsentProfiles.set(uid, null);
                syncCourseRoster(currentRosterRows);
              }).then(unsubscribe => {
                if (generation === consentListenerGeneration && consentListeners.get(uid) === subscription) subscription.unsubscribe = unsubscribe;
                else unsubscribe();
              }).catch(error => console.error('Face preference subscription failed:', error));
            });
            syncCourseRoster(rows);
          }
        }, function (error) {
          console.error('Course roster subscription failed:', error);
        });
        if (!disposed && sessionId === activeSessionDocId && courseId === activeCourseId) rosterUnsubscribe = unsubscribe;
        else if (typeof unsubscribe === 'function') unsubscribe();
      } catch (error) {
        console.error('Unable to start course roster subscription:', error);
      }
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
      const targetSessionId = activeSessionDocId;
      const eventSessionId = String(getFirstDefined(event, ['sessionId']) || '');
      const eventCourseId = String(getFirstDefined(event, ['courseId']) || '');
      if (eventSessionId && eventSessionId !== String(activeSessionDocId)) return false;
      if (eventCourseId && eventCourseId !== String(activeCourseId)) return false;

      const eventKey = String(getFirstDefined(event, ['cursor', 'timestamp', 'identity']) || '');
      if (eventKey && writtenBridgeEvents.has(eventKey)) return false;

      const authoritativeUid = String(getFirstDefined(event, ['uid']) || '').trim();
      if (!authoritativeUid) return false;
      if (!activeRosterUids.has(authoritativeUid)) {
        console.warn('Ignoring recognition event for a student outside the active course roster.');
        return false;
      }
      const users = await firebaseApi.readDocuments('users', [authoritativeUid]);
      if (disposed || activeSessionDocId !== targetSessionId) return false;
      const userLookup = buildUserLookup(users);
      const user = userLookup.get(normalizeLookupKey(authoritativeUid)) || null;
      if (!user) {
        console.warn('Ignoring recognition event for an unknown Firebase UID.');
        return false;
      }

      if (!window.FaceRollCourseRoster.permitsFacialRecognition(user) ||
          (liveConsentProfiles.has(authoritativeUid) && !window.FaceRollCourseRoster.permitsFacialRecognition(liveConsentProfiles.get(authoritativeUid)))) return false;

      const recognitionLabel = getRecognitionLabel(event);
      const uid = authoritativeUid;
      if (!uid) return false;
      const studentName = getUserDisplayName(user);

      const eventTime = toDate(getFirstDefined(event, ['timestamp', 'time', 'createdAt'])) || new Date();
      const decision = policyApi.checkInDecision(activeSessionRecord, eventTime);
      if (!decision.allowed) return false;
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
        membershipId: window.FaceRollCourseRoster.membershipId(activeCourseId, uid),
        status: decision.status,
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

    function pollBridgeEvents() {
      if (bridgePollPromise) return bridgePollPromise;
      const operation = pollBridgeEventsOnce();
      bridgePollPromise = operation;
      return operation.finally(function () {
        if (bridgePollPromise === operation) bridgePollPromise = null;
      });
    }

    async function pollBridgeEventsOnce() {
      // Cursor prevents the same bridge event from being processed twice.
      if (!activeSessionDocId || bridgePollInFlight) return;
      bridgePollInFlight = true;
      const targetSessionId = activeSessionDocId;
      try {
        const payload = await requestBridge('/events?cursor=' + encodeURIComponent(String(bridgeEventCursor)));
        if (disposed || activeSessionDocId !== targetSessionId) return;
        const events = Array.isArray(payload.events) ? payload.events : [];
        const processed = await window.FaceRollCourseRoster.processBridgeEvents(
          events,
          bridgeEventCursor,
          writeAttendanceFromBridgeEvent
        );
        bridgeEventCursor = events.length
          ? processed.cursor
          : Number(payload.nextCursor || bridgeEventCursor || 0);
      } catch (e) {
        console.error('Bridge event poll failed:', e);
        throw e;
      } finally {
        bridgePollInFlight = false;
      }
    }

    function startBridgePoller() {
      stopBridgePoller();
      const poll = function () { pollBridgeEvents().catch(function () {}); };
      poll();
      bridgePollHandle = setInterval(poll, 2000);
    }

    async function readAttendanceSettings() {
      const user = await firebaseApi.waitForAuthUser();
      if (!user) throw new Error('Sign in to start a session.');
      const settings = await firebaseApi.readDocument('instructor_settings', user.uid);
      return policyApi.normalizeSettings(settings);
    }

    async function readOwnedSessions() {
      const courseIds = Array.from(ownedCourses.keys());
      const rows = [];
      for (let index = 0; index < courseIds.length; index += 8) {
        rows.push.apply(rows, await firebaseApi.readQueryDocs('sessions', {
          filters: [{ field: 'courseId', operator: 'in', value: courseIds.slice(index, index + 8) }],
        }));
      }
      return rows.filter(function (session) {
        return ownedCourses.has(session.courseId) && ['active', 'starting', 'closing'].includes(session.status);
      }).sort(function (left, right) {
        return policyApi.toMillis(right.startTime) - policyApi.toMillis(left.startTime);
      });
    }

    async function readBridgeStatus() {
      try {
        const payload = await requestBridge('/status', { signal: AbortSignal.timeout(5000) });
        return payload.status || null;
      } catch (error) { return null; }
    }

    function bridgeIsRunning(status) {
      return Boolean(status && (status.captureRunning || status.recognizerRunning));
    }

    async function attachSession(session, bridgeStatus) {
      stopSessionListener();
      stopTimer(); stopPoller(); stopRosterListener(); stopBridgePoller();
      activeSessionRecord = session;
      activeSessionDocId = session.id || session.sessionId;
      activeCourseId = session.courseId;
      const course = ownedCourses.get(activeCourseId) || {};
      activeCourseName = String(course.courseName || course.name || activeCourseId);
      sessionStartedAt = policyApi.toMillis(session.startTime);
      policyApi.settingsForSession(session);
      bridgeEventCursor = 0;
      writtenBridgeEvents.clear();
      if (courseSelect) courseSelect.value = activeCourseId;
      if (sessionDateInput) sessionDateInput.value = session.date || policyApi.localDate(sessionStartedAt);
      setStartButtonState(true, false);
      updateDuration(sessionStartedAt);
      if (session.status === 'closing') {
        setSessionStatus('Finishing attendance — select Finish Session to retry');
        startButton.textContent = 'Finish Session';
        await fetchRows();
      } else {
        const bridgeMatches = bridgeIsRunning(bridgeStatus) && bridgeStatus.sessionId === activeSessionDocId
          && bridgeStatus.captureRunning && bridgeStatus.recognizerRunning;
        setSessionStatus(bridgeMatches ? 'Started' : 'Session active; classroom camera is disconnected');
        const roster = await loadCourseRosterUids(activeCourseId);
        if (disposed || activeSessionDocId !== (session.id || session.sessionId)) return;
        activeRosterUids = new Set(roster);
        activeRosterSignature = window.FaceRollCourseRoster.rosterSignature(Array.from(activeRosterUids));
        beginTimer(sessionStartedAt);
        startPoller();
        if (bridgeMatches) { startRosterListener(); startBridgePoller(); }
      }
      const generation = sessionGeneration;
      if (typeof firebaseApi.subscribeDocument === 'function') {
        const unsubscribe = await firebaseApi.subscribeDocument('sessions', activeSessionDocId, function (updated, info) {
          if (disposed || generation !== sessionGeneration || sessionActionBusy || (info && info.fromCache)) return;
          if (!updated || updated.status === 'closed' || updated.status === 'start_failed') {
            fetchRows().finally(function () {
              if (generation !== sessionGeneration) return;
              resetIdle({ keepAttendance: true });
              setSessionStatus('Session ended');
            });
          } else if (updated.status === 'closing') {
            activeSessionRecord = updated;
            stopTimer(); stopBridgePoller(); stopRosterListener();
            setSessionStatus('Finishing attendance');
            startButton.textContent = 'Finish Session';
          }
        }, function () { setSessionStatus('Session connection interrupted; reload to reconnect'); });
        if (!disposed && generation === sessionGeneration) sessionUnsubscribe = unsubscribe;
        else if (typeof unsubscribe === 'function') unsubscribe();
      }
    }

    async function restoreSession() {
      const values = await Promise.all([readOwnedSessions(), readBridgeStatus()]);
      const sessions = values[0], bridgeStatus = values[1];
      if (disposed) return false;
      let existing = sessions.find(function (session) {
        return (session.id || session.sessionId) === (bridgeStatus && bridgeStatus.sessionId);
      }) || sessions[0];
      if (bridgeIsRunning(bridgeStatus) && (!existing || (existing.id || existing.sessionId) !== bridgeStatus.sessionId)) {
        throw new Error('Another session is using the classroom camera. End it before starting a new session.');
      }
      if (!existing) return false;
      if (existing.status === 'starting') {
        if (!bridgeIsRunning(bridgeStatus)) throw new Error('A session is still starting. Wait for the camera, then reload Live Session.');
        const startedAt = bridgeStatus.sessionStartedAt > 0 ? bridgeStatus.sessionStartedAt * 1000
          : existing.startedAtMs || policyApi.toMillis(existing.startTime);
        const resumed = Object.assign({}, existing, policyApi.snapshot(policyApi.settingsForSession(existing), startedAt), { status: 'active' });
        await firebaseApi.writeDocument('sessions', existing.id || existing.sessionId, resumed);
        existing = resumed;
      }
      await attachSession(existing, bridgeStatus);
      return true;
    }

    async function handleStart() {
      // Create the Firestore session first, then start the local recognition bridge.
      if (!firebaseApi) { setSessionStatus('Firestore unavailable'); return; }
      const selectedId = courseSelect ? String(courseSelect.value || '').trim() : '';
      if (!selectedId) { setSessionStatus('Select a course first'); return; }
      setStartButtonState(false, true);
      let pendingSessionDocId = null;
      let bridgeStarted = false;
      try {
        if (await restoreSession()) return;
        const now = new Date();
        const sid = 'session_' + now.getTime();
        const settings = await readAttendanceSettings();
        const allowedUids = await loadCourseRosterUids(selectedId);
        pendingSessionDocId = sid;
        const selectedCourse = ownedCourses.get(selectedId);
        const pending = await firebaseApi.createSessionWithLocation(selectedCourse._documentId || selectedCourse.id || selectedId, sid, {
          ...policyApi.snapshot(settings, now),
          id: sid, sessionId: sid, courseId: selectedId, status: 'starting',
        });
        const bridgeSession = { sessionId: sid, courseId: selectedId };
        bridgeSession.allowedUids = allowedUids;
        const started = await requestBridge('/start-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bridgeSession),
        });
        if (!started.status || started.status.sessionId !== sid || started.status.courseId !== selectedId) {
          throw new Error('The classroom camera is running a different session. Reload Live Session to reconnect.');
        }
        bridgeStarted = true;
        const startedAt = started.status.sessionStartedAt > 0 ? started.status.sessionStartedAt * 1000 : Date.now();
        const active = Object.assign({}, pending, policyApi.snapshot(settings, startedAt), {
          id: sid, sessionId: sid, courseId: selectedId, status: 'active',
        });
        await firebaseApi.writeDocument('sessions', sid, active);
        if (!disposed) await attachSession(active, started.status);
      } catch (e) {
        console.error('Start failed:', e);
        try {
          if (bridgeStarted) {
            await requestBridge('/stop-session', { method: 'POST' });
          }
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
        if (pendingSessionDocId && activeSessionDocId === pendingSessionDocId) resetIdle();
        setSessionStatus('Start failed: ' + e.message);
        setStartButtonState(false, false);
      }
    }

    async function handleStop() {
      setStartButtonState(true, true);
      try {
        const sessionId = activeSessionDocId;
        const record = await firebaseApi.readDocument('sessions', sessionId);
        if (!record) throw new Error('The session could not be found.');
        if (record.status === 'closed' && record.defaultsApplied) {
          await fetchRows();
          resetIdle({ keepAttendance: true });
          setSessionStatus('Session ended');
          return;
        }
        const bridgeStatus = await readBridgeStatus();
        if (!bridgeStatus && record.status !== 'closing') {
          throw new Error('Cannot reach the classroom camera. Reconnect the bridge before ending the session');
        }
        if (bridgeIsRunning(bridgeStatus) && bridgeStatus.sessionId === sessionId) {
          await requestBridge('/stop-session', { method: 'POST' });
        }
        if (bridgeStatus && record.status === 'active') {
          stopBridgePoller();
          await pollBridgeEvents();
        }
        const endTime = record.endTime || new Date().toISOString();
        await firebaseApi.writeDocument('sessions', sessionId, { status: 'closing', endTime: endTime });
        activeSessionRecord = Object.assign({}, record, { status: 'closing', endTime: endTime });
        stopBridgePoller(); stopTimer();
        const settings = policyApi.settingsForSession(record);
        const memberships = await firebaseApi.readQueryDocs('enrollments', {
          filters: [{ field: 'courseId', operator: '==', value: activeCourseId },
            { field: 'status', operator: '==', value: 'active' }],
        });
        const uids = window.FaceRollCourseRoster.activeRosterUids(memberships, activeCourseId);
        for (let index = 0; index < uids.length; index += 20) {
          await Promise.all(uids.slice(index, index + 20).map(function (uid) {
            const id = sessionId + '_' + uid;
            return firebaseApi.createDocumentIfAbsent('attendance', id, {
              id: id, uid: uid, userId: uid, sessionId: sessionId, courseId: activeCourseId,
              membershipId: window.FaceRollCourseRoster.membershipId(activeCourseId, uid),
              status: settings.defaultAttendance, source: 'session_default',
              method: 'Session default', time: endTime, createdAt: endTime,
            });
          }));
        }
        await firebaseApi.writeDocument('sessions', sessionId, { status: 'closed', defaultsApplied: true });
        await fetchRows();
        resetIdle({ keepAttendance: true });
        setSessionStatus('Session ended');
      } catch (e) {
        console.error('Stop failed:', e);
        setSessionStatus('Unable to finish session: ' + e.message + '. Select Finish Session to retry.');
        setStartButtonState(true, false);
        startButton.textContent = 'Finish Session';
      }
    }

    async function initialize() {
      disposed = false;
      resetIdle();
      setStartButtonState(false, true);
      setSessionStatus('Checking for an active session…');
      if (dateRefreshTimer) clearInterval(dateRefreshTimer);
      dateRefreshTimer = setInterval(function () {
        if (!activeSessionDocId && sessionDateInput) sessionDateInput.value = policyApi.localDate();
      }, 60000);
      try {
        await loadCourses();
        if (!await restoreSession()) resetIdle();
      } catch (error) {
        setSessionStatus(error.message + ' Reload Live Session to retry.');
        setStartButtonState(false, true);
      }
    }

    initialize();
    window.addEventListener('faceroll:courses-updated', function () { loadCourses().catch(console.error); });
    window.addEventListener('pagehide', function () {
      disposed = true;
      if (dateRefreshTimer) clearInterval(dateRefreshTimer);
      dateRefreshTimer = null;
      stopSessionListener(); stopTimer(); stopPoller(); stopRosterListener(); stopBridgePoller();
    });
    window.addEventListener('pageshow', function (event) { if (event.persisted) initialize(); });

    if (startButton) {
      startButton.addEventListener('click', async function () {
        if (sessionActionBusy || startButton.disabled || disposed) return;
        sessionActionBusy = true;
        try {
          if (activeSessionDocId !== null) await handleStop();
          else await handleStart();
        } finally { sessionActionBusy = false; }
      });
    }
  }

  // ---------- Reports ----------

  async function renderReportsPage(options) {
    const backgroundRefresh = Boolean(options && options.background);
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
    if (!backgroundRefresh) resetExport('Loading attendance data...');

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

    if (!backgroundRefresh) tbody.innerHTML = '<tr><td colspan="6">Loading reports...</td></tr>';

    let users = [], courses = [], sessions = [], attendance = [];
    try {
      const results = !backgroundRefresh && typeof firebaseApi.readInstructorSnapshotSWR === 'function'
        ? await firebaseApi.readInstructorSnapshotSWR({})
        : await firebaseApi.readInstructorSnapshot({});
      users = results.users;
      courses = results.courses;
      sessions = results.sessions;
      attendance = completedAttendance(results);
    } catch (e) {
      console.error('Reports load failed:', e);
      if (!backgroundRefresh) {
        renderEmpty('Unable to load reports.');
        renderRetryRow(tbody, 6, 'Unable to load reports. ' +
          (e && e.message ? e.message : 'Check the emulator connection.'));
      }
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
      let filtered = attendance.filter(function (a) {
        const sid = String(getFirstDefined(a, ['sessionId']) || '');
        const sessionInfo = sessionMap.get(sid) || { courseId: String(getFirstDefined(a, ['courseId']) || ''), date: toDate(getFirstDefined(a, ['time', 'createdAt'])) };
        const courseName = courseMap.get(sessionInfo.courseId) || '';
        const recordDate = sessionInfo.date || toDate(getFirstDefined(a, ['time', 'createdAt']));

        if (courseSel && courseName !== courseSel) return false;
        if ((fromVal || toVal) && !recordDate) return false;
        if (fromVal && recordDate && recordDate < fromVal) return false;
        if (toVal) {
          const toEnd = new Date(toVal);
          toEnd.setHours(23, 59, 59, 999);
          if (recordDate && recordDate > toEnd) return false;
        }
        return true;
      });

      // A status filter selects students; their percentage still uses every
      // eligible session in the selected course/date range.
      if (statusSel) {
        const studentCourseKey = function (entry) {
          const session = sessionMap.get(String(entry.sessionId || ''));
          return String(entry.uid || entry.userId || entry.studentId || '') + '||' + String(session?.courseId || entry.courseId || '');
        };
        const matchingStudents = new Set(filtered.filter(function (entry) {
          return String(entry.status).toLowerCase() === statusSel;
        }).map(studentCourseKey));
        filtered = filtered.filter(function (entry) { return matchingStudents.has(studentCourseKey(entry)); });
      }

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

    bindLatest(courseFilter, 'change', 'reportsCourse', renderRows);
    bindLatest(fromDateInput, 'change', 'reportsFrom', renderRows);
    bindLatest(toDateInput, 'change', 'reportsTo', renderRows);
    bindLatest(statusFilter, 'change', 'reportsStatus', renderRows);
    renderRows();
  }

  // ---------- Profile ----------

  async function renderProfilePage(options) {
    const backgroundRefresh = Boolean(options && options.background);
    const params = new URLSearchParams(window.location.search);
    const requestedStudentId = params.get('studentId') || 'student001';
    const historyBody = document.getElementById('profileAttendanceBody');
    const saveButton = document.getElementById('profileSaveButton') || document.querySelector('#i3wlx77 .gjs-t-button');
    const enrollmentList = document.getElementById('profileEnrollmentList');
    const enrollmentStatus = document.getElementById('profileEnrollmentStatus');
    const nameEl = document.getElementById('ix63k7g');
    const coursesEl = document.getElementById('iobn7gg');
    const emailEl = document.getElementById('inpdknn');
    if (!historyBody) return;

    if (!backgroundRefresh) {
      if (saveButton) saveButton.disabled = true;
      if (nameEl) nameEl.textContent = 'Loading...';
      if (coursesEl) coursesEl.textContent = 'Loading...';
      if (emailEl) emailEl.textContent = 'Loading...';
      ['iaj9kju', 'iwzjofv', 'ip95okd', 'iq9g6ym'].forEach(function (id) {
        const element = document.getElementById(id);
        if (element) element.textContent = 'Loading...';
      });
      if (enrollmentList) enrollmentList.textContent = 'Loading enrollments...';
      if (enrollmentStatus) enrollmentStatus.textContent = '';
      historyBody.innerHTML = '<tr><td colspan="5">Loading student profile...</td></tr>';
      setProfileSaveStatus('Loading attendance history...');
    }

    let profileData = null;
    let profileLoadError = null;
    let dataSource = 'firestore';
    try {
      profileData = await loadProfileDataFromFirestore(requestedStudentId, backgroundRefresh);
    } catch (error) {
      console.error('Failed to load student profile from Firestore:', error);
      profileLoadError = error;
    }

    if (!profileData && !backgroundRefresh && !firebaseApi) {
      profileData = buildFallbackProfileData(requestedStudentId);
      dataSource = 'sample';
    }

    if (!profileData) {
      if (backgroundRefresh) return;
      if (nameEl) nameEl.textContent = requestedStudentId;
      if (coursesEl) coursesEl.textContent = 'No courses found';
      if (emailEl) emailEl.textContent = 'N/A';
      updateProfileSummary(buildProfileSummary([]));
      historyBody.innerHTML = '<tr><td colspan="5">Unable to load this student profile.</td></tr>';
      setProfileSaveStatus('Unable to find this student in your courses.', true);
      if (enrollmentList) enrollmentList.textContent = 'No enrollment records found.';
      if (profileLoadError) {
        renderRetryRow(historyBody, 5, 'Unable to load this student profile. ' +
          (profileLoadError.message || 'Check the emulator connection.'));
      }
      return;
    }

    const student = profileData.student;
    let history = profileData.history || [];
    if (nameEl) nameEl.textContent = student.name;
    if (coursesEl) coursesEl.textContent = (student.courses || []).join(', ') || 'No courses found';
    if (emailEl) emailEl.textContent = student.email;

    let enrollmentRows = profileData.enrollments || [];
    function setEnrollmentStatus(message, isError) {
      if (!enrollmentStatus) return;
      enrollmentStatus.textContent = message || '';
      enrollmentStatus.classList.toggle('profile-enrollment-error', Boolean(isError));
    }
    function updateCourseSummary() {
      if (!coursesEl) return;
      if (dataSource !== 'firestore') {
        coursesEl.textContent = (student.courses || []).join(', ') || 'No courses found';
        return;
      }
      const activeCourses = enrollmentRows
        .filter(function (row) { return row.status === 'active'; })
        .map(function (row) { return row.courseName; });
      coursesEl.textContent = activeCourses.join(', ') || 'No active enrollments';
    }
    function renderEnrollments() {
      if (!enrollmentList) return;
      enrollmentList.innerHTML = '';
      if (!enrollmentRows.length) {
        enrollmentList.textContent = dataSource === 'firestore'
          ? 'This student has no enrollments in your courses.'
          : 'Enrollment management is unavailable for sample data.';
        return;
      }
      enrollmentRows.forEach(function (enrollment) {
        const item = document.createElement('div');
        item.className = 'profile-enrollment-item';
        item.innerHTML = [
          '<div class="profile-enrollment-details"><strong></strong><span></span></div>',
          '<span class="status-badge profile-enrollment-badge"></span>',
          '<button type="button" class="profile-enrollment-button"></button>',
        ].join('');
        item.children[0].children[0].textContent = enrollment.courseName;
        item.children[0].children[1].textContent = enrollment.createdAt
          ? 'Enrolled ' + formatDateDisplay(enrollment.createdAt)
          : 'Enrollment date unavailable';
        const badge = item.children[1];
        badge.textContent = enrollment.status === 'active' ? 'Enrolled' :
          enrollment.status === 'removed' ? 'Removed' : 'Dropped';
        badge.classList.add(enrollment.status === 'active' ? 'status-present' : 'status-absent');
        const button = item.children[2];
        const action = enrollment.status === 'active' ? 'remove' : 'restore';
        button.textContent = action === 'remove' ? 'Remove from Course' : 'Restore Enrollment';
        button.classList.toggle('profile-enrollment-remove', action === 'remove');
        button.addEventListener('click', async function () {
          const prompt = action === 'remove'
            ? `Remove ${student.name} from ${enrollment.courseName}? Their attendance history will remain saved, but mobile check-in and camera recognition will stop immediately.`
            : `Restore ${student.name} to ${enrollment.courseName}?`;
          if (!window.confirm(prompt)) return;
          button.disabled = true;
          setEnrollmentStatus(action === 'remove' ? 'Removing enrollment...' : 'Restoring enrollment...', false);
          try {
            const instructor = await firebaseApi.getCurrentAuthUser();
            const result = await window.FaceRollCourseRoster.requestMembershipChange(
              window.FaceRollConfig?.RECOGNITION_API_URL || '',
              instructor,
              enrollment.courseId,
              enrollment.uid,
              action
            );
            enrollment.status = result.status;
            setEnrollmentStatus(
              result.status === 'active'
                ? `${student.name} is enrolled in ${enrollment.courseName}.`
                : `${student.name} was removed from ${enrollment.courseName}.`,
              false
            );
            updateCourseSummary();
            renderEnrollments();
          } catch (error) {
            console.error('Enrollment update failed:', error);
            setEnrollmentStatus(error && error.message ? error.message : 'Unable to update enrollment.', true);
            button.disabled = false;
          }
        });
        enrollmentList.appendChild(item);
      });
    }
    updateCourseSummary();
    renderEnrollments();

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
          const entry = history.find(function (item) { return item.entryKey === entryKey; });
          const payload = entry && entry.inferred ? { ...entry.overrideDocument, status: nextStatus.toLowerCase() }
            : { status: nextStatus.toLowerCase() };
          writes.push(firebaseApi.writeDocument('attendance', documentId, payload));
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

  if (firebaseApi && typeof firebaseApi.onConnectionRestored === 'function') {
    let reconnectRefresh = null;
    firebaseApi.onConnectionRestored(function () {
      if (reconnectRefresh) return;
      const bodyId = document.body ? document.body.id : '';
      if (bodyId === 'imwtil') reconnectRefresh = renderRosterPage({ background: true });
      else if (bodyId === 'iw11pz') reconnectRefresh = renderReportsPage({ background: true });
      else if (bodyId === 'idhra3g') reconnectRefresh = renderProfilePage({ background: true });
      if (reconnectRefresh && typeof reconnectRefresh.finally === 'function') {
        reconnectRefresh.finally(function () { reconnectRefresh = null; });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
