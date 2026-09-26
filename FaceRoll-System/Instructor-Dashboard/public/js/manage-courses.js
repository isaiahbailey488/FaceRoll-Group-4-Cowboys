(function () {
  'use strict';

  const SAMPLE_COURSES = [
    { courseId: 'CSCE4905', courseName: 'Capstone I', instructorId: 'instructor-demo' },
    { courseId: 'CSCE3010', courseName: 'Data Structures', instructorId: 'instructor-demo' },
    { courseId: 'CSCE4110', courseName: 'Algorithms', instructorId: 'instructor-demo' },
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, kind) {
    const el = $('manageCoursesStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'manage-courses-status' + (kind ? ' ' + kind : '');
  }

  function broadcastCoursesUpdated() {
    try {
      window.dispatchEvent(new CustomEvent('faceroll:courses-updated'));
    } catch (err) {
      console.warn('Unable to broadcast courses update:', err);
    }
  }

  async function loadCourseList() {
    const listEl = $('manageCoursesList');
    const panel = $('manageCoursesPanel');
    if (!listEl || !panel) return;

    const api = window.FaceRollFirebase;
    if (!api) {
      listEl.textContent = 'Firestore unavailable (sample mode)';
      return;
    }

    try {
      const [courses, user] = await Promise.all([
        api.readCollectionDocs('courses'),
        api.waitForAuthUser(),
      ]);
      if (!user) throw new Error('Sign in to view your courses.');

      const ownedCourses = courses.filter((course) => course.instructorId === user.uid);
      if (!ownedCourses.length) {
        listEl.textContent = 'No courses yet. Add one above.';
        return;
      }

      listEl.replaceChildren();
      ownedCourses.forEach((course) => {
        const courseId = String(course.courseId || course.id || '');
        const courseName = String(course.courseName || course.name || courseId);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(courseId)) return;

        const row = document.createElement('div');
        row.className = 'course-list-item';

        const details = document.createElement('span');
        details.className = 'course-list-details';
        const name = document.createElement('strong');
        name.textContent = courseName;
        const id = document.createElement('span');
        id.className = 'chip-id';
        id.textContent = courseId;
        details.append(name, id);

        const inviteButton = document.createElement('button');
        inviteButton.type = 'button';
        inviteButton.className = 'secondary-button';
        inviteButton.textContent = 'Invite Students';
        inviteButton.addEventListener('click', () => {
          panel.close();
          window.dispatchEvent(new CustomEvent('faceroll:invite-course', {
            detail: { courseId, courseName },
          }));
        });

        row.append(details, inviteButton);
        listEl.appendChild(row);
      });
    } catch (err) {
      console.error('Failed to load course list:', err);
      listEl.textContent = 'Unable to load courses';
    }
  }

  async function addCourse(courseId, courseName) {
    const api = window.FaceRollFirebase;
    if (!api) throw new Error('Firebase not available.');

    const user = await api.waitForAuthUser();
    if (!user) throw new Error('Sign in before adding a course.');

    const docId = String(courseId).trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(docId)) throw new Error('Use letters, numbers, hyphens or underscores for the course ID.');

    const payload = {
      courseId: docId,
      id: docId,
      courseName: String(courseName || docId).trim(),
      instructorId: user.uid,
      createdAt: new Date().toISOString(),
    };

    const created = await api.createDocumentIfAbsent('courses', docId, payload);
    if (!created) throw new Error('This course ID already exists. Choose a different ID; existing ownership will not be overwritten.');
    return payload;
  }

  async function seedSampleCourses() {
    const api = window.FaceRollFirebase;
    if (!api) throw new Error('Firebase not available.');

    for (const course of SAMPLE_COURSES) {
      await addCourse(course.courseId, course.courseName);
    }
    return SAMPLE_COURSES.length;
  }

  function wireUp() {
    const panel = $('manageCoursesPanel');
    if (!panel) return;

    const addBtn = $('addCourseBtn');
    const seedBtn = $('seedCoursesBtn');
    const idInput = $('newCourseId');
    const nameInput = $('newCourseName');

    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const courseId = (idInput && idInput.value) || '';
        const courseName = (nameInput && nameInput.value) || '';

        if (!courseId.trim()) {
          setStatus('Course ID is required.', 'error');
          if (idInput) idInput.focus();
          return;
        }

        addBtn.disabled = true;
        setStatus('Adding course...', '');
        try {
          const created = await addCourse(courseId, courseName);
          setStatus('Added course: ' + created.courseName + ' (' + created.courseId + ')', 'success');
          if (idInput) idInput.value = '';
          if (nameInput) nameInput.value = '';
          await loadCourseList();
          broadcastCoursesUpdated();
        } catch (err) {
          console.error('Add course failed:', err);
          setStatus('Failed to add course: ' + (err && err.message ? err.message : err), 'error');
        } finally {
          addBtn.disabled = false;
        }
      });
    }

    if (seedBtn) {
      seedBtn.addEventListener('click', async () => {
        seedBtn.disabled = true;
        setStatus('Seeding sample courses...', '');
        try {
          const n = await seedSampleCourses();
          setStatus('Seeded ' + n + ' sample courses.', 'success');
          await loadCourseList();
          broadcastCoursesUpdated();
        } catch (err) {
          console.error('Seed courses failed:', err);
          setStatus('Failed to seed courses: ' + (err && err.message ? err.message : err), 'error');
        } finally {
          seedBtn.disabled = false;
        }
      });
    }

    window.addEventListener('faceroll:courses-updated', loadCourseList);
    loadCourseList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUp);
  } else {
    wireUp();
  }
})();
