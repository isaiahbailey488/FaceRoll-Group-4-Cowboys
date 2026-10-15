'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const utils = require('../public/js/course-location-utils.js');
const source = fs.readFileSync(path.join(__dirname, '../public/js/course-location.js'), 'utf8');

function startPage({ key = 'test-key', sdk = true, status = 200, searchItems = [], geolocation } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false,
      classList: { add() {}, remove() {}, toggle() {} },
      handlers: {}, children: [],
      addEventListener(name, handler) { this.handlers[name] = handler; },
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
      querySelector() { return element(id + '-child'); },
    });
    return elements.get(id);
  }
  const calls = [];
  const views = [];
  const window = {
    navigator: { geolocation },
    FaceRollCourseLocationUtils: utils,
    FaceRollConfig: { HERE_API_KEY: key },
    location: { origin: 'http://127.0.0.1:5002' },
    FaceRollFirebase: {
      waitForAuthUser() { calls.push('auth-pending'); return new Promise(() => {}); },
    },
    addEventListener() {},
  };
  if (sdk) window.H = {
    service: { Platform: function () {
      calls.push('here-platform');
      this.createDefaultLayers = options => {
        assert.equal(options.lg, 'en');
        return { vector: { normal: { map: {} } } };
      };
      this.getSearchService = () => ({
        geocode(options, success) { success({ items: searchItems }); },
        reverseGeocode(options, success) { success({ items: [] }); },
      });
    } },
    Map: function () {
      calls.push('here-map');
      this.addEventListener = () => {};
      this.addObjects = () => {};
      this.removeObject = () => {};
      this.getViewModel = () => ({ setLookAtData(view) { views.push(view); } });
    },
    map: { Icon: function () {}, Circle: function () {}, Marker: function () { this.setData = () => {}; } },
    mapevents: { MapEvents: function () {}, Behavior: function () {} },
    ui: { UI: { createDefault(map, layers, language) { assert.equal(language, 'en-US'); } } },
  };
  vm.runInNewContext(source, {
    fetch: async () => ({ ok: status === 200, status }),
    AbortSignal: { timeout() { return undefined; } },
    window,
    document: { readyState: 'complete', getElementById: element, createElement() { return element('created-' + elements.size); }, addEventListener() {} },
    console,
  });
  return { element, calls, views };
}

test('HERE loads in English without waiting for authentication', async () => {
  const page = startPage();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.calls, ['auth-pending', 'here-platform', 'here-map']);
  assert.equal(page.element('save-location-button').disabled, true);
});

test('missing key shows a HERE configuration error', () => {
  const page = startPage({ key: '' });
  assert.match(page.element('map-status').textContent, /key is missing/);
  assert.ok(!page.calls.includes('here-map'));
});

test('unavailable HERE library shows a recoverable error', () => {
  const page = startPage({ sdk: false });
  assert.match(page.element('map-status').textContent, /library could not load/);
});

test('rejected origin shows the exact address to authorize without switching providers', async () => {
  const page = startPage({ status: 401 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.element('map-status').textContent, /http:\/\/127.0.0.1:5002/);
  assert.ok(!page.calls.includes('here-map'));
  assert.equal(page.element('location-search-button').disabled, true);
});

const searchResults = [
  { title: 'Dallas classroom', position: { lat: 32.78, lng: -96.8 } },
  { title: 'Austin classroom', position: { lat: 30.27, lng: -97.74 } },
];

test('submitting search moves to the first match and selecting another result recenters', async () => {
  const page = startPage({ searchItems: searchResults });
  await new Promise(resolve => setImmediate(resolve));
  page.element('location-search-input').value = 'classroom';
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  assert.equal(page.views.length, 1);
  assert.equal(page.views[0].position.lat, 32.78);
  assert.equal(page.views[0].position.lng, -96.8);
  assert.equal(page.views[0].zoom, 19);
  assert.equal(page.element('selected-address').textContent, 'Dallas classroom');
  page.element('search-results').children[1].handlers.click();
  assert.equal(page.views.length, 2);
  assert.equal(page.views[1].position.lat, 30.27);
  assert.equal(page.views[1].position.lng, -97.74);
  assert.equal(page.element('selected-address').textContent, 'Austin classroom');
});

test('no usable search matches leaves the map unchanged', async () => {
  const page = startPage({ searchItems: [{ title: 'Missing coordinates' }] });
  await new Promise(resolve => setImmediate(resolve));
  page.element('location-search-input').value = 'unknown';
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  assert.equal(page.views.length, 0);
  assert.match(page.element('search-status').textContent, /No matching locations/);
});

test('current location is requested on click and synchronizes the map and selected coordinates', async () => {
  let requests = 0;
  let succeed;
  const page = startPage({ geolocation: {
    getCurrentPosition(success, failure, options) {
      requests++;
      succeed = success;
      assert.equal(options.enableHighAccuracy, true);
      assert.equal(options.timeout, 15000);
    },
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
  const button = page.element('current-location-button');
  button.handlers.click();
  button.handlers.click();
  assert.equal(requests, 1);
  assert.equal(button.disabled, true);
  succeed({ coords: { latitude: 32.9, longitude: -96.7, accuracy: 8 } });
  assert.equal(page.views[0].position.lat, 32.9);
  assert.equal(page.views[0].position.lng, -96.7);
  assert.equal(page.element('selected-address').textContent, 'Current location');
  assert.equal(page.element('selected-latitude').textContent, '32.9');
  assert.equal(page.element('selected-longitude').textContent, '-96.7');
  assert.match(page.element('save-status').textContent, /unsaved/i);
  assert.equal(page.element('save-location-button').disabled, true);
  assert.equal(button.disabled, false);
  assert.match(page.element('current-location-status').textContent, /8 meters/);
});

for (const [code, message] of [[1, /denied/], [2, /could not be determined/], [3, /timed out/]]) {
  test('current location error ' + code + ' allows retry without moving the map', async () => {
    const page = startPage({ geolocation: {
      getCurrentPosition(success, fail) { fail({ code }); },
    } });
    await new Promise(resolve => setImmediate(resolve));
    page.element('current-location-button').handlers.click();
    assert.match(page.element('current-location-status').textContent, message);
    assert.equal(page.element('current-location-button').disabled, false);
    assert.equal(page.views.length, 0);
  });
}

test('current location reports unsupported browsers', async () => {
  const page = startPage();
  await new Promise(resolve => setImmediate(resolve));
  page.element('current-location-button').handlers.click();
  assert.match(page.element('current-location-status').textContent, /unavailable in this browser/);
  assert.equal(page.views.length, 0);
});

test('current location can be submitted through the search field', async () => {
  let requests = 0;
  const page = startPage({ geolocation: {
    getCurrentPosition(success) {
      requests++;
      success({ coords: { latitude: 33.1, longitude: -97.1, accuracy: 10 } });
    },
  } });
  await new Promise(resolve => setImmediate(resolve));
  page.element('location-search-input').value = 'Current location';
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  assert.equal(requests, 1);
  assert.equal(page.views[0].position.lat, 33.1);
  assert.equal(page.element('location-search-input').value, 'Current location');
  assert.equal(page.element('selected-latitude').textContent, '33.1');
  assert.equal(page.element('selected-longitude').textContent, '-97.1');
});

test('current location preserves all coordinate digits supplied by the browser', async () => {
  const latitude = 33.2108123456789;
  const longitude = -97.1473987654321;
  const page = startPage({ geolocation: {
    getCurrentPosition(success, failure, options) {
      assert.equal(options.maximumAge, 0);
      assert.equal(options.enableHighAccuracy, true);
      success({ coords: { latitude, longitude, accuracy: 4.75 } });
    },
  } });
  await new Promise(resolve => setImmediate(resolve));
  page.element('current-location-button').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.views[0].position.lat, latitude);
  assert.equal(page.views[0].position.lng, longitude);
  assert.equal(page.element('selected-latitude').textContent, String(latitude));
  assert.equal(page.element('selected-longitude').textContent, String(longitude));
  assert.match(page.element('current-location-status').textContent, /±4.75 meters/);
  const validated = utils.validateLocation({ latitude, longitude, radiusMeters: 15, addressLabel: 'Current location', enabled: true });
  assert.equal(validated.value.latitude, latitude);
  assert.equal(validated.value.longitude, longitude);
});
