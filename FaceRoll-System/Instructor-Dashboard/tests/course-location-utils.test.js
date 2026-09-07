'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../public/js/course-location-utils.js');

test('accepts a complete classroom location at each supported radius', function () {
  utils.ALLOWED_RADIUS_METERS.forEach(function (radiusMeters) {
    const result = utils.validateLocation({
      latitude: 33.2108,
      longitude: -97.1473,
      radiusMeters: radiusMeters,
      addressLabel: 'Discovery Park, Denton, TX',
      enabled: true,
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });
});

test('rejects invalid coordinates, radius, label, and enabled state', function () {
  const result = utils.validateLocation({
    latitude: 91,
    longitude: '-181',
    radiusMeters: 100,
    addressLabel: '   ',
    enabled: 'yes',
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 5);
});

test('normalizes numeric coordinate strings before saving', function () {
  const result = utils.validateLocation({
    latitude: '33.2108',
    longitude: '-97.1473',
    radiusMeters: '25',
    addressLabel: '  Classroom Building  ',
    enabled: false,
  });

  assert.equal(result.valid, true);
  assert.equal(result.value.latitude, 33.2108);
  assert.equal(result.value.longitude, -97.1473);
  assert.equal(result.value.radiusMeters, 25);
  assert.equal(result.value.addressLabel, 'Classroom Building');
});

test('authorizes instructor and administrator roles only', function () {
  assert.equal(utils.isAuthorizedRole('Instructor'), true);
  assert.equal(utils.isAuthorizedRole('admin'), true);
  assert.equal(utils.isAuthorizedRole('administrator'), true);
  assert.equal(utils.isAuthorizedRole('student'), false);
  assert.equal(utils.isAuthorizedRole(''), false);
});
