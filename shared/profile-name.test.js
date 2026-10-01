'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getStudentDisplayName } = require('../services/profile-name.js');

test('uses the saved student name instead of an email display name', function () {
  assert.equal(getStudentDisplayName({
    displayName: 'student@example.com',
    fname: 'Isaiah',
    lname: 'Cowboy',
  }, 'student@example.com'), 'Isaiah Cowboy');
});

test('rejects the email local part when other saved name fields are available', function () {
  assert.equal(getStudentDisplayName({
    fullName: 'justapleb1',
    displayName: 'justapleb1',
    fname: 'Isaiah',
    lname: 'Cowboy',
  }, 'justapleb1@example.com'), 'Isaiah Cowboy');
});

test('uses a valid saved full name before other profile values', function () {
  assert.equal(getStudentDisplayName({
    fullName: 'Maria Lopez',
    displayName: 'student@example.com',
  }, 'student@example.com'), 'Maria Lopez');
});

test('never returns an email-derived username when a legacy profile has no saved name', function () {
  assert.equal(getStudentDisplayName({
    fname: 'Justapleb1',
    lname: 'User',
    fullName: 'Justapleb1 User',
    displayName: 'justapleb1@gmail.com',
  }, 'justapleb1@gmail.com'), 'Student');
});
