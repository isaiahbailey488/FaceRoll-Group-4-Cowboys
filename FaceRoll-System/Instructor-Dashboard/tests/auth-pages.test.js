'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/auth-pages.js'), 'utf8');

test('login opens the dashboard immediately after authentication', async function () {
  const calls = [];
  const button = { disabled: false, textContent: 'Login' };
  const form = {
    querySelector: function () { return button; },
    addEventListener: function (event, handler) { this[event] = handler; },
  };
  const elements = {
    loginForm: form,
    'email-2': { value: 'teacher@example.com' },
    'password-2': { value: 'secret-password' },
    loginMessage: { textContent: '' },
  };
  const location = { href: '', pathname: '/index.html' };
  const window = {
    location,
    FaceRollFirebase: {
      async signInWithEmail() { calls.push('sign-in'); },
      async readInstructorSnapshot() { throw new Error('login must not wait for Firestore'); },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: {
      readyState: 'complete',
      getElementById: function (id) { return elements[id] || null; },
    },
    console,
    Date,
  });

  await form.submit({ preventDefault: function () {} });

  assert.deepEqual(calls, ['sign-in']);
  assert.equal(location.href, './instructor-dashboard.html');
});

test('registration verifies the active emulator session before redirecting', async function () {
  const calls = [];
  const button = { disabled: false, textContent: 'Submit' };
  const form = { addEventListener: function (event, handler) { this[event] = handler; } };
  const elements = {
    i6kz3: form,
    role: { value: 'instructor' },
    'full-name': { value: 'Isaiah Bailey' },
    email: { value: 'teacher@example.com' },
    password: { value: 'secret-password' },
    'confirm-password': { value: 'secret-password' },
    terms: { checked: true, disabled: false, dataset: { termsReviewed: 'true' } },
    registerMessage: { textContent: '' },
    irnt2i: button,
  };
  const location = { href: '', pathname: '/register.html' };
  const window = {
    location,
    FaceRollFirebase: {
      async registerWithEmail() { calls.push('register'); return { uid: 'teacher-1' }; },
      async writeDocument(collection, uid, profile) {
        calls.push('profile');
        assert.equal(collection, 'users');
        assert.equal(uid, 'teacher-1');
        assert.equal(profile.termsVersion, '2026-10-05');
        assert.equal(profile.termsAcceptedAt, profile.createdAt);
      },
      async waitForAuthUser() { calls.push('verify-auth'); return { uid: 'teacher-1' }; },
      async readInstructorSnapshot() { throw new Error('registration must not wait for Firestore'); },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: {
      readyState: 'complete',
      getElementById: function (id) { return elements[id] || null; },
    },
    console,
    Date,
  });

  await form.submit({ preventDefault: function () {} });

  assert.deepEqual(calls, ['register', 'profile', 'verify-auth']);
  assert.equal(location.href, './instructor-dashboard.html');
});

test('registration requires explicit acceptance of the terms', async function () {
  const calls = [];
  const button = { disabled: false, textContent: 'Submit' };
  const form = { addEventListener: function (event, handler) { this[event] = handler; } };
  const terms = {
    checked: false,
    disabled: false,
    dataset: { termsReviewed: 'true' },
    focused: false,
    focus: function () { this.focused = true; },
  };
  const elements = {
    i6kz3: form,
    role: { value: 'instructor' },
    'full-name': { value: 'Isaiah Bailey' },
    email: { value: 'teacher@example.com' },
    password: { value: 'secret-password' },
    'confirm-password': { value: 'secret-password' },
    terms,
    registerMessage: { textContent: '' },
    irnt2i: button,
  };
  const window = {
    location: { href: '', pathname: '/register.html' },
    FaceRollFirebase: {
      async registerWithEmail() { calls.push('register'); return { uid: 'teacher-1' }; },
    },
  };

  vm.runInNewContext(source, {
    window,
    document: {
      readyState: 'complete',
      getElementById: function (id) { return elements[id] || null; },
    },
    console,
    Date,
  });

  await form.submit({ preventDefault: function () {} });

  assert.deepEqual(calls, []);
  assert.equal(terms.focused, true);
  assert.match(elements.registerMessage.textContent, /accept the Terms of Use/i);
  assert.equal(window.location.href, '');
});

test('registration stays blocked until the agreement is opened and scrolled to the bottom', async function () {
  const calls = [];
  const button = { disabled: false, textContent: 'Submit' };
  const form = { addEventListener: function (event, handler) { this[event] = handler; } };
  const terms = {
    checked: true,
    disabled: true,
    dataset: { termsReviewed: 'false' },
  };
  const openTermsButton = {
    focused: false,
    focus: function () { this.focused = true; },
    addEventListener: function () {},
  };
  const elements = {
    i6kz3: form,
    role: { value: 'instructor' },
    'full-name': { value: 'Isaiah Bailey' },
    email: { value: 'teacher@example.com' },
    password: { value: 'secret-password' },
    'confirm-password': { value: 'secret-password' },
    terms,
    openTermsButton,
    registerMessage: { textContent: '' },
    irnt2i: button,
  };
  const window = {
    location: { href: '', pathname: '/register.html' },
    FaceRollFirebase: {
      async registerWithEmail() { calls.push('register'); return { uid: 'teacher-1' }; },
    },
  };

  vm.runInNewContext(source, {
    window,
    document: {
      readyState: 'complete',
      getElementById: function (id) { return elements[id] || null; },
    },
    console,
    Date,
  });

  await form.submit({ preventDefault: function () {} });

  assert.deepEqual(calls, []);
  assert.equal(openTermsButton.focused, true);
  assert.match(elements.registerMessage.textContent, /scroll to the bottom/i);
});

test('scrolling to the bottom unlocks the terms checkbox', function () {
  const listeners = {};
  const terms = {
    disabled: true,
    dataset: { termsReviewed: 'false' },
  };
  const dialog = {
    opened: false,
    showModal: function () { this.opened = true; },
    close: function () { this.opened = false; },
    addEventListener: function (event, handler) { listeners['dialog-' + event] = handler; },
  };
  const dialogBody = {
    scrollTop: 0,
    clientHeight: 300,
    scrollHeight: 900,
    focus: function () {},
    addEventListener: function (event, handler) { listeners['body-' + event] = handler; },
  };
  const openButton = {
    addEventListener: function (event, handler) { listeners['open-' + event] = handler; },
    focus: function () {},
  };
  const closeButton = {
    disabled: true,
    textContent: 'Scroll to the bottom to continue',
    addEventListener: function (event, handler) { listeners['close-' + event] = handler; },
  };
  const reviewStatus = {
    textContent: '',
    classList: { add: function (value) { this.added = value; } },
  };
  const elements = {
    terms,
    termsDialog: dialog,
    termsDialogBody: dialogBody,
    openTermsButton: openButton,
    closeTermsButton: closeButton,
    termsReviewStatus: reviewStatus,
  };

  vm.runInNewContext(source, {
    window: { location: { href: '', pathname: '/register.html' } },
    document: {
      readyState: 'complete',
      getElementById: function (id) { return elements[id] || null; },
    },
    console,
    Date,
  });

  listeners['open-click']();
  assert.equal(dialog.opened, true);
  assert.equal(terms.disabled, true);

  dialogBody.scrollTop = 600;
  listeners['body-scroll']();

  assert.equal(terms.disabled, false);
  assert.equal(terms.dataset.termsReviewed, 'true');
  assert.equal(closeButton.disabled, false);
  assert.match(closeButton.textContent, /return to registration/i);
  assert.match(reviewStatus.textContent, /select the checkbox/i);
});
