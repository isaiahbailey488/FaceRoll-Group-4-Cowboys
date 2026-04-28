(function () {
  const tbody = document.getElementById('attendanceTbody');
  const dateFrom = document.getElementById('dateFrom');
  const dateTo = document.getElementById('dateTo');
  const statusFilter = document.getElementById('statusFilter');
  const courseFilter = document.getElementById('courseFilter');
  const searchInput = document.getElementById('searchInput');
  const applyBtn = document.getElementById('applyFilters');
  const clearBtn = document.getElementById('clearFilters');
  const seedBtn = document.getElementById('seedFirestoreBtn');
  const statTotal = document.getElementById('statTotal');
  const statPresent = document.getElementById('statPresent');
  const statAbsent = document.getElementById('statAbsent');
  const tableCount = document.getElementById('tableCount');
  const firestoreStatus = document.getElementById('firestoreStatus');
  const prevPageBtn =
    document.getElementById('paginationPrevBtn') || document.querySelector('.pagination-prev');
  const nextPageBtn =
    document.getElementById('paginationNextBtn') || document.querySelector('.pagination-next');
  const sidebarProfileName = document.querySelector('.sidebar-footer .profile-name');
  const sidebarProfileRole = document.querySelector('.sidebar-footer .profile-role');

  function setSidebarProfileQuick(name, role) {
    if (sidebarProfileName) sidebarProfileName.textContent = name;
    if (sidebarProfileRole) sidebarProfileRole.textContent = role;
  }

  function initSidebarProfileFromAuth() {
    if (!window.firebase || typeof window.firebase.auth !== 'function') return;

    const auth = window.firebase.auth();
    const current = auth.currentUser;
    if (current) {
      setSidebarProfileQuick(current.displayName || current.email || 'Instructor', 'Instructor');
    }

    auth.onAuthStateChanged(async function (user) {
      if (!user) return;
      setSidebarProfileQuick(user.displayName || user.email || 'Instructor', 'Instructor');

      try {
        if (window.firebase.firestore) {
          const snap = await window.firebase.firestore().collection('users').doc(user.uid).get();
          if (snap.exists) {
            const data = snap.data() || {};
            const first = data.fname || data.firstName || data.first_name || '';
            const last = data.lname || data.lastName || data.last_name || '';
            const joined = [first, last].filter(Boolean).join(' ').trim();
            const name =
              data.displayName ||
              data.fullName ||
              data.name ||
              joined ||
              user.displayName ||
              user.email ||
              'Instructor';
            const rawRole = String(data.role || data.userType || 'Instructor');
            const role = rawRole.charAt(0).toUpperCase() + rawRole.slice(1);
            setSidebarProfileQuick(name, role);
          }
        }
      } catch (_error) {}
    });
  }

  initSidebarProfileFromAuth();

  let allAttendanceRows = [];
  let visibleAttendanceRows = [];
  let generatedSampleAssignments = new Map();
  let currentPage = 1;
  let hasLoadedOnce = false;
  const rowsPerPage = 10;
  const defaultSeedButtonLabel = seedBtn ? seedBtn.textContent.trim() : 'Seed Firestore Data';

  function getSampleDataApi() {
    return window.FaceRollSampleData || null;
  }

  function setStatus(message, isError) {
    if (!firestoreStatus) return;
    firestoreStatus.textContent = message;
    firestoreStatus.style.color = isError ? '#b91c1c' : '#475569';
  }

  function setSeedButtonState(isBusy) {
    if (!seedBtn) return;
    seedBtn.disabled = isBusy;
    seedBtn.style.opacity = isBusy ? '0.7' : '1';
    seedBtn.textContent = isBusy ? 'Seeding...' : defaultSeedButtonLabel;
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

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value.toDate === 'function') {
      const converted = value.toDate();
      return Number.isNaN(converted.getTime()) ? null : converted;
    }

    if (typeof value === 'object') {
      const seconds = value.seconds ?? value._seconds;
      if (typeof seconds === 'number') {
        return new Date(seconds * 1000);
      }
    }

    const converted = new Date(value);
    return Number.isNaN(converted.getTime()) ? null : converted;
  }

  function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function formatDateForDisplay(value) {
    const date = toDate(value);
    return date ? formatDateForInput(date) : 'N/A';
  }

  function normalizeStatus(value) {
    const rawStatus = String(value || '').trim().toLowerCase();
    if (rawStatus === 'present') return 'Present';
    if (rawStatus === 'absent') return 'Absent';
    if (rawStatus === 'late') return 'Late';
    return rawStatus ? rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1) : 'Unknown';
  }

  function buildUserMaps(users) {
    // Firestore records can reference students in a few different ways.
    const byDocId = new Map();
    const byStudentId = new Map();
    const byUid = new Map();
    const byEmail = new Map();

    users.forEach(function (user) {
      byDocId.set(user.id, user);

      const studentId =
        getFirstDefined(user, ['studentId', 'student_id', 'universityId', 'schoolId', 'userId']) || user.id;
      if (studentId) byStudentId.set(String(studentId), user);

      const uid = getFirstDefined(user, ['uid', 'userUid', 'authUid', 'userId']);
      if (uid) byUid.set(String(uid), user);

      const email = getFirstDefined(user, ['email']);
      if (email) byEmail.set(String(email).toLowerCase(), user);
    });

    return { byDocId, byStudentId, byUid, byEmail };
  }

  function buildCourseKeySet(courses) {
    return new Set(courses.map(function (course) {
      return String(getFirstDefined(course, ['courseId']) || course.id || '');
    }));
  }

  function buildSessionKeySet(sessions) {
    return new Set(sessions.map(function (session) {
      return String(getFirstDefined(session, ['sessionId']) || session.id || '');
    }));
  }

  function buildAttendanceKeySet(attendanceRows) {
    return new Set(attendanceRows.map(function (row) {
      const sessionId = String(getFirstDefined(row, ['sessionId']) || '');
      const uid = String(getFirstDefined(row, ['uid', 'userId']) || '');
      return sessionId + '::' + uid;
    }));
  }

  function getSeedStudentPayload(sampleStudent, userDocId) {
    const nameParts = sampleStudent.name.split(' ');
    const firstName = nameParts.shift() || '';
    return {
      role: 'student',
      userType: 'student',
      fname: firstName,
      lname: nameParts.join(' '),
      name: sampleStudent.name,
      fullName: sampleStudent.name,
      displayName: sampleStudent.name,
      studentId: sampleStudent.studentId,
      userId: userDocId,
      email: sampleStudent.email,
      optOutFlag: Boolean(sampleStudent.optOutFlag),
      seededBy: 'instructor-dashboard',
      seededFromAttendanceRef: userDocId,
    };
  }

  async function seedSampleStudentUsers(users) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi) return 0;

    const studentUsers = users.filter(function (user) {
      return String(user.role || '').toLowerCase() === 'student';
    });

    if (studentUsers.length >= sampleDataApi.getSampleStudents().length) return 0;

    const userMaps = buildUserMaps(users);
    const writes = sampleDataApi
      .getSampleStudents()
      .filter(function (student) {
        const studentId = String(student.studentId);
        const email = String(student.email).toLowerCase();
        return (
          !userMaps.byDocId.has(student.id) &&
          !userMaps.byStudentId.has(studentId) &&
          !userMaps.byUid.has(student.id) &&
          !userMaps.byEmail.has(email)
        );
      })
      .map(function (student) {
        return window.FaceRollFirebase.writeDocument('users', student.id, getSeedStudentPayload(student, student.id));
      });

    if (!writes.length) return 0;
    await Promise.all(writes);
    return writes.length;
  }

  async function seedSampleCourseSessionAttendanceData(courses, sessions, attendance) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi) return 0;

    const existingCourseIds = buildCourseKeySet(courses);
    const existingSessionIds = buildSessionKeySet(sessions);
    const existingAttendanceKeys = buildAttendanceKeySet(attendance);
    const writes = [];

    sampleDataApi.getSampleCourses().forEach(function (course) {
      const courseKey = String(getFirstDefined(course, ['courseId']) || course.id);
      if (!existingCourseIds.has(courseKey)) {
        writes.push(window.FaceRollFirebase.writeDocument('courses', course.id, course));
        existingCourseIds.add(courseKey);
      }
    });

    sampleDataApi.getSampleSessions().forEach(function (session) {
      const sessionKey = String(getFirstDefined(session, ['sessionId']) || session.id);
      if (!existingSessionIds.has(sessionKey)) {
        writes.push(window.FaceRollFirebase.writeDocument('sessions', session.id, session));
        existingSessionIds.add(sessionKey);
      }
    });

    sampleDataApi.getSampleAttendanceDocs().forEach(function (attendanceDoc) {
      const attendanceKey =
        String(getFirstDefined(attendanceDoc, ['sessionId']) || '') +
        '::' +
        String(getFirstDefined(attendanceDoc, ['uid', 'userId']) || '');

      if (!existingAttendanceKeys.has(attendanceKey)) {
        writes.push(window.FaceRollFirebase.writeDocument('attendance', attendanceDoc.id, attendanceDoc));
        existingAttendanceKeys.add(attendanceKey);
      }
    });

    if (!writes.length) return 0;
    await Promise.all(writes);
    return writes.length;
  }

  function findSampleStudent(referenceValue) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi || !referenceValue) return null;
    return sampleDataApi.getStudentByAnyId(String(referenceValue));
  }

  function getGeneratedSampleStudent(attendance, fallbackKey) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi) return null;

    const assignmentKey =
      String(fallbackKey || attendance.id || getFirstDefined(attendance, ['studentId', 'student_id', 'userId']) || '');

    if (!assignmentKey) return null;
    if (generatedSampleAssignments.has(assignmentKey)) return generatedSampleAssignments.get(assignmentKey);

    const sampleStudents = sampleDataApi.getSampleStudents();
    const assignedStudent = sampleStudents[generatedSampleAssignments.size % sampleStudents.length] || null;

    if (assignedStudent) generatedSampleAssignments.set(assignmentKey, assignedStudent);
    return assignedStudent;
  }

  async function seedMissingUsersFromAttendance(users, attendanceDocs) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi || !attendanceDocs.length) return 0;

    const userMaps = buildUserMaps(users);
    const sampleStudents = sampleDataApi.getSampleStudents();
    const writes = [];
    let nextSampleIndex = 0;

    attendanceDocs.forEach(function (attendance) {
      const userRef = getFirstDefined(attendance, ['uid', 'userId', 'studentUserId', 'studentRef']);
      const studentIdRef = getFirstDefined(attendance, ['studentId', 'student_id']);

      const existingUser =
        (userRef && userMaps.byDocId.get(String(userRef))) ||
        (userRef && userMaps.byUid.get(String(userRef))) ||
        (studentIdRef && userMaps.byStudentId.get(String(studentIdRef))) ||
        null;

      if (existingUser || !userRef) return;

      const sampleStudent =
        findSampleStudent(studentIdRef) ||
        sampleStudents[nextSampleIndex % sampleStudents.length] ||
        null;

      if (!sampleStudent) return;

      nextSampleIndex += 1;
      writes.push(
        window.FaceRollFirebase.writeDocument('users', String(userRef), getSeedStudentPayload(sampleStudent, String(userRef)))
      );

      userMaps.byDocId.set(String(userRef), sampleStudent);
      userMaps.byUid.set(String(userRef), sampleStudent);
      userMaps.byStudentId.set(String(sampleStudent.studentId), sampleStudent);
      userMaps.byEmail.set(String(sampleStudent.email).toLowerCase(), sampleStudent);
    });

    if (!writes.length) return 0;
    await Promise.all(writes);
    return writes.length;
  }

  async function seedAllSampleData() {
    // Manual fallback for demos when Firestore has no sample course data.
    setStatus('Seeding sample Firestore data...');

    let results = await Promise.all([
      window.FaceRollFirebase.readCollectionDocs('users'),
      window.FaceRollFirebase.readCollectionDocs('courses'),
      window.FaceRollFirebase.readCollectionDocs('sessions'),
      window.FaceRollFirebase.readCollectionDocs('attendance'),
    ]);

    let users = results[0];
    let courses = results[1];
    let sessions = results[2];
    let attendance = results[3];

    const seededUsersCount = await seedSampleStudentUsers(users);
    if (seededUsersCount) users = await window.FaceRollFirebase.readCollectionDocs('users');

    const seededLinkedCount = await seedSampleCourseSessionAttendanceData(courses, sessions, attendance);
    if (seededLinkedCount) {
      results = await Promise.all([
        window.FaceRollFirebase.readCollectionDocs('courses'),
        window.FaceRollFirebase.readCollectionDocs('sessions'),
        window.FaceRollFirebase.readCollectionDocs('attendance'),
      ]);
      courses = results[0];
      sessions = results[1];
      attendance = results[2];
    }

    const seededMissingUserCount = await seedMissingUsersFromAttendance(users, attendance);
    if (seededMissingUserCount) users = await window.FaceRollFirebase.readCollectionDocs('users');

    setStatus('Firestore seed complete. Added ' + (seededUsersCount + seededLinkedCount + seededMissingUserCount) + ' documents.');
    return { users, courses, sessions, attendance };
  }

  function buildCourseMap(courses) {
    const map = new Map();
    courses.forEach(function (course) {
      [course.id, getFirstDefined(course, ['courseId', 'course_id', 'code'])]
        .filter(Boolean)
        .forEach(function (key) { map.set(String(key), course); });
    });
    return map;
  }

  function buildSessionMap(sessions) {
    const map = new Map();
    sessions.forEach(function (session) {
      [session.id, getFirstDefined(session, ['sessionId', 'session_id'])]
        .filter(Boolean)
        .forEach(function (key) { map.set(String(key), session); });
    });
    return map;
  }

  function getUserDisplayName(user) {
    if (!user) return 'Unknown Student';

    const directName = getFirstDefined(user, ['name', 'fullName', 'displayName']);
    if (directName) return String(directName);

    const firstName = getFirstDefined(user, ['fname', 'firstName', 'first_name']);
    const lastName = getFirstDefined(user, ['lname', 'lastName', 'last_name']);
    const joinedName = [firstName, lastName].filter(Boolean).join(' ').trim();

    return joinedName || 'Unknown Student';
  }

  function normalizeRecognitionName(value) {
    // Combines names like "isaiah_bailey1" and "isaiah bailey 2".
    return String(value || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9@.]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s+\d+$/, '')
      .replace(/([a-z])\d+$/, '$1')
      .trim();
  }

  function formatRecognitionName(value) {
    const cleaned = normalizeRecognitionName(value);
    if (!cleaned) return '';
    return cleaned
      .split(' ')
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }

  function getAttendanceDisplayName(attendance) {
    const directName = getFirstDefined(attendance, ['studentName', 'displayName', 'name']);
    if (directName) return formatRecognitionName(directName) || String(directName);

    const recognitionLabel = getFirstDefined(attendance, ['recognitionLabel', 'identityLabel']);
    if (recognitionLabel) return formatRecognitionName(recognitionLabel);

    const recognitionIdentity = getFirstDefined(attendance, ['recognitionIdentity', 'identity']);
    if (recognitionIdentity) {
      return formatRecognitionName(String(recognitionIdentity).split(/[\\/]/).pop());
    }

    return '';
  }

  function getAttendanceNotes(attendance, session) {
    // Face recognition records should show a clear method in the table.
    const directNote = getFirstDefined(attendance, ['method', 'notes', 'comment', 'remarks']);
    if (directNote) return String(directNote);

    const source = String(getFirstDefined(attendance, ['source']) || '').toLowerCase();
    if (source === 'face_recognition') return 'Face Recognition';

    const sessionNote = getFirstDefined(session, ['notes']);
    return sessionNote ? String(sessionNote) : '';
  }

  function getCanonicalAttendanceKey(row) {
    // Deduplicate the same student within the same course/date.
    const cleanedName = normalizeRecognitionName(row.studentName);
    const courseName = String(row.courseName || '').trim().toLowerCase();
    const sessionDate = row.dateValue ? String(row.dateText || row.dateValue || '') : '';
    return [cleanedName || String(row.studentId || '').toLowerCase(), courseName, sessionDate].join('||');
  }

  function getUserStudentId(user, fallbackId) {
    const studentId =
      getFirstDefined(user, ['studentId', 'student_id', 'universityId', 'schoolId', 'userId']) || user?.id;
    return studentId ? String(studentId) : String(fallbackId || 'N/A');
  }

  function updateInstructorProfileCard(users) {
    const instructorUser =
      users.find(function (user) { return String(user.id || '') === 'instructor001'; }) ||
      users.find(function (user) {
        return String(getFirstDefined(user, ['role', 'userType']) || '').toLowerCase() === 'instructor';
      });

    if (!instructorUser) return;

    const firstName = getFirstDefined(instructorUser, ['fname', 'firstName', 'first_name']);
    const lastName = getFirstDefined(instructorUser, ['lname', 'lastName', 'last_name']);
    const displayName =
      getFirstDefined(instructorUser, ['name', 'fullName', 'displayName']) ||
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      'Instructor';
    const roleLabel = getFirstDefined(instructorUser, ['role', 'userType']) || 'Instructor';

    if (sidebarProfileName) sidebarProfileName.textContent = String(displayName);
    if (sidebarProfileRole) {
      const formattedRole = String(roleLabel);
      sidebarProfileRole.textContent = formattedRole.charAt(0).toUpperCase() + formattedRole.slice(1);
    }
  }

  function getAttendanceDate(attendance, session) {
    return (
      getFirstDefined(attendance, ['time', 'date', 'attendanceDate', 'recordedAt', 'timestamp', 'createdAt']) ||
      getFirstDefined(session, ['startTime', 'date', 'sessionDate', 'createdAt']) ||
      null
    );
  }

  function buildAttendanceRows(attendanceDocs, users, courses, sessions) {
    // Convert raw Firestore documents into rows the dashboard table can render.
    const userMaps = buildUserMaps(users);
    const courseMap = buildCourseMap(courses);
    const sessionMap = buildSessionMap(sessions);
    generatedSampleAssignments = new Map();

    const rowMap = new Map();

    attendanceDocs
      .map(function (attendance) {
        const userRef = getFirstDefined(attendance, ['uid', 'userId', 'studentUserId', 'studentRef']);
        const studentIdRef = getFirstDefined(attendance, ['studentId', 'student_id']);
        const sessionId = getFirstDefined(attendance, ['sessionId', 'session_id']);
        const courseId = getFirstDefined(attendance, ['courseId', 'course_id']);
        const session = sessionId ? sessionMap.get(String(sessionId)) : undefined;
        const resolvedCourseId = courseId || getFirstDefined(session, ['courseId', 'course_id']);
        const course = resolvedCourseId ? courseMap.get(String(resolvedCourseId)) : undefined;
        const user =
          (userRef && userMaps.byDocId.get(String(userRef))) ||
          (studentIdRef && userMaps.byStudentId.get(String(studentIdRef))) ||
          undefined;
        const attendanceDisplayName = getAttendanceDisplayName(attendance);
        const sampleStudent = user || findSampleStudent(studentIdRef) || findSampleStudent(userRef);
        const resolvedUser = user || sampleStudent || undefined;
        const studentName = attendanceDisplayName || (resolvedUser ? getUserDisplayName(resolvedUser) : 'Unknown Student');
        const studentId = resolvedUser
          ? getUserStudentId(resolvedUser, studentIdRef || userRef || attendance.id)
          : String(studentIdRef || userRef || attendance.id || 'N/A');

        return {
          attendanceId: attendance.id,
          studentName: studentName,
          studentId: studentId,
          dateValue: getAttendanceDate(attendance, session),
          dateText: formatDateForDisplay(getAttendanceDate(attendance, session)),
          status: normalizeStatus(getFirstDefined(attendance, ['status', 'attendanceStatus'])),
          notes: getAttendanceNotes(attendance, session),
          courseName: String(getFirstDefined(course, ['courseName', 'name', 'title', 'code']) || resolvedCourseId || ''),
        };
      })
      .forEach(function (row) {
        const key = getCanonicalAttendanceKey(row);
        const existing = rowMap.get(key);
        const rowDate = toDate(row.dateValue) || new Date(0);
        const existingDate = existing ? (toDate(existing.dateValue) || new Date(0)) : null;
        if (!existing || rowDate >= existingDate) rowMap.set(key, row);
      });

    return Array.from(rowMap.values())
      .sort(function (left, right) {
        const leftDate = toDate(left.dateValue);
        const rightDate = toDate(right.dateValue);

        if (leftDate && rightDate) return rightDate - leftDate;
        if (leftDate) return -1;
        if (rightDate) return 1;
        return left.studentName.localeCompare(right.studentName);
      });
  }

  function renderMessageRow(message) {
    tbody.innerHTML = '';

    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'cell-notes';
    cell.textContent = message;
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function getBadgeClass(status) {
    const normalized = status.toLowerCase();
    if (normalized === 'present') return 'status-present';
    if (normalized === 'absent') return 'status-absent';
    if (normalized === 'late') return 'status-late';
    return '';
  }

  function renderRows(rows) {
    tbody.innerHTML = '';

    if (!rows.length) {
      renderMessageRow('No attendance records match the current filters.');
      return;
    }

    rows.forEach(function (rowData) {
      const row = document.createElement('tr');
      row.innerHTML = [
        '<td class="cell-name"></td>',
        '<td class="cell-id"></td>',
        '<td class="cell-course"></td>',
        '<td class="cell-date"></td>',
        '<td class="cell-status"><span class="status-badge"></span></td>',
        '<td class="cell-notes"></td>',
      ].join('');

      row.children[0].textContent = rowData.studentName;
      row.children[1].textContent = rowData.studentId;
      row.children[2].textContent = rowData.courseName || 'Unknown Course';
      row.children[3].textContent = rowData.dateText;
      row.children[4].firstElementChild.textContent = rowData.status;
      const badgeClass = getBadgeClass(rowData.status);
      if (badgeClass) row.children[4].firstElementChild.classList.add(badgeClass);
      row.children[5].textContent = rowData.notes || 'No method';

      tbody.appendChild(row);
    });
  }

  function getTotalPages() {
    return Math.max(1, Math.ceil(visibleAttendanceRows.length / rowsPerPage));
  }

  function getPagedRows() {
    const startIndex = (currentPage - 1) * rowsPerPage;
    return visibleAttendanceRows.slice(startIndex, startIndex + rowsPerPage);
  }

  function updatePaginationControls() {
    if (!prevPageBtn || !nextPageBtn) return;

    const totalPages = getTotalPages();
    const hasRows = visibleAttendanceRows.length > 0;

    prevPageBtn.disabled = !hasRows || currentPage <= 1;
    nextPageBtn.disabled = !hasRows || currentPage >= totalPages;

    prevPageBtn.style.opacity = prevPageBtn.disabled ? '0.55' : '1';
    nextPageBtn.style.opacity = nextPageBtn.disabled ? '0.55' : '1';
    prevPageBtn.style.cursor = prevPageBtn.disabled ? 'not-allowed' : 'pointer';
    nextPageBtn.style.cursor = nextPageBtn.disabled ? 'not-allowed' : 'pointer';
  }

  function updateTableCount() {
    const totalCount = allAttendanceRows.length;
    const visibleCount = visibleAttendanceRows.length;
    const pagedRows = getPagedRows();

    if (!visibleCount) {
      tableCount.textContent = 'Showing 0 of ' + totalCount;
      return;
    }

    const startCount = (currentPage - 1) * rowsPerPage + 1;
    const endCount = startCount + pagedRows.length - 1;
    tableCount.textContent =
      'Showing ' +
      startCount +
      '-' +
      endCount +
      ' of ' +
      visibleCount +
      ' filtered records (Page ' +
      currentPage +
      ' of ' +
      getTotalPages() +
      ')';
  }

  function passesFilters(rowData) {
    // Apply date, status, course, and search filters from the filter bar.
    const query = (searchInput.value || '').trim().toLowerCase();
    const statusValue = statusFilter.value;
    const courseValue = courseFilter ? courseFilter.value : '';
    const fromValue = dateFrom.value;
    const toValue = dateTo.value;
    const rowDate = toDate(rowData.dateValue);

    if (query) {
      const nameMatches = rowData.studentName.toLowerCase().includes(query);
      const idMatches = rowData.studentId.toLowerCase().includes(query);
      const courseMatches = String(rowData.courseName || '').toLowerCase().includes(query);
      if (!nameMatches && !idMatches && !courseMatches) return false;
    }

    if (statusValue && rowData.status !== statusValue) return false;
    if (courseValue && rowData.courseName !== courseValue) return false;
    if (fromValue && rowDate && formatDateForInput(rowDate) < fromValue) return false;
    if (toValue && rowDate && formatDateForInput(rowDate) > toValue) return false;

    return true;
  }

  function applyFiltersNow() {
    visibleAttendanceRows = allAttendanceRows.filter(passesFilters);
    currentPage = 1;
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
  }

  function hasActiveFilters() {
    return Boolean(
      (dateFrom && dateFrom.value) ||
        (dateTo && dateTo.value) ||
        (statusFilter && statusFilter.value) ||
        (courseFilter && courseFilter.value) ||
        (searchInput && searchInput.value.trim())
    );
  }

  function clearFiltersNow() {
    dateFrom.value = '';
    dateTo.value = '';
    statusFilter.value = '';
    if (courseFilter) courseFilter.value = '';
    searchInput.value = '';
    applyFiltersNow();
  }

  function goToPreviousPage() {
    if (currentPage <= 1) return;
    currentPage -= 1;
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
  }

  function goToNextPage() {
    if (currentPage >= getTotalPages()) return;
    currentPage += 1;
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
  }

  function updateSummaryCards(users, attendanceRows) {
    // Summary cards show today's latest status per student/course.
    const todayKey = formatDateForInput(new Date());
    const latestTodayByStudentCourse = new Map();

    attendanceRows.filter(function (row) {
      const rowDate = toDate(row.dateValue);
      return rowDate && formatDateForInput(rowDate) === todayKey;
    }).forEach(function (row) {
      const studentKey = normalizeRecognitionName(row.studentName) || String(row.studentId || '').toLowerCase();
      const courseKey = String(row.courseName || '').trim().toLowerCase();
      const key = studentKey + '||' + courseKey;
      const rowDate = toDate(row.dateValue) || new Date(0);
      const existing = latestTodayByStudentCourse.get(key);
      const existingDate = existing ? (toDate(existing.dateValue) || new Date(0)) : null;
      if (!existing || rowDate >= existingDate) latestTodayByStudentCourse.set(key, row);
    });

    const todayRows = Array.from(latestTodayByStudentCourse.values());

    if (!todayRows.length) {
      statTotal.textContent = '0';
      statPresent.textContent = '0';
      statAbsent.textContent = '0';
      return;
    }

    const studentKeys = new Set(todayRows.map(function (row) {
      return normalizeRecognitionName(row.studentName) || String(row.studentId || '').toLowerCase();
    }));
    const presentCount = todayRows.filter(function (row) { return row.status === 'Present'; }).length;
    const absentCount = todayRows.filter(function (row) { return row.status === 'Absent'; }).length;

    statTotal.textContent = String(studentKeys.size);
    statPresent.textContent = String(presentCount);
    statAbsent.textContent = String(absentCount);
  }

  function populateCourseFilter(rows) {
    if (!courseFilter) return;

    const currentValue = courseFilter.value;
    const courseNames = Array.from(new Set(
      rows.map(function (row) { return String(row.courseName || '').trim(); }).filter(Boolean)
    )).sort(function (left, right) { return left.localeCompare(right); });

    courseFilter.innerHTML = '<option value="">All Courses</option>';
    courseNames.forEach(function (courseName) {
      const option = document.createElement('option');
      option.value = courseName;
      option.textContent = courseName;
      courseFilter.appendChild(option);
    });

    if (courseNames.includes(currentValue)) courseFilter.value = currentValue;
  }

  async function loadDashboardData() {
    // Load the collections that are needed to resolve names, courses, sessions, and attendance.
    if (!hasLoadedOnce) {
      renderMessageRow('Loading attendance records from Firestore...');
      setStatus('Loading data...');
    }

    const data = await Promise.all([
      window.FaceRollFirebase.readCollectionDocs('users'),
      window.FaceRollFirebase.readCollectionDocs('courses'),
      window.FaceRollFirebase.readCollectionDocs('sessions'),
      window.FaceRollFirebase.readCollectionDocs('attendance'),
    ]);

    const users = data[0];
    const courses = data[1];
    const sessions = data[2];
    const attendance = data[3];

    allAttendanceRows = buildAttendanceRows(attendance, users, courses, sessions);
    visibleAttendanceRows = allAttendanceRows.slice();
    currentPage = 1;

    updateInstructorProfileCard(users);
    updateSummaryCards(users, allAttendanceRows);
    populateCourseFilter(allAttendanceRows);
    if (hasActiveFilters()) {
      applyFiltersNow();
    } else {
      renderRows(getPagedRows());
      updateTableCount();
      updatePaginationControls();
    }
    setStatus('Data loaded successfully.');
    hasLoadedOnce = true;
  }

  applyBtn.addEventListener('click', applyFiltersNow);
  clearBtn.addEventListener('click', clearFiltersNow);
  if (courseFilter) courseFilter.addEventListener('change', applyFiltersNow);
  if (prevPageBtn) prevPageBtn.addEventListener('click', goToPreviousPage);
  if (nextPageBtn) nextPageBtn.addEventListener('click', goToNextPage);

  if (seedBtn) {
    seedBtn.addEventListener('click', async function () {
      setSeedButtonState(true);
      try {
        await seedAllSampleData();
        await loadDashboardData();
      } catch (error) {
        console.error('Manual Firestore seed failed:', error);
        setStatus('Firestore seed failed: ' + (error && error.message ? error.message : 'Unknown error'), true);
      } finally {
        setSeedButtonState(false);
      }
    });
  }

  let autoRefreshHandle = null;
  function startAutoRefresh() {
    if (autoRefreshHandle) return;
    autoRefreshHandle = window.setInterval(async function () {
      try {
        await loadDashboardData();
      } catch (error) {}
    }, 5000);
  }

  loadDashboardData()
    .then(function () {
      startAutoRefresh();
    })
    .catch(function (error) {
      console.error('Failed to load dashboard data:', error);
      setStatus('Firestore load failed: ' + (error && error.message ? error.message : 'Unknown error'), true);

      renderMessageRow('Unable to load Firestore data. Check Firebase Hosting auto-init and your Firestore collection fields.');
      tableCount.textContent = 'Showing 0 of 0';
      updatePaginationControls();
      statTotal.textContent = '0';
      statPresent.textContent = '0';
      statAbsent.textContent = '0';
    });
})();
