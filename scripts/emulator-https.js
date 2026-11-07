'use strict';
// TLS terminates on the instructor computer. Only fixed loopback services are
// reachable; this is not an open proxy, and request bodies/URLs are never logged.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

async function startEmulatorHttps({ cert, key, host = '127.0.0.1', authPort = 9449, firestorePort = 8443, authTargetPort = 9099, firestoreTargetPort = 8080 }) {
  const servers = [];
  const sockets = new Set();
  const tls = { cert, key, minVersion: 'TLSv1.2' };
  try {
    for (const [port, targetPort] of [[authPort, authTargetPort], [firestorePort, firestoreTargetPort]]) {
      const server = https.createServer(tls, (request, response) => {
        if (!request.url.startsWith('/') || request.url.startsWith('//')) { response.writeHead(400).end(); return; }
        const headers = { ...request.headers, host: `127.0.0.1:${targetPort}` };
        delete headers['proxy-authorization'];
        const upstream = http.request({ hostname: '127.0.0.1', port: targetPort,
          method: request.method, path: request.url, headers, timeout: 75000 }, result => {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
          result.on('error', () => response.destroy());
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => {
          if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"emulator_unavailable"}');
          else response.destroy();
        });
        request.on('aborted', () => upstream.destroy());
        response.on('close', () => upstream.destroy());
        request.pipe(upstream);
      });
      servers.push(server);
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    }
  } catch (error) {
    sockets.forEach(socket => socket.destroy());
    servers.forEach(server => server.close());
    throw error;
  }
  return { servers, close: async () => {
    sockets.forEach(socket => socket.destroy());
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  } };
}

if (require.main === module) {
  (async () => {
    if (!process.env.FACEROLL_TLS_CERT || !process.env.FACEROLL_TLS_KEY) throw new Error('Configure FACEROLL_TLS_CERT and FACEROLL_TLS_KEY.');
    const gateway = await startEmulatorHttps({
      cert: fs.readFileSync(process.env.FACEROLL_TLS_CERT), key: fs.readFileSync(process.env.FACEROLL_TLS_KEY),
      host: process.env.FACEROLL_HTTPS_HOST || '127.0.0.1',
    });
    console.log('Firebase HTTPS gateway ready: Auth 9449, Firestore 8443.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await gateway.close(); process.exit(0); });
  })().catch(error => { console.error('Firebase HTTPS gateway could not start:', error.code || 'configuration_error'); process.exitCode = 1; });
}
module.exports = { startEmulatorHttps };
