import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import { auth } from './firebase';

const REQUEST_TIMEOUT_MS = 120_000;
const ENROLLMENT_SAMPLE_COUNT = 3;

function logRecognitionStage(
  stage: string,
  details: Record<string, string | number | boolean | null> = {}
): void {
  if (__DEV__) {
    console.info(`[FaceRoll recognition] ${stage}`, details);
  }
}

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

export function configuredApiUrl(): string {
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

const CONNECTION_ERROR_CODES = new Set([
  'recognition_timeout',
  'recognition_unavailable',
  'http_502',
  'http_503',
  'http_504',
]);

// Server-provided message text is never shown to students; every code maps to
// app-authored copy so internal details cannot leak into the UI.
function messageForError(code: string): string {
  if (CONNECTION_ERROR_CODES.has(code)) {
    return "Can't reach FaceRoll right now. Check your connection and try again.";
  }
  switch (code) {
    case 'authentication_required':
      return 'Your login has expired. Sign in again and retry.';
    case 'student_required':
      return 'Only authenticated student accounts can use facial recognition.';
    case 'not_enrolled':
      return 'No face enrollment exists for this student. Enroll your face first.';
    case 'facial_recognition_opted_out':
      return 'Facial recognition is off. You can manage this preference in Profile & Settings.';
    case 'face_deletion_pending':
      return 'Your saved facial data is still being deleted. Facial recognition remains disabled.';
    case 'face_preference_changed':
      return 'Your face preference changed. Reopen this screen before trying again.';
    case 'face_preference_unavailable':
      return 'Your face preference could not be verified. Check your connection and try again.';
    case 'no_face_detected':
      return "We couldn't find your face. Center it in the oval and move to better light.";
    case 'multiple_faces_detected':
      return 'We see more than one person. Make sure only you are in the frame.';
    case 'invalid_face_image':
      return "The photo wasn't clear. Hold still and try again.";
    case 'request_too_large':
      return 'The captured photographs are too large. Retake them and try again.';
    case 'authentication_unavailable':
      return 'The recognition server cannot verify your login right now.';
    default:
      return 'FaceRoll could not finish that request. Please try again.';
  }
}

/** Errors that mean the login or identity check failed, not the photo. */
export const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'authentication_required',
  'student_required',
  'identity_mismatch',
  'facial_recognition_opted_out', 'face_deletion_pending', 'face_preference_changed', 'face_preference_unavailable',
]);

export type FaceScanFeedback = {
  title: string;
  hint: string;
};

export const NOT_RECOGNIZED_FEEDBACK: FaceScanFeedback = {
  title: "Face didn't match",
  hint: "That didn't match your enrolled face. Remove your hat or sunglasses, face the light, and try again.",
};

function titleForError(code: string): string | null {
  if (CONNECTION_ERROR_CODES.has(code)) return 'Connection problem';
  switch (code) {
    case 'no_face_detected':
      return 'No face found';
    case 'multiple_faces_detected':
      return 'More than one person';
    case 'invalid_face_image':
      return 'Photo not clear';
    case 'not_enrolled':
      return 'Face not enrolled';
    default:
      return AUTH_ERROR_CODES.has(code) ? 'Verification blocked' : null;
  }
}

/** Short title plus actionable hint for a failed enrollment or check-in. */
export function scanFeedbackForError(error: unknown, fallbackTitle: string): FaceScanFeedback {
  if (error instanceof RecognitionApiError) {
    return { title: titleForError(error.code) ?? fallbackTitle, hint: error.message };
  }
  // App-authored errors carry no code; Firebase and native errors do, and their
  // text is not written for students, so it stays hidden.
  const appMessage = error instanceof Error && !(error as { code?: unknown }).code
    ? error.message
    : '';
  return { title: fallbackTitle, hint: appMessage || 'Something went wrong. Please try again.' };
}

async function authenticatedRequest<T>(
  path: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<{ data: T; authenticatedUid: string }> {
  const startedAt = Date.now();
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new RecognitionApiError(
      'authentication_required',
      'You must be signed in to use facial recognition.',
      401
    );
  }

  const apiUrl = configuredApiUrl();
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout>;

  logRecognitionStage('request_started', { method, path });

  const requestOperation = async (): Promise<{
    data: T;
    authenticatedUid: string;
  }> => {
    let idToken: string;
    logRecognitionStage('firebase_token_requested', { path });
    try {
      idToken = await currentUser.getIdToken();
    } catch {
      throw new RecognitionApiError(
        'authentication_required',
        'Your login could not be verified. Sign in again and retry.',
        401
      );
    }
    logRecognitionStage('firebase_token_ready', {
      path,
      elapsedMs: Date.now() - startedAt,
    });
    if (timedOut) {
      throw new RecognitionApiError(
        'recognition_timeout',
        messageForError('recognition_timeout')
      );
    }

    const serializedBody = body ? JSON.stringify(body) : undefined;
    logRecognitionStage('request_payload_ready', {
      path,
      bodyCharacters: serializedBody?.length ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
    if (timedOut) {
      throw new RecognitionApiError(
        'recognition_timeout',
        messageForError('recognition_timeout')
      );
    }

    logRecognitionStage('request_sending', {
      path,
      elapsedMs: Date.now() - startedAt,
    });
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...(serializedBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: serializedBody,
      signal: controller.signal,
    });

    logRecognitionStage('response_received', {
      path,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    });
    const payload = (await response.json().catch(() => ({}))) as T & ApiErrorPayload;
    if (!response.ok) {
      const code = payload.error || `http_${response.status}`;
      throw new RecognitionApiError(
        code,
        messageForError(code),
        response.status
      );
    }
    return { data: payload, authenticatedUid: currentUser.uid };
  };

  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      logRecognitionStage('request_timed_out', {
        path,
        elapsedMs: Date.now() - startedAt,
      });
      reject(
        new RecognitionApiError(
          'recognition_timeout',
          messageForError('recognition_timeout')
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestOperation(), deadline]);
  } catch (error: any) {
    logRecognitionStage('request_failed', {
      path,
      code: error?.code || error?.name || 'unknown_error',
      elapsedMs: Date.now() - startedAt,
    });
    if (error instanceof RecognitionApiError) throw error;
    if (timedOut || error?.name === 'AbortError') {
      throw new RecognitionApiError(
        'recognition_timeout',
        messageForError('recognition_timeout')
      );
    }
    throw new RecognitionApiError(
      'recognition_unavailable',
      messageForError('recognition_unavailable')
    );
  } finally {
    clearTimeout(timeout!);
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
      messageForError('invalid_face_image')
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

export async function deleteFaceEnrollment(): Promise<'pending' | 'deleted'> {
  const { data, authenticatedUid } = await authenticatedRequest<any>(
    '/enrollment',
    'DELETE', undefined, 15000
  );
  if (data.success !== true || data.uid !== authenticatedUid) {
    throw new RecognitionApiError(
      'identity_mismatch',
      'The deletion response did not match the authenticated student.'
    );
  }
  if (!['pending', 'deleted'].includes(data.deletionStatus)) throw new Error('Deletion could not be confirmed. Retry to check its status.');
  return data.deletionStatus;
}
