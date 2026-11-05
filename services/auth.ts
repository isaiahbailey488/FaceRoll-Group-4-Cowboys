import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { generateStudentId, isSevenDigitStudentId } from './student-id';
import { fallbackNameFromEmail, getStudentDisplayName } from './profile-name';
import { isTerminalAuthError } from '../shared/auth-session';
import { optOutUpdate } from '../shared/face-privacy';

export { fallbackNameFromEmail, getStudentDisplayName } from './profile-name';

export interface User {
  uid: string;
  email: string | null;
}

export interface UserProfile {
  uid: string;
  userId: string;
  studentId: string;
  email: string;
  displayName: string;
  fname: string;
  lname: string;
  fullName: string;
  name: string;
  role: 'student' | 'instructor' | 'admin';
  userType: string;
  optOutFlag: boolean;
  faceEnrolled: boolean;
  faceConsentRevision?: number;
  faceDataDeletionStatus?: 'none' | 'pending' | 'deleted';
  createdAt?: any;
}

const SESSION_VALIDATION_TIMEOUT_MS = 6000;

function mapFirebaseUser(user: FirebaseUser): User {
  return {
    uid: user.uid,
    email: user.email,
  };
}

function normalizeProfile(uid: string, email: string, data: any): UserProfile {
  const resolvedName = getStudentDisplayName(data, email);
  const resolvedParts = resolvedName.split(/\s+/).filter(Boolean);
  const firstName = resolvedParts[0] || 'Student';
  const lastName = resolvedParts.slice(1).join(' ');

  return {
    uid,
    userId: data?.userId || data?.uid || uid,
    studentId: data?.studentId || data?.userId || uid,
    email: data?.email || email,
    displayName: resolvedName,
    fname: firstName,
    lname: lastName,
    fullName: resolvedName,
    name: resolvedName,
    role: (data?.role || 'student') as 'student' | 'instructor' | 'admin',
    userType: data?.userType || data?.role || 'student',
    optOutFlag: Boolean(data?.optOutFlag),
    faceEnrolled: Boolean(data?.faceEnrolled),
    faceConsentRevision: data?.faceConsentRevision ?? 0,
    faceDataDeletionStatus: data?.faceDataDeletionStatus ?? 'none',
    createdAt: data?.createdAt,
  };
}

export class FirestoreRulesNotDeployedError extends Error {
  code = 'firestore/rules-not-deployed';
  constructor(originalMessage?: string) {
    super(
      'Firestore security rules are blocking this write. ' +
        'Deploy firestore.rules to your Firebase project (see FIRESTORE_SETUP.md). ' +
        (originalMessage ? `Underlying error: ${originalMessage}` : '')
    );
    this.name = 'FirestoreRulesNotDeployedError';
  }
}

function isPermissionDenied(err: any): boolean {
  const code = err?.code || '';
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'permission-denied' ||
    code === 'firestore/permission-denied' ||
    msg.includes('missing or insufficient permissions') ||
    msg.includes('permission_denied')
  );
}

async function ensureUserProfileDoc(
  uid: string,
  email: string,
  firstName?: string,
  lastName?: string,
  replaceName = false
): Promise<void> {
  const userRef = doc(db, 'users', uid);

  // Try to read first. If rules block reads, we still try the write below.
  let existing = false;
  let existingStudentId: unknown;
  let existingProfile: any = null;
  try {
    const snap = await getDoc(userRef);
    existing = snap.exists();
    existingProfile = existing ? snap.data() : null;
    existingStudentId = existingProfile?.studentId;
  } catch (readErr: any) {
    if (!isPermissionDenied(readErr)) throw readErr;
    // Permission denied on read — assume doc does not exist and try to create.
  }

  const fname = String(firstName || 'Student').trim();
  const lname = String(lastName || '').trim();
  const fullName = `${fname} ${lname}`.trim();
  const existingName = getStudentDisplayName(existingProfile, email);
  const shouldUpdateExistingName = Boolean(firstName || lastName) &&
    (replaceName || existingName === 'Student');

  if (existing && isSevenDigitStudentId(existingStudentId)) {
    if (shouldUpdateExistingName) {
      await updateDoc(userRef, {
        displayName: fullName,
        fname,
        lname,
        fullName,
        name: fullName,
      });
    }
    return;
  }

  const newProfile = {
    uid,
    userId: uid,
    email: email.toLowerCase().trim(),
    displayName: fullName,
    fname,
    lname,
    fullName,
    name: fullName,
    role: 'student' as const,
    userType: 'student',
    optOutFlag: false,
    faceEnrolled: false,
    faceConsentRevision: 0,
    faceDataDeletionStatus: 'none',
    createdAt: serverTimestamp(),
  };

  const studentId = generateStudentId();
  const existingProfileUpdate = shouldUpdateExistingName
    ? {
        studentId,
        displayName: fullName,
        fname,
        lname,
        fullName,
        name: fullName,
      }
    : { studentId };
  try {
    await setDoc(
      userRef,
      existing ? existingProfileUpdate : { ...newProfile, studentId },
      { merge: true }
    );
  } catch (writeErr: any) {
    if (isPermissionDenied(writeErr)) {
      throw new FirestoreRulesNotDeployedError(writeErr?.message);
    }
    throw writeErr;
  }
}

export async function registerUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string
): Promise<User> {
  const normalizedEmail = email.toLowerCase().trim();
  const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
  const user = credential.user;
  const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();

  await updateProfile(user, { displayName: fullName });
  await ensureUserProfileDoc(user.uid, normalizedEmail, firstName, lastName, true);
  await updateDoc(doc(db, 'users', user.uid), {
    displayName: fullName,
    fname: firstName.trim(),
    lname: lastName.trim(),
    fullName,
    name: fullName,
  });
  return mapFirebaseUser(user);
}

export async function loginUser(email: string, password: string): Promise<User> {
  const normalizedEmail = email.toLowerCase().trim();
  const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
  // Authentication should not be held up by a Firestore profile read. Screens
  // load and repair the signed-in user's profile through getUserProfile().
  return mapFirebaseUser(credential.user);
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export async function validateCurrentSession(): Promise<User | null> {
  const sessionUser = auth.currentUser;
  if (!sessionUser) return null;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutError: any = new Error('Session validation timed out.');
        timeoutError.code = 'auth/network-request-failed';
        reject(timeoutError);
      }, SESSION_VALIDATION_TIMEOUT_MS);

      sessionUser.getIdToken(true).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  } catch (error) {
    if (isTerminalAuthError(error)) {
      // Do not sign out a newer session that replaced the one being checked.
      if (auth.currentUser === sessionUser) {
        try {
          await signOut(auth);
        } catch {
          // Routing still treats the invalid session as signed out.
        }
      }
      const replacementUser = auth.currentUser;
      return replacementUser && replacementUser !== sessionUser
        ? mapFirebaseUser(replacementUser)
        : null;
    }

    // Brief connectivity loss does not invalidate Firebase's persisted session.
    const offlineUser = auth.currentUser;
    return offlineUser ? mapFirebaseUser(offlineUser) : null;
  }

  const activeUser = auth.currentUser;
  return activeUser ? mapFirebaseUser(activeUser) : null;
}

export async function resetPassword(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  await sendPasswordResetEmail(auth, normalizedEmail);
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const current = auth.currentUser;
  if (!current || current.uid !== uid) {
    return null;
  }

  const userRef = doc(db, 'users', uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    await ensureUserProfileDoc(uid, current.email || `${uid}@unknown.local`);
    const reloaded = await getDoc(userRef);
    if (!reloaded.exists()) {
      return null;
    }
    return normalizeProfile(uid, current.email || '', reloaded.data());
  }

  return normalizeProfile(uid, current.email || '', snap.data());
}

export async function updateOptOut(uid: string, optOut: boolean): Promise<void> {
  const userRef = doc(db, 'users', uid);
  if (auth.currentUser?.uid !== uid) throw new Error('Sign in again before changing your preference.');
  try {
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(userRef);
      if (!snapshot.exists()) throw new Error('Your profile could not be loaded. Try again.');
      const changes = optOutUpdate(snapshot.data() as UserProfile, optOut, serverTimestamp());
      if (Object.keys(changes).length) transaction.update(userRef, changes);
    });
  } catch (err: any) {
    if (isPermissionDenied(err)) {
      throw new FirestoreRulesNotDeployedError(err?.message);
    }
    throw err;
  }
}

export async function getFacePrivacyProfile(uid: string): Promise<UserProfile> {
  const current = auth.currentUser;
  if (!current || current.uid !== uid) throw new Error('Sign in again.');
  const snapshot = await getDocFromServer(doc(db, 'users', uid));
  if (!snapshot.exists()) throw new Error('Your face preference could not be verified.');
  return normalizeProfile(uid, current.email || '', snapshot.data());
}

export function subscribeToProfile(uid: string, onProfile: (profile: UserProfile) => void, onError: () => void) {
  return onSnapshot(doc(db, 'users', uid), { includeMetadataChanges: true }, snapshot => {
    // Camera consent must be authoritative, including after a network interruption.
    if (!snapshot.exists() || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites || auth.currentUser?.uid !== uid) {
      onError();
      return;
    }
    onProfile(normalizeProfile(uid, auth.currentUser.email || '', snapshot.data()));
  }, onError);
}

export function subscribeToAuthState(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, (firebaseUser) => {
    callback(firebaseUser ? mapFirebaseUser(firebaseUser) : null);
  });
}

export function getCurrentUser(): User | null {
  const current = auth.currentUser;
  return current ? mapFirebaseUser(current) : null;
}
