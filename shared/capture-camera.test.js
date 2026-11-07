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
  const alerts = [], routes = [], uploads = [], deletions = [], locationCalls = [], automaticLocationCalls = [];
  const profile = { uid: 'student', optOutFlag: false, faceEnrolled: true, faceConsentRevision: 0, ...options.profile };
  let focused = true, appState = 'active', privacyState = 'ready', accountUid = 'student';
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
  let openedSettings = 0;
  const native = new Proxy({
    AppState: app, Alert: { alert: (...args) => alerts.push(args) },
    Linking: { openSettings: async () => { openedSettings++; } },
    Dimensions: { get: () => ({ width: 390, height: 844 }) }, StyleSheet: { create: value => value },
  }, { get: (object, key) => object[key] || key });
  const session = { sessionId: 'session', courseId: 'course', startTime: new Date().toISOString(),
    locationRequirement: options.locationRequirement || { kind: 'required', radiusMeters: 15 } };
  const cameraDevice = {
    takePictureAsync() {
      photos++;
      return options.capture ? options.capture() : Promise.resolve({ base64: `photo-${photos}`, uri: `temporary-${photos}` });
    },
  };
  class RecognitionApiError extends Error {
    constructor(code, message = code) { super(message); this.code = code; }
  }
  const locationCore = require('./checkin-location');
  let locationSample = null, locationGeneration = 0, locationScope = null, automaticScope = null;
  const freshLocation = () => ({ latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null });
  const locationApi = { state: 'idle', feedback: null, initialCollectionComplete: false, hasPreparedLocation: false,
    async collect(automatic = false) {
      (automatic ? automaticLocationCalls : locationCalls).push('collect');
      const generation = locationGeneration;
      locationApi.state = 'collecting'; locationApi.feedback = null; dirty = true;
      const provider = automatic ? options.initialCollectLocation : options.collectLocation;
      try {
        const value = provider ? await provider() : options.locationSample || freshLocation();
        if (generation !== locationGeneration || !focused) return null;
        locationSample = value;
        locationApi.state = value ? 'ready' : 'error';
        locationApi.feedback = value ? null : locationCore.locationFeedback(new locationCore.LocationCaptureError('location_timeout'));
        if (value) locationApi.hasPreparedLocation = true;
        dirty = true; return value;
      } catch (error) {
        if (generation !== locationGeneration) return null;
        locationSample = null; locationApi.state = 'error'; locationApi.feedback = locationCore.locationFeedback(error);
        dirty = true; return null;
      }
    },
    clear() { locationSample = null; locationGeneration++; locationApi.state = 'idle'; locationCalls.push('clear'); dirty = true; },
    releaseSample() { locationSample = null; locationCalls.push('release'); },
    getSample: () => options.getLocationSample ? options.getLocationSample() : locationSample,
    reportError: code => { locationSample = null; locationApi.state = 'error';
      locationApi.feedback = locationCore.locationFeedback(new locationCore.LocationCaptureError(code)); locationCalls.push(code); dirty = true; },
  };
  function useLocation(context, requirement, enabled, automatic) {
    react.useEffect(() => {
      const scope = JSON.stringify([context, requirement]);
      if (scope !== locationScope) {
        locationGeneration++; locationScope = scope; automaticScope = null; locationSample = null;
        locationApi.initialCollectionComplete = false; locationApi.hasPreparedLocation = false; dirty = true;
      }
      if (!focused || !enabled) { automaticScope = null; locationGeneration++; locationSample = null; return; }
      if (!automatic || automaticScope === scope) return;
      automaticScope = scope;
      if (requirement.kind !== 'required') { locationApi.initialCollectionComplete = true; dirty = true; return; }
      void locationApi.collect(true).finally(() => {
        if (focused && locationScope === scope) { locationApi.initialCollectionComplete = true; dirty = true; }
      });
    }, [context, JSON.stringify(requirement), enabled, automatic, focused]);
    react.useEffect(() => app.addEventListener('change', next => {
      if (next !== 'active') { locationSample = null; locationGeneration++; locationApi.state = 'idle'; dirty = true; }
    }).remove, []);
    return locationApi;
  }
  const permission = { granted: options.permissionGranted !== false, canAskAgain: options.canAskCameraAgain !== false };
  let permissionRequests = 0, permissionQueries = 0;
  const stubs = {
    react, 'react-native': native,
    'expo-camera': { CameraView, useCameraPermissions: () => [permission, () => permissionRequests++, async () => {
      permissionQueries++; if (options.getCameraPermission) Object.assign(permission, await options.getCameraPermission());
      dirty = true; return permission;
    }] },
    'expo-router': {
      useRouter: () => ({ back: () => routes.push('back'), replace: value => routes.push(value), push: value => routes.push(value) }),
      useFocusEffect: callback => react.useEffect(() => focused ? callback() : undefined, [focused, callback]),
    },
    'expo-status-bar': { StatusBar: 'StatusBar' }, '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '../constants/Colors': {}, '../components/ScanTipsCard': 'ScanTipsCard',
    '../components/FacePrivacyGate': FacePrivacyGate,
    '../hooks/useFacePrivacy': { useFacePrivacy: () => ({ state: privacyState, profile, unavailable: false, retry() {} }) },
    '../hooks/useCheckInLocation': { useCheckInLocation: useLocation },
    '../components/CheckInLocationCard': 'CheckInLocationCard',
    '../shared/checkin-location': require('./checkin-location'),
    '../shared/face-guide': require('./face-guide'),
    '../services/auth': {
      getCurrentUser: () => ({ uid: accountUid }), getUserProfile: async () => profile,
      getFacePrivacyProfile: () => options.consent ? options.consent() : Promise.resolve(profile),
      getStudentDisplayName: () => 'Student',
    },
    '../services/attendance': {
      getActiveSessions: async () => options.sessions ? options.sessions() : options.noSession ? [] : [session],
      submitAttendance: async data => {
        throw new Error('The check-in screen must never write attendance directly.');
      },
    },
    '../services/recognition': {
      discardTemporaryCameraFile: uri => deletions.push(uri), RecognitionApiError, AUTH_ERROR_CODES: new Set(),
      NOT_RECOGNIZED_FEEDBACK: { title: 'No match', hint: 'Try again' },
      scanFeedbackForError: error => ({ title: 'Failed', hint: error.message }),
      recognizeFace: async image => {
        throw new Error('The check-in screen must use the combined backend endpoint.');
      },
      checkInAttendance: async (data, requestOptions) => {
        uploads.push({ type: 'check-in', data, options: requestOptions });
        if (options.checkIn) return options.checkIn(data, requestOptions);
        if (options.recognize) {
          const recognized = await options.recognize();
          if (!recognized.recognized) throw new RecognitionApiError('face_not_recognized');
        }
        return { schemaVersion: 1, success: true, sessionId: data.sessionId, courseId: 'course',
          attendanceId: 'session_student', duplicate: Boolean(options.duplicate), status: options.status || 'present',
          recordedAt: new Date().toISOString(), locationStatus: data.location ? 'in_zone' : 'not_required' };
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
      module, exports: module.exports, __DEV__: false, AbortController,
      setTimeout: callback => { const token = Symbol(); timers.set(token, callback); return token; },
      clearTimeout: token => timers.delete(token),
      require: key => { assert.ok(Object.hasOwn(stubs, key), `Unexpected import ${key}`); return stubs[key]; },
    });
    return module.exports;
  }
  stubs['../hooks/useCaptureCamera'] = load('hooks/useCaptureCamera.ts');
  stubs['../constants/ScanTips'] = load('constants/ScanTips.ts');
  const TipsCard = load('components/ScanTipsCard.tsx').default;
  stubs['../components/ScanTipsCard'] = TipsCard;
  const guideModule = load('components/FaceCaptureGuide.tsx');
  stubs['../components/FaceCaptureGuide'] = guideModule;
  const LocationCard = load('components/CheckInLocationCard.tsx').default;
  stubs['../components/CheckInLocationCard'] = LocationCard;
  const Screen = load(`app/${filename}`).default;
  function expand(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if ([LocationCard, TipsCard, guideModule.default, guideModule.FaceCaptureControls].includes(node.type)) {
      return expand(node.type({ ...node.props, children: node.children }));
    }
    return { ...node, children: (node.children || []).map(expand) };
  }
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
      tree = expand(Screen());
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
  let initialTipsHandled = false;
  async function settle() {
    for (let index = 0; index < 4; index++) { render(); await new Promise(setImmediate); }
    render();
    if (!initialTipsHandled && !options.keepTips && nodes().some(node => node.type === 'Modal')) {
      initialTipsHandled = true; press('Dismiss tips');
    }
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
    const modal = nodes().find(item => item.type === 'Modal');
    assert.ok(!modal || nodes(modal).includes(node), `Tips modal blocks button: ${label}`);
    assert.ok(!node.props.disabled, `Button disabled: ${label}`);
    const result = node.props.onPress();
    render();
    return result;
  }
  render();
  return {
    render, settle, press, button, alerts, routes, uploads, deletions, locationCalls, automaticLocationCalls, RecognitionApiError,
    text: () => JSON.stringify(tree),
    get tipsModalVisible() { return nodes().some(node => node.type === 'Modal'); },
    get headerText() { return JSON.stringify(nodes().find(node => node.type === 'SafeAreaView')); },
    get controlsText() { return JSON.stringify(nodes().find(node => node.props?.testID === 'face-capture-controls')); },
    get cameraMounted() { return mounted; }, get photos() { return photos; },
    get mounts() { return mounts; }, get unmounts() { return unmounts; },
    get permissionRequests() { return permissionRequests; },
    get permissionQueries() { return permissionQueries; },
    get openedSettings() { return openedSettings; },
    cameraReady() { nodes().find(node => node.type === CameraView)?.props.onCameraReady(); render(); },
    layout(width, height) { tree.props.onLayout({ nativeEvent: { layout: { width, height } } }); render(); },
    get guideBounds() {
      const node = nodes().find(node => node.props?.testID === 'face-capture-guide');
      return node ? Object.assign({}, ...node.props.style) : null;
    },
    get controlsBounds() {
      const node = nodes().find(node => node.props?.testID === 'face-capture-controls');
      return node ? Object.assign({}, ...node.props.style) : null;
    },
    cameraError() { nodes().find(node => node.type === CameraView)?.props.onMountError(); render(); },
    focus(value) { focused = value; dirty = true; render(); },
    appState(value) { appState = value; appListeners.forEach(listener => listener(value)); render(); },
    privacy(value) { privacyState = value; profile.optOutFlag = value === 'opted_out'; dirty = true; render(); },
    enrollment(value) { profile.faceEnrolled = value; dirty = true; render(); },
    account(value) { accountUid = value; profile.uid = value; dirty = true; render(); },
    consentRevision(value) { profile.faceConsentRevision = value; dirty = true; render(); },
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); render(); },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      if (mounted) { mounted = false; unmounts++; }
    },
  };
}

for (const [filename, captureLabel] of [['attendance-checkin.tsx', 'Take check-in photo'], ['face-enrollment.tsx', 'Take enrollment photo']]) {
  test(`${filename} tips modal blocks capture until acknowledged and disappears on navigation away`, async () => {
    const screen = screenHarness(filename, { keepTips: true });
    await screen.settle();
    assert.equal(screen.tipsModalVisible, true);
    assert.throws(() => screen.press(captureLabel), /Tips modal blocks button/);
    screen.button(captureLabel).props.onPress(); await screen.settle();
    assert.equal(screen.photos, 0); assert.equal(screen.uploads.length, 0);
    screen.press('Dismiss tips'); await screen.settle();
    assert.equal(screen.tipsModalVisible, false); assert.equal(screen.cameraMounted, true);
    screen.press('Show scanning tips'); assert.equal(screen.tipsModalVisible, true);
    screen.focus(false); await screen.settle();
    assert.equal(screen.tipsModalVisible, false); assert.equal(screen.cameraMounted, false);
  });
}

test('course selection sits under the student name in the header and there are no manual location controls', async () => {
  const screen = screenHarness('attendance-checkin.tsx'); await screen.settle();
  assert.ok(screen.headerText.indexOf('Student') < screen.headerText.indexOf('course'));
  assert.ok(screen.headerText.includes('course')); assert.ok(!screen.controlsText.includes('courseChip'));
  assert.throws(() => screen.button('Get location'), /Missing button/);
  assert.throws(() => screen.button('Refresh location'), /Missing button/);
  assert.ok(!/accuracyMeters|radiusMeters|capturedAtMs/.test(screen.text()));
  assert.deepEqual(screen.automaticLocationCalls, ['collect']); assert.equal(screen.uploads.length, 0);
});

test('initial automatic location completes before requesting camera permission or opening the camera', async () => {
  const reading = deferred();
  const screen = screenHarness('attendance-checkin.tsx', { permissionGranted: false, initialCollectLocation: () => reading.promise });
  await screen.settle();
  assert.deepEqual(screen.automaticLocationCalls, ['collect']); assert.equal(screen.permissionRequests, 0);
  assert.equal(screen.cameraMounted, false); assert.equal(screen.photos, 0);
  assert.ok(screen.text().includes('Getting ready'));
  reading.resolve({ latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null });
  await screen.settle(); assert.equal(screen.permissionRequests, 1); assert.equal(screen.uploads.length, 0);
});

test('settings recovery never starts another location request until the student taps Check In', async () => {
  const { LocationCaptureError } = require('./checkin-location');
  const screen = screenHarness('attendance-checkin.tsx', {
    profile: { optOutFlag: true, faceEnrolled: false },
    initialCollectLocation: async () => { throw new LocationCaptureError('location_permission_blocked'); },
  });
  await screen.settle(); screen.press('Open Settings'); assert.equal(screen.openedSettings, 1);
  screen.appState('background'); screen.appState('active'); await screen.settle();
  assert.deepEqual(screen.automaticLocationCalls, ['collect']); assert.deepEqual(screen.locationCalls, []);
  screen.press('Check in with location'); await screen.settle();
  assert.equal(screen.uploads.length, 1); assert.equal(screen.photos, 0); assert.equal(screen.mounts, 0);
});

test('camera permission granted in Settings is rechecked without silently starting the camera or location', async () => {
  const screen = screenHarness('attendance-checkin.tsx', {
    permissionGranted: false, canAskCameraAgain: false,
    getCameraPermission: async () => ({ granted: true, canAskAgain: true }),
  });
  await screen.settle(); assert.equal(screen.permissionRequests, 0);
  screen.press('Open Settings'); assert.equal(screen.openedSettings, 1);
  screen.appState('background'); screen.appState('active'); await screen.settle();
  assert.equal(screen.permissionQueries, 1); assert.equal(screen.cameraMounted, false);
  assert.deepEqual(screen.automaticLocationCalls, ['collect']); assert.deepEqual(screen.locationCalls, []);
  screen.press('Resume check-in camera'); await screen.settle(); assert.equal(screen.cameraMounted, true);
  screen.press('Take check-in photo'); await screen.settle(); assert.equal(screen.uploads.length, 1);
  screen.focus(false); const queries = screen.permissionQueries;
  screen.appState('background'); screen.appState('active'); await screen.settle();
  assert.equal(screen.permissionQueries, queries, 'An unfocused check-in must not query camera permission.');
});

test('resuming the camera preserves its fresh automatic reading for the next photo instead of discarding it', async () => {
  const screen = screenHarness('attendance-checkin.tsx'); await screen.settle();
  screen.appState('background'); screen.appState('active'); await screen.settle();
  assert.equal(screen.cameraMounted, false);
  screen.press('Resume check-in camera'); await screen.settle();
  assert.equal(screen.cameraMounted, true); assert.equal(screen.photos, 0);
  assert.deepEqual(screen.locationCalls, ['collect']);
  screen.press('Take check-in photo'); await screen.settle();
  assert.equal(screen.uploads.length, 1); assert.deepEqual(screen.locationCalls, ['collect', 'release']);
  assert.deepEqual(screen.automaticLocationCalls, ['collect']);
});

test('location-only check-in replaces an expired reading in the same tap without ever opening the camera', async () => {
  let current = null;
  const screen = screenHarness('attendance-checkin.tsx', {
    profile: { optOutFlag: true, faceEnrolled: false }, permissionGranted: false,
    getLocationSample: () => current,
    collectLocation: async () => current = { latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null },
  });
  await screen.settle(); assert.equal(screen.uploads.length, 0);
  screen.press('Check in with location'); await screen.settle();
  assert.deepEqual(screen.automaticLocationCalls, ['collect']); assert.deepEqual(screen.locationCalls, ['collect', 'release']);
  assert.equal(screen.uploads.length, 1); assert.equal(screen.uploads[0].data.location, current);
  assert.equal(screen.uploads[0].data.image, null); assert.equal(screen.photos, 0); assert.equal(screen.mounts, 0);
  assert.equal(screen.permissionRequests, 0);
});

test('both screens use identical measured guide bounds and leave scrollable controls below on small and large phones', async () => {
  const checkin = screenHarness('attendance-checkin.tsx');
  const enrollment = screenHarness('face-enrollment.tsx');
  await checkin.settle(); await enrollment.settle();
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932]]) {
    checkin.layout(width, height); enrollment.layout(width, height);
    assert.deepEqual(checkin.guideBounds, enrollment.guideBounds);
    for (const screen of [checkin, enrollment]) {
      const frame = screen.guideBounds, controls = screen.controlsBounds;
      assert.equal(frame.position, 'absolute');
      assert.ok(frame.left >= 20 && frame.left + frame.width <= width - 20);
      assert.ok(controls.top > frame.top + frame.height + 20);
      assert.equal(controls.position, 'absolute'); assert.equal(controls.bottom, 0);
      assert.ok(height - controls.top >= 170, 'Small phones retain a usable scrolling area.');
    }
  }
});

test('check-in guide does not move when tips, automatic location, retry feedback or verification state changes', async () => {
  let attempts = 0;
  const pending = deferred();
  const screen = screenHarness('attendance-checkin.tsx', {
    keepTips: true, recognize: () => ++attempts === 1 ? pending.promise : Promise.resolve({ recognized: true }),
  });
  await screen.settle(); screen.layout(390, 844);
  const initial = screen.guideBounds;
  screen.press('Dismiss tips'); assert.deepEqual(screen.guideBounds, initial);
  screen.press('Show scanning tips'); assert.deepEqual(screen.guideBounds, initial);
  screen.press('Dismiss tips');
  screen.press('Take check-in photo'); await screen.settle();
  assert.deepEqual(screen.guideBounds, initial);
  pending.resolve({ recognized: false }); await screen.settle();
  assert.deepEqual(screen.guideBounds, initial);
  screen.press('Take check-in photo'); await screen.settle();
  assert.ok(screen.text().includes('Attendance Recorded!'));
  assert.deepEqual(screen.guideBounds, initial);
});

test('enrollment guide stays fixed through progress steps, review, upload and success', async () => {
  const pending = deferred();
  const screen = screenHarness('face-enrollment.tsx', { keepTips: true, enroll: () => pending.promise });
  await screen.settle(); screen.layout(320, 568);
  const initial = screen.guideBounds;
  screen.press('Dismiss tips'); assert.deepEqual(screen.guideBounds, initial);
  for (let index = 0; index < 3; index++) {
    screen.press('Take enrollment photo'); await screen.settle();
    assert.deepEqual(screen.guideBounds, initial);
  }
  screen.press('Submit Three Photos'); await screen.settle();
  assert.deepEqual(screen.guideBounds, initial);
  pending.resolve({ sampleCount: 3, model: 'Facenet512' }); await screen.settle();
  assert.deepEqual(screen.guideBounds, initial);
});

test('check-in keeps one camera preview through consent and verification, then releases it on success', async () => {
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
  assert.equal(screen.cameraMounted, true);
  assert.equal(screen.unmounts, 0);
  assert.equal(screen.uploads.length, 0);
  afterCapture.resolve({ optOutFlag: false, faceEnrolled: true, faceConsentRevision: 0 });
  await screen.settle();
  assert.equal(screen.cameraMounted, true);
  recognition.resolve({ recognized: true, uid: 'student' });
  await screen.settle();
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.uploads.at(-1).type, 'check-in');
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
    screen.press(resumeLabel); await screen.settle();
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

  test(`${filename} ${filename === 'attendance-checkin.tsx' ? 'keeps camera ready after capture failure' : 'releases camera on capture failure and only reopens for retry'}`, async () => {
    const screen = screenHarness(filename, { capture: async () => { throw new Error('Capture failed'); } });
    await screen.settle();
    screen.press(captureLabel);
    await screen.settle();
    if (filename === 'attendance-checkin.tsx') {
      assert.equal(screen.cameraMounted, true);
      assert.equal(screen.button(captureLabel).props.disabled, false);
    } else {
      assert.equal(screen.cameraMounted, false);
      screen.press(resumeLabel);
    }
    assert.equal(screen.cameraMounted, true);
    assert.equal(screen.photos, 1);
  });

  test(`${filename} releases camera on mount error and opt-out`, async () => {
    const screen = screenHarness(filename);
    await screen.settle();
    screen.cameraError();
    assert.equal(screen.cameraMounted, false);
    screen.press(resumeLabel); await screen.settle();
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

test('repeated failed face comparisons allow retakes without remounting the camera, then success releases it', async () => {
  let comparisons = 0;
  const screen = screenHarness('attendance-checkin.tsx', {
    locationRequirement: { kind: 'required', radiusMeters: 15 },
    recognize: async () => ({ recognized: ++comparisons === 4 }),
  });
  await screen.settle();
  assert.deepEqual(screen.automaticLocationCalls, ['collect']);
  for (let index = 0; index < 3; index++) {
    screen.press('Take check-in photo'); await screen.settle();
    assert.equal(screen.cameraMounted, true);
    assert.equal(screen.photos, index + 1);
    assert.equal(screen.mounts, 1); assert.equal(screen.unmounts, 0);
    assert.deepEqual(screen.locationCalls, []);
    assert.equal(screen.uploads[index].data.location, screen.uploads[0].data.location);
    assert.equal(screen.uploads[index].data.image, `photo-${index + 1}`);
  }
  screen.press('Try again'); await screen.settle();
  assert.equal(screen.photos, 4); assert.equal(screen.cameraMounted, false);
  assert.deepEqual(screen.locationCalls, ['release']);
  assert.equal(screen.mounts, 1); assert.equal(screen.unmounts, 1);
  screen.runTimers(); assert.deepEqual(screen.routes, ['back']);
});

test('no active session never opens the camera', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { noSession: true });
  await screen.settle();
  assert.equal(screen.mounts, 0);
});

for (const code of ['no_face_detected', 'multiple_faces_detected', 'invalid_face_image']) {
  test(`${code} leaves the camera ready for a retake and closing releases it`, async () => {
    let screen;
    screen = screenHarness('attendance-checkin.tsx', { checkIn: async () => {
      throw new screen.RecognitionApiError(code);
    } });
    await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
    assert.equal(screen.cameraMounted, true);
    assert.equal(screen.button('Take check-in photo').props.disabled, false);
    assert.equal(screen.unmounts, 0);
    assert.ok(!screen.locationCalls.includes('release'));
    screen.press('Close check-in');
    assert.equal(screen.cameraMounted, false); assert.deepEqual(screen.routes, ['back']);
  });
}

test('unmounting check-in releases the live preview and aborts pending verification', async () => {
  const pending = deferred();
  const screen = screenHarness('attendance-checkin.tsx', { checkIn: () => pending.promise });
  await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
  assert.equal(screen.cameraMounted, true);
  screen.unmount();
  assert.equal(screen.cameraMounted, false);
  assert.equal(screen.uploads[0].options.signal.aborted, true);
  pending.resolve({ status: 'present', locationStatus: 'in_zone' }); await screen.settle();
  assert.equal(screen.cameraMounted, false);
  assert.ok(!screen.text().includes('Attendance Recorded!'));
  screen.runTimers(); assert.deepEqual(screen.routes, []);
});

test('location is automatically prepared on entry and the first capture sends one combined request', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { locationRequirement: { kind: 'required', radiusMeters: 15 } });
  await screen.settle();
  screen.press('Take check-in photo'); await screen.settle();
  assert.deepEqual(screen.automaticLocationCalls, ['collect']);
  assert.equal(screen.photos, 1); assert.equal(screen.uploads.length, 1);
  assert.equal(screen.uploads[0].type, 'check-in');
  assert.deepEqual(Object.keys(screen.uploads[0].data).sort(), ['image', 'location', 'schemaVersion', 'sessionId']);
  assert.equal(screen.uploads[0].data.location.accuracyMeters, 3);
  assert.equal(screen.uploads[0].options.expectedUid, 'student');
  assert.equal(screen.uploads[0].options.expectedCourseId, 'course');
  assert.ok(screen.locationCalls.includes('release'));
  assert.ok(screen.text().includes('Classroom location verified'));
  assert.equal(screen.cameraMounted, false);
});

test('face check-in preserves the backend Late result and includes location', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { status: 'late' });
  await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
  assert.ok(screen.uploads[0].data.location);
  assert.ok(!screen.locationCalls.includes('collect'));
  assert.ok(screen.text().includes('Checked in as Late.'));
  assert.ok(screen.text().includes('Classroom location verified'));
});

test('unenrolled opted-in students see enrollment/privacy actions instead of a dead Get location button', async () => {
  const screen = screenHarness('attendance-checkin.tsx', { profile: { faceEnrolled: false }, permissionGranted: false });
  await screen.settle();
  assert.ok(screen.text().includes('Enroll face'));
  assert.ok(screen.text().includes('Profile & Settings'));
  assert.equal(screen.automaticLocationCalls.length, 0);
  assert.ok(!screen.text().includes('Get location'));
  assert.equal(screen.permissionRequests, 0); assert.equal(screen.mounts, 0); assert.equal(screen.locationCalls.length, 0);
  screen.press('Enroll face'); assert.equal(screen.routes.at(-1), '/face-enrollment');
  assert.ok(!screen.locationCalls.includes('collect')); assert.equal(screen.photos, 0);
});

test('location-only check-in works while face deletion is pending without requesting or opening the camera', async () => {
  const screen = screenHarness('attendance-checkin.tsx', {
    profile: { optOutFlag: true, faceEnrolled: false, faceDataDeletionStatus: 'pending' }, permissionGranted: false,
  });
  await screen.settle(); screen.press('Check in with location'); await screen.settle();
  assert.equal(screen.uploads.length, 1); assert.equal(screen.uploads[0].data.image, null);
  assert.ok(screen.uploads[0].data.location); assert.equal(screen.photos, 0); assert.equal(screen.mounts, 0);
  assert.equal(screen.permissionRequests, 0); assert.ok(screen.text().includes('Attendance Recorded!'));
});

test('both consent modes block self check-in when the saved classroom zone is disabled', async () => {
  for (const optedOut of [false, true]) {
    const screen = screenHarness('attendance-checkin.tsx', { profile: { optOutFlag: optedOut }, locationRequirement: { kind: 'not_required' } });
    await screen.settle();
    screen.press(optedOut ? 'Check in with location' : 'Try check-in again'); await screen.settle();
    assert.equal(screen.photos, 0); assert.equal(screen.uploads.length, 0);
    assert.ok(!screen.locationCalls.includes('collect')); assert.ok(screen.text().includes('Reload session'));
  }
});

test('backgrounding cancels a location-only upload and ignores its late success', async () => {
  const pending = deferred();
  const screen = screenHarness('attendance-checkin.tsx', { profile: { optOutFlag: true, faceEnrolled: false }, checkIn: () => pending.promise });
  await screen.settle(); screen.press('Check in with location'); await screen.settle(); screen.appState('background');
  assert.equal(screen.uploads[0].options.signal.aborted, true);
  pending.resolve({ status: 'present', locationStatus: 'in_zone' }); await screen.settle();
  assert.ok(!screen.text().includes('Attendance Recorded!')); assert.equal(screen.photos, 0);
});

test('unavailable policy or denied location prevents capture and upload', async () => {
  for (const policy of ['unavailable', 'required']) {
    const screen = screenHarness('attendance-checkin.tsx', {
      locationRequirement: { kind: policy, radiusMeters: 15 }, initialCollectLocation: async () => null, collectLocation: async () => null,
    });
    await screen.settle(); screen.press('Try check-in again'); await screen.settle();
    assert.equal(screen.photos, 0); assert.equal(screen.uploads.length, 0);
    if (policy === 'unavailable') assert.ok(screen.locationCalls.includes('location_policy_unavailable'));
  }
});

test('sample that expires during photo capture is refreshed with the check-in preview still open before upload', async () => {
  let reads = 0, screen;
  const fresh = { latitude: 33, longitude: -97, accuracyMeters: 2, capturedAtMs: Date.now(), mocked: false };
  screen = screenHarness('attendance-checkin.tsx', {
    locationRequirement: { kind: 'required', radiusMeters: 15 },
    getLocationSample: () => ++reads === 1 ? fresh : null,
    collectLocation: async () => {
      // Native permission/provider calls yield before sampling starts.
      await new Promise(setImmediate);
      assert.equal(screen.cameraMounted, true); return fresh;
    },
  });
  await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
  assert.equal(screen.photos, 1); assert.deepEqual(screen.locationCalls, ['collect', 'release']);
  assert.equal(screen.uploads[0].data.location, fresh);
  assert.equal(screen.cameraMounted, false);
});

test('a failed post-photo location refresh discards the photo and never uploads', async () => {
  let reads = 0;
  const screen = screenHarness('attendance-checkin.tsx', {
    locationRequirement: { kind: 'required', radiusMeters: 15 },
    getLocationSample: () => ++reads === 1 ? {} : null, collectLocation: async () => null,
  });
  await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
  assert.equal(screen.photos, 1); assert.equal(screen.uploads.length, 0);
  assert.ok(screen.deletions.includes('temporary-1')); assert.equal(screen.cameraMounted, true);
  assert.ok(screen.text().includes('Could not get your location'));
});

for (const [label, invalidate] of [
  ['navigation', screen => screen.focus(false)],
  ['account changes', screen => screen.account('other')],
  ['consent revision changes', screen => screen.consentRevision(1)],
  ['closing check-in', screen => screen.press('Close check-in')],
]) {
  test(`${label} aborts pending backend verification and ignores a late success`, async () => {
    const pending = deferred();
    const screen = screenHarness('attendance-checkin.tsx', { checkIn: () => pending.promise });
    await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
    invalidate(screen); await screen.settle();
    assert.equal(screen.uploads[0].options.signal.aborted, true);
    pending.resolve({ status: 'present', locationStatus: 'in_zone' }); await screen.settle();
    assert.ok(!screen.text().includes('Attendance Recorded!'));
    assert.equal(screen.cameraMounted, false);
    screen.runTimers(); assert.equal(screen.routes.length, label === 'closing check-in' ? 1 : 0);
  });
}

test('backend location rejection keeps the preview open and offers location recovery', async () => {
  let screen;
  screen = screenHarness('attendance-checkin.tsx', { checkIn: async () => {
    throw new screen.RecognitionApiError('location_outside_zone', 'Move inside the classroom.');
  } });
  await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
  assert.ok(screen.locationCalls.includes('location_outside_zone'));
  assert.ok(screen.locationCalls.includes('release'));
  assert.equal(screen.cameraMounted, true); assert.ok(!screen.text().includes('Attendance Recorded!'));
  assert.ok(screen.text().includes('Try checking in again'));
  screen.press('Take check-in photo'); await screen.settle();
  assert.ok(screen.locationCalls.includes('collect'));
  assert.equal(screen.photos, 2); assert.equal(screen.uploads.length, 2);
  assert.notEqual(screen.uploads[0].data.location, screen.uploads[1].data.location);
});

test('a face rejection never retains a location whose original freshness window has expired', async () => {
  const pending = deferred();
  let currentSample = { latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null };
  const screen = screenHarness('attendance-checkin.tsx', {
    getLocationSample: () => currentSample,
    collectLocation: async () => currentSample = { latitude: 33, longitude: -97, accuracyMeters: 3, capturedAtMs: Date.now(), mocked: null },
    recognize: () => pending.promise,
  });
  await screen.settle(); screen.press('Take check-in photo'); await screen.settle();
  currentSample = null; // The real hook expires independently while verification is pending.
  pending.resolve({ recognized: false }); await screen.settle();
  assert.ok(screen.locationCalls.includes('release'));
  screen.press('Take check-in photo'); await screen.settle();
  assert.ok(screen.locationCalls.includes('collect'));
  assert.equal(screen.photos, 2); assert.equal(screen.uploads.length, 2);
  assert.notEqual(screen.uploads[0].data.location, screen.uploads[1].data.location);
});

test('returning to check-in after leaving during session loading fetches sessions again', async () => {
  let loads = 0;
  const first = deferred();
  const screen = screenHarness('attendance-checkin.tsx', { sessions: () => ++loads === 1 ? first.promise : Promise.resolve([]) });
  screen.focus(false); screen.focus(true); await screen.settle();
  assert.equal(loads, 2);
  first.resolve([{ sessionId: 'obsolete', courseId: 'old-course' }]); await screen.settle();
  assert.ok(screen.text().includes('No Active Session'));
  assert.ok(!screen.text().includes('old-course')); assert.equal(screen.cameraMounted, false);
});

test('backgrounding during backend verification aborts the request and never applies a late success or restarts the camera', async () => {
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
  assert.equal(screen.uploads.filter(upload => upload.type === 'check-in').length, 1);
  assert.equal(screen.uploads[0].options.signal.aborted, true);
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
