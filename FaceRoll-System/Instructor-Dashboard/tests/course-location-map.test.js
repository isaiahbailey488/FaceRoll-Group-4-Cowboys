'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const utils = require('../public/js/course-location-utils.js');
const source = fs.readFileSync(path.join(__dirname, '../public/js/course-location.js'), 'utf8');

const savedLocation = { latitude: 33.2108123456789, longitude: -97.1473987654321,
  radiusMeters: 15, enabled: true, addressLabel: 'Saved classroom' };
function startPage({ key = 'test-key', sdk = true, status = 200, searchItems = [], geolocation,
  authenticated = false, courses = [{ courseId: 'COURSE', courseName: 'Course', instructorId: 'teacher', location: savedLocation },
    { courseId: 'OTHER', courseName: 'Other', instructorId: 'teacher', location: { ...savedLocation, addressLabel: 'Other classroom' } }],
  suggest, geocode, reverse } = {}) {
  const elements = new Map();
  const timers = new Map(), writes = [], objects = [], handlers = {}, pageHandlers = {}, suggestions = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
      value: '', textContent: '', disabled: false,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      handlers: {}, children: [],
      addEventListener(name, handler) { this.handlers[name] = handler; },
      appendChild(child) { this.children.push(child); },
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; }, contains(node) { return node === this || this.children.includes(node); },
      set innerHTML(value) { this.children = []; },
      querySelector() { return element(id + '-child'); },
      });
    }
    return elements.get(id);
  }
  const calls = [];
  const views = [];
  const window = {
    navigator: { geolocation },
    FaceRollCourseLocationUtils: utils,
    FaceRollConfig: { HERE_API_KEY: key },
    location: { origin: 'http://127.0.0.1:5002', href: 'http://127.0.0.1:5002/courses.html?courseId=COURSE',
      search: '?courseId=COURSE' },
    history: { replaceState() {} }, confirm: () => true,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'server-timestamp' } } },
    FaceRollFirebase: {
      waitForAuthUser() { calls.push('auth-pending'); return authenticated ? Promise.resolve({ uid: 'teacher' }) : new Promise(() => {}); },
      readDocument: async () => ({ role: 'instructor' }), readQueryDocs: async () => courses,
      writeDocument: async (...args) => writes.push(args),
      saveCourseLocation: async (id, courseId, expected, location) => {
        const next = { ...location, revision: ((expected && expected.revision) || 0) + 1 };
        writes.push(['courses', id, { location: next }]); return next;
      },
    },
    addEventListener(name, callback) { pageHandlers[name] = callback; },
  };
  if (sdk) window.H = {
    service: { Platform: function () {
      calls.push('here-platform');
      this.createDefaultLayers = options => {
        assert.equal(options.lg, 'en');
        return { vector: { normal: { map: {} } } };
      };
      this.getSearchService = () => ({
        geocode(options, success, fail) { if (geocode) geocode(options, success, fail); else success({ items: searchItems }); },
        autosuggest(options, success, fail) { suggestions.push(options); if (suggest) suggest(options, success, fail); else success({ items: searchItems }); },
        reverseGeocode(options, success) { if (reverse) reverse(options, success); else success({ items: [] }); },
      });
    } },
    Map: function () {
      calls.push('here-map');
      this.addEventListener = (name, callback) => { handlers[name] = callback; };
      this.addObjects = items => objects.push(...items);
      this.removeObject = item => { const i = objects.indexOf(item); if (i >= 0) objects.splice(i, 1); };
      this.getCenter = () => ({ lat: 33.21, lng: -97.14 });
      this.getViewModel = () => ({ setLookAtData(view) { views.push(view); } });
    },
    map: { Icon: function () {}, Circle: function (position, radius, options) {
      this.position = position; this.radius = radius; this.style = options.style;
      this.getBoundingBox = () => ({ north: 34, south: 32, east: -96, west: -98 });
    }, Marker: function (position) { this.position = position; this.setData = value => { this.data = value; }; } },
    mapevents: { MapEvents: function () {}, Behavior: function () {} },
    ui: { UI: { createDefault(map, layers, language) { assert.equal(language, 'en-US'); } } },
  };
  vm.runInNewContext(source, {
    fetch: async () => ({ ok: status === 200, status }),
    AbortSignal: { timeout() { return undefined; } },
    URL, URLSearchParams,
    setTimeout: callback => { const token = Symbol(); timers.set(token, callback); return token; },
    clearTimeout: token => timers.delete(token),
    window,
    document: { readyState: 'complete', getElementById: element, createElement() { return element('created-' + elements.size); }, addEventListener() {} },
    console,
  });
  return { element, calls, views, writes, objects, suggestions, handlers, pageHandlers, timers,
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
    type(value) { element('location-search-input').value = value; element('location-search-input').handlers.input(); },
    async suggestNow() { for (const [token, callback] of [...timers]) { timers.delete(token); await callback(); } },
    switchCourse(value) { element('course-select').value = value; element('course-select').handlers.change(); },
  };
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

test('current location is requested once on click and previews accuracy without moving the classroom pin', async () => {
  let requests = 0;
  let succeed;
  const page = startPage({ authenticated: true, geolocation: {
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
  assert.equal(page.views.at(-1).position.lat, 32.9);
  assert.equal(page.views.at(-1).position.lng, -96.7);
  assert.equal(page.element('selected-address').textContent, 'Saved classroom');
  assert.equal(page.element('selected-latitude').textContent, String(savedLocation.latitude));
  assert.equal(page.element('selected-longitude').textContent, String(savedLocation.longitude));
  assert.equal(page.element('current-location-actions').hidden, false);
  assert.equal(page.element('use-current-location-button').disabled, false);
  assert.equal(page.objects.find(object => object.radius === 8).position.lat, 32.9);
  assert.equal(page.writes.length, 0);
  assert.equal(button.disabled, false);
  assert.match(page.element('current-location-status').textContent, /±8 m/);
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
  const page = startPage({ authenticated: true, geolocation: {
    getCurrentPosition(success) {
      requests++;
      success({ coords: { latitude: 33.1, longitude: -97.1, accuracy: 10 } });
    },
  } });
  await new Promise(resolve => setImmediate(resolve));
  page.element('location-search-input').value = 'Current location';
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  assert.equal(requests, 1);
  assert.equal(page.views.at(-1).position.lat, 33.1);
  assert.equal(page.element('location-search-input').value, 'Current location');
  assert.equal(page.element('selected-latitude').textContent, String(savedLocation.latitude));
  page.element('use-current-location-button').handlers.click();
  assert.equal(page.element('selected-latitude').textContent, '33.1');
  assert.equal(page.element('selected-longitude').textContent, '-97.1');
});

test('current location preserves all coordinate digits supplied by the browser', async () => {
  const latitude = 33.2208123456789;
  const longitude = -97.1473987654321;
  const page = startPage({ authenticated: true, geolocation: {
    getCurrentPosition(success, failure, options) {
      assert.equal(options.maximumAge, 0);
      assert.equal(options.enableHighAccuracy, true);
      success({ coords: { latitude, longitude, accuracy: 4.75 } });
    },
  } });
  await new Promise(resolve => setImmediate(resolve));
  page.element('current-location-button').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.views.at(-1).position.lat, latitude);
  assert.equal(page.views.at(-1).position.lng, longitude);
  page.element('use-current-location-button').handlers.click();
  assert.equal(page.element('selected-latitude').textContent, String(latitude));
  assert.equal(page.element('selected-longitude').textContent, String(longitude));
  assert.match(page.element('current-location-status').textContent, /draft classroom pin/);
  const validated = utils.validateLocation({ latitude, longitude, radiusMeters: 15, addressLabel: 'Current location', enabled: true });
  assert.equal(validated.value.latitude, latitude);
  assert.equal(validated.value.longitude, longitude);
});

test('typed suggestions debounce, show addresses and leave the pin unchanged until selected', async () => {
  const page = startPage({ authenticated: true, searchItems: [
    { title: 'Engineering', address: { label: '100 College Ave, Denton, TX' }, position: { lat: 33.22, lng: -97.15 } },
  ] });
  await page.settle();
  const views = page.views.length;
  page.type('En');
  assert.equal(page.timers.size, 0);
  page.type('Eng'); page.type('Engineering');
  assert.equal(page.timers.size, 1);
  assert.equal(page.suggestions.length, 0);
  await page.suggestNow();
  assert.equal(page.suggestions.length, 1);
  assert.equal(page.suggestions[0].q, 'Engineering');
  assert.equal(page.suggestions[0].at, '33.21,-97.14');
  assert.equal(page.views.length, views);
  const result = page.element('search-results').children[0];
  assert.equal(result.children[1].textContent, '100 College Ave, Denton, TX');
  result.handlers.click(); await page.settle();
  assert.equal(page.element('selected-latitude').textContent, '33.22');
  assert.equal(page.writes.length, 0);
});

test('late suggestions cannot replace a newer query or a different course', async () => {
  const pending = [];
  const page = startPage({ authenticated: true, suggest: (options, success) => pending.push(success) });
  await page.settle();
  page.type('Old building'); const first = page.suggestNow();
  page.type('New building'); const second = page.suggestNow();
  pending[0]({ items: searchResults }); await first;
  assert.equal(page.element('search-results').children.length, 0);
  page.switchCourse('OTHER');
  pending[1]({ items: searchResults }); await second;
  assert.equal(page.element('search-results').children.length, 0);
  assert.equal(page.element('selected-address').textContent, 'Other classroom');
});

test('suggestion failure leaves the normal Search action available', async () => {
  const page = startPage({ authenticated: true, searchItems: searchResults,
    suggest: (options, success, fail) => fail(new Error('private-provider-details')) });
  await page.settle(); page.type('Classroom'); await page.suggestNow();
  assert.match(page.element('search-status').textContent, /Press Search/);
  assert.ok(!page.element('search-status').textContent.includes('private-provider-details'));
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  assert.equal(page.element('selected-address').textContent, 'Dallas classroom');
});

test('poor or missing accuracy warns and never automatically changes or saves the pin', async () => {
  for (const accuracy of [100, null]) {
    const page = startPage({ authenticated: true, geolocation: {
      getCurrentPosition(success) { success({ coords: { latitude: 33.3, longitude: -97.3, accuracy } }); },
    } });
    await page.settle(); page.element('current-location-button').handlers.click();
    assert.equal(page.element('selected-latitude').textContent, String(savedLocation.latitude));
    assert.match(page.element('current-location-status').textContent, /too imprecise/);
    assert.equal(page.writes.length, 0);
    if (accuracy) assert.ok(page.objects.some(object => object.radius === accuracy));
    page.element('dismiss-current-location-button').handlers.click();
    assert.equal(page.element('current-location-actions').hidden, true);
    assert.equal(page.objects.filter(object => object.data === 'current-location').length, 0);
  }
});

test('late browser location callbacks after a course switch or restore cannot change the zone', async () => {
  for (const action of ['switch', 'restore']) {
    let success;
    const page = startPage({ authenticated: true, geolocation: { getCurrentPosition(callback) { success = callback; } } });
    await page.settle(); page.element('current-location-button').handlers.click();
    if (action === 'switch') page.switchCourse('OTHER');
    else page.element('restore-location-button').handlers.click();
    success({ coords: { latitude: 1, longitude: 2, accuracy: 3 } });
    assert.equal(page.element('selected-latitude').textContent, String(savedLocation.latitude));
    assert.equal(page.element('current-location-actions').hidden, true);
    assert.equal(page.writes.length, 0);
  }
});

test('restore brings back the exact saved pin, label, radius and verification flag without writing', async () => {
  const page = startPage({ authenticated: true, searchItems: searchResults });
  await page.settle();
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  page.element('location-search-input').value = 'Different address';
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  page.element('radius-meters').value = '8'; page.element('radius-meters').handlers.input();
  page.element('location-enabled-toggle').handlers.click();
  assert.equal(page.element('restore-location-button').disabled, false);
  page.element('restore-location-button').handlers.click();
  assert.equal(page.element('selected-latitude').textContent, String(savedLocation.latitude));
  assert.equal(page.element('selected-longitude').textContent, String(savedLocation.longitude));
  assert.equal(page.element('selected-address').textContent, savedLocation.addressLabel);
  assert.equal(page.element('radius-meters').value, '15');
  assert.equal(page.element('location-enabled-toggle').attributes['aria-checked'], 'true');
  assert.equal(page.element('restore-location-button').disabled, true);
  assert.equal(page.writes.length, 0);
});

test('restore uses the latest successful save and rejects old geocode callbacks', async () => {
  let finish;
  const page = startPage({ authenticated: true, searchItems: searchResults,
    geocode: (options, success) => { if (options.q === 'Pending') finish = success; else success({ items: searchResults }); } });
  await page.settle();
  page.element('location-search-input').value = 'Dallas';
  await page.element('location-search-form').handlers.submit({ preventDefault() {} });
  await page.element('save-location-button').handlers.click();
  assert.equal(page.writes.length, 1);
  assert.match(page.element('save-status').textContent, /next session/);
  assert.match(page.element('save-status').textContent, /Running sessions keep their saved zone/);
  page.element('location-search-input').value = 'Pending';
  const pending = page.element('location-search-form').handlers.submit({ preventDefault() {} });
  page.element('radius-meters').value = '3'; page.element('radius-meters').handlers.input();
  page.element('restore-location-button').handlers.click();
  finish({ items: [{ title: 'Old result', position: { lat: 1, lng: 2 } }] }); await pending;
  assert.equal(page.element('selected-address').textContent, 'Dallas classroom');
  assert.equal(page.element('selected-latitude').textContent, '32.78');
  assert.equal(page.element('radius-meters').value, '15');
  assert.equal(page.writes.length, 1);
});

test('keyboard navigation selects suggestions and Escape dismisses them', async () => {
  const page = startPage({ authenticated: true, searchItems: searchResults });
  await page.settle(); page.type('Classroom'); await page.suggestNow();
  const first = page.element('search-results').children[0], second = page.element('search-results').children[1];
  page.element('location-search-input').handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(first.focused, true);
  first.handlers.keydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(second.focused, true);
  second.handlers.keydown({ key: 'Escape' });
  assert.equal(page.element('search-results').children.length, 0);
  assert.equal(page.element('location-search-input').attributes['aria-expanded'], 'false');
});
