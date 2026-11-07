const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCheckInRequest, validateCheckInSuccess } = require('./checkin-contract');
const fixture = require('./checkin-contract.cases.json');

test('canonical requests are copied, immutable and allow a missing position only as explicit null', () => {
  const request = structuredClone(fixture.request);
  const normalized = validateCheckInRequest(request);
  assert.deepEqual(normalized, request); assert.notEqual(normalized.location, request.location);
  assert.equal(Object.isFrozen(normalized.location), true);
  assert.equal(validateCheckInRequest({ ...request, location: null }).location, null);
  assert.equal(validateCheckInRequest({ ...request, image: null }).image, null);
  for (const key of Object.keys(request)) {
    const incomplete = { ...request }; delete incomplete[key];
    assert.throws(() => validateCheckInRequest(incomplete), { code: 'invalid_check_in_request' });
  }
});
for (const entry of fixture.invalidRequests) test('request rejects ' + entry.name, () => {
  const request = structuredClone(fixture.request);
  let target = request;
  for (const part of entry.path.slice(0, -1)) target = target[part];
  target[entry.path.at(-1)] = entry.value;
  assert.throws(() => validateCheckInRequest(request), { code: 'invalid_check_in_request' });
});
test('nonfinite coordinates and oversized images fail without disclosing request contents', () => {
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => validateCheckInRequest({ ...fixture.request, location: { ...fixture.request.location, latitude: value } }));
  assert.throws(() => validateCheckInRequest({ ...fixture.request, image: 'A'.repeat(8000004) }), { message: 'Invalid check-in payload.' });
});
test('successful responses cannot echo sensitive inputs or claim outside-zone success', () => {
  assert.deepEqual(validateCheckInSuccess(fixture.success), fixture.success);
  for (const payload of [
    { ...fixture.success, image: fixture.request.image }, { ...fixture.success, location: fixture.request.location },
    { ...fixture.success, status: 'absent' }, { ...fixture.success, locationStatus: 'outside_zone' },
    { ...fixture.success, recordedAt: '2026-02-30T17:00:00.000Z' },
  ]) assert.throws(() => validateCheckInSuccess(payload));
});
