export interface FacePrivacyProfile {
  optOutFlag: boolean;
  faceEnrolled?: boolean;
  faceConsentRevision?: number;
  faceDataDeletionStatus?: 'none' | 'pending' | 'deleted';
}
export function faceAccessState(profile: FacePrivacyProfile | null): 'loading' | 'opted_out' | 'deletion_pending' | 'ready';
export function optOutUpdate(profile: FacePrivacyProfile | null, optOut: boolean, timestamp: unknown): Record<string, unknown>;
export function deletionMessage(status?: string): string;
export const LOCATION_CHECK_IN_PENDING: string;
