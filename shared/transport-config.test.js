const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTransportConfig, httpsOrigin } = require('./transport-config');
const emulator = { mode: 'emulator', apiUrl: 'https://demo.example.test', authEmulatorUrl: 'https://demo.example.test:9449', firestoreEmulatorUrl: 'https://demo.example.test:8443' };
test('production and emulator configurations are explicit and cannot be mixed', () => {
  assert.equal(resolveTransportConfig(emulator, true).mode, 'emulator');
  assert.equal(resolveTransportConfig({ mode: 'production', apiUrl: emulator.apiUrl }).mode, 'production');
  assert.throws(() => resolveTransportConfig({ apiUrl: emulator.apiUrl }));
  assert.throws(() => resolveTransportConfig(emulator, false), /Release/);
  assert.throws(() => resolveTransportConfig({ ...emulator, mode: 'production' }), /Production/);
  assert.throws(() => resolveTransportConfig({ ...emulator, legacyEmulatorHost: '192.168.1.5' }, true), /Plain HTTP/);
  assert.throws(() => resolveTransportConfig({ ...emulator, authEmulatorUrl: '' }, true));
});
test('every application endpoint rejects plaintext, redirects-as-URLs and embedded credentials', () => {
  for (const bad of ['http://localhost:5055', 'http://127.0.0.1', 'http://10.0.2.2', 'http://192.168.1.5', 'https://u:p@example.test', 'https://example.test/other', 'https://example.test?q=token', 'https://example.test/#fragment']) {
    assert.throws(() => httpsOrigin(bad, 'Endpoint'));
    for (const key of ['apiUrl', 'authEmulatorUrl', 'firestoreEmulatorUrl']) assert.throws(() => resolveTransportConfig({ ...emulator, [key]: bad }, true));
  }
});
