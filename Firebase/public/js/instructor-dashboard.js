(function () {
  const tbody = document.getElementById('attendanceTbody');
  const dateFrom = document.getElementById('dateFrom');
  const dateTo = document.getElementById('dateTo');
  const statusFilter = document.getElementById('statusFilter');
  const searchInput = document.getElementById('searchInput');
  const applyBtn = document.getElementById('applyFilters');
  const clearBtn = document.getElementById('clearFilters');
  const exportBtn = document.getElementById('exportCsvBtn');
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

  let allAttendanceRows = [];
  let visibleAttendanceRows = [];
  let generatedSampleAssignments = new Map();
  let currentPage = 1;
  const rowsPerPage = 10;
  const defaultSeedButtonLabel = seedBtn ? seedBtn.textContent.trim() : 'Seed Firestore Data';

  function getSampleDataApi() {
    return window.FaceRollSampleData || null;
  }

  function setStatus(message, isError) {
    if (!firestoreStatus) {
      return;
    }

    firestoreStatus.textContent = message;
    firestoreStatus.style.color = isError ? '#b91c1c' : '#475569';
  }

  function setSeedButtonState(isBusy) {
    if (!seedBtn) {
      return;
    }

    seedBtn.disabled = isBusy;
    seedBtn.style.opacity = isBusy ? '0.7' : '1';
    seedBtn.textContent = isBusy ? 'Seeding...' : defaultSeedButtonLabel;
  }

  function getFirstDefined(source, keys) {
    if (!source) {
      return undefined;
    }

    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        return source[key];
      }
    }

    return undefined;
  }

  function toDate(value) {
    if (!value) {
      return null;
    }

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
    return date.toISOString().slice(0, 10);
  }

  function formatDateForDisplay(value) {
    const date = toDate(value);
    return date ? formatDateForInput(date) : 'N/A';
  }

  function normalizeStatus(value) {
    const rawStatus = String(value || '').trim().toLowerCase();

    if (rawStatus === 'present') {
      return 'Present';
    }

    if (rawStatus === 'absent') {
      return 'Absent';
    }

    if (rawStatus === 'late') {
      return 'Late';
    }

    return rawStatus ? rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1) : 'Unknown';
  }

  function buildUserMaps(users) {
    const byDocId = new Map();
    const byStudentId = new Map();
    const byUid = new Map();
    const byEmail = new Map();

    users.forEach((user) => {
      byDocId.set(user.id, user);

      const studentId =
        getFirstDefined(user, ['studentId', 'student_id', 'universityId', 'schoolId', 'userId']) || user.id;
      if (studentId) {
        byStudentId.set(String(studentId), user);
      }

      const uid = getFirstDefined(user, ['uid', 'userUid', 'authUid', 'userId']);
      if (uid) {
        byUid.set(String(uid), user);
      }

      const email = getFirstDefined(user, ['email']);
      if (email) {
        byEmail.set(String(email).toLowerCase(), user);
      }
    });

    return { byDocId, byStudentId, byUid, byEmail };
  }

  function buildCourseKeySet(courses) {
    return new Set(
      courses.map((course) => String(getFirstDefined(course, ['courseId']) || course.id || ''))
    );
  }

  function buildSessionKeySet(sessions) {
    return new Set(
      sessions.map((session) => String(getFirstDefined(session, ['sessionId']) || session.id || ''))
    );
  }

  function buildAttendanceKeySet(attendanceRows) {
    return new Set(
      attendanceRows.map((row) => {
        const sessionId = String(getFirstDefined(row, ['sessionId']) || '');
        const uid = String(getFirstDefined(row, ['uid', 'userId']) || '');
        return sessionId + '::' + uid;
      })
    );
  }

  function getSeedStudentPayload(sampleStudent, userDocId) {
    const [firstName, ...lastNameParts] = sampleStudent.name.split(' ');

    return {
      role: 'student',
      userType: 'student',
      fname: firstName,
      lname: lastNameParts.join(' '),
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
    if (!sampleDataApi) {
      return 0;
    }

    const studentUsers = users.filter((user) => String(user.role || '').toLowerCase() === 'student');
    if (studentUsers.length >= sampleDataApi.getSampleStudents().length) {
      return 0;
    }

    const userMaps = buildUserMaps(users);
    const writes = sampleDataApi
      .getSampleStudents()
      .filter((student) => {
        const studentId = String(student.studentId);
        const email = String(student.email).toLowerCase();
        return (
          !userMaps.byDocId.has(student.id) &&
          !userMaps.byStudentId.has(studentId) &&
          !userMaps.byUid.has(student.id) &&
          !userMaps.byEmail.has(email)
        );
      })
      .map((student) =>
        window.FaceRollFirebase.writeDocument('users', student.id, getSeedStudentPayload(student, student.id))
      );

    if (!writes.length) {
      return 0;
    }

    await Promise.all(writes);
    return writes.length;
  }

  async function seedSampleCourseSessionAttendanceData(courses, sessions, attendance) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi) {
      return 0;
    }

    const existingCourseIds = buildCourseKeySet(courses);
    const existingSessionIds = buildSessionKeySet(sessions);
    const existingAttendanceKeys = buildAttendanceKeySet(attendance);
    const writes = [];

    sampleDataApi.getSampleCourses().forEach((course) => {
      const courseKey = String(getFirstDefined(course, ['courseId']) || course.id);
      if (!existingCourseIds.has(courseKey)) {
        writes.push(window.FaceRollFirebase.writeDocument('courses', course.id, course));
        existingCourseIds.add(courseKey);
      }
    });

    sampleDataApi.getSampleSessions().forEach((session) => {
      const sessionKey = String(getFirstDefined(session, ['sessionId']) || session.id);
      if (!existingSessionIds.has(sessionKey)) {
        writes.push(window.FaceRollFirebase.writeDocument('sessions', session.id, session));
        existingSessionIds.add(sessionKey);
      }
    });

    sampleDataApi.getSampleAttendanceDocs().forEach((attendanceDoc) => {
      const attendanceKey =
        String(getFirstDefined(attendanceDoc, ['sessionId']) || '') +
        '::' +
        String(getFirstDefined(attendanceDoc, ['uid', 'userId']) || '');
      if (!existingAttendanceKeys.has(attendanceKey)) {
        writes.push(window.FaceRollFirebase.writeDocument('attendance', attendanceDoc.id, attendanceDoc));
        existingAttendanceKeys.add(attendanceKey);
      }
    });

    if (!writes.length) {
      return 0;
    }

    await Promise.all(writes);
    return writes.length;
  }

  async function seedMissingUsersFromAttendance(users, attendanceDocs) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi || !attendanceDocs.length) {
      return 0;
    }

    const userMaps = buildUserMaps(users);
    const sampleStudents = sampleDataApi.getSampleStudents();
    const writes = [];
    let nextSampleIndex = 0;

    attendanceDocs.forEach((attendance) => {
      const userRef = getFirstDefined(attendance, ['uid', 'userId', 'studentUserId', 'studentRef']);
      const studentIdRef = getFirstDefined(attendance, ['studentId', 'student_id']);

      const existingUser =
        (userRef && userMaps.byDocId.get(String(userRef))) ||
        (userRef && userMaps.byUid.get(String(userRef))) ||
        (studentIdRef && userMaps.byStudentId.get(String(studentIdRef))) ||
        null;

      if (existingUser || !userRef) {
        return;
      }

      const sampleStudent =
        findSampleStudent(studentIdRef) ||
        sampleStudents[nextSampleIndex % sampleStudents.length] ||
        null;

      if (!sampleStudent) {
        return;
      }

      nextSampleIndex += 1;
      writes.push(
        window.FaceRollFirebase.writeDocument('users', String(userRef), getSeedStudentPayload(sampleStudent, String(userRef)))
      );
      userMaps.byDocId.set(String(userRef), sampleStudent);
      userMaps.byUid.set(String(userRef), sampleStudent);
      userMaps.byStudentId.set(String(sampleStudent.studentId), sampleStudent);
      userMaps.byEmail.set(String(sampleStudent.email).toLowerCase(), sampleStudent);
    });

    if (!writes.length) {
      return 0;
    }

    await Promise.all(writes);
    return writes.length;
  }

  async function seedAllSampleData() {
    setStatus('Seeding sample Firestore data...');

    let [users, courses, sessions, attendance] = await Promise.all([
      window.FaceRollFirebase.readCollectionDocs('users'),
      window.FaceRollFirebase.readCollectionDocs('courses'),
      window.FaceRollFirebase.readCollectionDocs('sessions'),
      window.FaceRollFirebase.readCollectionDocs('attendance'),
    ]);

    const seededUsersCount = await seedSampleStudentUsers(users);
    if (seededUsersCount) {
      users = await window.FaceRollFirebase.readCollectionDocs('users');
    }

    const seededLinkedCount = await seedSampleCourseSessionAttendanceData(courses, sessions, attendance);
    if (seededLinkedCount) {
      [courses, sessions, attendance] = await Promise.all([
        window.FaceRollFirebase.readCollectionDocs('courses'),
        window.FaceRollFirebase.readCollectionDocs('sessions'),
        window.FaceRollFirebase.readCollectionDocs('attendance'),
      ]);
    }

    const seededMissingUserCount = await seedMissingUsersFromAttendance(users, attendance);
    if (seededMissingUserCount) {
      users = await window.FaceRollFirebase.readCollectionDocs('users');
    }

    setStatus(
      'Firestore seed complete. Added ' +
        (seededUsersCount + seededLinkedCount + seededMissingUserCount) +
        ' documents.'
    );

    return { users, courses, sessions, attendance };
  }

  function findSampleStudent(referenceValue) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi || !referenceValue) {
      return null;
    }

    return sampleDataApi.getStudentByAnyId(String(referenceValue));
  }

  function getGeneratedSampleStudent(attendance, fallbackKey) {
    const sampleDataApi = getSampleDataApi();
    if (!sampleDataApi) {
      return null;
    }

    const assignmentKey =
      String(fallbackKey || attendance.id || getFirstDefined(attendance, ['studentId', 'student_id', 'userId']) || '');

    if (!assignmentKey) {
      return null;
    }

    if (generatedSampleAssignments.has(assignmentKey)) {
      return generatedSampleAssignments.get(assignmentKey);
    }

    const sampleStudents = sampleDataApi.getSampleStudents();
    const assignedStudent = sampleStudents[generatedSampleAssignments.size % sampleStudents.length] || null;

    if (assignedStudent) {
      generatedSampleAssignments.set(assignmentKey, assignedStudent);
    }

    return assignedStudent;
  }

  function buildCourseMap(courses) {
    return new Map(courses.map((course) => [course.id, course]));
  }

  function buildSessionMap(sessions) {
    return new Map(sessions.map((session) => [session.id, session]));
  }

  function getUserDisplayName(user) {
    if (!user) {
      return 'Unknown Student';
    }

    const directName = getFirstDefined(user, ['name', 'fullName', 'displayName']);
    if (directName) {
      return String(directName);
    }

    const firstName = getFirstDefined(user, ['fname', 'firstName', 'first_name']);
    const lastName = getFirstDefined(user, ['lname', 'lastName', 'last_name']);
    const joinedName = [firstName, lastName].filter(Boolean).join(' ').trim();

    if (joinedName) {
      return joinedName;
    }

    return 'Unknown Student';
  }

  function getUserStudentId(user, fallbackId) {
    const studentId =
      getFirstDefined(user, ['studentId', 'student_id', 'universityId', 'schoolId', 'userId']) || user?.id;
    return studentId ? String(studentId) : String(fallbackId || 'N/A');
  }

  function updateInstructorProfileCard(users) {
    const instructorUser =
      users.find((user) => String(user.id || '') === 'instructor001') ||
      users.find((user) => String(getFirstDefined(user, ['role', 'userType']) || '').toLowerCase() === 'instructor');

    if (!instructorUser) {
      return;
    }

    const firstName = getFirstDefined(instructorUser, ['fname', 'firstName', 'first_name']);
    const lastName = getFirstDefined(instructorUser, ['lname', 'lastName', 'last_name']);
    const displayName =
      getFirstDefined(instructorUser, ['name', 'fullName', 'displayName']) ||
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      'Instructor';
    const roleLabel = getFirstDefined(instructorUser, ['role', 'userType']) || 'Instructor';

    if (sidebarProfileName) {
      sidebarProfileName.textContent = String(displayName);
    }

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
    const userMaps = buildUserMaps(users);
    const courseMap = buildCourseMap(courses);
    const sessionMap = buildSessionMap(sessions);
    generatedSampleAssignments = new Map();

    // Normalize mixed Firestore documents into the fixed table shape the current UI expects.
    return attendanceDocs.map((attendance) => {
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
      const sampleStudent =
        user ||
        findSampleStudent(studentIdRef) ||
        findSampleStudent(userRef) ||
        findSampleStudent(attendance.id) ||
        getGeneratedSampleStudent(attendance, studentIdRef || userRef || attendance.id);
      const resolvedUser = user || sampleStudent || undefined;

      return {
        attendanceId: attendance.id,
        studentName: getUserDisplayName(resolvedUser),
        studentId: getUserStudentId(resolvedUser, studentIdRef || userRef || attendance.id),
        dateValue: getAttendanceDate(attendance, session),
        dateText: formatDateForDisplay(getAttendanceDate(attendance, session)),
        status: normalizeStatus(getFirstDefined(attendance, ['status', 'attendanceStatus'])),
        notes: String(
          getFirstDefined(attendance, ['method', 'notes', 'comment', 'remarks']) ||
            getFirstDefined(session, ['notes']) ||
            ''
        ),
        courseName: String(getFirstDefined(course, ['courseName', 'name', 'title', 'code']) || ''),
      };
    }).sort((left, right) => {
      const leftDate = toDate(left.dateValue);
      const rightDate = toDate(right.dateValue);

      if (leftDate && rightDate) {
        return rightDate - leftDate;
      }

      if (leftDate) {
        return -1;
      }

      if (rightDate) {
        return 1;
      }

      return left.studentName.localeCompare(right.studentName);
    });
  }

  function renderMessageRow(message) {
    tbody.innerHTML = '';

    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'cell-notes';
    cell.textContent = message;
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function getBadgeClass(status) {
    const normalized = status.toLowerCase();

    if (normalized === 'present') {
      return 'status-present';
    }

    if (normalized === 'absent') {
      return 'status-absent';
    }

    if (normalized === 'late') {
      return 'status-late';
    }

    return '';
  }

  function renderRows(rows) {
    tbody.innerHTML = '';

    if (!rows.length) {
      renderMessageRow('No attendance records match the current filters.');
      return;
    }

    rows.forEach((rowData) => {
      const row = document.createElement('tr');
      row.innerHTML = [
        '<td class="cell-name"></td>',
        '<td class="cell-id"></td>',
        '<td class="cell-date"></td>',
        '<td class="cell-status"><span class="status-badge"></span></td>',
        '<td class="cell-notes"></td>',
      ].join('');

      row.children[0].textContent = rowData.studentName;
      row.children[1].textContent = rowData.studentId;
      row.children[2].textContent = rowData.dateText;
      row.children[3].firstElementChild.textContent = rowData.status;
      const badgeClass = getBadgeClass(rowData.status);
      if (badgeClass) {
        row.children[3].firstElementChild.classList.add(badgeClass);
      }
      row.children[4].textContent = rowData.notes || 'No notes';

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
    if (!prevPageBtn || !nextPageBtn) {
      return;
    }

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
    const query = (searchInput.value || '').trim().toLowerCase();
    const statusValue = statusFilter.value;
    const fromValue = dateFrom.value;
    const toValue = dateTo.value;
    const rowDate = toDate(rowData.dateValue);

    if (query) {
      const nameMatches = rowData.studentName.toLowerCase().includes(query);
      const idMatches = rowData.studentId.toLowerCase().includes(query);
      if (!nameMatches && !idMatches) {
        return false;
      }
    }

    if (statusValue && rowData.status !== statusValue) {
      return false;
    }

    if (fromValue && rowDate && formatDateForInput(rowDate) < fromValue) {
      return false;
    }

    if (toValue && rowDate && formatDateForInput(rowDate) > toValue) {
      return false;
    }

    return true;
  }

  function applyFiltersNow() {
    visibleAttendanceRows = allAttendanceRows.filter(passesFilters);
    currentPage = 1;
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
  }

  function clearFiltersNow() {
    dateFrom.value = '';
    dateTo.value = '';
    statusFilter.value = '';
    searchInput.value = '';
    applyFiltersNow();
  }

  function exportVisibleToCSV() {
    const headers = ['Student Name', 'Student ID', 'Date', 'Status', 'Notes'];
    const csvRows = visibleAttendanceRows.map((row) => [
      row.studentName,
      row.studentId,
      row.dateText,
      row.status,
      row.notes || '',
    ]);
    const csv = [headers]
      .concat(csvRows)
      .map((csvRow) => csvRow.map((value) => '"' + String(value).replace(/"/g, '""') + '"').join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);

    anchor.href = url;
    anchor.download = 'attendance_' + stamp + '.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function goToPreviousPage() {
    if (currentPage <= 1) {
      return;
    }

    currentPage -= 1;
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
  }

  function goToNextPage() {
    if (currentPage >= getTotalPages()) {
      return;
    }

    currentPage += 1;
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
  }

  function updateSummaryCards(users, attendanceRows) {
    const studentUsers = users.filter((user) => {
      const role = String(getFirstDefined(user, ['role', 'userType']) || '').toLowerCase();
      return role === 'student';
    });

    statTotal.textContent = String(studentUsers.length || users.length);

    const datedRows = attendanceRows.filter((row) => toDate(row.dateValue));
    if (!datedRows.length) {
      statPresent.textContent = '0';
      statAbsent.textContent = '0';
      return;
    }

    // For this prototype, the "today" cards use the most recent attendance date found in Firestore.
    const latestDate = formatDateForInput(toDate(datedRows[0].dateValue));
    const latestRows = datedRows.filter((row) => {
      const rowDate = toDate(row.dateValue);
      return rowDate && formatDateForInput(rowDate) === latestDate;
    });

    const presentCount = latestRows.filter((row) => row.status === 'Present').length;
    const absentCount = latestRows.filter((row) => row.status === 'Absent').length;

    statPresent.textContent = String(presentCount);
    statAbsent.textContent = String(absentCount);
  }

  async function loadDashboardData() {
    renderMessageRow('Loading attendance records from Firestore...');
    setStatus('Loading Firestore data...');

    // Load the existing collections together so we can resolve user/session/course references in one pass.
    const [users, courses, sessions, attendance] = await Promise.all([
      window.FaceRollFirebase.readCollectionDocs('users'),
      window.FaceRollFirebase.readCollectionDocs('courses'),
      window.FaceRollFirebase.readCollectionDocs('sessions'),
      window.FaceRollFirebase.readCollectionDocs('attendance'),
    ]);

    allAttendanceRows = buildAttendanceRows(attendance, users, courses, sessions);
    if (!allAttendanceRows.length) {
      const sampleDataApi = getSampleDataApi();
      allAttendanceRows = sampleDataApi ? sampleDataApi.getAttendanceTableRows() : [];
    }
    visibleAttendanceRows = allAttendanceRows.slice();
    currentPage = 1;

    updateInstructorProfileCard(users);
    updateSummaryCards(users, allAttendanceRows);
    renderRows(getPagedRows());
    updateTableCount();
    updatePaginationControls();
    setStatus('Firestore data loaded successfully. Sample data will only be added when you click Seed Firestore Data.');
  }

  applyBtn.addEventListener('click', applyFiltersNow);
  clearBtn.addEventListener('click', clearFiltersNow);
  exportBtn.addEventListener('click', exportVisibleToCSV);
  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', goToPreviousPage);
  }
  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', goToNextPage);
  }
  if (seedBtn) {
    seedBtn.addEventListener('click', async () => {
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

  loadDashboardData().catch((error) => {
    console.error('Failed to load dashboard data:', error);
    setStatus('Firestore load failed: ' + (error && error.message ? error.message : 'Unknown error'), true);
    const sampleDataApi = getSampleDataApi();
    if (sampleDataApi) {
      const sampleStudents = sampleDataApi.getSampleStudents();
      allAttendanceRows = sampleDataApi.getAttendanceTableRows();
      visibleAttendanceRows = allAttendanceRows.slice();
      currentPage = 1;
      updateInstructorProfileCard([
        {
          id: 'instructor001',
          fname: 'John',
          lname: 'Smith',
          role: 'instructor',
        },
      ]);
      updateSummaryCards(sampleStudents, allAttendanceRows);
      renderRows(getPagedRows());
      updateTableCount();
      updatePaginationControls();
      return;
    }

    renderMessageRow('Unable to load Firestore data. Check Firebase Hosting auto-init and your Firestore collection fields.');
    tableCount.textContent = 'Showing 0 of 0';
    updatePaginationControls();
    statTotal.textContent = '0';
    statPresent.textContent = '0';
    statAbsent.textContent = '0';
  });
})();
