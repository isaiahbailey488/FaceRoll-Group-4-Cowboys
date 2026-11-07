export interface CheckInLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly capturedAtMs: number;
  readonly mocked: boolean | null;
}
export interface CheckInRequest {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly image: string | null;
  readonly location: CheckInLocation | null;
}
export interface CheckInSuccess {
  readonly schemaVersion: 1;
  readonly success: true;
  readonly attendanceId: string;
  readonly sessionId: string;
  readonly courseId: string;
  readonly status: 'present' | 'late';
  readonly locationStatus: 'in_zone' | 'not_required';
  readonly recordedAt: string;
  readonly duplicate: boolean;
}
export function validateCheckInRequest(value: unknown): CheckInRequest;
export function validateCheckInSuccess(value: unknown): CheckInSuccess;
