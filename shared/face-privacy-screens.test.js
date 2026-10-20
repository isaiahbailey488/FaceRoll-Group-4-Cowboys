const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real screen render and permission effects without a native camera.
function renderScreen(filename, state, unavailable = false) {
  let permissionRequests = 0;
  const effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useRef: value => ({ current: value }),
    useCallback: value => value,
    useEffect: value => effects.push(value),
  };
  const camera = function CameraView() {};
  const gate = function FacePrivacyGate() {};
  const native = new Proxy({
    Dimensions: { get: () => ({ width: 390 }) }, StyleSheet: { create: value => value },
  }, { get: (object, key) => object[key] || key });
  const stubs = {
    react, 'react-native': native,
    'expo-camera': { CameraView: camera, useCameraPermissions: () => [{ granted: false }, () => permissionRequests++] },
    'expo-router': { useRouter: () => ({}) }, 'expo-status-bar': {}, '@expo/vector-icons': {},
    '../constants/Colors': {}, '../components/ScanTipsCard': {},
    '../components/FacePrivacyGate': gate,
    '../hooks/useFacePrivacy': { useFacePrivacy: () => ({ state, unavailable, profile: null, retry() {} }) },
    '../hooks/useCaptureCamera': { useCaptureCamera: () => ({ screenActive: true, active: false, ready: false }) },
    '../services/auth': { getCurrentUser: () => null },
    '../services/attendance': {}, '../services/recognition': {},
    '../shared/face-privacy': require('./face-privacy'),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', filename), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: key => {
    assert.ok(Object.hasOwn(stubs, key), `Unexpected import ${key}`);
    return stubs[key];
  }, __DEV__: false });
  const tree = module.exports.default();
  effects.forEach(effect => effect());
  return { tree, gate, permissionRequests };
}

for (const filename of ['attendance-checkin.tsx', 'face-enrollment.tsx']) {
  for (const state of ['loading', 'opted_out', 'deletion_pending']) {
    test(`${filename} hides camera and never requests permission while ${state}`, () => {
      const { tree, gate, permissionRequests } = renderScreen(filename, state);
      assert.equal(tree.type, gate);
      assert.equal(permissionRequests, 0);
    });
  }
  test(`${filename} handles an unavailable preference without opening camera`, () => {
    const { tree, gate, permissionRequests } = renderScreen(filename, 'loading', true);
    assert.equal(tree.type, gate);
    assert.equal(tree.props.unavailable, true);
    assert.equal(permissionRequests, 0);
  });
}
