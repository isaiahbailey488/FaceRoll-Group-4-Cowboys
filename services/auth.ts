import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  User as FirebaseUser,
} from '@firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from '@firebase/firestore';
import { auth, db } from './firebase';

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

export function fallbackNameFromEmail(email: string) {
  const localPart = (email || '').split('@')[0] || 'student';
  const cleaned = localPart.replace(/[._-]+/g, ' ').trim();
  const words = cleaned
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  if (!words.length) return { firstName: 'Student', lastName: 'User' };
  if (words.length === 1) return { firstName: words[0], lastName: 'User' };
  return { firstName: words[0], lastName: words.slice(1).join(' ') };
}

function normalizeProfile(uid: string, email: string, data: any): UserProfile {
  const fallbackName = fallbackNameFromEmail(email);

  const firstName = data?.fname || fallbackName.firstName;
  const lastName = data?.lname || fallbackName.lastName;
  const fullName = data?.fullName || data?.displayName || `${firstName} ${lastName}`.trim();

  return {
    uid,
    userId: data?.userId || data?.uid || uid,
    studentId: data?.studentId || data?.userId || uid,
    email: data?.email || email,
    displayName: data?.displayName || fullName,
    fname: firstName,
    lname: lastName,
    fullName,
    name: data?.name || fullName,
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
  lastName?: string
): Promise<void> {
  const userRef = doc(db, 'users', uid);

  // Try to read first. If rules block reads, we still try the write below.
  let existing = false;
  try {
    const snap = await getDoc(userRef);
    existing = snap.exists();
  } catch (readErr: any) {
    if (!isPermissionDenied(readErr)) throw readErr;
    // Permission denied on read — assume doc does not exist and try to create.
  }

  if (existing) return;

  const fallback = fallbackNameFromEmail(email);
  const fname = (firstName || fallback.firstName).trim();
  const lname = (lastName || fallback.lastName).trim();
  const fullName = `${fname} ${lname}`.trim();

  try {
    await setDoc(userRef, {
      uid,
      userId: uid,
      studentId: uid,
      email: email.toLowerCase().trim(),
      displayName: fullName,
      fname,
      lname,
      fullName,
      name: fullName,
      role: 'student',
      userType: 'student',
      optOutFlag: false,
      faceEnrolled: false,
      createdAt: serverTimestamp(),
    });
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

  await ensureUserProfileDoc(user.uid, normalizedEmail, firstName, lastName);
  return mapFirebaseUser(user);
}

export async function loginUser(email: string, password: string): Promise<User> {
  const normalizedEmail = email.toLowerCase().trim();
  const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
  const user = credential.user;

  // Ensure profile exists even for users created elsewhere
  await ensureUserProfileDoc(user.uid, normalizedEmail);
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
