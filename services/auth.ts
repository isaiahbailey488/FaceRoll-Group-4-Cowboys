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
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { generateStudentId, isSevenDigitStudentId } from './student-id';
import { fallbackNameFromEmail, getStudentDisplayName } from './profile-name';

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
  createdAt?: any;
}

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
  const user = credential.user;
  const safeAuthName = getStudentDisplayName({ fullName: user.displayName }, normalizedEmail);
  const authName = safeAuthName === 'Student'
    ? []
    : safeAuthName.split(/\s+/).filter(Boolean);

  // Ensure profile exists even for users created elsewhere
  await ensureUserProfileDoc(
    user.uid,
    normalizedEmail,
    authName[0],
    authName.slice(1).join(' ')
  );
  return mapFirebaseUser(user);
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
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

export async function markFaceEnrolled(uid: string, enrolled: boolean): Promise<void> {
  const userRef = doc(db, 'users', uid);
  try {
    await updateDoc(userRef, { faceEnrolled: enrolled });
  } catch (err: any) {
    if (isPermissionDenied(err)) {
      throw new FirestoreRulesNotDeployedError(err?.message);
    }
    // Doc may not exist yet — fall back to an upsert so enrollment always succeeds.
    if (err?.code === 'not-found' || /no document/i.test(String(err?.message))) {
      await setDoc(userRef, { uid, faceEnrolled: enrolled }, { merge: true });
      return;
    }
    throw err;
  }
}

export async function updateOptOut(uid: string, optOut: boolean): Promise<void> {
  const userRef = doc(db, 'users', uid);
  try {
    await updateDoc(userRef, { optOutFlag: optOut });
  } catch (err: any) {
    if (isPermissionDenied(err)) {
      throw new FirestoreRulesNotDeployedError(err?.message);
    }
    if (err?.code === 'not-found' || /no document/i.test(String(err?.message))) {
      await setDoc(userRef, { uid, optOutFlag: optOut }, { merge: true });
      return;
    }
    throw err;
  }
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
