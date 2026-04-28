(function () {
  const sampleDataApi = window.FaceRollSampleData;
  const PROFILE_OVERRIDE_STORAGE_KEY = 'faceroll-profile-overrides';
  const firebaseApi = window.FaceRollFirebase || null;
  window.FaceRollProfileSave = null;

  if (!sampleDataApi) {
    return;
  }

  function normalizeStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();

    if (normalized === 'present') {
      return 'Present';
    }

    if (normalized === 'late') {
      return 'Late';
    }

    if (normalized === 'absent') {
      return 'Absent';
    }

    return '';
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

  function formatDateDisplay(value) {
    const date = toDate(value);
    return date ? date.toISOString().slice(0, 10) : 'N/A';
  }

  function formatTimeDisplay(value) {
    const date = toDate(value);
    if (!date) {
      return 'N/A';
    }

    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getStatusClass(status) {
    const normalized = String(status || '').toLowerCase();

    if (normalized === 'present') {
      return 'status-present';
    }

    if (normalized === 'late') {
      return 'status-late';
    }

    if (normalized === 'absent') {
      return 'status-absent';
    }

    return '';
  }

  function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function readProfileOverrides() {
    try {
      const raw = window.localStorage.getItem(PROFILE_OVERRIDE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      return {};
    }
  }

  function writeProfileOverrides(overrides) {
    try {
      window.localStorage.setItem(PROFILE_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
    } catch (error) {
      // Ignore storage failures so the profile still works for the current session.
    }
  }

  function getStudentProfileOverrides(studentId) {
    const allOverrides = readProfileOverrides();
    return allOverrides[studentId] || {};
  }

  function saveStudentProfileOverrides(studentId, overridesByEntryKey) {
    const allOverrides = readProfileOverrides();
    allOverrides[studentId] = overridesByEntryKey;
    writeProfileOverrides(allOverrides);
  }

  function buildHistoryEntryKey(entry) {
    return [entry.date, entry.course, entry.recordedTime].join('|');
  }

  function applyOverridesToHistory(studentId, history) {
    const overridesByEntryKey = getStudentProfileOverrides(studentId);

    return history.map((entry) => {
      const entryKey = buildHistoryEntryKey(entry);
      const overrideStatus = normalizeStatus(overridesByEntryKey[entryKey]);

      return {
        date: entry.date,
        course: entry.course,
        status: overrideStatus || normalizeStatus(entry.status),
        recordedTime: entry.recordedTime,
        entryKey: entryKey,
      };
    });
  }

  function buildProfileSummary(history) {
    const totalSessions = history.length;
    const sessionsAttended = history.filter((entry) => entry.status === 'Present').length;
    const lateArrivals = history.filter((entry) => entry.status === 'Late').length;
    const totalAbsences = history.filter((entry) => entry.status === 'Absent').length;
    const attendanceRate = totalSessions === 0 ? 0 : Math.round(((sessionsAttended + lateArrivals) / totalSessions) * 100);

    return {
      attendanceRate: attendanceRate,
      sessionsAttended: sessionsAttended,
      lateArrivals: lateArrivals,
      totalAbsences: totalAbsences,
    };
  }

  function applyStatusBadge(statusElement, status) {
    statusElement.textContent = status;
    statusElement.classList.remove('status-present', 'status-late', 'status-absent');

    const statusClass = getStatusClass(status);
    if (statusClass) {
      statusElement.classList.add(statusClass);
    }
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

    return joinedName || 'Unknown Student';
  }

  function getUserEmail(user, fallbackStudent) {
    return (
      getFirstDefined(user, ['email']) ||
      getFirstDefined(fallbackStudent, ['email']) ||
      'N/A'
    );
  }

  function updateProfileSummary(summary) {
    document.getElementById('iaj9kju').textContent = summary.attendanceRate + '%';
    document.getElementById('iwzjofv').textContent = String(summary.sessionsAttended);
    document.getElementById('ip95okd').textContent = String(summary.lateArrivals);
    document.getElementById('iq9g6ym').textContent = String(summary.totalAbsences);
  }

  function setProfileSaveStatus(message, isError) {
    const statusElement = document.getElementById('profileSaveStatus');
    if (!statusElement) {
      return;
    }

    statusElement.textContent = message;
    statusElement.style.color = isError ? '#b91c1c' : '#475569';
  }

  function renderProfileHistoryRows(historyBody, history) {
    historyBody.innerHTML = '';

    history.forEach((entry) => {
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
      row.dataset.entryKey = entry.entryKey;
      row.dataset.documentId = entry.documentId || '';
      applyStatusBadge(row.children[2].firstElementChild, entry.status);
      row.children[3].textContent = entry.recordedTime;
      row.children[4].firstElementChild.value = 'No Change';

      historyBody.appendChild(row);
    });
  }

  async function loadProfileDataFromFirestore(requestedStudentId) {
    if (!firebaseApi) {
      return null;
    }

    const [users, courses, sessions, attendance] = await Promise.all([
      firebaseApi.readCollectionDocs('users'),
      firebaseApi.readCollectionDocs('courses'),
      firebaseApi.readCollectionDocs('sessions'),
      firebaseApi.readCollectionDocs('attendance'),
    ]);

    const studentUser =
      users.find((user) => String(user.id || '') === String(requestedStudentId)) ||
      users.find((user) => String(getFirstDefined(user, ['studentId', 'userId', 'uid']) || '') === String(requestedStudentId)) ||
      null;

    if (!studentUser) {
      return null;
    }

    const studentKeys = new Set(
      [
        studentUser.id,
        getFirstDefined(studentUser, ['studentId', 'userId', 'uid']),
      ]
        .filter(Boolean)
        .map((value) => String(value))
    );

    const courseMap = new Map(courses.map((course) => [String(course.id), course]));
    const sessionMap = new Map(sessions.map((session) => [String(session.id), session]));
    const studentAttendance = attendance.filter((entry) => {
      const uid = getFirstDefined(entry, ['uid', 'userId']);
      return uid && studentKeys.has(String(uid));
    });

    const history = studentAttendance
      .map((entry) => {
        const session = sessionMap.get(String(getFirstDefined(entry, ['sessionId']) || ''));
        const course = session ? courseMap.get(String(getFirstDefined(session, ['courseId']) || '')) : null;
        const entryDate = getFirstDefined(entry, ['time']) || getFirstDefined(session, ['startTime']);
        const recordedTimeValue = getFirstDefined(entry, ['time']);
        const recordedTime =
          normalizeStatus(getFirstDefined(entry, ['status'])) === 'Absent'
            ? 'N/A'
            : formatTimeDisplay(recordedTimeValue || entryDate);

        return {
          documentId: entry.id,
          date: formatDateDisplay(entryDate),
          course: String(getFirstDefined(course, ['courseName', 'name', 'title']) || 'Unknown Course'),
          status: normalizeStatus(getFirstDefined(entry, ['status'])),
          recordedTime: recordedTime,
          entryKey: String(entry.id),
        };
      })
      .sort((left, right) => String(right.date).localeCompare(String(left.date)));

    const fallbackStudent = sampleDataApi ? sampleDataApi.getStudentByAnyId(requestedStudentId) : null;
    const derivedCourses = Array.from(new Set(history.map((entry) => entry.course).filter(Boolean)));

    return {
      student: {
        studentId: String(getFirstDefined(studentUser, ['studentId']) || studentUser.id || requestedStudentId),
        name: getUserDisplayName(studentUser),
        email: getUserEmail(studentUser, fallbackStudent),
        courses: derivedCourses.length ? derivedCourses : (fallbackStudent ? fallbackStudent.courses : ['Unknown Course']),
      },
      history: history,
    };
  }

  function buildFallbackProfileData(requestedStudentId) {
    const student = sampleDataApi.getStudentByStudentId(requestedStudentId);
    return {
      student: student,
      history: applyOverridesToHistory(student.studentId, sampleDataApi.getAttendanceHistory(student.studentId)),
      source: 'sample',
    };
  }

  function renderRosterPage() {
    const tbody = document.getElementById('rosterTbody');
    const courseFilter = document.getElementById('rosterCourseFilter');
    const searchInput = document.getElementById('rosterSearchInput');

    if (!tbody) {
      return;
    }

    const students = sampleDataApi.getSampleStudents();

    function renderRows() {
      const search = String(searchInput.value || '').trim().toLowerCase();
      const course = String(courseFilter.value || '').trim();
      const filteredStudents = students.filter((student) => {
        const matchesSearch =
          !search ||
          student.name.toLowerCase().includes(search) ||
          student.studentId.toLowerCase().includes(search);
        const matchesCourse = !course || student.courses.includes(course);
        return matchesSearch && matchesCourse;
      });

      tbody.innerHTML = '';

      filteredStudents.forEach((student) => {
        const row = document.createElement('tr');
        row.innerHTML = [
          '<td></td>',
          '<td></td>',
          '<td></td>',
          '<td></td>',
          '<td></td>',
          '<td><a class="student-action-link">View Profile</a></td>',
        ].join('');

        row.children[0].textContent = student.name;
        row.children[1].textContent = student.studentId;
        row.children[2].textContent = student.email;
        row.children[3].textContent = student.attendanceRate + '%';
        row.children[4].textContent = String(student.totalAbsences);
        row.children[5].firstElementChild.href = './student-profile.html?studentId=' + encodeURIComponent(student.studentId);

        tbody.appendChild(row);
      });
    }

    courseFilter.addEventListener('change', renderRows);
    searchInput.addEventListener('input', renderRows);
    renderRows();
  }

  async function renderProfilePage() {
    const params = new URLSearchParams(window.location.search);
    const requestedStudentId = params.get('studentId') || 'student001';
    const historyBody = document.getElementById('profileAttendanceBody');
    const saveButton = document.getElementById('profileSaveButton') || document.querySelector('#i3wlx77 .gjs-t-button');

    if (!historyBody) {
      return;
    }

    historyBody.innerHTML = '<tr><td colspan="5">Loading student profile...</td></tr>';
    setProfileSaveStatus('Loading attendance history...');

    let profileData;
    let dataSource = 'firestore';

    try {
      profileData = await loadProfileDataFromFirestore(requestedStudentId);
    } catch (error) {
      console.error('Failed to load student profile from Firestore:', error);
      profileData = null;
    }

    if (!profileData) {
      profileData = buildFallbackProfileData(requestedStudentId);
      dataSource = 'sample';
    }

    const student = profileData.student;
    let history = profileData.history;

    document.getElementById('ix63k7g').textContent = student.name;
    document.getElementById('iobn7gg').textContent = student.courses.join(', ');
    document.getElementById('inpdknn').textContent = student.email;
    const initialSummary = buildProfileSummary(history);
    updateProfileSummary(initialSummary);
    renderProfileHistoryRows(historyBody, history);
    setProfileSaveStatus(
      dataSource === 'firestore'
        ? 'Connected to Firestore. Select a new status and click Save override.'
        : 'Using sample profile data. Saves will stay local until Firestore data is available.',
      false
    );

    if (!saveButton) {
      return;
    }

    window.FaceRollProfileSave = async function () {
      const rows = Array.from(historyBody.querySelectorAll('tr'));
      let appliedChanges = 0;
      const writes = [];
      let sampleChanges = 0;

      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
      setProfileSaveStatus('Saving attendance override...');

      rows.forEach((row) => {
        const select = row.querySelector('select');
        const nextStatus = normalizeStatus(select && select.value);
        const entryKey = row.dataset.entryKey;
        const documentId = row.dataset.documentId;

        if (!entryKey || !select || !nextStatus) {
          return;
        }

        if (dataSource === 'firestore' && firebaseApi && documentId) {
          writes.push(
            firebaseApi.writeDocument('attendance', documentId, {
              status: nextStatus.toLowerCase(),
            })
          );
        } else {
          const overridesByEntryKey = getStudentProfileOverrides(student.studentId);
          overridesByEntryKey[entryKey] = nextStatus;
          saveStudentProfileOverrides(student.studentId, overridesByEntryKey);
          sampleChanges += 1;
        }
      });

      try {
        if (writes.length) {
          await Promise.all(writes);
          const refreshedProfileData = await loadProfileDataFromFirestore(student.studentId);
          if (refreshedProfileData) {
            history = refreshedProfileData.history;
            renderProfileHistoryRows(historyBody, history);
            updateProfileSummary(buildProfileSummary(history));
            appliedChanges = writes.length;
          }
        } else {
          const updatedHistory = applyOverridesToHistory(student.studentId, sampleDataApi.getAttendanceHistory(student.studentId));
          history = updatedHistory;
          renderProfileHistoryRows(historyBody, history);
          updateProfileSummary(buildProfileSummary(history));
          appliedChanges = sampleChanges;
        }

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
        setProfileSaveStatus(
          'Save failed: ' + (error && error.message ? error.message : 'Unknown error'),
          true
        );
      } finally {
        saveButton.disabled = false;
        window.setTimeout(function () {
          saveButton.textContent = 'Save override';
        }, 1400);
      }
    };

    saveButton.onclick = window.FaceRollProfileSave;
  }

  function renderLiveSessionPage() {
    const tbody = document.getElementById('liveSessionTbody');
    const startButton = document.getElementById('iq6lcg');
    const durationElement = document.getElementById('impi7gl');
    const sessionDateInput = document.getElementById('liveSessionDate');
    if (!tbody) {
      return;
    }

    const sessionStatusValue =
      document.getElementById('liveSessionStatus') ||
      (Array.from(document.querySelectorAll('.filter-field .filter-label'))
        .find((label) => String(label.textContent || '').trim() === 'Session Status')
        ?.parentElement?.querySelector('span')) ||
      null;

    const rows = sampleDataApi.getLiveSessionRows();
    const recognizedCount = rows.filter((row) => row.status !== 'Absent').length;
    const lateCount = rows.filter((row) => row.status === 'Late').length;

    document.getElementById('i2ojcf').textContent = String(recognizedCount);
    document.getElementById('imevvg').textContent = String(lateCount);

    tbody.innerHTML = '';

    rows.forEach((entry) => {
      const row = document.createElement('tr');
      row.innerHTML = [
        '<td></td>',
        '<td></td>',
        '<td><span class="status-badge live-status"></span></td>',
        '<td></td>',
      ].join('');

      row.children[0].textContent = entry.studentName;
      row.children[1].textContent = entry.course;
      row.children[2].firstElementChild.textContent = entry.status;
      const statusClass = getStatusClass(entry.status);
      if (statusClass) {
        row.children[2].firstElementChild.classList.add(statusClass);
      }
      row.children[3].textContent = entry.recordedTime;

      tbody.appendChild(row);
    });

    let timerHandle = null;
    let sessionStartedAt = null;

    function setSessionStatus(statusText) {
      if (sessionStatusValue) {
        sessionStatusValue.textContent = statusText;
      }
    }

    function setStartButtonState(isStarted) {
      if (!startButton) {
        return;
      }

      startButton.textContent = isStarted ? 'Stop Session' : 'Start Session';
      startButton.disabled = false;
      startButton.style.opacity = '1';
      startButton.style.cursor = 'pointer';
    }

    function updateDurationFromStart(startedAt) {
      if (!durationElement) {
        return;
      }

      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      durationElement.textContent = formatDuration(elapsedSeconds);
    }

    function beginDurationTimer(startedAt) {
      if (timerHandle) {
        window.clearInterval(timerHandle);
      }

      updateDurationFromStart(startedAt);
      timerHandle = window.setInterval(function () {
        updateDurationFromStart(startedAt);
      }, 1000);
    }

    function stopDurationTimer() {
      if (timerHandle) {
        window.clearInterval(timerHandle);
        timerHandle = null;
      }
    }

    if (sessionDateInput && !sessionDateInput.value) {
      sessionDateInput.value = new Date().toISOString().slice(0, 10);
    }

    // The live session should only exist for the current page instance.
    setSessionStatus('Not Started');
    stopDurationTimer();
    if (durationElement) {
      durationElement.textContent = '00:00';
    }
    setStartButtonState(false);

    if (startButton) {
      startButton.addEventListener('click', function () {
        if (sessionStartedAt !== null) {
          sessionStartedAt = null;
          setSessionStatus('Not Started');
          setStartButtonState(false);
          stopDurationTimer();
          if (durationElement) {
            durationElement.textContent = '00:00';
          }
          return;
        }

        const startedAt = Date.now();
        sessionStartedAt = startedAt;
        setSessionStatus('Started');
        setStartButtonState(true);
        beginDurationTimer(startedAt);
      });
    }
  }

  function renderReportsPage() {
    const tbody = document.getElementById('reportsTbody');
    if (!tbody) {
      return;
    }

    const rows = sampleDataApi.getReportRows();
    const totalStudents = rows.length;
    const totalSessions = 30;
    const averageAttendance = Math.round(
      rows.reduce((sum, row) => sum + Number.parseInt(row.attendanceRate, 10), 0) / totalStudents
    );

    document.getElementById('ikkzfr').textContent = averageAttendance + '%';
    document.getElementById('i8cefo').textContent = String(totalSessions);
    document.getElementById('injzav').textContent = String(totalStudents);

    tbody.innerHTML = '';

    rows.forEach((entry) => {
      const row = document.createElement('tr');
      row.innerHTML = [
        '<td></td>',
        '<td></td>',
        '<td></td>',
        '<td></td>',
        '<td></td>',
        '<td></td>',
      ].join('');

      row.children[0].textContent = entry.studentName;
      row.children[1].textContent = entry.course;
      row.children[2].textContent = String(entry.sessionsAttended);
      row.children[3].textContent = String(entry.sessionsMissed);
      row.children[4].textContent = String(entry.lateArrivals);
      row.children[5].textContent = entry.attendanceRate;

      tbody.appendChild(row);
    });
  }

  const pageId = document.body && document.body.id;

  if (pageId === 'imwtil') {
    renderRosterPage();
  }

  if (pageId === 'idhra3g') {
    renderProfilePage();
  }

  if (pageId === 'imsyg1') {
    renderLiveSessionPage();
  }

  if (pageId === 'iw11pz') {
    renderReportsPage();
  }
})();
