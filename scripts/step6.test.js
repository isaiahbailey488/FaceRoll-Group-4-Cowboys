const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('network probe refuses production projects and external endpoints before loading SDKs', () => {
  for (const extra of [
    { GCLOUD_PROJECT: 'production-project' },
    { GCLOUD_PROJECT: 'demo-faceroll-step6', FACEROLL_STEP6_METADATA: JSON.stringify({ apiUrl: 'https://external.example.test',
      authUrl: 'https://127.0.0.1:1', firestoreUrl: 'https://127.0.0.1:2' }) },
  ]) {
    const result = spawnSync(process.execPath, ['scripts/step6-sdk-probe.cjs'], { cwd: root, windowsHide: true,
      timeout: 10000, encoding: 'utf8', env: { ...process.env, FACEROLL_STEP6_TEST: '1', ...extra } });
    assert.equal(result.status, 1, result.error?.message || result.stderr);
    assert.match(result.stderr, /Isolated project required|127\.0\.0\.1/);
    assert.equal(result.stdout, '');
  }
});

test('synthetic API fixture refuses production/foreign emulator configuration before importing Firebase', () => {
  const python = path.join(root, 'FaceRoll-System/recognition/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['scripts/step6-api-fixture.py'], { cwd: root, windowsHide: true, timeout: 10000, encoding: 'utf8',
    env: { ...process.env, FACEROLL_STEP6_TEST: '1', GCLOUD_PROJECT: 'demo-faceroll-step6', FACEROLL_FIREBASE_MODE: 'emulator',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9389', FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' } });
  assert.equal(result.status, 1, result.error?.message || result.stderr);
  assert.match(result.stderr, /Isolated Firestore required/); assert.equal(result.stdout, '');
});
