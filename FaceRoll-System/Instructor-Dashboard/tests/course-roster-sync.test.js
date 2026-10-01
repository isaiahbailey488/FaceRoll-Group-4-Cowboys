const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeRosterUids,
  rosterSignature,
  membershipId,
  processBridgeEvents,
  membershipRosterRows,
  requestMembershipChange,
} = require('../public/js/course-roster-sync.js');

test('camera roster includes only active memberships for the selected course', () => {
  const memberships = [
    {courseId:'COURSE-A',uid:'uid-b',status:'active'},
    {courseId:'COURSE-A',uid:'uid-a',status:'active'},
    {courseId:'COURSE-A',uid:'uid-a',status:'active'},
    {courseId:'COURSE-A',uid:'pending-uid',status:'pending'},
    {courseId:'COURSE-A',uid:'removed-uid',status:'removed'},
    {courseId:'COURSE-A',uid:'missing-status'},
    {courseId:'COURSE-B',uid:'other-course',status:'active'},
    {courseId:'COURSE-A',uid:'../unsafe',status:'active'},
  ];
  assert.deepEqual(activeRosterUids(memberships,'COURSE-A'),['uid-a','uid-b']);
});

test('roster signature is stable and changes for additions or removals', () => {
  assert.equal(rosterSignature(['uid-b','uid-a']),rosterSignature(['uid-a','uid-b']));
  assert.notEqual(rosterSignature(['uid-a']),rosterSignature(['uid-a','uid-b']));
  assert.notEqual(rosterSignature(['uid-a','uid-b']),rosterSignature(['uid-b']));
});

test('camera attendance uses the same deterministic membership ID as mobile check-in', () => {
  assert.equal(membershipId('COURSE-A','uid-a'),'8_COURSE-A_uid-a');
  assert.throws(()=>membershipId('COURSE/A','uid-a'),/Invalid/);
  assert.throws(()=>membershipId('COURSE-A','../uid'),/Invalid/);
});

test('bridge event processing advances only after successful attendance handling', async () => {
  const events=[{cursor:1,uid:'uid-a'},{cursor:2,uid:'uid-b'}];
  const processed=await processBridgeEvents(events,0,async()=>true);
  assert.deepEqual(processed,{cursor:2,wroteAttendance:true});
  await assert.rejects(
    processBridgeEvents(events,0,async event=>{
      if(event.cursor===2) throw new Error('Firestore rejected attendance');
      return true;
    }),
    /Firestore rejected/
  );
});

test('membership roster contains only courses owned by the signed-in instructor', () => {
  const rows=membershipRosterRows(
    [
      {courseId:'OWNED',uid:'student-a',status:'active',createdAt:'2026-09-30T12:00:00.000Z'},
      {courseId:'OWNED',uid:'student-b',status:'removed'},
      {courseId:'OTHER',uid:'student-a',status:'active'},
    ],
    [
      {courseId:'OWNED',courseName:'Owned Course',instructorId:'teacher'},
      {courseId:'OTHER',courseName:'Other Course',instructorId:'other'},
    ],
    [{id:'student-a',displayName:'Student A'}],
    'teacher'
  );
  assert.equal(rows.length,2);
  assert.equal(rows[0].courseName,'Owned Course');
  assert.equal(rows[0].user.displayName,'Student A');
  assert.equal(rows[0].createdAt,'2026-09-30T12:00:00.000Z');
  assert.equal(rows[1].status,'removed');
});

test('membership change uses instructor authentication and validates the response', async () => {
  const user={getIdToken:async()=> 'instructor-token'};
  const result=await requestMembershipChange(
    'https://classroom.example',user,'COURSE','student','remove',async(url,options)=>{
      assert.equal(url,'https://classroom.example/courses/COURSE/members/student');
      assert.equal(options.headers.Authorization,'Bearer instructor-token');
      assert.deepEqual(JSON.parse(options.body),{action:'remove'});
      return {ok:true,json:async()=>({success:true,courseId:'COURSE',uid:'student',status:'removed'})};
    }
  );
  assert.equal(result.status,'removed');
});
