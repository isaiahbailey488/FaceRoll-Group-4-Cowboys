'use strict';

// Collection readiness only. The backend owns the classroom/attendance decision.
const MAX_SAMPLE_AGE_MS = 15000; // Leave headroom under the server's 30s limit.
const MAX_FUTURE_MS = 5000;
const LOCATION_TIMEOUT_MS = 25000;
const LOCATION_SETTLE_MS = 3000;
const LOCATION_DISCLOSURE = 'Your location is used only for classroom check-in. Samples are temporary, are not saved in your attendance history, and are cleared when you leave this screen. FaceRoll does not track your location in the background.';

const FEEDBACK = {
  location_required: ['Classroom location required', 'Reload the session, then try checking in again. A fresh location is collected automatically.', 'reload'],
  location_policy_invalid: ['Classroom location must be enabled', 'Ask your instructor to start a session with classroom location enabled, then reload.', 'reload'],
  location_outside_zone: ['Location could not be verified', 'Try checking in again. If it still does not work, ask your instructor for help.', 'retry'],
  location_uncertain: ['Location could not be verified', 'Try checking in again. If it still does not work, ask your instructor for help.', 'retry'],
  location_unverified: ['Location could not be verified', 'Try checking in again. If it still does not work, ask your instructor for help.', 'retry'],
  location_permission_denied: ['Location permission needed', 'Allow location access while using FaceRoll, then try again.', 'retry'],
  location_permission_blocked: ['Location access is off', 'Open your phone settings and allow location access while using FaceRoll.', 'settings'],
  location_precise_required: ['Precise location needed', 'Enable Precise Location for FaceRoll in your phone settings, then try again.', 'settings'],
  location_services_disabled: ['Location services are off', 'Turn on your phone’s Location Services, then return and try again.', 'settings'],
  location_inaccurate: ['Location could not be verified', 'Try checking in again. If it still does not work, ask your instructor for help.', 'retry'],
  location_stale: ['A fresh location is needed', 'Try checking in again to collect a fresh location.', 'retry'],
  location_future: ['Check your phone clock', 'Set your phone’s date and time automatically, then try again.', 'settings'],
  location_mocked: ['Simulated location detected', 'Turn off simulated or mock locations, then try again.', 'retry'],
  location_timeout: ['Could not get your location', 'Check Location Services and move to a spot with a clearer signal, then try again.', 'retry'],
  location_unavailable: ['Location unavailable', 'Check location permission and Location Services, then try again or ask your instructor for help.', 'retry'],
  location_policy_unavailable: ['Classroom settings unavailable', 'Reload the session or ask your instructor to check the course’s location settings.', 'reload'],
  location_cancelled: ['Location collection stopped', 'Try checking in again when you are ready.', 'retry'],
};

class LocationCaptureError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(FEEDBACK, code) ? code : 'location_unavailable';
    super(FEEDBACK[safe][1]);
    this.name = 'LocationCaptureError';
    this.code = safe;
  }
}

function locationFeedback(error) {
  const code = error instanceof LocationCaptureError ? error.code : 'location_unavailable';
  const [title, hint, action] = FEEDBACK[code];
  return { code, title, hint, action };
}

function courseLocationRequirement(course) {
  if (!course || typeof course !== 'object') return { kind: 'unavailable' };
  const zone = course.location;
  if (zone === undefined || zone === null) return { kind: 'not_required' };
  if (typeof zone !== 'object' || typeof zone.enabled !== 'boolean') return { kind: 'unavailable' };
  if (!zone.enabled) return { kind: 'not_required' };
  if (!Number.isFinite(zone.latitude) || zone.latitude < -90 || zone.latitude > 90 ||
      !Number.isFinite(zone.longitude) || zone.longitude < -180 || zone.longitude > 180 ||
      !Number.isInteger(zone.radiusMeters) || zone.radiusMeters < 1 || zone.radiusMeters > 15) {
    return { kind: 'unavailable' };
  }
  return { kind: 'required', radiusMeters: zone.radiusMeters };
}

function sampleFromPosition(value, radiusMeters, now = Date.now()) {
  const coords = value?.coords;
  if (!coords || !Number.isFinite(coords.latitude) || coords.latitude < -90 || coords.latitude > 90 ||
      !Number.isFinite(coords.longitude) || coords.longitude < -180 || coords.longitude > 180 ||
      !Number.isFinite(value.timestamp) || value.timestamp <= 0 || value.timestamp > 8640000000000000) {
    throw new LocationCaptureError('location_unavailable');
  }
  if (value.mocked === true) throw new LocationCaptureError('location_mocked');
  if (value.mocked !== undefined && value.mocked !== null && typeof value.mocked !== 'boolean') throw new LocationCaptureError('location_unavailable');
  const capturedAtMs = Math.trunc(value.timestamp);
  if (now - capturedAtMs > MAX_SAMPLE_AGE_MS) throw new LocationCaptureError('location_stale');
  if (capturedAtMs - now > MAX_FUTURE_MS) throw new LocationCaptureError('location_future');
  if (!Number.isFinite(coords.accuracy) || coords.accuracy < 0 || coords.accuracy > radiusMeters) {
    throw new LocationCaptureError('location_inaccurate');
  }
  // Drop altitude, heading, speed and every other native field.
  return Object.freeze({ latitude: coords.latitude, longitude: coords.longitude,
    accuracyMeters: coords.accuracy, capturedAtMs, mocked: typeof value.mocked === 'boolean' ? value.mocked : null });
}

function isSampleFresh(sample, now = Date.now()) {
  return Boolean(sample && Number.isSafeInteger(sample.capturedAtMs) &&
    now - sample.capturedAtMs <= MAX_SAMPLE_AGE_MS && sample.capturedAtMs - now <= MAX_FUTURE_MS);
}

/** Bounded foreground subscription, removed on success, cancellation or failure. */
function collectCheckInLocation(provider, { requirement, signal, isActive = () => true,
  onStage = () => {}, timeoutMs = LOCATION_TIMEOUT_MS, now = Date.now,
  settleMs = LOCATION_SETTLE_MS,
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  if (requirement?.kind === 'not_required') return Promise.resolve(null);
  if (requirement?.kind !== 'required' || !Number.isInteger(requirement.radiusMeters) ||
      requirement.radiusMeters < 1 || requirement.radiusMeters > 15) {
    return Promise.reject(new LocationCaptureError('location_policy_unavailable'));
  }
  return new Promise((resolve, reject) => {
    let finished = false, subscription = null, timer;
    let startingWatch = false, bestSample = null, settleTimer = null, settled = false, watchStartedAt = null;
    let lastRejection = null;
    const controller = new AbortController();
    const remove = item => { try { item?.remove(); } catch { /* Never expose native diagnostics. */ } };
    const finish = (error, sample) => {
      if (finished) return;
      finished = true;
      unschedule(timer);
      if (settleTimer !== null) unschedule(settleTimer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
      remove(subscription);
      subscription = null;
      bestSample = null;
      if (error) reject(error); else resolve(sample);
    };
    const cancel = () => finish(new LocationCaptureError('location_cancelled'));
    const current = () => !finished && !signal?.aborted && isActive();
    const complete = () => {
      if (!current()) { cancel(); return; }
      if (startingWatch || !subscription) return;
      if (bestSample && isSampleFresh(bestSample, now())) finish(null, bestSample);
      else {
        bestSample = null; settled = false; settleTimer = null;
        lastRejection = new LocationCaptureError('location_stale');
      }
    };
    if (signal?.aborted || !isActive()) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = schedule(() => {
      // Decide once at the deadline. A second freshness check can cross expiry
      // and reset settling after the only overall timeout has already fired.
      if (!current()) cancel();
      else if (!startingWatch && subscription && bestSample && isSampleFresh(bestSample, now())) finish(null, bestSample);
      else finish(lastRejection || new LocationCaptureError('location_timeout'));
    }, timeoutMs);
    (async () => {
      try {
        onStage('permission');
        let permission = await provider.getForegroundPermissionsAsync();
        if (finished) return;
        if (!permission.granted && permission.canAskAgain !== false) {
          permission = await provider.requestForegroundPermissionsAsync();
        }
        if (finished) return;
        if (!permission.granted) {
          finish(new LocationCaptureError(permission.canAskAgain === false ? 'location_permission_blocked' : 'location_permission_denied'));
          return;
        }
        if (permission.android?.accuracy === 'coarse' || permission.ios?.accuracy === 'reduced') {
          finish(new LocationCaptureError('location_precise_required')); return;
        }
        if (!await provider.hasServicesEnabledAsync()) {
          if (!finished) finish(new LocationCaptureError('location_services_disabled'));
          return;
        }
        if (finished) return;
        // System permission dialogs can briefly make iOS inactive. Sampling
        // waits for active state; navigating away/backgrounding still cancels.
        await provider.waitUntilActive?.(controller.signal);
        if (!current()) { cancel(); return; }
        onStage('sampling');
        watchStartedAt = Math.trunc(now());
        startingWatch = true;
        const watcher = await provider.watchPositionAsync(value => {
          if (!current()) { cancel(); return; }
          try {
            const sample = sampleFromPosition(value, requirement.radiusMeters, now());
            if (sample.capturedAtMs < watchStartedAt) throw new LocationCaptureError('location_stale');
            if (!bestSample || !isSampleFresh(bestSample, now()) || sample.accuracyMeters < bestSample.accuracyMeters ||
                (sample.accuracyMeters === bestSample.accuracyMeters && sample.capturedAtMs > bestSample.capturedAtMs)) bestSample = sample;
            if (settleMs <= 0) { settled = true; complete(); }
            else if (settleTimer === null) {
              settleTimer = schedule(() => { settled = true; complete(); }, settleMs);
            }
          }
          catch (error) {
            lastRejection = error instanceof LocationCaptureError ? error : new LocationCaptureError('location_unavailable');
            if (['location_mocked', 'location_future'].includes(lastRejection.code)) finish(lastRejection);
          }
        }, () => finish(new LocationCaptureError('location_unavailable')));
        startingWatch = false;
        if (finished) { remove(watcher); return; }
        subscription = watcher;
        if (!current()) { cancel(); return; }
        if (settled) complete();
      } catch {
        if (!finished) finish(new LocationCaptureError('location_unavailable'));
      }
    })();
  });
}

module.exports = { MAX_SAMPLE_AGE_MS, MAX_FUTURE_MS, LOCATION_TIMEOUT_MS, LOCATION_SETTLE_MS, LOCATION_DISCLOSURE,
  LocationCaptureError, locationFeedback, courseLocationRequirement, sampleFromPosition, isSampleFresh, collectCheckInLocation };
