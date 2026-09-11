import {
  collection,
  doc,
  getDocs,
  query,
  where,
  limit as limitDocs,
  runTransaction,
} from 'firebase/firestore';
import { db } from './firebase';

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
  gracePeriodMinutes: number;
  status: 'active' | 'closed';
}

export interface SubmitAttendanceInput {
  uid: string;
  sessionId: string;
  courseId?: string;
  method?: string;
  source?: 'phone_face_verification' | 'classroom_camera';
  status?: 'present' | 'late' | 'absent';
}

export function buildAttendanceDocumentId(sessionId: string, uid: string): string {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedUid = String(uid || '').trim();
  if (!normalizedSessionId || !normalizedUid) {
    throw new Error('Attendance requires a session ID and Firebase UID.');
  }
  if (normalizedSessionId.includes('/') || normalizedUid.includes('/')) {
    throw new Error('Attendance identity contains an invalid document path.');
  }
  return `${normalizedSessionId}_${normalizedUid}`;
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

export async function getActiveSessionForUser(_uid: string): Promise<{ sessionId: string; courseId: string } | null> {
  const sessions = await getActiveSessions();
  if (!sessions.length) return null;
  return {
    sessionId: sessions[0].sessionId,
    courseId: sessions[0].courseId,
  };
}

export async function getActiveSessions(): Promise<Session[]> {
  const MAX_SESSION_HOURS = 3;
  const q = query(collection(db, 'sessions'));
  const snap = await getDocs(q);

  const now = Date.now();
  const maxAgeMs = MAX_SESSION_HOURS * 60 * 60 * 1000;

  const rawActive = snap.docs
    .map((d) => {
      const data = d.data() as any;
      const startIso = toIsoString(data.startTime);
      const startMs = new Date(startIso).getTime();
      const explicitStatus = String(data.status || '').toLowerCase();
      const hasEndTime = Boolean(data.endTime);

      const isClosed = explicitStatus === 'closed' || hasEndTime;
      const withinWindow = now - startMs <= maxAgeMs && now - startMs >= -60 * 1000;
      const isActive = !isClosed && withinWindow;

      return {
        id: data.id || d.id,
        sessionId: data.sessionId || d.id,
        courseId: data.courseId || '',
        courseName: '',
        startTime: startIso,
        gracePeriodMinutes: Number(data.gracePeriodMinutes ?? 10),
        status: isActive ? 'active' : 'closed',
      } as Session;
    })
    .filter((s) => s.status === 'active')
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  const uniqueCourseIds = Array.from(new Set(rawActive.map((s) => s.courseId).filter(Boolean)));
  const courseNameMap = new Map<string, string>();
  await Promise.all(
    uniqueCourseIds.map(async (cid) => {
      const name = await getCourseNameById(cid);
      if (name) courseNameMap.set(cid, name);
    })
  );

  return rawActive.map((s) => ({
    ...s,
    courseName: courseNameMap.get(s.courseId) || s.courseId || '',
  }));
}

export async function submitAttendance(
  uidOrInput: string | SubmitAttendanceInput,
  sessionId?: string,
  courseId?: string,
  status: 'present' | 'late' | 'absent' = 'present',
  method = 'face recognition',
  _confidence = 0.95
): Promise<{ success: boolean; id: string; duplicate?: boolean }> {
  const nowIso = new Date().toISOString();

  const payload =
    typeof uidOrInput === 'string'
      ? {
          uid: uidOrInput,
          sessionId: sessionId || '',
          courseId: courseId || '',
          status,
          method,
          source: 'phone_face_verification' as const,
        }
      : {
          uid: uidOrInput.uid,
          sessionId: uidOrInput.sessionId,
          courseId: uidOrInput.courseId || '',
          status: uidOrInput.status || 'present',
          method: uidOrInput.method || 'face recognition',
          source: uidOrInput.source || ('phone_face_verification' as const),
        };

  const attendanceDocId = buildAttendanceDocumentId(payload.sessionId, payload.uid);
  const attendanceRef = doc(db, 'attendance', attendanceDocId);
  const created = await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(attendanceRef);
    if (existing.exists()) return false;

    transaction.set(attendanceRef, {
      id: attendanceDocId,
      uid: payload.uid,
      userId: payload.uid,
      sessionId: payload.sessionId,
      courseId: payload.courseId,
      status: payload.status,
      method: payload.method,
      source: payload.source,
      time: nowIso,
      createdAt: nowIso,
    });
    return true;
  });

  return { success: true, id: attendanceDocId, duplicate: !created };
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
