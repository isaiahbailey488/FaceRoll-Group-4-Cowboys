'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/auth-pages.js'), 'utf8');

test('login prepares instructor data before opening the dashboard', async function () {
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
      async readInstructorSnapshot() { calls.push('snapshot'); },
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

  assert.deepEqual(calls, ['sign-in', 'snapshot']);
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
    registerMessage: { textContent: '' },
    irnt2i: button,
  };
  const location = { href: '', pathname: '/register.html' };
  const window = {
    location,
    FaceRollFirebase: {
      async registerWithEmail() { calls.push('register'); return { uid: 'teacher-1' }; },
      async writeDocument() { calls.push('profile'); },
      async waitForAuthUser() { calls.push('verify-auth'); return { uid: 'teacher-1' }; },
      async readInstructorSnapshot() { calls.push('snapshot'); },
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

  assert.deepEqual(calls, ['register', 'profile', 'verify-auth', 'snapshot']);
  assert.equal(location.href, './instructor-dashboard.html');
});
