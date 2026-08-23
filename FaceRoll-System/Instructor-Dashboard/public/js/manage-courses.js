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
    if (!listEl) return;

    const api = window.FaceRollFirebase;
    if (!api) {
      listEl.innerHTML = '<span class="chip">Firestore unavailable (sample mode)</span>';
      return;
    }

    try {
      const courses = await api.readCollectionDocs('courses');
      if (!courses.length) {
        listEl.innerHTML = '<span class="chip">No courses yet — add one above.</span>';
        return;
      }
      listEl.innerHTML = '';
      courses.forEach((c) => {
        const courseId = String(c.courseId || c.id || '');
        const courseName = String(c.courseName || c.name || courseId);
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = '<strong></strong> <span class="chip-id"></span>';
        chip.children[0].textContent = courseName;
        chip.children[1].textContent = courseId;
        listEl.appendChild(chip);
      });
    } catch (err) {
      console.error('Failed to load course list:', err);
      listEl.innerHTML = '<span class="chip" style="color:#dc2626">Unable to load courses</span>';
    }
  }

  async function addCourse(courseId, courseName, instructorId) {
    const api = window.FaceRollFirebase;
    if (!api) throw new Error('Firebase not available.');

    const docId = String(courseId).trim();
    if (!docId) throw new Error('Course ID is required.');

    const payload = {
      courseId: docId,
      id: docId,
      courseName: String(courseName || docId).trim(),
      instructorId: String(instructorId || '').trim() || 'instructor-demo',
      createdAt: new Date().toISOString(),
    };

    await api.writeDocument('courses', docId, payload);
    return payload;
  }

  async function seedSampleCourses() {
    const api = window.FaceRollFirebase;
    if (!api) throw new Error('Firebase not available.');

    for (const course of SAMPLE_COURSES) {
      await api.writeDocument('courses', course.courseId, {
        ...course,
        id: course.courseId,
        createdAt: new Date().toISOString(),
      });
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
    const instructorInput = $('newCourseInstructor');

    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const courseId = (idInput && idInput.value) || '';
        const courseName = (nameInput && nameInput.value) || '';
        const instructorId = (instructorInput && instructorInput.value) || '';

        if (!courseId.trim()) {
          setStatus('Course ID is required.', 'error');
          if (idInput) idInput.focus();
          return;
        }

        addBtn.disabled = true;
        setStatus('Adding course...', '');
        try {
          const created = await addCourse(courseId, courseName, instructorId);
          setStatus('Added course: ' + created.courseName + ' (' + created.courseId + ')', 'success');
          if (idInput) idInput.value = '';
          if (nameInput) nameInput.value = '';
          if (instructorInput) instructorInput.value = '';
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

    loadCourseList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUp);
  } else {
    wireUp();
  }
})();
