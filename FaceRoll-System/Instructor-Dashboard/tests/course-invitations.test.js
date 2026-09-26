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
  await assert.rejects(requestInvitation('https://safe.example', user, 'A', 'create', async () => ({ok:false,json:async()=>({error:'invitation_exists'})})), /Replace/);
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

test('courses page launches invitations from a dedicated dialog without a duplicate course selector', () => {
  const html=fs.readFileSync(path.join(__dirname,'../public/courses.html'),'utf8');
  assert.match(html,/<dialog[^>]+id="inviteStudentsDialog"/);
  assert.match(html,/id="invitation-course-name"/);
  assert.doesNotMatch(html,/id="invitation-course"/);
  assert.equal((html.match(/id="invitation-create"/g) || []).length,1);
});
