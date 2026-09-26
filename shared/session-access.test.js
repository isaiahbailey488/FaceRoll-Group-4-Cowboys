const test = require('node:test');
const assert = require('node:assert/strict');
const {membershipId, accessibleActiveSessions} = require('./session-access');
const now = Date.parse('2026-09-24T12:00:00.000Z');
const session = (courseId, fields={}) => ({courseId,sessionId:`s-${courseId}`,startTime:'2026-09-24T11:00:00.000Z',status:'active',...fields});

test('only active sessions for active student memberships are accessible',()=>{
  const memberships=[{uid:'student',courseId:'A',status:'active'},{uid:'student',courseId:'B',status:'dropped'},{uid:'other',courseId:'C',status:'active'}];
  const result=accessibleActiveSessions([session('A'),session('B'),session('C'),session('D')],memberships,'student',now);
  assert.deepEqual(result.map(row=>row.courseId),['A']);
});
test('closed, ended, stale, and future sessions are excluded',()=>{
  const memberships=[{uid:'student',courseId:'A',status:'active'}];
  const rows=[session('A'),session('A',{status:'closed'}),session('A',{endTime:'2026-09-24T11:30:00Z'}),
    session('A',{startTime:'2026-09-24T08:00:00Z'}),session('A',{startTime:'2026-09-24T12:02:00Z'})];
  assert.equal(accessibleActiveSessions(rows,memberships,'student',now).length,1);
});
test('membership ID matches the join-service contract',()=>{
  assert.equal(membershipId('COURSE','student'),'6_COURSE_student');
  assert.throws(()=>membershipId('../bad','student'));
});
