const test = require('node:test');
const assert = require('node:assert/strict');
const {parseInvitation, createJoinFlow, requestCourseInvitation} = require('./course-join');
const raw = JSON.stringify({schemaVersion:1,type:'course-invitation',token:'a'.repeat(64)});
const course = {success:true,courseId:'COURSE',courseName:'Capstone',instructorName:'Teacher',alreadyJoined:false,status:'active'};

test('scanner accepts only the exact invitation payload', () => {
  assert.equal(parseInvitation(raw), 'a'.repeat(64));
  for (const value of ['https://untrusted.example', '{}', raw.replace('course-invitation','other'), 'x'.repeat(1025), JSON.stringify({...JSON.parse(raw),endpoint:'https://evil.example'})]) {
    assert.throws(() => parseInvitation(value), /valid FaceRoll/);
  }
});
test('repeated scan callbacks resolve once; joining requires confirmation', async () => {
  let finish, calls = [], state;
  const flow = createJoinFlow((action) => { calls.push(action); return action === 'resolve' ? new Promise(r=>{finish=r;}) : Promise.resolve(course); }, s=>{state=s;});
  const pending = flow.scan(raw);
  await flow.scan(raw); await flow.join();
  assert.deepEqual(calls,['resolve']);
  finish(course); await pending;
  assert.equal(state.stage,'confirm');
  await flow.join(); await flow.join();
  assert.deepEqual(calls,['resolve','join']);
  assert.equal(state.stage,'success');
});
test('cancellation ignores late resolution and never joins', async () => {
  let finish, state;
  const flow = createJoinFlow(()=>new Promise(r=>{finish=r;}), s=>{state=s;});
  const pending=flow.scan(raw); flow.cancel(); finish(course); await pending;
  assert.equal(state.stage,'resolving');
  await flow.join();
});
test('invalid scan and failed join require explicit rescan', async () => {
  let calls=0, state;
  const flow=createJoinFlow(async action=>{calls++;if(action==='join')throw new Error('Revoked');return course;},s=>{state=s;});
  await flow.scan('invalid'); assert.equal(calls,0); assert.equal(state.stage,'error');
  flow.reset(); await flow.scan(raw); await flow.join();
  assert.equal(state.message,'Revoked'); await flow.join(); assert.equal(calls,2);
});
test('different course response cannot finish confirmation',async()=>{
  let state;
  const flow=createJoinFlow(async a=>a==='resolve'?course:{...course,courseId:'OTHER'},s=>{state=s;});
  await flow.scan(raw);await flow.join();assert.equal(state.stage,'error');
});
test('API sends token only to configured origin and requires authentication', async () => {
  const user={getIdToken:async()=> 'id-token'};
  await assert.rejects(requestCourseInvitation('https://api.example',null,'join','token'),/Sign in/);
  await assert.rejects(requestCourseInvitation('http://untrusted.example',user,'join','token'),/invalid/);
  const result=await requestCourseInvitation('https://api.example',user,'join','invite',async(url,options)=>{
    assert.equal(url,'https://api.example/course-invitations/join');assert.equal(options.headers.Authorization,'Bearer id-token');
    assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{token:'invite'});
    return {ok:true,json:async()=>course};
  });assert.equal(result.courseId,'COURSE');
});
test('API translates expired invitations and rejects malformed success',async()=>{
  const user={getIdToken:async()=> 'token'};
  await assert.rejects(requestCourseInvitation('https://api.example',user,'join','invite',async()=>({ok:false,status:404,json:async()=>({error:'invitation_unavailable'})})),/expired/);
  await assert.rejects(requestCourseInvitation('https://api.example',user,'resolve','invite',async()=>({ok:true,json:async()=>({success:true})})),/invalid response/);
});
