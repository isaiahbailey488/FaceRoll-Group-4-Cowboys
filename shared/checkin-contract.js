'use strict';
const schema = require('../FaceRoll-System/recognition/faceroll_recognition/checkin.schema.json');

function invalid() {
  const error = new TypeError('Invalid check-in payload.');
  error.code = 'invalid_check_in_request';
  throw error;
}
function validate(value, spec) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const accepted = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (!accepted.includes(type) && !(type === 'number' && accepted.includes('integer') && Number.isSafeInteger(value))) invalid();
  if (spec.enum && !spec.enum.includes(value)) invalid();
  if (type === 'null') return null;
  if (type === 'object') {
    if ((spec.required || []).some(key => !Object.prototype.hasOwnProperty.call(value, key))
        || Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(spec.properties, key))) invalid();
    const output = {};
    Object.keys(value).forEach(key => { output[key] = validate(value[key], spec.properties[key]); });
    return Object.freeze(output);
  }
  if (type === 'number') {
    if (!Number.isFinite(value) || (spec.minimum !== undefined && value < spec.minimum)
        || (spec.maximum !== undefined && value > spec.maximum)) invalid();
  }
  if (type === 'string') {
    if ((spec.minLength !== undefined && value.length < spec.minLength)
        || (spec.maxLength !== undefined && value.length > spec.maxLength)
        || (spec.pattern && new RegExp(spec.pattern).exec(value)?.[0] !== value)) invalid();
    if (spec.format === 'base64' && (value.length % 4 !== 0 || /^[A-Za-z0-9+/]+={0,2}$/.exec(value)?.[0] !== value)) invalid();
    if (spec.format === 'utc-milliseconds' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) invalid();
  }
  return value;
}

module.exports = {
  validateCheckInRequest: value => validate(value, schema.$defs.request),
  validateCheckInSuccess: value => validate(value, schema.$defs.success),
};
