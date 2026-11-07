import {
  collection,
  getDocs,
  query,
  where,
  limit as limitDocs,
} from 'firebase/firestore';
import { db } from './firebase';
import { activeCourseIds } from '../shared/session-access';
import { checkInDecision } from '../shared/session-policy';
import { courseLocationRequirement, LocationRequirement } from '../shared/checkin-location';

export interface AttendanceRecord {
  id: string;
  courseId: string;
  courseName: string;
  sessionId: string;
  time: string;
  status: 'present' | 'late' | 'absent';
  method?: string;
}

export interface Session {
  id: string;
  sessionId: string;
  courseId: string;
  courseName: string;
  startTime: string;
  locationRequirement?: LocationRequirement;
  zonePolicyVersion?: number;
  classroomZone?: unknown;
  gracePeriodMinutes: number;
  policyVersion?: number;
  startedAtMs?: number;
  attendanceWindowMinutes?: number;
  allowLate?: boolean;
  defaultAttendance?: 'present' | 'late' | 'absent';
  checkInClosesAtMs?: number | null;
  status: 'active' | 'closed';
}

function toIsoString(value: any): string {
  if (!value) return new Date().toISOString();

  if (typeof value?.toDate === 'function') {
    return value.toDate().toISOString();
  }

  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();

  return new Date().toISOString();
}

function normalizeAttendanceStatus(value: any): 'present' | 'late' | 'absent' {
  const s = String(value || '').toLowerCase().trim();
  if (s === 'absent') return 'absent';
  if (s === 'late') return 'late';
  return 'present';
}

async function getCourseNameById(courseId: string): Promise<string> {
  if (!courseId) return '';
  const snap = await getDocs(query(collection(db, 'courses'), where('courseId', '==', courseId), limitDocs(1)));

  if (!snap.empty) {
    const data = snap.docs[0].data() as any;
    return data.courseName || data.name || '';
  }

  return '';
}

async function getSessionById(sessionId: string): Promise<any | null> {
  const q = query(collection(db, 'sessions'), where('sessionId', '==', sessionId), limitDocs(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function getRecentActivity(uid: string, max = 10): Promise<AttendanceRecord[]> {
  const q = query(collection(db, 'attendance'), where('uid', '==', uid));

  const snap = await getDocs(q);

  const rows = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data() as any;
      const sessionId = data.sessionId || '';
      const session = sessionId ? await getSessionById(sessionId) : null;
      const courseId = data.courseId || session?.courseId || '';
      const courseName = (await getCourseNameById(courseId)) || 'Unknown Course';

      return {
        id: data.id || d.id,
        courseId,
        courseName,
        sessionId,
        time: toIsoString(data.time),
        status: normalizeAttendanceStatus(data.status),
        method: data.method || 'face recognition',
      } as AttendanceRecord;
    })
  );

  rows.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return rows.slice(0, max);
}

export async function getActiveSessionForUser(uid: string): Promise<{ sessionId: string; courseId: string } | null> {
  const sessions = await getActiveSessions(uid);
  if (!sessions.length) return null;
  return {
    sessionId: sessions[0].sessionId,
    courseId: sessions[0].courseId,
  };
}

export async function getActiveSessions(uid: string): Promise<Session[]> {
  if (!uid) return [];
  const [snap, enrollmentSnap] = await Promise.all([
    getDocs(query(collection(db, 'sessions'))),
    getDocs(query(collection(db, 'enrollments'), where('uid', '==', uid))),
  ]);
  const allowedCourses = activeCourseIds(
    enrollmentSnap.docs.map((entry) => entry.data()),
    uid
  );

  const now = Date.now();

  const rawActive = snap.docs
    .map((d) => {
      const data = d.data() as any;
      const startIso = toIsoString(data.startTime);
      const explicitStatus = String(data.status || '').toLowerCase();
      const decision = checkInDecision({ ...data,
        status: explicitStatus || 'active' }, now);

      return {
        id: data.id || d.id,
        sessionId: data.sessionId || d.id,
        courseId: data.courseId || '',
        courseName: '',
        startTime: startIso,
        gracePeriodMinutes: Number(data.gracePeriodMinutes ?? 10),
        policyVersion: data.policyVersion,
        zonePolicyVersion: data.zonePolicyVersion,
        classroomZone: data.classroomZone,
        startedAtMs: data.startedAtMs,
        attendanceWindowMinutes: data.attendanceWindowMinutes,
        allowLate: data.allowLate,
        defaultAttendance: data.defaultAttendance,
        checkInClosesAtMs: data.checkInClosesAtMs,
        status: decision.allowed ? 'active' : 'closed',
      } as Session;
    })
    .filter((s) => s.status === 'active' && allowedCourses.has(s.courseId))
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  const uniqueCourseIds = Array.from(new Set(rawActive.map((s) => s.courseId).filter(Boolean)));
  const courseDetails = new Map<string, { name: string; location: LocationRequirement }>();
  await Promise.all(
    uniqueCourseIds.map(async (cid) => {
      // Location requirements must come from the saved course, never a route
      // parameter. Ambiguous/missing records cannot silently disable collection.
      const courses = await getDocs(query(collection(db, 'courses'), where('courseId', '==', cid), limitDocs(2)));
      const course = courses.size === 1 ? courses.docs[0].data() : null;
      courseDetails.set(cid, { name: course?.courseName || course?.name || cid,
        location: courseLocationRequirement(course) });
    })
  );

  return rawActive.map((s) => ({
    ...s,
    courseName: courseDetails.get(s.courseId)?.name || s.courseId || '',
    locationRequirement: s.zonePolicyVersion === undefined
      ? courseDetails.get(s.courseId)?.location || { kind: 'unavailable' }
      : s.zonePolicyVersion === 1 ? courseLocationRequirement({ location: s.classroomZone }) : { kind: 'unavailable' },
  }));
}

export function formatAttendanceDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
