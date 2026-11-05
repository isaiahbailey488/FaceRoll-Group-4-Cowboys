export interface AttendancePolicy {
  defaultAttendance: 'present' | 'late' | 'absent';
  gracePeriodMinutes: number;
  attendanceWindowMinutes: number;
  allowLate: boolean;
}
export const DEFAULTS: Readonly<AttendancePolicy>;
export function normalizeSettings(value?: Partial<AttendancePolicy> | null): AttendancePolicy;
export function settingsForSession(session: any): AttendancePolicy;
export function snapshot(settings: Partial<AttendancePolicy>, now?: number | Date): AttendancePolicy & {
  policyVersion: number; startedAtMs: number; startTime: string; date: string; checkInClosesAtMs: number | null;
};
export function checkInDecision(session: any, now?: number | Date): {
  allowed: boolean; status?: 'present' | 'late'; code?: string; message?: string;
};
export function localDate(value?: number | Date): string;
export function toMillis(value: unknown): number;
