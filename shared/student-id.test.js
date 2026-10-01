'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateStudentId, isSevenDigitStudentId } = require('../services/student-id.js');

test('generates randomized student IDs within the seven-digit range', function () {
  assert.equal(generateStudentId(() => 0), '1000000');
  assert.equal(generateStudentId(() => 0.5), '5500000');
  assert.equal(generateStudentId(() => 0.999999999), '9999999');
});

test('accepts only seven-digit numeric student IDs', function () {
  assert.equal(isSevenDigitStudentId('4827316'), true);
  assert.equal(isSevenDigitStudentId('student001'), false);
  assert.equal(isSevenDigitStudentId('123456'), false);
  assert.equal(isSevenDigitStudentId('12345678'), false);
  assert.equal(isSevenDigitStudentId('123A567'), false);
});
