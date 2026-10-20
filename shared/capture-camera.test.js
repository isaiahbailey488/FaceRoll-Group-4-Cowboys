const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the actual screens and camera hook with native camera and network boundaries mocked.
function screenHarness(filename, options = {}) {
  const slots = [], queuedEffects = [], appListeners = new Set(), timers = new Map();
  const alerts = [], routes = [], uploads = [], deletions = [];
  const profile = { uid: 'student', optOutFlag: false, faceEnrolled: true, faceConsentRevision: 0 };
  let focused = true, appState = 'active', privacyState = 'ready';
  let cursor = 0, dirty = true, tree, mounted = false, mounts = 0, unmounts = 0, photos = 0;
  const same = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps, cleanup: previous?.cleanup };
        queuedEffects.push(() => {
          previous?.cleanup?.();
          slots[index].cleanup = callback();
        });
      }
    },
  };
  const app = {
    get currentState() { return appState; },
    addEventListener(_event, handler) {
      appListeners.add(handler);
      return { remove: () => appListeners.delete(handler) };
    },
  };
  const CameraView = function CameraView() {};
  const FacePrivacyGate = function FacePrivacyGate() {};
  const native = new Proxy({
    AppState: app, Alert: { alert: (...args) => alerts.push(args) },
    Dimensions: { get: () => ({ width: 390 }) }, StyleSheet: { create: value => value },
  }, { get: (object, key) => object[key] || key });
  const session = { sessionId: 'session', courseId: 'course', startTime: new Date().toISOString() };
  const cameraDevice = {
    takePictureAsync() {
      photos++;
      return options.capture ? options.capture() : Promise.resolve({ base64: `photo-${photos}`, uri: `temporary-${photos}` });
    },
  };
  class RecognitionApiError extends Error {}
  const permission = { granted: true };
  const stubs = {
    react, 'react-native': native,
    'expo-camera': { CameraView, useCameraPermissions: () => [permission, () => {}] },
    'expo-router': {
      useRouter: () => ({ back: () => routes.push('back'), replace: value => routes.push(value), push: value => routes.push(value) }),
      useFocusEffect: callback => react.useEffect(() => focused ? callback() : undefined, [focused, callback]),
    },
    'expo-status-bar': { StatusBar: 'StatusBar' }, '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '../constants/Colors': {}, '../components/ScanTipsCard': 'ScanTipsCard',
    '../components/FacePrivacyGate': FacePrivacyGate,
    '../hooks/useFacePrivacy': { useFacePrivacy: () => ({ state: privacyState, profile, unavailable: false, retry() {} }) },
    '../services/auth': {
      getCurrentUser: () => ({ uid: 'student' }), getUserProfile: async () => profile,
      getFacePrivacyProfile: () => options.consent ? options.consent() : Promise.resolve(profile),
      getStudentDisplayName: () => 'Student',
    },
    '../services/attendance': {
      getActiveSessions: async () => options.noSession ? [] : [session],
      submitAttendance: async data => {
        uploads.push({ type: 'attendance', data });
        return { duplicate: Boolean(options.duplicate) };
      },
    },
    '../services/recognition': {
      discardTemporaryCameraFile: uri => deletions.push(uri), RecognitionApiError, AUTH_ERROR_CODES: new Set(),
      NOT_RECOGNIZED_FEEDBACK: { title: 'No match', hint: 'Try again' },
      scanFeedbackForError: error => ({ title: 'Failed', hint: error.message }),
      recognizeFace: async image => {
        uploads.push({ type: 'recognize', image });
        return options.recognize ? options.recognize() : { recognized: true, uid: 'student' };
      },
      enrollFace: async images => {
        uploads.push({ type: 'enroll', images });
        return options.enroll ? options.enroll() : { sampleCount: 3, model: 'Facenet512' };
      },
    },
    '../shared/face-privacy': require('./face-privacy'),
  };
  function load(relative) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2020,
    } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports, __DEV__: false,
      setTimeout: callback => { const token = Symbol(); timers.set(token, callback); return token; },
      clearTimeout: token => timers.delete(token),
      require: key => { assert.ok(Object.hasOwn(stubs, key), `Unexpected import ${key}`); return stubs[key]; },
    });
    return module.exports;
  }
  stubs['../hooks/useCaptureCamera'] = load('hooks/useCaptureCamera.ts');
  const Screen = load(`app/${filename}`).default;
  function nodes(node = tree) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...(node.children || []).flatMap(nodes)];
  }
  function render() {
    let passes = 0;
    while (dirty) {
      assert.ok(++passes < 30, 'Screen render did not settle');
      dirty = false; cursor = 0;
      tree = Screen();
      const camera = nodes().find(node => node.type === CameraView);
      if (camera && !mounted) {
        mounted = true; mounts++;
        camera.props.ref.current = cameraDevice;
        if (options.autoReady !== false) camera.props.onCameraReady();
      } else if (!camera && mounted) {
        mounted = false; unmounts++;
        for (const slot of slots) if (slot?.current === cameraDevice) slot.current = null;
      }
      while (queuedEffects.length) queuedEffects.shift()();
    }
    return tree;
  }
  async function settle() {
    for (let index = 0; index < 4; index++) { render(); await new Promise(setImmediate); }
    render();
  }
  function button(label) {
    const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : (node?.children || []).map(text).join('');
    const match = nodes().find(node => node.type === 'TouchableOpacity' &&
      (node.props.accessibilityLabel === label || text(node) === label));
    assert.ok(match, `Missing button: ${label}`);
    return match;
  }
  function press(label) {
    const node = button(label);
    assert.ok(!node.props.disabled, `Button disabled: ${label}`);
    const result = node.props.onPress();
    render();
    return result;
  }
  render();
  return {
    render, settle, press, button, alerts, routes, uploads, deletions,
    get cameraMounted() { return mounted; }, get photos() { return photos; },
    get mounts() { return mounts; }, get unmounts() { return unmounts; },
    cameraReady() { nodes().find(node => node.type === CameraView)?.props.onCameraReady(); render(); },
    cameraError() { nodes().find(node => node.type === CameraView)?.props.onMountError(); render(); },
    focus(value) { focused = value; dirty = true; render(); },
    appState(value) { appState = value; appListeners.forEach(listener => listener(value)); render(); },
    privacy(value) { privacyState = value; dirty = true; render(); },
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); render(); },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      if (mounted) { mounted = false; unmounts++; }
    },
  };
}

test('check-in releases native camera before consent check or recognition completes, and through success', async () => {
  let consentReads = 0;
  const afterCapture = deferred(), recognition = deferred();
  const screen = screenHarness('attendance-checkin.tsx', {
    consent: () => ++consentReads === 2 ? afterCapture.promise : Promise.resolve({ optOutFlag: false, faceEnrolled: true, faceConsentRevision: 0 }),
    recognize: () => recognition.promise,
  });
  await screen.settle();
  assert.equal(screen.cameraMounted, true);
  screen.press('Take check-in photo');
  await screen.settle();
  assert.equal(screen.photos, 1);
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.unmounts, 1);
  assert.equal(screen.uploads.length, 0);
  afterCapture.resolve({ optOutFlag: false, faceConsentRevision: 0 });
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  recognition.resolve({ recognized: true, uid: 'student' });
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.uploads.at(-1).type, 'attendance');
  screen.runTimers();
  assert.deepEqual(screen.routes, ['back']);
});

test('enrollment releases camera after third photo, stays off for review/upload/success, and retakes reopen it', async () => {
  const enrollment = deferred(), afterCapture = deferred();
  let consentReads = 0;
  const screen = screenHarness('face-enrollment.tsx', {
    enroll: () => enrollment.promise,
    consent: () => ++consentReads === 6 ? afterCapture.promise : Promise.resolve({ optOutFlag: false, faceConsentRevision: 0 }),
  });
  await screen.settle();
  for (let photo = 0; photo < 3; photo++) {
    screen.press('Take enrollment photo');
    await screen.settle();
    assert.equal(screen.cameraMounted, photo < 2);
  }
  assert.equal(screen.uploads.length, 0);
  afterCapture.resolve({ optOutFlag: false, faceConsentRevision: 0 });
  await screen.settle();
  screen.press('Slightly Left');
  assert.equal(screen.cameraMounted, true);
  screen.press('Take enrollment photo');
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  screen.press('Submit Three Photos');
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  enrollment.resolve({ sampleCount: 3, model: 'Facenet512' });
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.photos, 4);
  assert.equal(screen.deletions.length, 4);
  screen.runTimers();
  assert.deepEqual(screen.routes, ['/(tabs)/home']);
});

for (const [filename, captureLabel, resumeLabel] of [
  ['attendance-checkin.tsx', 'Take check-in photo', 'Resume check-in camera'],
  ['face-enrollment.tsx', 'Take enrollment photo', 'Resume enrollment camera'],
]) {
  test(`${filename} waits for native readiness and keeps camera off after backgrounding until explicit resume`, async () => {
    const screen = screenHarness(filename, { autoReady: false });
    await screen.settle();
    assert.equal(screen.cameraMounted, true);
    assert.equal(screen.button(captureLabel).props.disabled, true);
    screen.cameraReady();
    assert.equal(screen.button(captureLabel).props.disabled, false);
    screen.appState('inactive');
    assert.equal(screen.cameraMounted, false);
    screen.appState('background');
    screen.appState('active');
    assert.equal(screen.cameraMounted, false);
    screen.press(resumeLabel);
    assert.equal(screen.cameraMounted, true);
    assert.equal(screen.photos, 0);
    screen.unmount();
    assert.equal(screen.cameraMounted, false);
  });

  test(`${filename} discards a capture completed after navigation away without uploading or restarting camera`, async () => {
    const capture = deferred();
    const screen = screenHarness(filename, { capture: () => capture.promise });
    await screen.settle();
    screen.press(captureLabel);
    await screen.settle();
    screen.focus(false);
    assert.equal(screen.cameraMounted, false);
    capture.resolve({ base64: 'late-photo', uri: 'late-temporary' });
    await screen.settle();
    assert.deepEqual(screen.deletions, ['late-temporary']);
    assert.equal(screen.uploads.length, 0);
    screen.focus(true);
    assert.equal(screen.cameraMounted, false);
  });

  test(`${filename} releases camera on capture failure and only reopens for retry`, async () => {
    const screen = screenHarness(filename, { capture: async () => { throw new Error('Capture failed'); } });
    await screen.settle();
    screen.press(captureLabel);
    await screen.settle();
    assert.equal(screen.cameraMounted, false);
    screen.press(resumeLabel);
    assert.equal(screen.cameraMounted, true);
    assert.equal(screen.photos, 1);
  });

  test(`${filename} releases camera on mount error and opt-out`, async () => {
    const screen = screenHarness(filename);
    await screen.settle();
    screen.cameraError();
    assert.equal(screen.cameraMounted, false);
    screen.press(resumeLabel);
    assert.equal(screen.cameraMounted, true);
    screen.privacy('opted_out');
    assert.equal(screen.cameraMounted, false);
  });
}

test('duplicate attendance keeps camera off and exits normally', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { duplicate: true });
  await screen.settle();
  screen.press('Take check-in photo');
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.alerts.at(-1)[0], 'Already Checked In');
  screen.runTimers();
  assert.deepEqual(screen.routes, ['back']);
});

test('failed check-in verification keeps camera off until the student retries', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { recognize: async () => ({ recognized: false }) });
  await screen.settle();
  screen.press('Take check-in photo');
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  screen.press('Resume check-in camera');
  assert.equal(screen.cameraMounted, true);
  assert.equal(screen.photos, 1);
});

test('no active session never opens the camera', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { noSession: true });
  await screen.settle();
  assert.equal(screen.mounts, 0);
});

test('backgrounding during check-in verification prevents a late attendance submission and camera restart', async () => {
  const recognition = deferred();
  const screen = screenHarness('attendance-checkin.tsx', { recognize: () => recognition.promise });
  await screen.settle();
  screen.press('Take check-in photo');
  await screen.settle();
  screen.appState('background');
  screen.appState('active');
  recognition.resolve({ recognized: true, uid: 'student' });
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.uploads.filter(upload => upload.type === 'attendance').length, 0);
  screen.runTimers();
  assert.equal(screen.routes.length, 0);
});

test('failed enrollment upload never reopens the camera', async () => {
  const screen = screenHarness('face-enrollment.tsx', { enroll: async () => { throw new Error('Offline'); } });
  await screen.settle();
  for (let index = 0; index < 3; index++) {
    screen.press('Take enrollment photo');
    await screen.settle();
  }
  screen.press('Submit Three Photos');
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  screen.press('Start Over');
  assert.equal(screen.cameraMounted, true);
});

test('leaving a successful check-in cancels its delayed navigation without reopening camera', async () => {
  const screen = screenHarness('attendance-checkin.tsx');
  await screen.settle();
  screen.press('Take check-in photo');
  await screen.settle();
  screen.focus(false);
  screen.runTimers();
  assert.equal(screen.cameraMounted, false);
  assert.deepEqual(screen.routes, []);
});
