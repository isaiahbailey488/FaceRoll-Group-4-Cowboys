(function (global) {
  const students = [
    {
      id: 'student001',
      studentId: 'student001',
      name: 'Daniel Perez',
      email: 'student1@test.com',
      optOutFlag: false,
      attendanceRate: 93,
      totalAbsences: 2,
      sessionsAttended: 28,
      sessionsMissed: 2,
      lateArrivals: 1,
      courses: ['Course 1030'],
    },
    {
      id: 'student002',
      studentId: 'student002',
      name: 'Maria Lopez',
      email: 'student2@test.com',
      optOutFlag: true,
      attendanceRate: 80,
      totalAbsences: 6,
      sessionsAttended: 24,
      sessionsMissed: 6,
      lateArrivals: 2,
      courses: ['Course 1030'],
    },
    {
      id: 'student003',
      studentId: 'student003',
      name: 'Aisha Khan',
      email: 'student3@test.com',
      optOutFlag: false,
      attendanceRate: 97,
      totalAbsences: 1,
      sessionsAttended: 29,
      sessionsMissed: 1,
      lateArrivals: 3,
      courses: ['Course 1030'],
    },
    {
      id: 'student004',
      studentId: 'student004',
      name: 'Marco Ruiz',
      email: 'student4@test.com',
      optOutFlag: false,
      attendanceRate: 87,
      totalAbsences: 4,
      sessionsAttended: 26,
      sessionsMissed: 4,
      lateArrivals: 1,
      courses: ['Course 1030'],
    },
    {
      id: 'student005',
      studentId: 'student005',
      name: 'Liu Wei',
      email: 'student5@test.com',
      optOutFlag: false,
      attendanceRate: 100,
      totalAbsences: 0,
      sessionsAttended: 30,
      sessionsMissed: 0,
      lateArrivals: 0,
      courses: ['Course 1030'],
    },
    {
      id: 'student006',
      studentId: 'student006',
      name: 'Emma Wilson',
      email: 'student6@test.com',
      optOutFlag: false,
      attendanceRate: 90,
      totalAbsences: 3,
      sessionsAttended: 27,
      sessionsMissed: 3,
      lateArrivals: 2,
      courses: ['Course 1030'],
    },
    {
      id: 'student007',
      studentId: 'student007',
      name: 'Noah Brown',
      email: 'student7@test.com',
      optOutFlag: false,
      attendanceRate: 76,
      totalAbsences: 7,
      sessionsAttended: 23,
      sessionsMissed: 7,
      lateArrivals: 1,
      courses: ['Course 1030'],
    },
  ];

  const attendanceHistory = {
    student001: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Present', recordedTime: '09:01 AM' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Present', recordedTime: '09:00 AM' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Late', recordedTime: '09:07 AM' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Present', recordedTime: '09:02 AM' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
    ],
    student002: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Late', recordedTime: '09:08 AM' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Present', recordedTime: '09:03 AM' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Present', recordedTime: '09:04 AM' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
    ],
    student003: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Present', recordedTime: '08:58 AM' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Late', recordedTime: '09:06 AM' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Late', recordedTime: '09:07 AM' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Present', recordedTime: '09:00 AM' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Present', recordedTime: '09:01 AM' },
    ],
    student004: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Present', recordedTime: '09:03 AM' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Present', recordedTime: '09:03 AM' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Late', recordedTime: '09:09 AM' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Present', recordedTime: '09:01 AM' },
    ],
    student005: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Present', recordedTime: '09:00 AM' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Present', recordedTime: '09:01 AM' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Present', recordedTime: '09:02 AM' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Present', recordedTime: '08:59 AM' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Present', recordedTime: '09:00 AM' },
    ],
    student006: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Late', recordedTime: '09:10 AM' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Present', recordedTime: '09:02 AM' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Present', recordedTime: '09:03 AM' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Present', recordedTime: '09:01 AM' },
    ],
    student007: [
      { date: '2026-03-07', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
      { date: '2026-03-05', course: 'Course 1030', status: 'Present', recordedTime: '09:04 AM' },
      { date: '2026-03-03', course: 'Course 1030', status: 'Absent', recordedTime: 'N/A' },
      { date: '2026-02-28', course: 'Course 1030', status: 'Late', recordedTime: '09:11 AM' },
      { date: '2026-02-26', course: 'Course 1030', status: 'Present', recordedTime: '09:05 AM' },
    ],
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getSampleCourses() {
    return clone([
      {
        id: 'course1030',
        courseId: 'course1030',
        courseName: 'Course 1030',
        instructorId: 'instructor001',
      },
    ]);
  }

  function getSampleSessions() {
    return clone([
      {
        id: 'session0307',
        sessionId: 'session0307',
        courseId: 'course1030',
        startTime: '2026-03-07T09:00:00.000Z',
        gracePeriodMinutes: 10,
      },
      {
        id: 'session0305',
        sessionId: 'session0305',
        courseId: 'course1030',
        startTime: '2026-03-05T09:00:00.000Z',
        gracePeriodMinutes: 10,
      },
      {
        id: 'session0303',
        sessionId: 'session0303',
        courseId: 'course1030',
        startTime: '2026-03-03T09:00:00.000Z',
        gracePeriodMinutes: 10,
      },
      {
        id: 'session0228',
        sessionId: 'session0228',
        courseId: 'course1030',
        startTime: '2026-02-28T09:00:00.000Z',
        gracePeriodMinutes: 10,
      },
      {
        id: 'session0226',
        sessionId: 'session0226',
        courseId: 'course1030',
        startTime: '2026-02-26T09:00:00.000Z',
        gracePeriodMinutes: 10,
      },
    ]);
  }

  function getSampleAttendanceDocs() {
    const sessionMap = {
      '2026-03-07': 'session0307',
      '2026-03-05': 'session0305',
      '2026-03-03': 'session0303',
      '2026-02-28': 'session0228',
      '2026-02-26': 'session0226',
    };

    return getSampleStudents().flatMap((student) =>
      getAttendanceHistory(student.studentId).map((entry) => ({
        id: student.studentId + '_' + entry.date.replace(/-/g, ''),
        sessionId: sessionMap[entry.date],
        uid: student.id,
        status: entry.status.toLowerCase(),
        time: entry.recordedTime === 'N/A' ? entry.date + 'T09:00:00.000Z' : entry.date + 'T09:00:00.000Z',
        method:
          entry.status === 'Present'
            ? 'face recognition'
            : entry.status === 'Late'
              ? 'manual late check'
              : 'manual absence mark',
      }))
    );
  }

  function getSampleStudents() {
    return clone(students);
  }

  function getStudentByStudentId(studentId) {
    return clone(students.find((student) => student.studentId === studentId) || students[0]);
  }

  function getStudentByAnyId(idOrStudentId) {
    return clone(
      students.find((student) => student.studentId === idOrStudentId || student.id === idOrStudentId) || null
    );
  }

  function getAttendanceHistory(studentId) {
    return clone(attendanceHistory[studentId] || attendanceHistory.student001);
  }

  function getAttendanceTableRows() {
    return getSampleStudents().flatMap((student) =>
      getAttendanceHistory(student.studentId).map((entry) => ({
        attendanceId: student.studentId + '-' + entry.date,
        studentName: student.name,
        studentId: student.studentId,
        dateValue: entry.date,
        dateText: entry.date,
        status: entry.status,
        notes:
          entry.status === 'Present'
            ? 'On time'
            : entry.status === 'Late'
              ? 'Minor delay'
              : 'Follow up required',
        courseName: entry.course,
      }))
    );
  }

  function getLiveSessionRows() {
    return getSampleStudents().map((student, index) => {
      const latestEntry = getAttendanceHistory(student.studentId)[0];

      return {
        studentName: student.name,
        course: latestEntry.course,
        status: latestEntry.status,
        recordedTime:
          latestEntry.recordedTime === 'N/A'
            ? 'N/A'
            : ['09:01 AM', '09:07 AM', '09:00 AM', '09:03 AM', '09:02 AM', '09:10 AM', 'N/A'][index] || latestEntry.recordedTime,
      };
    });
  }

  function getReportRows() {
    return getSampleStudents().map((student) => ({
      studentName: student.name,
      course: student.courses[0],
      sessionsAttended: student.sessionsAttended,
      sessionsMissed: student.sessionsMissed,
      lateArrivals: student.lateArrivals,
      attendanceRate: student.attendanceRate + '%',
    }));
  }

  global.FaceRollSampleData = {
    getSampleStudents,
    getSampleCourses,
    getSampleSessions,
    getSampleAttendanceDocs,
    getStudentByStudentId,
    getStudentByAnyId,
    getAttendanceHistory,
    getAttendanceTableRows,
    getLiveSessionRows,
    getReportRows,
  };
})(window);
