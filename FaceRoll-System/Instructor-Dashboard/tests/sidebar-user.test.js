'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/sidebar-user.js'), 'utf8');

function createStorage(initialValue) {
  const values = new Map(initialValue ? [['faceroll.sidebar-profile.v1', initialValue]] : []);
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function runSidebar(options) {
  const created = [];
  const menuList = createNode('ul');
  const profileName = createNode('p');
  const profileRole = createNode('p');
  const profileMini = createNode('div');
  profileMini.parentElement = createNode('footer');
  let profileCallback;

  function createNode(tagName) {
    const classes = new Set();
    const selectors = {};
    const node = {
      tagName: String(tagName || '').toUpperCase(),
      textContent: '',
      children: [],
      style: {},
      className: '',
      setAttribute() {},
      addEventListener(event, handler) { this[event] = handler; },
      appendChild(child) { this.children.push(child); return child; },
      contains() { return false; },
      querySelector(selector) { return selectors[selector] || null; },
      classList: {
        contains(value) { return classes.has(value); },
        toggle(value, force) {
          if (force === true || (force === undefined && !classes.has(value))) classes.add(value);
          else classes.delete(value);
        },
      },
      set innerHTML(value) {
        this._innerHTML = String(value);
        if (this._innerHTML.includes('faceroll-account-name')) {
          selectors['.faceroll-account-name'] = createNode('div');
          selectors['.faceroll-account-email'] = createNode('div');
          selectors['.faceroll-account-role'] = createNode('div');
          selectors['.faceroll-account-action'] = createNode('button');
        }
      },
      get innerHTML() { return this._innerHTML || ''; },
    };
    return node;
  }

  const document = {
    head: createNode('head'),
    querySelector(selector) {
      if (selector === '.sidebar-menu-list') return menuList;
      if (selector === '.sidebar-footer .profile-name') return profileName;
      if (selector === '.sidebar-footer .profile-role') return profileRole;
      if (selector === '.sidebar-footer .profile-mini') return profileMini;
      return null;
    },
    getElementById(id) { return created.find(node => node.id === id) || null; },
    createElement(tagName) { const node = createNode(tagName); created.push(node); return node; },
    addEventListener() {},
  };
  const firebaseApi = {
    async subscribeAuthState(onNext) {
      if (options.deferAuth) options.authCallback = onNext;
      else onNext(options.authUser);
      return function () {};
    },
    async subscribeDocument(_collection, _id, onNext) {
      profileCallback = onNext;
      if (options.profile) onNext(options.profile, options.snapshotInfo);
      return function () {};
    },
  };
  if (options.sharedAuthUser) {
    firebaseApi.readCachedAuthUserSummary = function () { return options.sharedAuthUser; };
    firebaseApi.readCachedUserProfile = function () { return options.sharedProfile || null; };
    firebaseApi.cacheUserProfile = function () {};
  }
  const window = {
    FaceRollFirebase: firebaseApi,
    location: { pathname: '/instructor-dashboard.html' },
    dispatchEvent() {},
    addEventListener() {},
  };
  const sessionStorage = createStorage(options.cachedValue);
  vm.runInNewContext(source, {
    window,
    document,
    sessionStorage,
    globalThis: { sessionStorage },
    CustomEvent: function CustomEvent() {},
    console,
  });
  return {
    profileName,
    profileRole,
    sendProfile(profile, snapshotInfo) { profileCallback(profile, snapshotInfo); },
    restoreAuth(user) { if (options.authCallback) options.authCallback(user); },
  };
}

test('sidebar renders the small shared user cache before Auth restoration finishes', () => {
  const sidebar = runSidebar({
    deferAuth: true,
    sharedAuthUser: { uid: 'teacher-1', email: 'teacher@example.com', displayName: '' },
    sharedProfile: { id: 'teacher-1', firstName: 'Isaiah', lastName: 'Cowboy', role: 'instructor' },
  });

  assert.equal(sidebar.profileName.textContent, 'Isaiah Cowboy');
  assert.equal(sidebar.profileRole.textContent, 'Instructor');
});

test('sidebar keeps the cached Firestore name and role while reconnecting between pages', () => {
  const cachedValue = JSON.stringify({
    authUid: 'teacher-1',
    profile: { id: 'teacher-1', firstName: 'Isaiah', lastName: 'Cowboy', role: 'instructor' },
  });
  const sidebar = runSidebar({
    authUser: { uid: 'teacher-1', email: 'teacher@example.com', displayName: 'teacher@example.com' },
    cachedValue,
  });

  assert.equal(sidebar.profileName.textContent, 'Isaiah Cowboy');
  assert.equal(sidebar.profileRole.textContent, 'Instructor');
});

test('sidebar waits for Firestore and prefers its saved name over the Auth email', () => {
  const sidebar = runSidebar({
    authUser: { uid: 'teacher-1', email: 'teacher@example.com', displayName: 'teacher@example.com' },
  });

  assert.equal(sidebar.profileName.textContent, 'Loading...');
  assert.equal(sidebar.profileRole.textContent, 'Loading...');
  sidebar.sendProfile(null, { fromCache: true });
  assert.equal(sidebar.profileName.textContent, 'Loading...');
  assert.equal(sidebar.profileRole.textContent, 'Loading...');
  sidebar.sendProfile({ id: 'teacher-1', firstName: 'Isaiah', lastName: 'Cowboy', role: 'instructor' });
  assert.equal(sidebar.profileName.textContent, 'Isaiah Cowboy');
  assert.equal(sidebar.profileRole.textContent, 'Instructor');
});
