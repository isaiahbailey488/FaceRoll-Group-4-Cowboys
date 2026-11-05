const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePromise = import('../public/js/course-invitations.mjs');
const payload = { schemaVersion: 1, type: 'course-invitation', token: 'a'.repeat(64) };

test('invitation request sends selected course and action with authenticated token', async () => {
  const { requestInvitation } = await modulePromise;
  for (const action of ['create', 'replace', 'revoke']) {
    await requestInvitation('https://classroom.example', { getIdToken: async () => 'verified-token' }, 'COURSE-2', action,
      async (url, options) => {
        assert.equal(url, 'https://classroom.example/courses/COURSE-2/invitations');
        assert.equal(options.headers.Authorization, 'Bearer verified-token');
        assert.deepEqual(JSON.parse(options.body), { action });
        assert.equal(options.redirect, 'error');
        return { ok: true, json: async () => ({ success: true, courseId: 'COURSE-2' }) };
      });
  }
});

test('invalid endpoint, missing user, mismatched course and existing invitation fail clearly', async () => {
  const { requestInvitation } = await modulePromise;
  const user = { getIdToken: async () => 'token' };
  const noFetch = () => { throw new Error('Unexpected fetch'); };
  await assert.rejects(requestInvitation('http://unsafe.example', user, 'A', 'create', noFetch), /HTTPS/);
  await assert.rejects(requestInvitation('https://safe.example', null, 'A', 'create', noFetch), /Sign in/);
  await assert.rejects(requestInvitation('https://safe.example', user, 'A', 'create', async () => ({ok:true,json:async()=>({success:true,courseId:'B'})})), /Unexpected/);
  await assert.rejects(requestInvitation('https://safe.example', user, 'A', 'create', async () => ({ok:false,json:async()=>({error:'invitation_exists'})})), /Refresh/);
});

test('reopening uses authenticated uncached GET and expiration changes use POST', async () => {
  const { requestInvitation } = await modulePromise;
  const user = { getIdToken: async () => 'verified-token' };
  await requestInvitation('https://classroom.example', user, 'COURSE', 'view', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer verified-token');
    return { ok: true, json: async () => ({ success: true, courseId: 'COURSE' }) };
  });
  for (const action of ['create', 'replace', 'update_expiration', 'renew']) {
    await requestInvitation('https://classroom.example', user, 'COURSE', action, async (url, options) => {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { action, expiration: 'never' });
      return { ok: true, json: async () => ({ success: true, courseId: 'COURSE' }) };
    }, 'never');
  }
});

async function setupDialog(fetcher, { courses = [{ value: 'COURSE', name: 'Course One' }, { value: 'OTHER', name: 'Course Two' }], selectedCourse = 'COURSE' } = {}) {
  const { initializeInvitationDialog } = await modulePromise;
  class Element {
    constructor() { this.handlers = {}; this.children = []; this.hidden = true; this.disabled = false; this.textContent = ''; this.value = '24h'; }
    addEventListener(event, handler) { this.handlers[event] = handler; }
    showModal() { this.open = true; }
    close() { this.open = false; this.handlers.close?.(); }
    focus() { this.focused = true; }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    get options() { return this.children; }
    get selectedOptions() { return this.children.filter(option => option.value === this.value); }
    getContext() { return { fillRect() {} }; }
    click() { return this.handlers.click?.(); }
  }
  const elements = Object.fromEntries([
    'inviteStudentsDialog', 'closeInvitationDialog', 'invitation-course-name', 'invitation-status',
    'invitation-qr', 'invitation-create', 'invitation-replace', 'invitation-revoke',
    'invitation-update_expiration', 'invitation-renew', 'invitation-expiration', 'invitation-refresh',
    'rosterInviteStudents', 'rosterCourseFilter', 'invitation-course',
  ].map(id => [id, new Element()]));
  elements.rosterCourseFilter.value = selectedCourse;
  elements.rosterCourseFilter.children = [{ value: '', textContent: 'All Courses' },
    ...courses.map(course => ({ value: course.value, textContent: course.name }))];
  const handlers = {}, requests = [], confirmations = [];
  initializeInvitationDialog({ getElementById: id => elements[id], createElement: () => new Element() }, {
    FaceRollConfig: { RECOGNITION_API_URL: 'https://classroom.example' },
    FaceRollFirebase: { getCurrentAuthUser: async () => ({ getIdToken: async () => 'owner' }) },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    confirm: message => { confirmations.push(message); return true; },
  }, async (url, options) => {
    requests.push({ url, ...options });
    return fetcher(url, options);
  });
  return {
    elements, requests, confirmations,
    open: (courseId = 'COURSE') => handlers['faceroll:invite-course']({ detail: { courseId, courseName: courseId } }),
    close: () => elements.inviteStudentsDialog.close(),
  };
}

const activeInvitation = (courseId = 'COURSE') => ({
  success: true, courseId, status: 'active', expiration: 'never', expiresAt: null, canReopen: true, qrPayload: payload,
});
const response = result => ({ ok: true, json: async () => result });

test('Students invite button uses the roster course and popup changes leave roster filters untouched', async () => {
  const dialog = await setupDialog(async url => response(activeInvitation(url.includes('/OTHER/') ? 'OTHER' : 'COURSE')),
    { selectedCourse: 'OTHER' });
  try {
    await dialog.elements.rosterInviteStudents.click();
    assert.equal(dialog.elements.inviteStudentsDialog.open, true);
    assert.equal(dialog.elements['invitation-course'].value, 'OTHER');
    assert.match(dialog.elements['invitation-course-name'].textContent, /Course Two/);
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
    assert.equal(dialog.elements['invitation-expiration'].disabled, false);
    assert.deepEqual(dialog.elements['invitation-course'].options.map(option => option.value), ['COURSE', 'OTHER']);
    dialog.elements['invitation-course'].value = 'COURSE';
    await dialog.elements['invitation-course'].handlers.change();
    assert.match(dialog.requests.at(-1).url, /\/courses\/COURSE\/invitations$/);
    assert.equal(dialog.elements.rosterCourseFilter.value, 'OTHER');
    assert.ok(dialog.requests.every(request => request.method === 'GET'));
    dialog.close();
    assert.equal(dialog.elements.rosterInviteStudents.focused, true);
    await dialog.elements.rosterInviteStudents.click();
    assert.equal(dialog.elements['invitation-course'].value, 'OTHER');
  } finally { dialog.close(); }
});

test('All Courses can open invitations and empty courses show guidance without sending a request', async () => {
  const dialog = await setupDialog(async () => response(activeInvitation()), { selectedCourse: '' });
  try {
    await dialog.elements.rosterInviteStudents.click();
    assert.equal(dialog.elements['invitation-course'].value, 'COURSE');
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
    assert.equal(dialog.elements.rosterCourseFilter.value, '');
  } finally { dialog.close(); }
  const empty = await setupDialog(() => { throw new Error('No request expected'); }, { courses: [], selectedCourse: '' });
  await empty.elements.rosterInviteStudents.click();
  assert.equal(empty.elements.inviteStudentsDialog.open, true);
  assert.equal(empty.requests.length, 0);
  assert.match(empty.elements['invitation-status'].textContent, /No courses available/);
  assert.equal(empty.elements['invitation-create'].disabled, true);
  empty.close();
});

test('dialog reopens the same QR after close and from a new browser without creating or replacing', async () => {
  for (let browser = 0; browser < 2; browser++) {
    const dialog = await setupDialog(async () => response(activeInvitation()));
    for (let opening = 0; opening < 2; opening++) {
      await dialog.open();
      assert.equal(dialog.elements['invitation-qr'].hidden, false);
      assert.equal(dialog.elements['invitation-expiration'].value, 'never');
      assert.equal(dialog.elements['invitation-expiration'].disabled, false);
      assert.match(dialog.elements['invitation-status'].textContent, /never expires/);
      assert.equal(dialog.elements['invitation-create'].hidden, true);
      assert.equal(dialog.elements['invitation-update_expiration'].disabled, false);
      dialog.close();
      assert.equal(dialog.elements['invitation-qr'].hidden, true);
    }
    assert.ok(dialog.requests.every(request => request.method === 'GET'));
  }
});

test('empty, expired and legacy invitations expose only appropriate actions', async () => {
  const cases = [
    [{ ...activeInvitation(), status: 'none', canReopen: false, qrPayload: null }, 'create'],
    [{ ...activeInvitation(), status: 'expired', expiration: '2h', expiresAt: new Date(Date.now() - 1000).toISOString(), qrPayload: null }, 'renew'],
    [{ ...activeInvitation(), canReopen: false, qrPayload: null }, 'replace'],
  ];
  for (const [result, action] of cases) {
    const dialog = await setupDialog(async () => response(result));
    await dialog.open();
    assert.equal(dialog.elements['invitation-qr'].hidden, true);
    assert.equal(dialog.elements[`invitation-${action}`].disabled, false);
    assert.equal(dialog.elements['invitation-update_expiration'].hidden, true);
    if (action === 'replace') assert.match(dialog.elements['invitation-status'].textContent, /older invitation/);
    dialog.close();
  }
});

test('saving expiration and renewing redraw the same QR and disabling allows a new invitation', async () => {
  let saved = activeInvitation();
  const dialog = await setupDialog(async (_url, options) => {
    if (options.method === 'GET') return response(saved);
    const { action, expiration } = JSON.parse(options.body);
    if (action === 'revoke') return response({ success: true, courseId: 'COURSE', revoked: true });
    saved = { ...saved, status: 'active', expiration,
      expiresAt: expiration === 'never' ? null : new Date(Date.now() + 7200000).toISOString(), qrPayload: payload };
    return response(saved);
  });
  try {
    await dialog.open();
    dialog.elements['invitation-expiration'].value = '2h';
    await dialog.elements['invitation-update_expiration'].click();
    assert.deepEqual(JSON.parse(dialog.requests.at(-1).body), { action: 'update_expiration', expiration: '2h' });
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
    saved = { ...saved, status: 'expired', expiresAt: new Date(Date.now() - 1000).toISOString(), qrPayload: null };
    await dialog.elements['invitation-refresh'].click();
    dialog.elements['invitation-expiration'].value = 'never';
    await dialog.elements['invitation-renew'].click();
    assert.deepEqual(JSON.parse(dialog.requests.at(-1).body), { action: 'renew', expiration: 'never' });
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
    assert.match(dialog.confirmations.at(-1), /previously shared copies/);
    await dialog.elements['invitation-revoke'].click();
    assert.equal(dialog.elements['invitation-qr'].hidden, true);
    assert.equal(dialog.elements['invitation-create'].disabled, false);
    assert.deepEqual(JSON.parse(dialog.requests.at(-1).body), { action: 'revoke' });
  } finally { dialog.close(); }
});

test('QR hides at expiry and reopening does not restart the saved expiration', async () => {
  const result = { ...activeInvitation(), expiration: '2h', expiresAt: new Date(Date.now() + 80).toISOString() };
  const dialog = await setupDialog(async () => response(result));
  try {
    await dialog.open();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(dialog.elements['invitation-qr'].hidden, true);
    assert.equal(dialog.elements['invitation-renew'].disabled, false);
    dialog.close();
    await dialog.open();
    assert.equal(dialog.elements['invitation-qr'].hidden, true);
    assert.match(dialog.elements['invitation-status'].textContent, /expired/);
    assert.ok(dialog.requests.every(request => request.method === 'GET'));
  } finally { dialog.close(); }
});

test('failed reads and writes require refreshing server state before another mutation', async () => {
  let fail = true;
  const dialog = await setupDialog(async (_url, options) => {
    if (fail || options.method === 'POST') throw new Error('Connection lost');
    return response(activeInvitation());
  });
  try {
    await dialog.open();
    assert.equal(dialog.elements['invitation-create'].disabled, true);
    assert.equal(dialog.elements['invitation-refresh'].disabled, false);
    fail = false;
    await dialog.elements['invitation-refresh'].click();
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
    await dialog.elements['invitation-update_expiration'].click();
    assert.equal(dialog.elements['invitation-qr'].hidden, true);
    assert.equal(dialog.elements['invitation-update_expiration'].disabled, true);
    assert.match(dialog.elements['invitation-status'].textContent, /Refresh/);
    await dialog.elements['invitation-refresh'].click();
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
  } finally { dialog.close(); }
});

test('create automatically displays the existing QR when another tab already created it', async () => {
  let reads = 0;
  const dialog = await setupDialog(async (_url, options) => {
    if (options.method === 'POST') return { ok: false, json: async () => ({ error: 'invitation_exists' }) };
    reads++;
    return response(reads === 1 ? { ...activeInvitation(), status: 'none', qrPayload: null } : activeInvitation());
  });
  try {
    await dialog.open();
    assert.equal(dialog.elements['invitation-create'].disabled, false);
    await dialog.elements['invitation-create'].click();
    assert.equal(reads, 2);
    assert.equal(dialog.elements['invitation-qr'].hidden, false);
    assert.equal(dialog.elements['invitation-expiration'].disabled, false);
    assert.equal(dialog.elements['invitation-create'].hidden, true);
    assert.equal(dialog.elements['invitation-update_expiration'].disabled, false);
    assert.ok(!dialog.requests.some(request => request.body && JSON.parse(request.body).action === 'replace'));
  } finally { dialog.close(); }
});

test('a delayed response for a closed course cannot overwrite the next course dialog', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const dialog = await setupDialog(async url => url.includes('/FIRST/') ? pending : response(activeInvitation('SECOND')));
  const first = dialog.open('FIRST');
  await new Promise(resolve => setImmediate(resolve));
  dialog.close();
  await dialog.open('SECOND');
  release(response(activeInvitation('FIRST')));
  await first;
  assert.match(dialog.elements['invitation-course-name'].textContent, /SECOND/);
  assert.equal(dialog.elements['invitation-update_expiration'].disabled, false);
  assert.equal(dialog.elements['invitation-qr'].hidden, false);
  dialog.close();
});

test('QR changes when token changes and rejects malformed payloads', async () => {
  const { qrMatrix } = await modulePromise;
  const matrix = qrMatrix(payload);
  assert.equal(Math.sqrt(matrix.length) % 1, 0);
  assert.notDeepEqual(matrix, qrMatrix({...payload, token:'b'.repeat(64)}));
  assert.throws(() => qrMatrix({...payload, token:'bad'}), /Invalid/);
});

test('canvas includes four-module quiet zone and a white background', async () => {
  const { drawQr, qrMatrix } = await modulePromise;
  const rectangles = [];
  const ctx = {fillStyle:'',fillRect(...args){rectangles.push([this.fillStyle,...args]);}};
  const canvas = {hidden:true,getContext:()=>ctx};
  drawQr(canvas, payload);
  const size = Math.sqrt(qrMatrix(payload).length);
  assert.equal(canvas.width, (size + 8) * 6);
  assert.deepEqual(rectangles[0], ['#fff',0,0,canvas.width,canvas.height]);
  assert.ok(rectangles.slice(1).every(([,x,y]) => x >=24 && y >=24 && x < canvas.width-24 && y < canvas.height-24));
  assert.equal(canvas.hidden, false);
});

test('course deletion uses authenticated DELETE and validates ownership response', async () => {
  const { deleteOwnedCourse } = await modulePromise;
  const user={getIdToken:async()=> 'verified-token'};
  const result=await deleteOwnedCourse('https://classroom.example',user,'COURSE',async(url,options)=>{
    assert.equal(url,'https://classroom.example/courses/COURSE');
    assert.equal(options.method,'DELETE');
    assert.equal(options.headers.Authorization,'Bearer verified-token');
    return {ok:true,json:async()=>({success:true,courseId:'COURSE'})};
  });
  assert.equal(result.courseId,'COURSE');
  await assert.rejects(deleteOwnedCourse('https://classroom.example',user,'COURSE',async()=>({ok:false,json:async()=>({error:'course_owner_required'})})),/owner/);
});

test('Students hosts invitations in a popup outside the roster layout and Courses has no invitation dialog', () => {
  const html=fs.readFileSync(path.join(__dirname,'../public/student-roster.html'),'utf8');
  assert.match(html,/<dialog[^>]+id="inviteStudentsDialog"/);
  assert.match(html,/id="invitation-course-name"/);
  assert.match(html,/id="invitation-course"/);
  assert.match(html,/id="rosterInviteStudents"/);
  assert.ok(html.indexOf('<dialog') > html.indexOf('</main>'));
  assert.doesNotMatch(html,/href="\.\/css\/(?:courses|course-settings)\.css/);
  assert.equal((html.match(/id="invitation-create"/g) || []).length,1);
  assert.doesNotMatch(html,/id="course-delete"/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public/courses.html'),'utf8'),/id="inviteStudentsDialog"/);
});

test('updated invitation module bypasses old cached code and offers an explicit view control', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/student-roster.html'), 'utf8');
  assert.match(html, /src="\.\/js\/course-invitations\.mjs\?v=[^"]+"/);
  assert.match(html, /id="invitation-refresh"[^>]*>View QR Code<\/button>/);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../firebase.json'), 'utf8'));
  const moduleHeaders = config.hosting.headers.find(rule => rule.source === '**/*.mjs');
  assert.ok(moduleHeaders?.headers.some(header => header.key === 'Cache-Control' && header.value.includes('must-revalidate')));
});
