import copy
import unittest
from flask import Flask
from faceroll_recognition.invitations import InvitationError, delete_course, invitation_blueprint, mutate_invitation
from tests.test_invitations import Store


class CourseDeleteTests(unittest.TestCase):
    def setUp(self):
        self.db = Store()
        self.db.data.update({
            ('enrollments','member'): {'courseId':'COURSE','uid':'student','status':'active'},
            ('sessions','session'): {'courseId':'COURSE','status':'closed'},
            ('attendance','attendance'): {'courseId':'COURSE','uid':'student'},
            ('courses','other'): {'courseId':'OTHER','instructorId':'teacher'},
            ('attendance','other'): {'courseId':'OTHER','uid':'student'},
        })
        mutate_invitation('teacher', self.db, self.db.transact, 'COURSE', 'create')

    def test_owner_deletes_course_and_only_its_related_records(self):
        result=delete_course('teacher',self.db,self.db.transact,'COURSE')
        self.assertTrue(result['success'])
        self.assertFalse(any(value.get('courseId')=='COURSE' for value in self.db.data.values()))
        self.assertIn(('courses','other'),self.db.data)
        self.assertIn(('attendance','other'),self.db.data)

    def test_non_owner_and_student_cannot_delete(self):
        self.db.data['users','other']={'role':'instructor'}
        self.db.data['users','student']={'role':'student'}
        before=copy.deepcopy(self.db.data)
        for uid in ('other','student'):
            with self.assertRaises(InvitationError):
                delete_course(uid,self.db,self.db.transact,'COURSE')
            self.assertEqual(self.db.data,before)

    def test_failed_delete_rolls_back_every_record(self):
        before=copy.deepcopy(self.db.data)
        original=self.db.delete
        calls=0
        def fail(ref):
            nonlocal calls
            calls+=1
            original(ref)
            if calls==2: raise RuntimeError('failure')
        self.db.delete=fail
        with self.assertRaises(RuntimeError): delete_course('teacher',self.db,self.db.transact,'COURSE')
        self.assertEqual(self.db.data,before)

    def test_active_session_must_be_ended_before_delete(self):
        self.db.data['sessions','session']['status']='active'
        before=copy.deepcopy(self.db.data)
        with self.assertRaises(InvitationError) as error:
            delete_course('teacher',self.db,self.db.transact,'COURSE')
        self.assertEqual(error.exception.code,'active_session_exists')
        self.assertEqual(self.db.data,before)

    def test_http_delete_requires_auth_and_no_body(self):
        def boundary(token):
            if token!='valid': raise InvitationError(401,'invalid_token')
            return 'teacher',self.db,self.db.transact
        app=Flask(__name__);app.register_blueprint(invitation_blueprint(boundary));client=app.test_client()
        self.assertEqual(client.delete('/courses/COURSE').status_code,401)
        self.assertEqual(client.delete('/courses/COURSE',headers={'Authorization':'Bearer valid'},json={}).status_code,400)
        self.assertEqual(client.delete('/courses/COURSE',headers={'Authorization':'Bearer valid'}).status_code,200)

if __name__=='__main__': unittest.main()
