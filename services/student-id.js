'use strict';

const MIN_STUDENT_ID = 1000000;
const STUDENT_ID_RANGE = 9000000;

function isSevenDigitStudentId(value) {
  return /^\d{7}$/.test(String(value || ''));
}

function generateStudentId(random = Math.random) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('The random source must return a number from 0 up to, but not including, 1.');
  }

  return String(MIN_STUDENT_ID + Math.floor(value * STUDENT_ID_RANGE));
}

module.exports = {
  generateStudentId,
  isSevenDigitStudentId,
};
