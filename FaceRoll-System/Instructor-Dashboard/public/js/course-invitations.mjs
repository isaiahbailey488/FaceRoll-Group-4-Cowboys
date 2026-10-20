import { toQR } from './vendor/toqr.mjs';

export async function requestInvitation(baseUrl, user, courseId, action, fetcher = fetch, expiration) {
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new Error('The recognition server is not configured. Restart the demo or configure its HTTPS address.'); }
  if (url.protocol !== 'https:' || url.origin !== baseUrl || url.username || url.password) {
    throw new Error('Configure a trusted HTTPS recognition server address.');
  }
  if (!user) throw new Error('Sign in to manage invitations.');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(courseId)) throw new Error('Select a valid course.');
  const options = {
    method: action === 'view' ? 'GET' : 'POST', cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${await user.getIdToken()}` },
  };
  if (action !== 'view') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ action, ...(expiration === undefined ? {} : { expiration }) });
  }
  const response = await fetcher(`${baseUrl}/courses/${encodeURIComponent(courseId)}/invitations`, options);
  const result = await response.json();
  if (!response.ok) {
    const messages = { invitation_exists: 'An invitation already exists. Refresh to view its current QR code.',
      invitation_expired: 'This invitation has expired. Refresh and choose Renew Invitation.',
      invitation_not_expired: 'This invitation is already active. Refresh to view it.',
      invitation_not_recoverable: 'This older invitation cannot be reopened. Replace it to enable reliable reopening.',
      invitation_unavailable: 'This invitation is no longer available. Refresh its status.',
      invalid_expiration: 'Choose 2 hours, 24 hours, or Never.',
      course_owner_required: 'Only the course owner can manage its invitation.',
      instructor_required: 'An instructor account is required.' };
    const error = new Error(messages[result.error] || 'Invitation request failed. Check the server connection and sign-in.');
    error.code = result.error;
    throw error;
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

export function initializeInvitationDialog(document, window, fetcher = fetch) {
  const dialog = document.getElementById('inviteStudentsDialog');
  if (!dialog) return;
  const closeButton = document.getElementById('closeInvitationDialog');
  const courseLabel = document.getElementById('invitation-course-name');
  const status = document.getElementById('invitation-status');
  const canvas = document.getElementById('invitation-qr');
  const actions = ['create', 'replace', 'revoke', 'update_expiration', 'renew'];
  const buttons = Object.fromEntries(actions.map(a => [a, document.getElementById(`invitation-${a}`)]));
  const expirationSelect = document.getElementById('invitation-expiration');
  const refreshButton = document.getElementById('invitation-refresh');
  const inviteButton = document.getElementById('rosterInviteStudents');
  const rosterCourseFilter = document.getElementById('rosterCourseFilter');
  const courseSelect = document.getElementById('invitation-course');
  let currentCourseId = '', generation = 0, busy = false, expiry, invitation = null;
  const clear = () => { canvas.hidden = true; canvas.width = canvas.width; clearTimeout(expiry); };
  const controls = () => {
    const present = invitation && invitation.status !== 'none';
    const visible = {
      create: invitation?.status === 'none', replace: present, revoke: present,
      update_expiration: invitation?.status === 'active' && invitation.canReopen,
      renew: invitation?.status === 'expired' && invitation.canReopen,
    };
    actions.forEach(action => {
      buttons[action].hidden = !visible[action];
      buttons[action].disabled = busy || !currentCourseId || !visible[action];
    });
    expirationSelect.disabled = busy || !currentCourseId || !invitation;
    refreshButton.disabled = busy || !currentCourseId;
    if (courseSelect) courseSelect.disabled = busy || !courseSelect.options.length;
  };
  const render = result => {
    clear();
    if (!['none', 'active', 'expired'].includes(result.status)) throw new Error('Unexpected invitation status. Refresh to try again.');
    invitation = result;
    expirationSelect.value = result.expiration || '24h';
    if (result.status === 'none') {
      status.textContent = 'No active invitation. Choose an expiration and create a QR code.';
    } else {
      const expires = result.expiresAt === null ? null : Date.parse(result.expiresAt);
      if (expires !== null && !Number.isFinite(expires)) throw new Error('Unexpected invitation expiration. Refresh to try again.');
      const expired = expires !== null && expires <= Date.now();
      if (expired || result.status === 'expired') {
        invitation = { ...result, status: 'expired' };
        status.textContent = result.canReopen ?
          'Invitation expired. Renew it to reactivate the same QR code and previously shared copies.' : 'Invitation expired.';
      } else {
        status.textContent = expires === null ? 'Active — never expires. Disable it whenever you want to stop new joins.' :
          `Active — expires ${new Date(expires).toLocaleString()}.`;
        if (result.canReopen && result.qrPayload) drawQr(canvas, result.qrPayload);
        if (expires !== null) expiry = setTimeout(() => render(result), Math.min(expires - Date.now(), 2147483647));
      }
      if (!result.canReopen) status.textContent += ' This older invitation cannot be displayed again. Existing copies keep their current validity. Replace it once to enable reopening; replacement disables old copies.';
      else if (invitation.status === 'active') status.textContent += ' Students can scan this in FaceRoll using Join a Course.';
    }
    controls();
  };
  const load = async () => {
    clear(); invitation = null;
    const version = ++generation, courseId = currentCourseId;
    busy = true; controls(); status.textContent = 'Loading invitation...';
    try {
      const user = await window.FaceRollFirebase.getCurrentAuthUser();
      const result = await requestInvitation(window.FaceRollConfig?.RECOGNITION_API_URL || '', user, courseId, 'view', fetcher);
      if (version === generation) render(result);
    } catch (error) {
      if (version === generation) { clear(); invitation = null; status.textContent = error.message || 'Unable to load invitation. Refresh to try again.'; }
    } finally {
      if (version === generation) { busy = false; controls(); }
    }
  };
  const openCourse = async (courseId, courseName) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(courseId)) return;

    clear();
    currentCourseId = courseId;
    courseLabel.textContent = `${courseName || courseId} (${currentCourseId})`;
    if (courseSelect) courseSelect.value = courseId;
    if (!dialog.open) dialog.showModal();
    await load();
  };
  window.addEventListener('faceroll:invite-course', async (event) => {
    await openCourse(String(event.detail?.courseId || ''), String(event.detail?.courseName || ''));
  });

  inviteButton?.addEventListener('click', async () => {
    const courses = Array.from(rosterCourseFilter?.options || [])
      .filter(option => /^[A-Za-z0-9_-]{1,200}$/.test(option.value));
    courseSelect.replaceChildren();
    courses.forEach(course => {
      const option = document.createElement('option');
      option.value = course.value;
      option.textContent = course.textContent;
      courseSelect.appendChild(option);
    });
    if (!courses.length) {
      clear(); generation++; busy = false; invitation = null; currentCourseId = '';
      courseLabel.textContent = 'Choose a course to invite students.';
      status.textContent = 'No courses available yet. Wait for your roster to load, or create a course on the Courses page, then reopen this window.';
      controls();
      dialog.showModal();
      return;
    }
    const selected = courses.find(course => course.value === rosterCourseFilter.value) || courses[0];
    await openCourse(selected.value, selected.textContent);
  });
  courseSelect?.addEventListener('change', async () => {
    const selected = courseSelect.selectedOptions[0];
    if (selected) await openCourse(selected.value, selected.textContent);
  });

  refreshButton.addEventListener('click', load);
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    clear(); generation++; busy = false; invitation = null;
    currentCourseId = '';
    courseLabel.textContent = 'Choose a course to invite students.';
    status.textContent = '';
    controls();
    inviteButton?.focus();
  });
  actions.forEach(action => buttons[action].addEventListener('click', async () => {
    if (busy || !currentCourseId || buttons[action].disabled) return;
    if (['replace', 'revoke'].includes(action) && !window.confirm(`${action === 'replace' ? 'Replace' : 'Disable'} this course invitation? Previously shared QR codes will stop working. Enrolled students keep their access.`)) return;
    if (action === 'renew' && !window.confirm('Renew this invitation? The same QR code and previously shared copies will work again.')) return;
    clear(); const version = ++generation, courseId = currentCourseId, expiration = expirationSelect.value;
    busy = true; controls(); status.textContent = 'Updating invitation...';
    try {
      const user = await window.FaceRollFirebase.getCurrentAuthUser();
      const result = await requestInvitation(window.FaceRollConfig?.RECOGNITION_API_URL || '', user, courseId, action, fetcher,
        action === 'revoke' ? undefined : expiration);
      if (version !== generation) return;
      render(action === 'revoke' ? { status: 'none', expiration: '24h' } : result);
    } catch (error) {
      if (version === generation) {
        if (action === 'create' && error.code === 'invitation_exists') {
          await load();
          return;
        }
        clear();
        invitation = null;
        status.textContent = `${error.message || 'Unable to update invitation.'} Refresh to check its current status before trying again.`;
      }
    } finally { if (version === generation) { busy = false; controls(); } }
  }));
  if (inviteButton) inviteButton.disabled = false;
  controls();
}

if (typeof document !== 'undefined') initializeInvitationDialog(document, window);
