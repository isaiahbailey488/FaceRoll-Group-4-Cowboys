'use strict';
const { validateQrPayload } = require('./course-contracts');

function parseInvitation(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 1024) throw new Error();
    return validateQrPayload(JSON.parse(raw)).token;
  } catch { throw new Error('This is not a valid FaceRoll course invitation.'); }
}

function createJoinFlow(request, onChange) {
  let state = { stage: 'scanning' }, token = null, generation = 0;
  const publish = (next) => { state = next; onChange(next); };
  const reset = () => { generation++; token = null; publish({ stage: 'scanning' }); };
  return {
    reset,
    cancel() { generation++; token = null; },
    async scan(raw) {
      if (state.stage !== 'scanning') return;
      const version = ++generation;
      publish({ stage: 'resolving' });
      try {
        token = parseInvitation(raw);
        const course = await request('resolve', token);
        if (version === generation) publish({ stage: 'confirm', course });
      } catch (error) {
        if (version === generation) { token = null; publish({ stage: 'error', message: error.message }); }
      }
    },
    async join() {
      if (state.stage !== 'confirm' || !token) return;
      const course = state.course, version = ++generation;
      publish({ stage: 'joining', course });
      try {
        const result = await request('join', token);
        if (result.courseId !== course.courseId) throw new Error('The course response changed. Scan the invitation again.');
        if (version === generation) { token = null; publish({ stage: 'success', course: result }); }
      } catch (error) {
        if (version === generation) { token = null; publish({ stage: 'error', message: error.message }); }
      }
    },
  };
}

async function requestCourseInvitation(baseUrl, user, action, token, fetcher = fetch) {
  if (!user) throw new Error('Sign in before joining a course.');
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.origin !== baseUrl) {
    throw new Error('The course server address is invalid.');
  }
  if (!['resolve', 'join'].includes(action)) throw new Error('Invalid course action.');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const idToken = await user.getIdToken();
        if (controller.signal.aborted) throw new Error('Request timed out.');
        const response = await fetcher(`${baseUrl}/course-invitations/${action}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const result = await response.json();
        if (!response.ok) {
          const messages = {
            invitation_unavailable: 'This invitation has expired or been revoked. Ask your instructor for a new code.',
            membership_removed: 'Your membership was removed. Contact your instructor to rejoin.',
            student_required: 'Sign in with a student account to join a course.',
          };
          throw new Error(response.status === 401 ? 'Your sign-in expired. Sign in again.' : messages[result.error] || 'Unable to join this course. Try scanning again.');
        }
        if (result.success !== true || typeof result.courseId !== 'string' || !result.courseId ||
            typeof result.courseName !== 'string' || typeof result.instructorName !== 'string' ||
            typeof result.alreadyJoined !== 'boolean' || (action === 'join' && result.status !== 'active')) {
          throw new Error('The course server returned an invalid response.');
        }
        return result;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('The course server took too long. Scan again to retry.'));
      }, 20000); }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { parseInvitation, createJoinFlow, requestCourseInvitation };
