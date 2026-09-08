import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import { auth } from './firebase';

const REQUEST_TIMEOUT_MS = 120_000;
const ENROLLMENT_SAMPLE_COUNT = 3;

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type EnrollmentResult = {
  success: true;
  uid: string;
  sampleCount: number;
  model: string;
  message: string;
};

export type RecognitionResult = {
  success: true;
  recognized: boolean;
  uid: string | null;
  confidence: number;
  distance: number | null;
  threshold: number;
  model: string;
};

export class RecognitionApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'RecognitionApiError';
    this.code = code;
    this.status = status;
  }
}

export function discardTemporaryCameraFile(uri?: string): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The operating system can remove an already-expired camera cache entry.
  }
}

function configuredApiUrl(): string {
  const publicEnvironmentUrl = process.env.EXPO_PUBLIC_RECOGNITION_API_URL;
  const extra = Constants?.expoConfig?.extra as
    | { recognitionApiUrl?: string }
    | undefined;
  const manifestExtra = (Constants as any)?.manifest?.extra as
    | { recognitionApiUrl?: string }
    | undefined;
  const value =
    publicEnvironmentUrl ||
    extra?.recognitionApiUrl ||
    manifestExtra?.recognitionApiUrl ||
    '';
  const normalized = value.trim().replace(/\/+$/, '');

  if (!normalized) {
    throw new RecognitionApiError(
      'recognition_api_not_configured',
      'The recognition server address is not configured. Set EXPO_PUBLIC_RECOGNITION_API_URL before starting Expo.'
    );
  }
  if (!/^https?:\/\//i.test(normalized)) {
    throw new RecognitionApiError(
      'invalid_recognition_api_url',
      'The recognition server address must begin with http:// or https://.'
    );
  }
  const safeDevelopmentHttp = /^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?$/i;
  if (normalized.toLowerCase().startsWith('http://') && !safeDevelopmentHttp.test(normalized)) {
    throw new RecognitionApiError(
      'insecure_recognition_api_url',
      'Face photographs and Firebase tokens require HTTPS outside a local simulator.'
    );
  }
  return normalized;
}

function messageForError(code: string, fallback?: string): string {
  switch (code) {
    case 'authentication_required':
      return 'Your login has expired. Sign in again and retry.';
    case 'student_required':
      return 'Only authenticated student accounts can use facial recognition.';
    case 'not_enrolled':
      return 'No face enrollment exists for this student. Enroll your face first.';
    case 'invalid_face_image':
      return fallback || 'Exactly one clear face is required in each photograph.';
    case 'request_too_large':
      return 'The captured photographs are too large. Retake them and try again.';
    case 'authentication_unavailable':
      return 'The recognition server cannot verify your login right now.';
    default:
      return fallback || 'The recognition request could not be completed.';
  }
}

async function authenticatedRequest<T>(
  path: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>
): Promise<{ data: T; authenticatedUid: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new RecognitionApiError(
      'authentication_required',
      'You must be signed in to use facial recognition.',
      401
    );
  }

  let idToken: string;
  try {
    idToken = await currentUser.getIdToken();
  } catch {
    throw new RecognitionApiError(
      'authentication_required',
      'Your login could not be verified. Sign in again and retry.',
      401
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${configuredApiUrl()}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as T & ApiErrorPayload;
    if (!response.ok) {
      const code = payload.error || `http_${response.status}`;
      throw new RecognitionApiError(
        code,
        messageForError(code, payload.message),
        response.status
      );
    }
    return { data: payload, authenticatedUid: currentUser.uid };
  } catch (error: any) {
    if (error instanceof RecognitionApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new RecognitionApiError(
        'recognition_timeout',
        'The recognition server took too long to respond. Please try again.'
      );
    }
    throw new RecognitionApiError(
      'recognition_unavailable',
      'Could not reach the recognition server. Check its address and connection.'
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrollFace(images: readonly string[]): Promise<EnrollmentResult> {
  if (
    images.length !== ENROLLMENT_SAMPLE_COUNT ||
    images.some((image) => typeof image !== 'string' || !image.trim())
  ) {
    throw new RecognitionApiError(
      'invalid_enrollment_images',
      `Enrollment requires exactly ${ENROLLMENT_SAMPLE_COUNT} captured photographs.`
    );
  }

  const { data, authenticatedUid } = await authenticatedRequest<any>(
    '/enroll',
    'POST',
    { images }
  );
  if (data.success !== true || data.uid !== authenticatedUid) {
    throw new RecognitionApiError(
      'identity_mismatch',
      'The enrollment response did not match the authenticated student.'
    );
  }
  if (Number(data.sample_count) !== ENROLLMENT_SAMPLE_COUNT || data.model !== 'Facenet512') {
    throw new RecognitionApiError(
      'invalid_enrollment_response',
      'The recognition server did not confirm three Facenet512 samples.'
    );
  }
  return {
    success: true,
    uid: data.uid,
    sampleCount: Number(data.sample_count ?? 0),
    model: String(data.model || ''),
    message: String(data.message || 'Face enrollment saved successfully.'),
  };
}

export async function recognizeFace(image: string): Promise<RecognitionResult> {
  if (typeof image !== 'string' || !image.trim()) {
    throw new RecognitionApiError(
      'invalid_face_image',
      'A captured photograph is required for recognition.'
    );
  }

  const { data, authenticatedUid } = await authenticatedRequest<any>(
    '/recognize',
    'POST',
    { image }
  );
  const recognized = data.success === true && data.recognized === true;
  const uid = typeof data.uid === 'string' && data.uid ? data.uid : null;
  if (recognized && uid !== authenticatedUid) {
    throw new RecognitionApiError(
      'identity_mismatch',
      'Recognition returned a different identity from the authenticated student.'
    );
  }
  return {
    success: true,
    recognized,
    uid: recognized ? uid : null,
    confidence: Number(data.confidence ?? 0),
    distance: data.distance == null ? null : Number(data.distance),
    threshold: Number(data.threshold ?? 0),
    model: String(data.model || ''),
  };
}

export async function deleteFaceEnrollment(): Promise<void> {
  const { data, authenticatedUid } = await authenticatedRequest<any>(
    '/enrollment',
    'DELETE'
  );
  if (data.success !== true || data.uid !== authenticatedUid) {
    throw new RecognitionApiError(
      'identity_mismatch',
      'The deletion response did not match the authenticated student.'
    );
  }
}
