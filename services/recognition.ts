import { runtimeConfig } from './runtime-config';
import { File } from 'expo-file-system';
import { fetch as secureFetch } from 'expo/fetch';
import { auth } from './firebase';
import { CheckInRequest, CheckInSuccess, validateCheckInRequest, validateCheckInSuccess } from '../shared/checkin-contract';
import { isSampleFresh, LocationCaptureError, locationFeedback } from '../shared/checkin-location';

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
  return runtimeConfig.apiUrl;
}

const CONNECTION_ERROR_CODES = new Set([
  'recognition_timeout',
  'recognition_unavailable',
  'http_502',
  'http_503',
  'http_504',
  'check_in_unavailable', 'check_in_timeout',
]);

const CHECK_IN_MESSAGES: Record<string, string> = {
  check_in_unavailable: 'Check-in could not be confirmed. Check your connection and retry. If it was already accepted, the original record will be kept.',
  check_in_timeout: 'Check-in could not be confirmed in time. Check Recent Activity or retry; an accepted record will not be replaced.',
  check_in_cancelled: 'Check-in was cancelled. Check Recent Activity if the request had already been sent.',
  invalid_check_in_request: 'The check-in request could not be prepared. Try checking in again; location is collected automatically when needed.',
  invalid_check_in_response: 'The server did not confirm a valid attendance result. Check Recent Activity before retrying.',
  identity_mismatch: 'The response did not match your account and selected class. Reopen check-in and try again.',
  membership_required: 'You are not actively enrolled in this course. Refresh your courses or ask your instructor for help.',
  course_unavailable: 'This course is unavailable. Reopen Check-In or ask your instructor for help.',
  attendance_session_closed: 'This class session has ended. Ask your instructor if your attendance needs to be recorded.',
  attendance_session_changed: 'This class session changed. Close and reopen Check-In before trying again.',
  attendance_session_not_started: 'This class session has not started. Wait for your instructor, then reopen Check-In.',
  attendance_policy_invalid: 'The session settings are unavailable. Ask your instructor to restart the session.',
  attendance_window_closed: 'The check-in window has closed. Ask your instructor for help.',
  attendance_late_disabled: 'The grace period has ended and late check-ins are disabled. Ask your instructor for help.',
  attendance_already_recorded: 'Attendance is already recorded for this class. Check Recent Activity or ask your instructor about the recorded status.',
  attendance_record_conflict: 'The attendance record has changed. Check Recent Activity or ask your instructor for help.',
  face_required: 'Facial recognition is on. Enroll your face if needed, then reopen Check-In to take a photo. Classroom location is collected automatically.',
  face_not_allowed: 'Facial recognition is off. Reopen check-in to submit location only, without a photo.',
};
const LOCATION_CODES = new Set(['location_required', 'location_policy_invalid', 'location_mocked', 'location_stale',
  'location_future', 'location_inaccurate', 'location_outside_zone', 'location_uncertain', 'location_unverified', 'location_unavailable']);
const KNOWN_API_CODES = new Set([...Object.keys(CHECK_IN_MESSAGES), ...LOCATION_CODES,
  'authentication_required', 'student_required', 'not_enrolled', 'facial_recognition_opted_out',
  'face_deletion_pending', 'face_preference_changed', 'face_preference_unavailable',
  'no_face_detected', 'multiple_faces_detected', 'invalid_face_image', 'request_too_large',
  'authentication_unavailable', 'face_not_recognized', 'recognition_unavailable', 'recognition_timeout']);

// Server-provided message text is never shown to students; every code maps to
// app-authored copy so internal details cannot leak into the UI.
function messageForError(code: string): string {
  if (CHECK_IN_MESSAGES[code]) return CHECK_IN_MESSAGES[code];
  if (LOCATION_CODES.has(code)) return locationFeedback(new LocationCaptureError(code)).hint;
  if (code === 'face_not_recognized') return NOT_RECOGNIZED_FEEDBACK.hint;
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
      return 'More than one face was detected. Make sure only you are in the full camera view and try again with better lighting.';
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
  if (LOCATION_CODES.has(code)) return locationFeedback(new LocationCaptureError(code)).title;
  if (code === 'face_not_recognized') return NOT_RECOGNIZED_FEEDBACK.title;
  if (code === 'attendance_already_recorded') return 'Attendance already recorded';
  if (code.startsWith('attendance_') || code === 'course_unavailable' || code === 'membership_required') return 'Check-in unavailable';
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
  timeoutMs = REQUEST_TIMEOUT_MS,
  options: { signal?: AbortSignal; expectedUid?: string; beforeSend?: () => void } = {}
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
  const checkIn = path === '/attendance/check-in';
  const timeoutCode = checkIn ? 'check_in_timeout' : 'recognition_timeout';
  const unavailableCode = checkIn ? 'check_in_unavailable' : 'recognition_unavailable';
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout>;
  const assertCurrent = () => {
    if (options.signal?.aborted) throw new RecognitionApiError('check_in_cancelled', messageForError('check_in_cancelled'));
    if (auth.currentUser?.uid !== currentUser.uid || (options.expectedUid && options.expectedUid !== currentUser.uid)) {
      throw new RecognitionApiError('identity_mismatch', messageForError('identity_mismatch'));
    }
    if (timedOut) throw new RecognitionApiError(timeoutCode, messageForError(timeoutCode));
  };
  assertCurrent();
  let cancelRequest: (() => void) | undefined;

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
    assertCurrent();

    const serializedBody = body ? JSON.stringify(body) : undefined;
    logRecognitionStage('request_payload_ready', {
      path,
      bodyCharacters: serializedBody?.length ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
    assertCurrent();
    options.beforeSend?.();

    logRecognitionStage('request_sending', {
      path,
      elapsedMs: Date.now() - startedAt,
    });
    // Expo's native adapter enforces redirect:error on iOS/Android. React
    // Native's XHR-based global fetch ignores that option.
    const response = await secureFetch(`${apiUrl}${path}`, {
      method,
      redirect: 'error',
      credentials: 'omit',
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
    assertCurrent();
    if (!response.ok) {
      const code = typeof payload?.error === 'string' && KNOWN_API_CODES.has(payload.error) ? payload.error : `http_${response.status}`;
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
          timeoutCode,
          messageForError(timeoutCode)
        )
      );
    }, timeoutMs);
  });

  const cancellation = new Promise<never>((_, reject) => {
    cancelRequest = () => {
      controller.abort();
      reject(new RecognitionApiError('check_in_cancelled', messageForError('check_in_cancelled')));
    };
    options.signal?.addEventListener('abort', cancelRequest, { once: true });
    if (options.signal?.aborted) cancelRequest();
  });

  try {
    return await Promise.race([requestOperation(), deadline, cancellation]);
  } catch (error: any) {
    logRecognitionStage('request_failed', {
      path,
      code: error?.code || error?.name || 'unknown_error',
      elapsedMs: Date.now() - startedAt,
    });
    if (error instanceof RecognitionApiError) throw error;
    if (timedOut || error?.name === 'AbortError') {
      throw new RecognitionApiError(
        timeoutCode,
        messageForError(timeoutCode)
      );
    }
    throw new RecognitionApiError(
      unavailableCode,
      messageForError(unavailableCode)
    );
  } finally {
    clearTimeout(timeout!);
    if (cancelRequest) options.signal?.removeEventListener('abort', cancelRequest);
  }
}

/** One authoritative request; never writes attendance from the phone. */
export async function checkInAttendance(input: CheckInRequest, options: {
  expectedUid: string; expectedCourseId: string; signal?: AbortSignal;
}): Promise<CheckInSuccess> {
  let payload: CheckInRequest;
  try { payload = validateCheckInRequest(input); }
  catch { throw new RecognitionApiError('invalid_check_in_request', messageForError('invalid_check_in_request')); }
  const { data, authenticatedUid } = await authenticatedRequest<unknown>('/attendance/check-in', 'POST',
    { ...payload }, REQUEST_TIMEOUT_MS, { ...options, beforeSend: () => {
      if (payload.location && !isSampleFresh(payload.location, Date.now())) {
        throw new RecognitionApiError('location_stale', messageForError('location_stale'));
      }
    } });
  let result: CheckInSuccess;
  try { result = validateCheckInSuccess(data); }
  catch { throw new RecognitionApiError('invalid_check_in_response', messageForError('invalid_check_in_response')); }
  if (result.sessionId !== payload.sessionId || result.courseId !== options.expectedCourseId ||
      result.attendanceId !== `${payload.sessionId}_${authenticatedUid}`) {
    throw new RecognitionApiError('identity_mismatch', messageForError('identity_mismatch'));
  }
  return result;
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
