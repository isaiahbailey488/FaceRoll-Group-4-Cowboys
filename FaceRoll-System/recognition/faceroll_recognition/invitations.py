"""Instructor-owned course invitations; no biometric data enters this service."""

import hashlib
import re
import secrets
import os
from urllib.parse import urlsplit
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request


class InvitationError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def firebase_boundary(token):
    # Reuse the API's emulator-aware configuration without changing student auth.
    from .mobile_api import _firebase_app_options, _firestore_client
    import firebase_admin
    from firebase_admin import auth, firestore

    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(options=_firebase_app_options())
    try:
        claims = auth.verify_id_token(token, check_revoked=True)
        uid = claims.get('uid') or claims.get('sub')
        if not isinstance(uid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', uid):
            raise ValueError('Invalid identity')
    except Exception:
        raise InvitationError(401, 'invalid_token') from None
    client = _firestore_client(firestore)

    def transact(operation):
        return firestore.transactional(operation)(client.transaction())

    return uid, client, transact


def mutate_invitation(uid, client, transact, course_id, action, *, now=None):
    if not isinstance(course_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', course_id):
        raise InvitationError(400, 'invalid_course_id')
    if action not in ('create', 'replace', 'revoke'):
        raise InvitationError(400, 'invalid_action')
    instant = now or datetime.now(timezone.utc)
    stamp = instant.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    expires = (instant + timedelta(hours=24)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    token = secrets.token_hex(32) if action != 'revoke' else None
    digest = hashlib.sha256(token.encode()).hexdigest() if token else None
    head_ref = client.collection('courseInvitationHeads').document(course_id)

    def operation(tx):
        # All reads precede writes. Ownership is rechecked on transaction retries.
        profile = client.collection('users').document(uid).get(transaction=tx).to_dict() or {}
        if (profile.get('role') or profile.get('userType')) not in ('instructor', 'admin', 'administrator'):
            raise InvitationError(403, 'instructor_required')
        courses = list(client.collection('courses').where('courseId', '==', course_id).limit(2).stream(transaction=tx))
        if not courses:
            raise InvitationError(404, 'course_not_found')
        if len(courses) != 1:
            raise InvitationError(409, 'ambiguous_course')
        if courses[0].to_dict().get('instructorId') != uid:
            raise InvitationError(403, 'course_owner_required')
        head = head_ref.get(transaction=tx).to_dict() or {}
        old_hash = head.get('tokenHash')
        old_ref = client.collection('courseInvitations').document(old_hash) if old_hash else None
        old = old_ref.get(transaction=tx).to_dict() if old_ref else None
        if old_hash and (not old or old.get('courseId') != course_id):
            raise InvitationError(409, 'invalid_invitation_state')
        if action == 'create' and old_hash:
            raise InvitationError(409, 'invitation_exists')
        new_ref = client.collection('courseInvitations').document(digest) if digest else None
        if new_ref and new_ref.get(transaction=tx).exists:
            raise InvitationError(409, 'token_collision')
        if old:
            tx.update(old_ref, {'status': 'revoked', 'updatedAt': stamp})
        if action == 'revoke':
            tx.delete(head_ref)
            return {'success': True, 'courseId': course_id, 'revoked': bool(old_hash)}
        record = dict(schemaVersion=1, courseId=course_id, createdBy=uid,
                      tokenHash=digest, status='active', createdAt=stamp,
                      updatedAt=stamp, expiresAt=expires)
        tx.create(new_ref, record)
        tx.set(head_ref, dict(schemaVersion=1, courseId=course_id, tokenHash=digest))
        return {'success': True, 'courseId': course_id, 'expiresAt': expires,
                'qrPayload': dict(schemaVersion=1, type='course-invitation', token=token)}

    return transact(operation)


def redeem_invitation(uid, client, transact, token, *, join=False, clock=None):
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
        raise InvitationError(400, 'invalid_invitation_token')
    if not isinstance(uid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', uid):
        raise InvitationError(401, 'invalid_token')
    digest = hashlib.sha256(token.encode()).hexdigest()
    current_time = clock or (lambda: datetime.now(timezone.utc))

    def operation(tx):
        profile = client.collection('users').document(uid).get(transaction=tx).to_dict() or {}
        if (profile.get('role') or profile.get('userType')) != 'student':
            raise InvitationError(403, 'student_required')
        invitation = client.collection('courseInvitations').document(digest).get(transaction=tx).to_dict() or {}
        course_id = invitation.get('courseId')
        if (invitation.get('schemaVersion') != 1 or invitation.get('tokenHash') != digest
                or invitation.get('status') != 'active' or not isinstance(course_id, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', course_id)):
            raise InvitationError(404, 'invitation_unavailable')
        try:
            expiration = datetime.fromisoformat(invitation['expiresAt'].replace('Z', '+00:00'))
            if expiration.tzinfo is None or current_time() >= expiration:
                raise ValueError('Expired')
        except (KeyError, AttributeError, TypeError, ValueError):
            raise InvitationError(404, 'invitation_unavailable') from None
        head = client.collection('courseInvitationHeads').document(course_id).get(transaction=tx).to_dict() or {}
        if head.get('tokenHash') != digest:
            raise InvitationError(404, 'invitation_unavailable')
        courses = list(client.collection('courses').where('courseId', '==', course_id).limit(2).stream(transaction=tx))
        if len(courses) != 1:
            raise InvitationError(409, 'course_unavailable')
        course = courses[0].to_dict()
        owner = course.get('instructorId')
        if not owner or owner != invitation.get('createdBy'):
            raise InvitationError(404, 'invitation_unavailable')
        instructor = client.collection('users').document(owner).get(transaction=tx).to_dict() or {}
        if (instructor.get('role') or instructor.get('userType')) not in ('instructor', 'admin', 'administrator'):
            raise InvitationError(404, 'invitation_unavailable')
        enrollment_id = f'{len(course_id)}_{course_id}_{uid}'
        ref = client.collection('enrollments').document(enrollment_id)
        existing = ref.get(transaction=tx).to_dict()
        if existing is not None:
            if (existing.get('schemaVersion') != 1 or existing.get('courseId') != course_id
                    or existing.get('uid') != uid or existing.get('status') not in ('active', 'dropped', 'removed')):
                raise InvitationError(409, 'invalid_membership_state')
            if existing['status'] == 'removed':
                raise InvitationError(403, 'membership_removed')
        duplicate = bool(existing and existing['status'] == 'active')
        result = {'success': True, 'courseId': course_id,
                  'courseName': course.get('courseName') or course.get('name') or course_id,
                  'instructorName': instructor.get('displayName') or instructor.get('fullName') or instructor.get('name') or 'Instructor',
                  'alreadyJoined': duplicate}
        if join:
            if not duplicate:
                # Recheck expiry just before writing; retries re-read all authorization state.
                instant = current_time()
                if instant >= expiration:
                    raise InvitationError(404, 'invitation_unavailable')
                stamp = instant.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                if existing:
                    tx.update(ref, {'status': 'active', 'updatedAt': stamp})
                else:
                    tx.create(ref, dict(schemaVersion=1, courseId=course_id, uid=uid,
                                        status='active', createdAt=stamp, updatedAt=stamp))
            result.update(membershipId=enrollment_id, status='active')
        return result

    return transact(operation)


def delete_course(uid, client, transact, course_id):
    if not isinstance(course_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', course_id):
        raise InvitationError(400, 'invalid_course_id')

    def operation(tx):
        profile = client.collection('users').document(uid).get(transaction=tx).to_dict() or {}
        if (profile.get('role') or profile.get('userType')) not in ('instructor', 'admin', 'administrator'):
            raise InvitationError(403, 'instructor_required')
        courses = list(client.collection('courses').where('courseId', '==', course_id).limit(2).stream(transaction=tx))
        if not courses:
            raise InvitationError(404, 'course_not_found')
        if len(courses) != 1:
            raise InvitationError(409, 'ambiguous_course')
        course = courses[0]
        if course.to_dict().get('instructorId') != uid:
            raise InvitationError(403, 'course_owner_required')

        # Read every dependent document before starting writes. Course deletion
        # is intentionally atomic so no orphaned roster or invitation remains.
        related = []
        sessions = []
        for collection_name in ('enrollments', 'sessions', 'attendance', 'courseInvitations'):
            snapshots = list(client.collection(collection_name)
                             .where('courseId', '==', course_id).limit(450).stream(transaction=tx))
            related.extend(snapshots)
            if collection_name == 'sessions':
                sessions = snapshots
        if any(snapshot.to_dict().get('status') == 'active'
               and not snapshot.to_dict().get('endTime') for snapshot in sessions):
            raise InvitationError(409, 'active_session_exists')
        head_ref = client.collection('courseInvitationHeads').document(course_id)
        head = head_ref.get(transaction=tx)
        targets = [snapshot.reference for snapshot in related]
        if head.exists:
            targets.append(head_ref)
        targets.append(course.reference)
        if len(targets) > 450:
            raise InvitationError(409, 'course_too_large_to_delete')
        for target in targets:
            tx.delete(target)
        return {'success': True, 'courseId': course_id, 'deletedRecords': len(targets)}

    return transact(operation)


def mutate_membership(uid, client, transact, course_id, student_uid, action, *, now=None):
    if not isinstance(course_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', course_id):
        raise InvitationError(400, 'invalid_course_id')
    if not isinstance(student_uid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', student_uid):
        raise InvitationError(400, 'invalid_student_uid')
    if action not in ('remove', 'restore'):
        raise InvitationError(400, 'invalid_action')
    instant = now or datetime.now(timezone.utc)
    stamp = instant.isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    def operation(tx):
        profile = client.collection('users').document(uid).get(transaction=tx).to_dict() or {}
        if (profile.get('role') or profile.get('userType')) not in ('instructor', 'admin', 'administrator'):
            raise InvitationError(403, 'instructor_required')
        courses = list(client.collection('courses').where('courseId', '==', course_id).limit(2).stream(transaction=tx))
        if not courses:
            raise InvitationError(404, 'course_not_found')
        if len(courses) != 1:
            raise InvitationError(409, 'ambiguous_course')
        if courses[0].to_dict().get('instructorId') != uid:
            raise InvitationError(403, 'course_owner_required')

        membership_id = f'{len(course_id)}_{course_id}_{student_uid}'
        membership_ref = client.collection('enrollments').document(membership_id)
        membership = membership_ref.get(transaction=tx).to_dict()
        if membership is None:
            raise InvitationError(404, 'membership_not_found')
        if (membership.get('schemaVersion') != 1 or membership.get('courseId') != course_id
                or membership.get('uid') != student_uid
                or membership.get('status') not in ('active', 'dropped', 'removed')):
            raise InvitationError(409, 'invalid_membership_state')

        target_status = 'removed' if action == 'remove' else 'active'
        changed = membership['status'] != target_status
        if changed:
            tx.update(membership_ref, {'status': target_status, 'updatedAt': stamp})
        return {
            'success': True,
            'courseId': course_id,
            'uid': student_uid,
            'membershipId': membership_id,
            'status': target_status,
            'changed': changed,
        }

    return transact(operation)


def invitation_blueprint(boundary=None):
    api = Blueprint('course_invitations', __name__)
    authenticate = boundary or firebase_boundary

    @api.before_request
    def check_origin():
        origin = request.headers.get('Origin')
        if not origin:
            return None
        allowed = {item.strip() for item in os.getenv('FACEROLL_DASHBOARD_ORIGINS', '').split(',') if item.strip()}
        parsed = urlsplit(origin)
        local_demo = (os.getenv('FIREBASE_AUTH_EMULATOR_HOST') and os.getenv('FIRESTORE_EMULATOR_HOST')
                      and parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1'))
        if origin not in allowed and not local_demo:
            return jsonify(success=False, error='origin_not_allowed'), 403

    @api.after_request
    def cors(response):
        origin = request.headers.get('Origin')
        if origin and response.status_code != 403:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Vary'] = 'Origin'
            response.headers['Access-Control-Allow-Methods'] = 'POST, DELETE, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
        response.headers['Cache-Control'] = 'no-store'
        return response

    @api.post('/courses/<course_id>/invitations')
    def manage(course_id):
        try:
            header = request.headers.get('Authorization', '').split()
            if len(header) != 2 or header[0].lower() != 'bearer':
                raise InvitationError(401, 'authentication_required')
            if request.content_length is None or request.content_length > 1024:
                raise InvitationError(413, 'request_too_large')
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict) or set(payload) != {'action'}:
                raise InvitationError(400, 'invalid_request')
            uid, client, transact = authenticate(header[1])
            result = mutate_invitation(uid, client, transact, course_id, payload['action'])
            response = jsonify(result)
            response.headers['Cache-Control'] = 'no-store'
            return response
        except InvitationError as error:
            return jsonify(success=False, error=error.code), error.status
        except Exception:
            # Never include tokens, request bodies, or SDK errors in responses/logs.
            return jsonify(success=False, error='invitation_service_unavailable'), 503

    @api.delete('/courses/<course_id>')
    def remove_course(course_id):
        try:
            header = request.headers.get('Authorization', '').split()
            if len(header) != 2 or header[0].lower() != 'bearer':
                raise InvitationError(401, 'authentication_required')
            if request.content_length not in (None, 0):
                raise InvitationError(400, 'invalid_request')
            uid, client, transact = authenticate(header[1])
            return jsonify(delete_course(uid, client, transact, course_id))
        except InvitationError as error:
            return jsonify(success=False, error=error.code), error.status
        except Exception:
            return jsonify(success=False, error='invitation_service_unavailable'), 503

    @api.post('/courses/<course_id>/members/<student_uid>')
    def manage_membership(course_id, student_uid):
        try:
            header = request.headers.get('Authorization', '').split()
            if len(header) != 2 or header[0].lower() != 'bearer':
                raise InvitationError(401, 'authentication_required')
            if request.content_length is None or request.content_length > 1024:
                raise InvitationError(413, 'request_too_large')
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict) or set(payload) != {'action'}:
                raise InvitationError(400, 'invalid_request')
            uid, client, transact = authenticate(header[1])
            return jsonify(mutate_membership(
                uid,
                client,
                transact,
                course_id,
                student_uid,
                payload['action'],
            ))
        except InvitationError as error:
            return jsonify(success=False, error=error.code), error.status
        except Exception:
            return jsonify(success=False, error='invitation_service_unavailable'), 503

    def student_invitation(join):
        try:
            header = request.headers.get('Authorization', '').split()
            if len(header) != 2 or header[0].lower() != 'bearer':
                raise InvitationError(401, 'authentication_required')
            if request.content_length is None or request.content_length > 1024:
                raise InvitationError(413, 'request_too_large')
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict) or set(payload) != {'token'}:
                raise InvitationError(400, 'invalid_request')
            uid, client, transact = authenticate(header[1])
            response = jsonify(redeem_invitation(uid, client, transact, payload['token'], join=join))
            response.headers['Cache-Control'] = 'no-store'
            return response
        except InvitationError as error:
            return jsonify(success=False, error=error.code), error.status
        except Exception:
            return jsonify(success=False, error='invitation_service_unavailable'), 503

    @api.post('/course-invitations/resolve')
    def resolve():
        return student_invitation(False)

    @api.post('/course-invitations/join')
    def join():
        return student_invitation(True)

    return api
