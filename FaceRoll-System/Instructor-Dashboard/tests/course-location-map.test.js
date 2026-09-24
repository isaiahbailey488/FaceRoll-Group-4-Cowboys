'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const utils = require('../public/js/course-location-utils.js');
const source = fs.readFileSync(path.join(__dirname, '../public/js/course-location.js'), 'utf8');

function startPage({ key = 'test-key', sdk = true, status = 200, searchItems = [] } = {}) {
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
    map: { Circle: function () {}, Marker: function () { this.setData = () => {}; } },
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
