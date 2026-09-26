const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(user, exists = false) {
  const elements = {};
  for (const id of ['manageCoursesPanel','addCourseBtn','newCourseId','newCourseName','manageCoursesStatus']) {
    elements[id] = {value:'',addEventListener(_event, handler){this.click=handler;},focus(){}};
  }
  elements.newCourseId.value='CAPSTONE';elements.newCourseName.value='Capstone';
  const writes=[], events=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/manage-courses.js'),'utf8'), {
    document:{readyState:'complete',getElementById:id=>elements[id]},
    window:{FaceRollFirebase:{waitForAuthUser:async()=>user,createDocumentIfAbsent:async(...args)=>{if(exists)return false;writes.push(args);return true;}},dispatchEvent:e=>events.push(e),addEventListener(){}},
    CustomEvent:class {constructor(name){this.type=name;}},console:{error(){},warn(){}},
  });
  return {elements,writes,events};
}
test('new course belongs to signed-in user and broadcasts dropdown refresh',async()=>{
  const {elements,writes,events}=setup({uid:'real-instructor-uid'});
  await elements.addCourseBtn.click();
  assert.equal(writes[0][2].instructorId,'real-instructor-uid');
  assert.equal(events[0].type,'faceroll:courses-updated');
});
test('signed-out creation is blocked and duplicate IDs cannot replace ownership',async()=>{
  for(const [user,exists] of [[null,false],[{uid:'other'},true]]) {
    const {elements,writes,events}=setup(user,exists);await elements.addCourseBtn.click();
    assert.equal(writes.length,0);assert.equal(events.length,0);
    assert.match(elements.manageCoursesStatus.textContent,/Failed to add course/);
  }
});

test('course management lists only owned courses and opens invitations for the selected course', async () => {
  class Element {
    constructor() { this.children=[]; this.textContent=''; }
    addEventListener(_event, handler) { this.click=handler; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children=[...children]; }
  }
  const panel=new Element();
  panel.close=()=>{ panel.closed=true; };
  const list=new Element();
  const elements={manageCoursesPanel:panel,manageCoursesList:list};
  const events=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/manage-courses.js'),'utf8'), {
    document:{readyState:'complete',getElementById:id=>elements[id] || null,createElement:()=>new Element()},
    window:{
      FaceRollFirebase:{
        waitForAuthUser:async()=>({uid:'owner-1'}),
        readCollectionDocs:async()=>[
          {courseId:'OWNED',courseName:'Owned Course',instructorId:'owner-1'},
          {courseId:'OTHER',courseName:'Other Course',instructorId:'owner-2'},
        ],
      },
      dispatchEvent:event=>events.push(event),
      addEventListener(){},
    },
    CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}},
    console:{error(){},warn(){}},
  });
  await new Promise(resolve=>setImmediate(resolve));

  assert.equal(list.children.length,1);
  const inviteButton=list.children[0].children[1];
  assert.equal(inviteButton.textContent,'Invite Students');
  inviteButton.click();
  assert.equal(panel.closed,true);
  assert.equal(events[0].type,'faceroll:invite-course');
  assert.equal(events[0].detail.courseId,'OWNED');
  assert.equal(events[0].detail.courseName,'Owned Course');
});
