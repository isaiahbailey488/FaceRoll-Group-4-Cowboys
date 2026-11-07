const assert = require('node:assert/strict');
assert.equal(process.env.FACEROLL_STEP6_TEST, '1', 'Isolated Step 6 runner required.');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-faceroll-step6', 'Isolated project required.');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { fixture } = require('./tls-test-helpers.cjs');
const { startEmulatorHttps } = require('./emulator-https');
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'FaceRoll-System/recognition/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function request(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.get(url + '/health', { rejectUnauthorized: true, ...options }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('TLS check timed out.')));
  });
}
async function stop(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}
function ready(child) {
  return new Promise((resolve, reject) => {
    let output = '', diagnostics = '';
    const timer = setTimeout(() => reject(new Error('Synthetic HTTPS API startup timed out.')), 45000);
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-1500); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic API exited before readiness: ' + diagnostics)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      try {
        const metadata = JSON.parse(output.split('\n')[0]);
        assert.equal(new URL(metadata.apiUrl).hostname, '127.0.0.1');
        assert.equal(new URL(metadata.apiUrl).protocol, 'https:');
        clearTimeout(timer); resolve(metadata);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
}
(async () => {
  const tls = fixture(); let gateway, api, probe;
  try {
    gateway = await startEmulatorHttps({ ...tls, authPort: 0, firestorePort: 0, authTargetPort: 9389, firestoreTargetPort: 8389 });
    api = spawn(python, [path.join(__dirname, 'step6-api-fixture.py'), tls.directory],
      { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const metadata = await ready(api);
    assert.equal(await request(metadata.apiUrl, { ca: tls.ca }), 200);
    await assert.rejects(request(metadata.apiUrl), error => /CERT|VERIFY|ISSUER/.test(error.code || ''));
    await assert.rejects(request(metadata.apiUrl, { ca: tls.ca, servername: 'wrong.example.test' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    // Plain HTTP cannot reach a successful API handler on its TLS listener.
    await new Promise((resolve, reject) => {
      const req = http.get(metadata.apiUrl.replace('https:', 'http:') + '/health', response => {
        response.resume(); if (response.statusCode === 200) reject(new Error('Cleartext reached the HTTPS API.')); else resolve();
      });
      req.on('error', resolve); req.setTimeout(3000, () => req.destroy());
    });
    const urls = gateway.servers.map(server => `https://127.0.0.1:${server.address().port}`);
    await new Promise((resolve, reject) => {
      probe = spawn(process.execPath, [path.join(__dirname, 'step6-sdk-probe.cjs')], {
        cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env,
          NODE_EXTRA_CA_CERTS: path.join(tls.directory, 'ca.pem'), NODE_TLS_REJECT_UNAUTHORIZED: '1',
          FACEROLL_STEP6_METADATA: JSON.stringify({ ...metadata, authUrl: urls[0], firestoreUrl: urls[1] }) },
      });
      const timer = setTimeout(() => { probe.kill(); reject(new Error('Step 6 network rehearsal timed out.')); }, 180000);
      probe.once('error', error => { clearTimeout(timer); reject(error); });
      probe.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Step 6 client rehearsal failed.')); });
    });
  } finally {
    await stop(probe); await stop(api); await gateway?.close(); tls.cleanup();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
