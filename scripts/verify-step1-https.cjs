// Reproducible integration check pinned to a separate local emulator project.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCommand } = require('./demo');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'build', 'step1');
fs.mkdirSync(directory, { recursive: true });
fs.copyFileSync(path.join(root, 'firestore.rules'), path.join(directory, 'firestore.rules'));
fs.writeFileSync(path.join(directory, 'firebase.json'), JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  emulators: { auth: { host: '127.0.0.1', port: 9189 }, firestore: { host: '127.0.0.1', port: 8189 },
    hub: { host: '127.0.0.1', port: 4419 }, logging: { host: '127.0.0.1', port: 4519 },
    ui: { enabled: false }, singleProjectMode: true },
}, null, 2));
const environment = { ...process.env, GCLOUD_PROJECT: 'demo-faceroll-step1',
  FACEROLL_STEP1_EMULATOR_TEST: '1', FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1', DEBUG: '' };
const invocation = resolveCommand(process.platform === 'win32' ? 'firebase.cmd' : 'firebase', [
  'emulators:exec', '--only', 'auth,firestore', '--project', 'demo-faceroll-step1',
  '--config', path.join(directory, 'firebase.json'), 'node --test scripts/secure-transport.test.js',
], environment);
const child = spawn(invocation.command, invocation.args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Could not launch the Firebase CLI for the isolated HTTPS check.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
