const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { fixture } = require('./tls-test-helpers.cjs');
const { startEmulatorHttps } = require('./emulator-https');
const root = path.resolve(__dirname, '..');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function get(port, options = {}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port, path: '/', rejectUnauthorized: true, ...options }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, data, authorized: response.socket?.authorized }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('TLS gateway forwards to fixed local services and rejects untrusted certificates, wrong hosts and proxy requests', async () => {
  const tls = fixture(); let authRequests = 0, firestoreRequests = 0, gateway;
  const auth = http.createServer((_request, response) => { authRequests++; response.end('auth'); });
  const firestore = http.createServer((_request, response) => { firestoreRequests++; response.end('firestore'); });
  try {
    await listen(auth); await listen(firestore);
    gateway = await startEmulatorHttps({ ...tls, authPort: 0, firestorePort: 0,
      authTargetPort: auth.address().port, firestoreTargetPort: firestore.address().port });
    const [authPort, firestorePort] = gateway.servers.map(server => server.address().port);
    assert.equal((await get(authPort, { ca: tls.ca })).data, 'auth');
    assert.equal((await get(firestorePort, { ca: tls.ca })).data, 'firestore');
    await assert.rejects(get(authPort));
    await assert.rejects(get(authPort, { ca: tls.ca, servername: 'wrong.example.test' }));
    assert.equal((await get(authPort, { ca: tls.ca, path: 'http://external.invalid/secret' })).status, 400);
    assert.equal(authRequests, 1); assert.equal(firestoreRequests, 1);
  } finally {
    await gateway?.close(); await close(auth); await close(firestore); tls.cleanup();
  }
});

// Opt-in integration mode, run by emulators:exec with a separate demo project.
if (process.env.FACEROLL_STEP1_EMULATOR_TEST === '1') test('real Firebase SDK signs in and reads/writes Firestore through certificate-validated HTTPS', async () => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-faceroll-step1');
  const tls = fixture(); let gateway;
  try {
    gateway = await startEmulatorHttps({ ...tls, authPort: 0, firestorePort: 0, authTargetPort: 9189, firestoreTargetPort: 8189 });
    const urls = gateway.servers.map(server => `https://127.0.0.1:${server.address().port}`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'step1-sdk-probe.cjs'), ...urls], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tls.directory, 'ca.pem') }, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('SDK HTTPS check timed out.')); }, 45000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(output)); });
    });
  } finally { await gateway?.close(); tls.cleanup(); }
});
