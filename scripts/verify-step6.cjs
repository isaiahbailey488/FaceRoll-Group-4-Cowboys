// Real HTTPS + Firebase integration. Never reads/imports the user's demo data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveCommand } = require('./demo');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'build', 'step6');
const reportPath = path.join(directory, 'latest-results.json');
const rules = ['firestore.rules', 'FaceRoll-System/Instructor-Dashboard/firestore.rules'];
const environment = { ...process.env, GCLOUD_PROJECT: 'demo-faceroll-step6', FIREBASE_PROJECT_ID: 'demo-faceroll-step6',
  GOOGLE_CLOUD_PROJECT: 'demo-faceroll-step6', FACEROLL_FIREBASE_MODE: 'emulator', FACEROLL_STEP6_TEST: '1',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9389', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8389',
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1', CI: 'true', DEBUG: '', NODE_TLS_REJECT_UNAUTHORIZED: '1' };
delete environment.GOOGLE_APPLICATION_CREDENTIALS;
delete environment.FIREBASE_CONFIG;
delete environment.FACEROLL_TLS_CERT;
delete environment.FACEROLL_TLS_KEY;
fs.mkdirSync(directory, { recursive: true });
const config = path.join(directory, 'firebase.json');
fs.writeFileSync(config, JSON.stringify({ firestore: { rules: 'firestore.rules' },
  emulators: { auth: { host: '127.0.0.1', port: 9389 }, firestore: { host: '127.0.0.1', port: 8389, websocketPort: 9199 },
    hub: { host: '127.0.0.1', port: 4439 }, logging: { host: '127.0.0.1', port: 4539 },
    ui: { enabled: false }, singleProjectMode: true } }, null, 2));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
  project: environment.GCLOUD_PROJECT, inference: 'synthetic', device: 'Node service rehearsal; no physical device',
  ruleRuns: [], physicalIPhone: 'pending', productionDeployment: 'not_performed' };
function save() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
function run(rule, index) {
  fs.copyFileSync(path.join(root, rule), path.join(directory, 'firestore.rules'));
  const resultFile = path.join(directory, `probe-${index}.json`);
  // Remove a stale result only at the exact known file inside this workspace.
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  const env = { ...environment, FACEROLL_STEP6_RESULT: resultFile };
  const invocation = resolveCommand(process.platform === 'win32' ? 'firebase.cmd' : 'firebase', [
    'emulators:exec', '--only', 'auth,firestore', '--project', environment.GCLOUD_PROJECT,
    '--config', config, 'node scripts/step6-network.cjs',
  ], env);
  console.log(`Step 6 HTTPS rehearsal: ${rule}`);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => {
      const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { status: 'failed', checks: [] };
      report.ruleRuns.push({ rules: rule, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rule))).digest('hex'), ...result });
      save();
      if (code === 0 && result.status === 'passed') resolve();
      else reject(new Error('Step 6 HTTPS rehearsal failed; see build/step6/latest-results.json.'));
    });
  });
}
(async () => {
  assert.notEqual(path.resolve(directory), root);
  save();
  for (let index = 0; index < rules.length; index++) await run(rules[index], index);
  report.status = 'passed';
  console.log('Automated HTTPS rehearsal passed for both rule files. Physical iPhone checks remain pending.');
})().catch(error => { report.status = 'failed'; console.error(error.message); process.exitCode = 1; })
  .finally(() => { report.finishedAt = new Date().toISOString(); save(); });
