const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDirectory = path.join(__dirname, '../public');

test('every page declares the FaceRoll favicon and the root asset exists', function () {
  const favicon = fs.readFileSync(path.join(publicDirectory, 'favicon.ico'));
  assert.deepEqual(Array.from(favicon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

  const pages = fs.readdirSync(publicDirectory).filter(function (name) { return name.endsWith('.html'); });
  pages.forEach(function (name) {
    const html = fs.readFileSync(path.join(publicDirectory, name), 'utf8');
    assert.match(html, /<link rel="icon" href="\/favicon\.ico" type="image\/png"\/>/);
  });
});

test('local HTML navigation targets survive direct refreshes', function () {
  const pages = fs.readdirSync(publicDirectory).filter(function (name) { return name.endsWith('.html'); });
  pages.forEach(function (name) {
    const html = fs.readFileSync(path.join(publicDirectory, name), 'utf8');
    const links = html.matchAll(/href="\.\/([^"?#]+\.html)(?:[?#][^"]*)?"/g);
    for (const link of links) {
      assert.equal(fs.existsSync(path.join(publicDirectory, link[1])), true, name + ' links to missing ' + link[1]);
    }
  });
});

test('dashboard pages do not contain corrupted UTF-8 text', function () {
  const pages = fs.readdirSync(publicDirectory).filter(function (name) { return name.endsWith('.html'); });
  pages.forEach(function (name) {
    const html = fs.readFileSync(path.join(publicDirectory, name), 'utf8');
    assert.doesNotMatch(html, /[\u00c2\u00c3\ufffd]|\u00e2[\u0080-\u00bf]/,
      name + ' contains text that appears to have been decoded with the wrong character set');
  });
});

test('every protected instructor page loads the authentication guard', function () {
  const protectedPages = [
    'instructor-dashboard.html', 'live-session.html', 'student-roster.html',
    'student-profile.html', 'reports.html', 'courses.html', 'settings.html',
  ];
  protectedPages.forEach(function (name) {
    const html = fs.readFileSync(path.join(publicDirectory, name), 'utf8');
    assert.match(html, /<body[^>]*data-auth-required="true"/);
    const firebaseClientIndex = html.indexOf('/js/firebase-client.js');
    const authGuardIndex = html.indexOf('/js/auth-guard.js');
    const sidebarIndex = html.indexOf('/js/sidebar-user.js');
    assert.ok(firebaseClientIndex >= 0 && authGuardIndex > firebaseClientIndex,
      name + ' must load the auth guard after the Firebase client');
    assert.ok(sidebarIndex < 0 || authGuardIndex < sidebarIndex,
      name + ' must guard the page before loading sidebar data');
  });
});
