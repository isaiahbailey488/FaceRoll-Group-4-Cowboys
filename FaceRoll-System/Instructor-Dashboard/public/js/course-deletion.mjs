import { deleteOwnedCourse } from './course-invitations.mjs?v=20261015-students-invites-3';

export function initializeCourseDeletion(document, window, fetcher = fetch) {
  const status = document.getElementById('manageCoursesStatus');
  let busy = false;
  window.addEventListener('faceroll:delete-course', async event => {
    const { courseId, courseName, trigger } = event.detail || {};
    if (busy || !/^[A-Za-z0-9_-]{1,200}$/.test(courseId || '')) return;
    if (!window.confirm(`Delete ${courseName || courseId}? This permanently removes its roster, sessions, attendance history, and invitations.`)) return;
    busy = true;
    if (trigger) trigger.disabled = true;
    status.className = 'manage-courses-status';
    status.textContent = 'Deleting course...';
    try {
      const user = await window.FaceRollFirebase.getCurrentAuthUser();
      await deleteOwnedCourse(window.FaceRollConfig?.RECOGNITION_API_URL || '', user, courseId, fetcher);
      status.className = 'manage-courses-status success';
      status.textContent = `Deleted ${courseName || courseId}.`;
      window.dispatchEvent(new window.CustomEvent('faceroll:courses-updated'));
    } catch (error) {
      status.className = 'manage-courses-status error';
      status.textContent = error.message || 'Unable to delete course.';
    } finally {
      busy = false;
      if (trigger) trigger.disabled = false;
    }
  });
}

if (typeof document !== 'undefined' && document.getElementById('manageCoursesStatus')) {
  initializeCourseDeletion(document, window);
}
