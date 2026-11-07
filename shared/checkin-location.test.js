const test = require('node:test');
const assert = require('node:assert/strict');
const { collectCheckInLocation, courseLocationRequirement, sampleFromPosition, isSampleFresh,
  LocationCaptureError, locationFeedback, MAX_SAMPLE_AGE_MS } = require('./checkin-location');

const NOW = 1793898000000;
const required = { kind: 'required', radiusMeters: 15 };
const fix = changes => ({ coords: { latitude: 33, longitude: -97, accuracy: 3, altitude: 1, speed: 0 }, timestamp: NOW, ...changes });
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const calls = [], timers = new Map(), stages = [];
  let update, failure, removed = 0, active = true, clock = NOW;
  const durations = new Map();
  const controller = new AbortController();
  const provider = {
    getForegroundPermissionsAsync: async () => { calls.push('permission'); return { granted: true }; },
    requestForegroundPermissionsAsync: async () => { calls.push('request'); return { granted: true }; },
    hasServicesEnabledAsync: async () => { calls.push('services'); return true; },
    watchPositionAsync: async (next, error) => { calls.push('watch'); update = next; failure = error; return { remove: () => removed++ }; },
    ...overrides,
  };
  return {
    calls, stages, timers, controller,
    collect(requirement = required, settleMs = 0) {
      return collectCheckInLocation(provider, { requirement, signal: controller.signal, isActive: () => active,
        onStage: stage => stages.push(stage), now: () => overrides.now ? overrides.now(clock) : clock, settleMs,
        schedule: (callback, duration) => { const id = Symbol(); timers.set(id, callback); durations.set(id, duration); return id; },
        unschedule: id => timers.delete(id) });
    },
    position: value => update(value), error: () => failure('private native details'),
    timeout: () => [...timers.values()].forEach(callback => callback()),
    advance: ms => { clock += ms; },
    settle: () => { for (const [id, callback] of [...timers]) if (durations.get(id) === 3000) { timers.delete(id); callback(); } },
    inactive: () => { active = false; }, get removed() { return removed; },
  };
}

test('settling selects the best reported fresh accuracy without averaging or leaving a watch active', async () => {
  const h = harness(); let done = false;
  const request = h.collect(required, 3000).then(value => { done = true; return value; }); await flush();
  h.position(fix({ coords: { latitude: 33, longitude: -97, accuracy: 12 } }));
  h.advance(1000); h.position(fix({ coords: { latitude: 33.00001, longitude: -97, accuracy: 5 }, timestamp: NOW + 1000 }));
  h.advance(1000); h.position(fix({ coords: { latitude: 33.00002, longitude: -97, accuracy: 9 }, timestamp: NOW + 2000 }));
  assert.equal(done, false); assert.equal(h.removed, 0);
  h.advance(1000); h.settle(); const sample = await request;
  assert.equal(sample.accuracyMeters, 5); assert.equal(sample.latitude, 33.00001);
  assert.equal(sample.capturedAtMs, NOW + 1000); assert.equal(h.removed, 1); assert.equal(h.timers.size, 0);
});

test('a recent cached sample from before this attempt is not accepted', async () => {
  const h = harness(); const request = h.collect(required, 3000); await flush();
  h.position(fix({ timestamp: NOW - 1 })); assert.equal(h.removed, 0);
  h.timeout(); await assert.rejects(request, { code: 'location_stale' }); assert.equal(h.removed, 1);
});

test('deadline can return the best valid sample and cancellation during settling discards it', async () => {
  const h = harness(); const request = h.collect(required, 3000); await flush(); h.position(fix());
  h.timeout(); assert.equal((await request).accuracyMeters, 3); assert.equal(h.removed, 1);
  const cancelled = harness(); const pending = cancelled.collect(required, 3000); await flush();
  cancelled.position(fix()); cancelled.controller.abort();
  await assert.rejects(pending, { code: 'location_cancelled' }); assert.equal(cancelled.removed, 1); assert.equal(cancelled.timers.size, 0);
});

test('settled samples wait for the native stop handle before readiness', async () => {
  const registration = deferred(); let update, removed = 0, complete = false;
  const h = harness({ watchPositionAsync: callback => { update = callback; return registration.promise; } });
  const pending = h.collect(required, 3000).then(value => { complete = true; return value; }); await flush();
  update(fix()); h.settle(); await flush(); assert.equal(complete, false);
  registration.resolve({ remove: () => removed++ }); await pending;
  assert.equal(removed, 1); assert.equal(h.timers.size, 0);
});

test('expiry during the deadline decision cannot leave a location watch running', async () => {
  let deadline = false, reads = 0, done = false;
  const h = harness({ now: clock => clock + (deadline ? reads++ : 0) });
  const request = h.collect(required, 3000).then(sample => { done = true; return sample; });
  await flush(); h.position(fix()); h.advance(MAX_SAMPLE_AGE_MS); deadline = true;
  h.timeout(); await flush();
  assert.equal(done, true); assert.equal(h.removed, 1); assert.equal(h.timers.size, 0);
  assert.equal((await request).capturedAtMs, NOW);
});

test('saved course policy enables collection only for valid required locations', () => {
  assert.deepEqual(courseLocationRequirement({}), { kind: 'not_required' });
  assert.deepEqual(courseLocationRequirement({ location: { enabled: false } }), { kind: 'not_required' });
  const zone = { enabled: true, latitude: 33, longitude: -97, radiusMeters: 10 };
  assert.deepEqual(courseLocationRequirement({ location: zone }), { kind: 'required', radiusMeters: 10 });
  for (const value of [null, { location: {} }, { location: false }, { location: { ...zone, enabled: 'false' } },
    { location: { ...zone, radiusMeters: 16 } }, { location: { ...zone, radiusMeters: 0.5 } },
    { location: { ...zone, latitude: NaN } }]) {
    assert.equal(courseLocationRequirement(value).kind, 'unavailable');
  }
});

test('normalization preserves sample time and mock signal, drops unused fields and never invents accuracy', () => {
  const normalized = sampleFromPosition(fix(), 15, NOW);
  assert.deepEqual(normalized, { latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: NOW, mocked: null });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(sampleFromPosition(fix({ mocked: false, timestamp: NOW - 1000.25 }), 15, NOW).capturedAtMs, NOW - 1001);
  for (const coords of [{ latitude: 33, longitude: -97, accuracy: null }, { latitude: true, longitude: -97, accuracy: 3 },
    { latitude: 33, longitude: Infinity, accuracy: 3 }, { latitude: 33, longitude: -97, accuracy: -1 }]) {
    assert.throws(() => sampleFromPosition(fix({ coords }), 15, NOW), LocationCaptureError);
  }
  assert.throws(() => sampleFromPosition(fix({ mocked: 'false' }), 15, NOW), { code: 'location_unavailable' });
  assert.throws(() => sampleFromPosition(fix({ mocked: true }), 15, NOW), { code: 'location_mocked' });
});

test('freshness and clock boundaries preserve margin for backend delivery', () => {
  const normalized = sampleFromPosition(fix({ timestamp: NOW - MAX_SAMPLE_AGE_MS }), 15, NOW);
  assert.equal(isSampleFresh(normalized, NOW), true);
  assert.equal(isSampleFresh(normalized, NOW + 1), false);
  assert.throws(() => sampleFromPosition(fix({ timestamp: NOW - MAX_SAMPLE_AGE_MS - 1 }), 15, NOW), { code: 'location_stale' });
  assert.throws(() => sampleFromPosition(fix({ timestamp: NOW + 5001 }), 15, NOW), { code: 'location_future' });
  assert.equal(sampleFromPosition(fix({ timestamp: NOW + 5000 }), 15, NOW).capturedAtMs, NOW + 5000);
});

test('non-required or unavailable courses never request OS permission or start a subscription', async () => {
  const h = harness();
  assert.equal(await h.collect({ kind: 'not_required' }), null);
  await assert.rejects(h.collect({ kind: 'unavailable' }), { code: 'location_policy_unavailable' });
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
});

test('first permission request is user-triggered and acquisition stops after one valid sample', async () => {
  const calls = [];
  const h = harness({
    getForegroundPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
    requestForegroundPermissionsAsync: async () => { calls.push('prompt'); return { granted: true }; },
  });
  assert.deepEqual(calls, []);
  const request = h.collect(); await flush();
  h.position(fix());
  assert.equal((await request).latitude, 33);
  assert.deepEqual(calls, ['prompt']);
  assert.equal(h.removed, 1); assert.equal(h.timers.size, 0);
  h.position(fix({ timestamp: NOW + 1000 }));
  assert.equal(h.removed, 1);
});

test('denied, blocked, approximate permission and disabled services have controlled recovery messages', async () => {
  for (const [permission, code] of [
    [{ granted: false, canAskAgain: true }, 'location_permission_denied'],
    [{ granted: false, canAskAgain: false }, 'location_permission_blocked'],
    [{ granted: true, android: { accuracy: 'coarse' } }, 'location_precise_required'],
    [{ granted: true, ios: { accuracy: 'reduced' } }, 'location_precise_required'],
  ]) {
    const h = harness({ getForegroundPermissionsAsync: async () => permission, requestForegroundPermissionsAsync: async () => permission });
    await assert.rejects(h.collect(), { code });
    assert.ok(!h.calls.includes('watch'));
    assert.equal(h.timers.size, 0);
  }
  const h = harness({ hasServicesEnabledAsync: async () => false });
  await assert.rejects(h.collect(), { code: 'location_services_disabled' });
  assert.equal(locationFeedback(new LocationCaptureError('location_permission_blocked')).action, 'settings');
});

test('stale or inaccurate updates wait for a fresh accurate fix instead of using cached positions', async () => {
  const h = harness(); const request = h.collect(); await flush();
  h.position(fix({ timestamp: NOW - 30000 }));
  h.position(fix({ coords: { latitude: 33, longitude: -97, accuracy: 30 } }));
  assert.equal(h.removed, 0);
  h.position(fix());
  assert.equal((await request).accuracyMeters, 3);
  assert.equal(h.removed, 1);
});

test('poor accuracy and no updates time out, removing the subscription', async () => {
  for (const poorAccuracy of [false, true]) {
    const h = harness(); const request = h.collect(); await flush();
    if (poorAccuracy) h.position(fix({ coords: { latitude: 33, longitude: -97, accuracy: 20 } }));
    h.timeout();
    await assert.rejects(request, { code: poorAccuracy ? 'location_inaccurate' : 'location_timeout' });
    assert.equal(h.removed, 1); assert.equal(h.timers.size, 0);
  }
});

test('mocked and future-clock samples stop acquisition immediately', async () => {
  for (const [value, code] of [[fix({ mocked: true }), 'location_mocked'], [fix({ timestamp: NOW + 5001 }), 'location_future']]) {
    const h = harness(); const request = h.collect(); await flush(); h.position(value);
    await assert.rejects(request, { code });
    assert.equal(h.removed, 1);
  }
});

test('cancellation while permission is pending never starts GPS after a late permission grant', async () => {
  const permission = deferred();
  const h = harness({ getForegroundPermissionsAsync: () => permission.promise });
  const request = h.collect(); h.controller.abort();
  await assert.rejects(request, { code: 'location_cancelled' });
  permission.resolve({ granted: true }); await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
});

test('cancellation before subscription creation resolves removes the late subscription', async () => {
  const registration = deferred(); let removed = 0;
  const h = harness({ watchPositionAsync: () => registration.promise });
  const request = h.collect(); await flush(); h.controller.abort();
  await assert.rejects(request, { code: 'location_cancelled' });
  registration.resolve({ remove: () => removed++ }); await flush();
  assert.equal(removed, 1);
});

test('a synchronous first fix still removes the subscription returned afterward', async () => {
  let removed = 0;
  const h = harness({ watchPositionAsync: async onPosition => { onPosition(fix()); return { remove: () => removed++ }; } });
  await h.collect(); await flush();
  assert.equal(removed, 1);
});

test('success waits for a delayed stop handle and removes the watch before resolving', async () => {
  const registration = deferred(); let emit, removed = 0, completed = false;
  const h = harness({ watchPositionAsync: callback => { emit = callback; return registration.promise; } });
  const request = h.collect().then(sample => {
    assert.equal(removed, 1, 'Location acquisition must stop before readiness is reported.');
    completed = true;
    return sample;
  });
  await flush(); emit(fix()); await flush();
  assert.equal(completed, false);
  assert.equal(h.timers.size, 1, 'Pending native setup must remain bounded by the timeout.');
  registration.resolve({ remove: () => removed++ });
  assert.equal((await request).latitude, 33);
  assert.equal(completed, true);
  assert.equal(h.timers.size, 0);
  // Native events already queued after removal must not change the result or
  // create a replacement subscription.
  emit(fix({ coords: { latitude: 34, longitude: -97, accuracy: 3 } }));
  assert.equal(removed, 1);
});

test('cancelling after an early fix rejects it and still removes the late watch handle', async () => {
  const registration = deferred(); let emit, removed = 0;
  const h = harness({ watchPositionAsync: callback => { emit = callback; return registration.promise; } });
  const request = h.collect(); await flush(); emit(fix()); h.controller.abort();
  await assert.rejects(request, { code: 'location_cancelled' });
  registration.resolve({ remove: () => removed++ }); await flush();
  assert.equal(removed, 1); assert.equal(h.timers.size, 0);
});

test('timeout after an early fix never reports ready and cleans up a late native handle', async () => {
  const registration = deferred(); let emit, removed = 0;
  const h = harness({ watchPositionAsync: callback => { emit = callback; return registration.promise; } });
  const request = h.collect(); await flush(); emit(fix()); h.timeout();
  await assert.rejects(request, { code: 'location_timeout' });
  registration.resolve({ remove: () => removed++ }); await flush();
  assert.equal(removed, 1);
});

test('permission dialog can temporarily become inactive; collection waits until active', async () => {
  const foreground = deferred();
  const h = harness({ waitUntilActive: () => foreground.promise });
  const request = h.collect(); await flush();
  assert.ok(!h.calls.includes('watch'));
  foreground.resolve(); await flush(); h.position(fix());
  assert.ok(await request);
});

test('backgrounding or native failure stops acquisition without exposing native diagnostics', async () => {
  const h = harness(); const request = h.collect(); await flush(); h.inactive(); h.position(fix());
  await assert.rejects(request, { code: 'location_cancelled' });
  assert.equal(h.removed, 1);
  const failed = harness(); const rejected = failed.collect(); await flush(); failed.error();
  await assert.rejects(rejected, { code: 'location_unavailable' });
  assert.equal(failed.removed, 1);
  assert.ok(!JSON.stringify(locationFeedback(new Error('private coordinates -97 33'))).includes('private'));
});
