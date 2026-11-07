'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { fixture } = require('./tls-test-helpers.cjs');
const { ensureLanTrust, createDemoEnvironment } = require('./demo');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = (url.startsWith('https:') ? https : http).get(url, { timeout: 90000, ...options }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('HTTPS smoke request timed out.')));
    request.on('error', reject);
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('LAN trust validates the CA and matching certificate/key before startup', () => {
  const tls = fixture(); const other = fixture();
  const config = { networkMode: 'local', tlsCert: path.join(tls.directory, 'server.pem'), tlsKey: path.join(tls.directory, 'server.key') };
  try {
    // The disposable CA filename differs from mkcert's rootCA.pem.
    fs.copyFileSync(path.join(tls.directory, 'ca.pem'), path.join(tls.directory, 'rootCA.pem'));
    const discovered = { ...config };
    ensureLanTrust(discovered, () => ({ status: 0, stdout: tls.directory }));
    assert.equal(discovered.tlsCa, path.join(tls.directory, 'rootCA.pem'));
    assert.throws(() => ensureLanTrust({ ...config, tlsCa: path.join(other.directory, 'ca.pem') }), /signed by/);
    assert.throws(() => ensureLanTrust({ ...config, tlsCa: path.join(tls.directory, 'ca.pem'), tlsKey: path.join(other.directory, 'server.key') }));
    assert.throws(() => ensureLanTrust({ ...config }, () => ({ status: 1 })), /FACEROLL_TLS_CA/);
  } finally { tls.cleanup(); other.cleanup(); }
});

test('real Expo Metro serves HTTPS manifests, Android bundle and WSS while refusing plaintext and untrusted clients', { timeout: 240000 }, async () => {
  const tls = fixture(); let child; let socket; let output = '';
  try {
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    // --localhost may bind ::1 on Windows; use its actual localhost hostname.
    const origin = `https://localhost:${port}`;
    const env = { ...createDemoEnvironment({ networkMode: 'local', lanAddress: '127.0.0.1',
      tlsCert: path.join(tls.directory, 'server.pem'), tlsKey: path.join(tls.directory, 'server.key'), tlsCa: path.join(tls.directory, 'ca.pem') }),
      EXPO_PACKAGER_PROXY_URL: origin, EXPO_OFFLINE: '1', CI: '1', EXPO_NO_TELEMETRY: '1' };
    child = spawn(process.execPath, [require.resolve('expo/bin/cli'), 'start', '--localhost', '--port', String(port), '--go', '--max-workers', '2'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    let spawnError; child.on('error', error => { spawnError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError || child.exitCode !== null) throw new Error(`Expo stopped: ${spawnError?.message || output}`);
      try { ready = (await get(`${origin}/status`, { ca: tls.ca, timeout: 1000 })).status === 200; } catch { /* server still starting */ }
      if (ready) break;
      await pause(500);
    }
    assert.ok(ready, `Metro was not ready: ${output}`);
    await assert.rejects(get(`${origin}/status`));
    await assert.rejects(get(`${origin}/status`, { ca: tls.ca, servername: 'wrong.example.test' }));
    await assert.rejects(get(`http://localhost:${port}/status`, { timeout: 3000 }));
    const manifestResponse = await get(`${origin}/`, { ca: tls.ca, headers: { accept: 'application/expo+json', 'expo-platform': 'android' } });
    assert.equal(manifestResponse.status, 200, manifestResponse.data);
    const manifest = JSON.parse(manifestResponse.data);
    assert.ok(manifest.launchAsset.url.startsWith(`${origin}/`), manifest.launchAsset.url);
    assert.equal(manifest.extra.expoClient.hostUri, `localhost:${port}`);
    // Same HTTPS listener handles Fast Refresh/dev WebSocket upgrades.
    await new Promise((resolve, reject) => {
      socket = new WebSocket(`${origin.replace('https:', 'wss:')}/hot`, { ca: tls.ca, handshakeTimeout: 5000 });
      socket.once('open', resolve); socket.once('error', reject);
    });
    const bundle = await get(manifest.launchAsset.url, { ca: tls.ca, timeout: 120000 });
    assert.equal(bundle.status, 200, bundle.data.slice(0, 800));
    assert.ok(bundle.data.length > 100000, 'Expected the real Android application bundle.');
    // Also exercise the exact QR renderer used by the launcher, without printing
    // a synthetic QR that a user might mistake for their running demo.
    const cli = require.resolve('@expo/cli/package.json', { paths: [path.dirname(require.resolve('expo/package.json'))] });
    const { printQRCode } = require(path.join(path.dirname(cli), 'build/src/utils/qr.js'));
    assert.ok(printQRCode(`exps://127.0.0.1:${port}`).lines > 5);
  } finally {
    socket?.terminate();
    if (child?.pid && child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      await stopped;
    }
    tls.cleanup();
  }
});
