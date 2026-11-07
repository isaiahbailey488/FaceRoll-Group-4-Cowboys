import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { collectCheckInLocation, LocationCaptureError } from '../shared/checkin-location';

function waitUntilActive(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new LocationCaptureError('location_cancelled'));
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (cancelled: boolean) => {
      listener.remove();
      signal.removeEventListener('abort', abort);
      if (cancelled) reject(new LocationCaptureError('location_cancelled')); else resolve();
    };
    const abort = () => done(true);
    const listener = AppState.addEventListener('change', state => { if (state === 'active') done(false); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else if (AppState.currentState === 'active') done(false);
  });
}

const provider = {
  getForegroundPermissionsAsync: Location.getForegroundPermissionsAsync,
  requestForegroundPermissionsAsync: Location.requestForegroundPermissionsAsync,
  hasServicesEnabledAsync: Location.hasServicesEnabledAsync,
  waitUntilActive,
  watchPositionAsync: (onPosition: (value: unknown) => void, onError: () => void) =>
    Location.watchPositionAsync({ accuracy: Location.Accuracy.Highest, distanceInterval: 0,
      timeInterval: 1000, mayShowUserSettingsDialog: false }, onPosition, onError),
};

// No network, Firestore, disk, analytics, cached fix or background task here.
export function captureCheckInLocation(options: Parameters<typeof collectCheckInLocation>[1]) {
  return collectCheckInLocation(provider, options);
}
