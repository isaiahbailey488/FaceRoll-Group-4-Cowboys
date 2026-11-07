import type { CheckInLocation } from './checkin-contract';
export type LocationRequirement = { readonly kind: 'not_required' } | { readonly kind: 'unavailable' } |
  { readonly kind: 'required'; readonly radiusMeters: number };
export interface LocationFeedback { code: string; title: string; hint: string; action: 'retry' | 'settings' | 'reload'; }
export class LocationCaptureError extends Error { readonly code: string; constructor(code: string); }
export const MAX_SAMPLE_AGE_MS: number;
export const MAX_FUTURE_MS: number;
export const LOCATION_TIMEOUT_MS: number;
export const LOCATION_SETTLE_MS: number;
export const LOCATION_DISCLOSURE: string;
export function locationFeedback(error: unknown): LocationFeedback;
export function courseLocationRequirement(course: unknown): LocationRequirement;
export function sampleFromPosition(value: unknown, radiusMeters: number, now?: number): CheckInLocation;
export function isSampleFresh(sample: CheckInLocation | null, now?: number): boolean;
export interface LocationProvider {
  getForegroundPermissionsAsync(): Promise<{ granted: boolean; canAskAgain?: boolean; android?: { accuracy?: string }; ios?: { accuracy?: string } }>;
  requestForegroundPermissionsAsync(): ReturnType<LocationProvider['getForegroundPermissionsAsync']>;
  hasServicesEnabledAsync(): Promise<boolean>;
  waitUntilActive?(signal: AbortSignal): Promise<void>;
  watchPositionAsync(onPosition: (value: unknown) => void, onError: () => void): Promise<{ remove(): void }>;
}
export function collectCheckInLocation(provider: LocationProvider, options: {
  requirement: LocationRequirement; signal?: AbortSignal; isActive?: () => boolean;
  onStage?: (stage: 'permission' | 'sampling') => void; timeoutMs?: number;
  settleMs?: number;
}): Promise<CheckInLocation | null>;
