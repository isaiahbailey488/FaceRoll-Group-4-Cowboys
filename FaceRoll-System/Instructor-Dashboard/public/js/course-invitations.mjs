import { toQR } from './vendor/toqr.mjs';

export async function requestInvitation(baseUrl, user, courseId, action, fetcher = fetch) {
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new Error('The recognition server is not configured. Restart the demo or configure its HTTPS address.'); }
  if (url.protocol !== 'https:' || url.origin !== baseUrl || url.username || url.password) {
    throw new Error('Configure a trusted HTTPS recognition server address.');
  }
  if (!user) throw new Error('Sign in to manage invitations.');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(courseId)) throw new Error('Select a valid course.');
  const response = await fetcher(`${baseUrl}/courses/${encodeURIComponent(courseId)}/invitations`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const result = await response.json();
  if (!response.ok) {
    const messages = { invitation_exists: 'An invitation already exists. Choose Replace QR code to generate a new one.',
      course_owner_required: 'Only the course owner can manage its invitation.',
      instructor_required: 'An instructor account is required.' };
    throw new Error(messages[result.error] || 'Invitation request failed. Check the server connection and sign-in.');
  }
  if (result.success !== true || result.courseId !== courseId) throw new Error('Unexpected invitation response.');
  return result;
}

export async function deleteOwnedCourse(baseUrl, user, courseId, fetcher = fetch) {
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new Error('The recognition server is not configured. Restart the demo.'); }
  if (url.protocol !== 'https:' || url.origin !== baseUrl || !user || !/^[A-Za-z0-9_-]{1,200}$/.test(courseId)) {
    throw new Error('Unable to delete the selected course.');
  }
  const response = await fetcher(`${baseUrl}/courses/${encodeURIComponent(courseId)}`, {
    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${await user.getIdToken()}` },
  });
  const result = await response.json();
  if (!response.ok || result.success !== true || result.courseId !== courseId) {
    throw new Error(result.error === 'course_owner_required' ? 'Only the course owner can delete it.' :
      result.error === 'active_session_exists' ? 'End the active attendance session before deleting this course.' :
      'The course could not be deleted. Try again.');
  }
  return result;
}

export function qrMatrix(payload) {
  if (!payload || payload.schemaVersion !== 1 || payload.type !== 'course-invitation' ||
      !/^[a-f0-9]{64}$/.test(payload.token)) throw new Error('Invalid QR response.');
  return toQR(JSON.stringify({ schemaVersion: 1, type: payload.type, token: payload.token }));
}

export function drawQr(canvas, payload) {
  const matrix = qrMatrix(payload);
  const size = Math.sqrt(matrix.length), scale = 6, quiet = 4;
  canvas.width = canvas.height = (size + quiet * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  matrix.forEach((dark, index) => {
    if (dark) ctx.fillRect((index % size + quiet) * scale, (Math.floor(index / size) + quiet) * scale, scale, scale);
  });
  canvas.hidden = false;
}

if (typeof document !== 'undefined') {
  const dialog = document.getElementById('inviteStudentsDialog');
  const closeButton = document.getElementById('closeInvitationDialog');
  const courseLabel = document.getElementById('invitation-course-name');
  const status = document.getElementById('invitation-status');
  const canvas = document.getElementById('invitation-qr');
  const buttons = ['create', 'replace', 'revoke'].map(a => document.getElementById(`invitation-${a}`));
  const deleteButton = document.getElementById('course-delete');
  const createCourseButton = document.getElementById('toggleCreateCourse');
  let currentCourseId = '', currentCourseName = '', generation = 0, busy = false, expiry;
  const clear = () => { generation++; canvas.hidden = true; canvas.width = canvas.width; clearTimeout(expiry); };
  const controls = () => {
    buttons.forEach(b => { b.disabled = busy || !currentCourseId; });
    deleteButton.disabled = busy || !currentCourseId;
  };
  window.addEventListener('faceroll:invite-course', (event) => {
    const courseId = String(event.detail?.courseId || '');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(courseId)) return;

    clear();
    currentCourseId = courseId;
    currentCourseName = String(event.detail?.courseName || courseId);
    courseLabel.textContent = `${currentCourseName} (${currentCourseId})`;
    status.textContent = 'Create a QR code for students to join this course.';
    controls();
    dialog.showModal();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    clear();
    currentCourseId = '';
    currentCourseName = '';
    courseLabel.textContent = 'Choose a course from Course Management.';
    status.textContent = '';
    controls();
    createCourseButton?.focus();
  });
  buttons.forEach((button, index) => button.addEventListener('click', async () => {
    const action = ['create', 'replace', 'revoke'][index];
    if (action !== 'create' && !window.confirm(`${action === 'replace' ? 'Replace' : 'Revoke'} this course invitation? Its current QR code will stop working.`)) return;
    clear(); const version = generation, courseId = currentCourseId;
    busy = true; controls(); status.textContent = 'Updating invitation...';
    try {
      const user = await window.FaceRollFirebase.getCurrentAuthUser();
      const result = await requestInvitation(window.FaceRollConfig?.RECOGNITION_API_URL || '', user, courseId, action);
      if (version !== generation) return;
      if (action === 'revoke') { status.textContent = 'Invitation revoked.'; return; }
      const remaining = Date.parse(result.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Invitation has expired. Replace the QR code.');
      drawQr(canvas, result.qrPayload);
      status.textContent = `Expires ${new Date(result.expiresAt).toLocaleString()}. Students can scan this in FaceRoll using Join a Course.`;
      expiry = setTimeout(() => { clear(); status.textContent = 'Invitation expired. Replace the QR code.'; }, Math.min(remaining, 2147483647));
    } catch (error) { if (version === generation) status.textContent = error.message || 'Unable to update invitation.'; }
    finally { busy = false; controls(); }
  }));
  deleteButton.addEventListener('click', async () => {
    const courseId = currentCourseId;
    if (!courseId || !window.confirm('Delete this course? This permanently removes its roster, sessions, attendance history, and invitations.')) return;
    clear(); busy = true; controls(); status.textContent = 'Deleting course...';
    try {
      const user = await window.FaceRollFirebase.getCurrentAuthUser();
      await deleteOwnedCourse(window.FaceRollConfig?.RECOGNITION_API_URL || '', user, courseId);
      window.dispatchEvent(new CustomEvent('faceroll:courses-updated'));
      dialog.close();
    } catch (error) { status.textContent = error.message || 'Unable to delete course.'; }
    finally { busy = false; controls(); }
  });
  controls();
}
