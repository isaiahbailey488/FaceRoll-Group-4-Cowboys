const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./checkin-location');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(automatic = false, initial = {}) {
  const slots = [], effects = [], listeners = new Set(), timers = new Map(), requests = [];
  let cursor = 0, dirty = true, focused = true, appState = 'active', enabled = initial.enabled ?? true;
  let key = 'student:session', requirement = initial.requirement || { kind: 'required', radiusMeters: 15 }, result;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index]; },
    useCallback(value, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value, deps }; return slots[index].value; },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const previous = slots[index]; slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const app = { get currentState() { return appState; }, addEventListener(_name, callback) {
    listeners.add(callback); return { remove: () => listeners.delete(callback) };
  } };
  const service = { captureCheckInLocation(options) {
    const work = deferred(); requests.push({ ...work, options }); options.onStage('permission'); return work.promise;
  } };
  const stubs = { react, 'react-native': { AppState: app },
    'expo-router': { useFocusEffect: callback => react.useEffect(() => focused ? callback() : undefined, [focused, callback]) },
    '../services/location': service, '../shared/checkin-location': core };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../hooks/useCheckInLocation.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, Date,
    setTimeout: callback => { const token = Symbol(); timers.set(token, callback); return token; },
    clearTimeout: token => timers.delete(token),
    require: name => { assert.ok(Object.hasOwn(stubs, name), name); return stubs[name]; },
  });
  function render() {
    let passes = 0;
    while (dirty) {
      assert.ok(++passes < 30, 'Location hook did not settle');
      cursor = 0; dirty = false;
      result = module.exports.useCheckInLocation(key, requirement, enabled, automatic);
      while (effects.length) effects.shift()();
    }
    return result;
  }
  render();
  return {
    requests, timers, get value() { return render(); },
    collect() { const pending = render().collect(); render(); return pending; },
    switchContext(next) { key = next; dirty = true; render(); },
    policy(next) { requirement = next; dirty = true; render(); },
    enabled(next) { enabled = next; dirty = true; render(); },
    focus(next) { focused = next; dirty = true; render(); },
    state(next) { appState = next; listeners.forEach(callback => callback(next)); render(); },
    expire() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); render(); },
    async settle() { await new Promise(setImmediate); render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const sample = () => ({ latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null });

test('automatic entry collects once, retains freshness without idle polling, and replaces an expired sample only on demand', async () => {
  const h = harness(true);
  assert.equal(h.requests.length, 1); assert.equal(h.value.initialCollectionComplete, false);
  h.requests[0].resolve(sample()); await h.settle();
  assert.equal(h.value.initialCollectionComplete, true); assert.equal(h.value.hasPreparedLocation, true);
  assert.ok(h.value.getSample()); h.expire(); await h.settle();
  assert.equal(h.requests.length, 1); assert.equal(h.value.hasPreparedLocation, true);
  assert.equal(h.value.getSample(), null);
  const replacement = h.collect(); h.requests[1].resolve(sample()); await replacement; await h.settle();
  assert.equal(h.requests.length, 2); assert.ok(h.value.getSample());
});

test('automatic permission failure offers settings without a retry loop; a check-in attempt can try again', async () => {
  const h = harness(true);
  h.requests[0].reject(new core.LocationCaptureError('location_permission_blocked')); await h.settle(); await h.settle();
  assert.equal(h.requests.length, 1); assert.equal(h.value.initialCollectionComplete, true);
  assert.equal(h.value.hasPreparedLocation, false); assert.equal(h.value.feedback.action, 'settings');
  const retry = h.collect(); h.requests[1].resolve(sample()); await retry; await h.settle();
  assert.equal(h.value.hasPreparedLocation, true);
});

test('automatic acquisition cancels on background and never starts another request on app resume', async () => {
  const h = harness(true);
  h.requests[0].options.onStage('sampling'); h.state('background');
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[0].resolve(sample()); await h.settle(); h.state('active'); await h.settle();
  assert.equal(h.requests.length, 1); assert.equal(h.value.hasPreparedLocation, false);
  assert.equal(h.value.getSample(), null);
});

test('reopening check-in starts one new automatic acquisition and ignores the previous visit late result', async () => {
  const h = harness(true); const old = h.requests[0];
  h.focus(false); h.focus(true);
  assert.equal(old.options.signal.aborted, true); assert.equal(h.requests.length, 2);
  old.resolve(sample()); await h.settle();
  assert.equal(h.value.state, 'collecting'); assert.equal(h.value.hasPreparedLocation, false);
  h.requests[1].resolve(sample()); await h.settle();
  assert.equal(h.value.initialCollectionComplete, true); assert.ok(h.value.getSample());
});

test('switching sessions cancels automatic acquisition and only accepts the new session sample', async () => {
  const h = harness(true); const old = h.requests[0];
  h.switchContext('student:new-session');
  assert.equal(old.options.signal.aborted, true); assert.equal(h.requests.length, 2);
  old.resolve(sample()); await h.settle(); assert.equal(h.value.hasPreparedLocation, false);
  const current = sample(); h.requests[1].resolve(current); await h.settle();
  assert.equal(h.value.getSample(), current);
});

test('automatic mode never requests location for disabled access or unavailable classroom settings', () => {
  const disabled = harness(true, { enabled: false }); assert.equal(disabled.requests.length, 0);
  disabled.enabled(true); assert.equal(disabled.requests.length, 1);
  disabled.enabled(false); assert.equal(disabled.requests[0].options.signal.aborted, true);
  const unavailable = harness(true, { requirement: { kind: 'unavailable' } });
  assert.equal(unavailable.requests.length, 0); assert.equal(unavailable.value.initialCollectionComplete, true);
  assert.equal(unavailable.value.hasPreparedLocation, false);
});

test('location does not auto-start and only one user-requested acquisition can run at once', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  const first = h.collect();
  assert.equal(h.value.state, 'collecting');
  assert.equal(await h.collect(), null);
  assert.equal(h.requests.length, 1);
  const value = sample(); h.requests[0].resolve(value); await first; await h.settle();
  assert.equal(h.value.state, 'ready'); assert.equal(h.value.getSample(), value);
  assert.equal(h.timers.size, 1);
  h.expire();
  assert.equal(h.value.state, 'expired'); assert.equal(h.value.getSample(), null);
  assert.equal(h.timers.size, 0);
});

for (const [name, invalidate] of [
  ['switching courses', h => h.switchContext('student:other-session')],
  ['switching accounts', h => h.switchContext('other-student:session')],
  ['changing course location policy', h => h.policy({ kind: 'required', radiusMeters: 5 })],
  ['revoking consent', h => h.enabled(false)],
  ['leaving the screen', h => h.focus(false)],
  ['backgrounding', h => h.state('background')],
  ['unmounting', h => h.unmount()],
]) {
  test(`${name} cancels pending work and discards a late position`, async () => {
    const h = harness(); const pending = h.collect(); const request = h.requests[0];
    invalidate(h);
    assert.equal(request.options.signal.aborted, true);
    request.resolve(sample());
    assert.equal(await pending, null);
    assert.equal(h.value.getSample(), null);
    assert.equal(h.timers.size, 0);
    assert.equal(h.requests.length, 1);
  });
}

test('brief inactive permission dialog is allowed, but an active GPS watch stops on inactivity', async () => {
  const h = harness(); const pending = h.collect();
  h.state('inactive');
  assert.equal(h.requests[0].options.signal.aborted, false);
  assert.equal(h.requests[0].options.isActive(), false);
  h.state('active'); h.requests[0].options.onStage('sampling'); h.state('inactive');
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[0].resolve(sample()); assert.equal(await pending, null);
});

test('ready sample is erased on background and never silently recollected on resume', async () => {
  const h = harness(); const pending = h.collect(); h.requests[0].resolve(sample()); await pending; await h.settle();
  assert.ok(h.value.getSample());
  h.state('background');
  assert.equal(h.value.getSample(), null); assert.equal(h.timers.size, 0);
  h.state('active');
  assert.equal(h.requests.length, 1); assert.equal(h.value.state, 'idle');
});

test('acquisition failures show controlled recovery feedback and can be retried', async () => {
  const h = harness(); const pending = h.collect();
  h.requests[0].reject(new core.LocationCaptureError('location_permission_blocked'));
  await pending; await h.settle();
  assert.equal(h.value.state, 'error'); assert.equal(h.value.feedback.action, 'settings');
  assert.equal(h.value.getSample(), null);
  const retry = h.collect(); h.requests[1].resolve(sample()); await retry; await h.settle();
  assert.equal(h.value.state, 'ready');
});

test('upload completion erases coordinates and timers while retaining controlled location recovery feedback', async () => {
  const h = harness(); const pending = h.collect(); h.requests[0].resolve(sample()); await pending; await h.settle();
  assert.equal(h.timers.size, 1);
  h.value.reportError('location_outside_zone');
  h.value.releaseSample();
  assert.equal(h.value.state, 'error');
  assert.equal(h.value.feedback.action, 'retry');
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 1);
  // Reading the sample also clears feedback, so check it after the recovery state.
  assert.equal(h.value.getSample(), null);
});
