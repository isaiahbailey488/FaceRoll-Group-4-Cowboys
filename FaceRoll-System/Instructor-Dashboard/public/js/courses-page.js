(function () {
  'use strict';

  const toggle = document.getElementById('toggleCreateCourse');
  const panel = document.getElementById('manageCoursesPanel');
  const closeButton = document.getElementById('closeCreateCourse');
  if (!toggle || !panel || !closeButton) return;

  toggle.addEventListener('click', function () {
    panel.showModal();
    document.getElementById('newCourseId').focus();
  });

  closeButton.addEventListener('click', function () {
    panel.close();
  });

  panel.addEventListener('close', function () {
    toggle.focus();
  });
})();
