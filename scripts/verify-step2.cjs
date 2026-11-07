// Isolated Auth/Firestore verification; never imports or exports demo data.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCommand } = require('./demo');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'build', 'step2');
fs.mkdirSync(directory, { recursive: true });
const environment = { ...process.env, GCLOUD_PROJECT: 'demo-faceroll-step2',
  FIREBASE_PROJECT_ID: 'demo-faceroll-step2', GOOGLE_CLOUD_PROJECT: 'demo-faceroll-step2',
  FACEROLL_FIREBASE_MODE: 'emulator', FACEROLL_STEP2_EMULATOR_TEST: '1',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9289', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8289',
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1', CI: 'true', DEBUG: '' };
delete environment.GOOGLE_APPLICATION_CREDENTIALS;
const python = path.join(root, 'FaceRoll-System', 'recognition', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const config = path.join(directory, 'firebase.json');
fs.writeFileSync(config, JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  emulators: { auth: { host: '127.0.0.1', port: 9289 }, firestore: { host: '127.0.0.1', port: 8289, websocketPort: 9189 },
    hub: { host: '127.0.0.1', port: 4429 }, logging: { host: '127.0.0.1', port: 4529 },
    ui: { enabled: false }, singleProjectMode: true },
}, null, 2));
// Run both checked-in rule sets; they are separate deployment entry points.
async function verify(rules) {
  fs.copyFileSync(path.join(root, rules), path.join(directory, 'firestore.rules'));
  console.log(`Checking backend attendance with ${rules}`);
  const command = `"${python}" -m pytest FaceRoll-System/recognition/tests/test_attendance_emulator.py -q --tb=short`;
  const invocation = resolveCommand(process.platform === 'win32' ? 'firebase.cmd' : 'firebase', [
    'emulators:exec', '--only', 'auth,firestore', '--project', 'demo-faceroll-step2', '--config', config, command,
  ], environment);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Backend attendance emulator checks failed.')));
  });
}
(async () => {
  await verify('firestore.rules');
  await verify('FaceRoll-System/Instructor-Dashboard/firestore.rules');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
