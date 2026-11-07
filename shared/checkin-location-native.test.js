const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('./checkin-location');

const flush = () => new Promise(setImmediate);
function adapter() {
  let state = 'active', onPosition, watchOptions, removed = 0;
  const listeners = new Set();
  const native = {
    Accuracy: { Highest: 5 }, getForegroundPermissionsAsync: async () => ({ granted: true }),
    requestForegroundPermissionsAsync: async () => ({ granted: true }), hasServicesEnabledAsync: async () => true,
    watchPositionAsync: async (options, callback) => { watchOptions = options; onPosition = callback; return { remove: () => removed++ }; },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../services/location.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports,
    require: name => {
      if (name === 'expo-location') return native;
      if (name === '../shared/checkin-location') return core;
      assert.equal(name, 'react-native');
      return { AppState: { get currentState() { return state; }, addEventListener(_name, callback) {
        listeners.add(callback); return { remove: () => listeners.delete(callback) };
      } } };
    },
  });
  return {
    collect: options => module.exports.captureCheckInLocation({ ...options, settleMs: 0 }), listeners,
    state(next) { state = next; listeners.forEach(callback => callback(next)); },
    update() { onPosition({ coords: { latitude: 33, longitude: -97, accuracy: 3 }, timestamp: Date.now() }); },
    get options() { return watchOptions; }, get removed() { return removed; },
  };
}

test('native adapter uses foreground highest-accuracy sampling and removes it after one fix', async () => {
  const h = adapter(); const pending = h.collect({ requirement: { kind: 'required', radiusMeters: 15 } });
  await flush();
  assert.equal(h.options.accuracy, 5);
  assert.equal(h.options.mayShowUserSettingsDialog, false);
  h.update();
  assert.equal((await pending).mocked, null);
  assert.equal(h.removed, 1);
  assert.equal(h.listeners.size, 0);
  h.update(); await flush();
  assert.equal(h.removed, 1, 'Queued native events must not restart location acquisition.');
});

test('native adapter waits out an inactive system dialog before opening a GPS watch', async () => {
  const h = adapter(); h.state('inactive');
  const pending = h.collect({ requirement: { kind: 'required', radiusMeters: 15 } });
  await flush();
  assert.equal(h.options, undefined); assert.equal(h.listeners.size, 1);
  h.state('active'); await flush(); h.update(); await pending;
  assert.equal(h.listeners.size, 0); assert.equal(h.removed, 1);
});

test('cancelling the wait for active state removes its AppState listener without starting GPS', async () => {
  const h = adapter(); h.state('inactive'); const controller = new AbortController();
  const pending = h.collect({ requirement: { kind: 'required', radiusMeters: 15 }, signal: controller.signal });
  await flush(); assert.equal(h.listeners.size, 1);
  controller.abort();
  await assert.rejects(pending, { code: 'location_cancelled' }); await flush();
  assert.equal(h.listeners.size, 0); assert.equal(h.options, undefined);
});
