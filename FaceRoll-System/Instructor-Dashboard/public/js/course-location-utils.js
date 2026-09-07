(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FaceRollCourseLocationUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALLOWED_RADIUS_METERS = Object.freeze([20, 25, 30, 50]);
  const AUTHORIZED_ROLES = Object.freeze(['instructor', 'admin', 'administrator']);

  function toFiniteNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeRole(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isAuthorizedRole(value) {
    return AUTHORIZED_ROLES.includes(normalizeRole(value));
  }

  function validateLocation(location) {
    const errors = [];
    const latitude = toFiniteNumber(location && location.latitude);
    const longitude = toFiniteNumber(location && location.longitude);
    const radiusMeters = toFiniteNumber(location && location.radiusMeters);
    const addressLabel = String((location && location.addressLabel) || '').trim();

    if (latitude === null || latitude < -90 || latitude > 90) {
      errors.push('Latitude must be a number between -90 and 90.');
    }
    if (longitude === null || longitude < -180 || longitude > 180) {
      errors.push('Longitude must be a number between -180 and 180.');
    }
    if (!ALLOWED_RADIUS_METERS.includes(radiusMeters)) {
      errors.push('Radius must be 20, 25, 30, or 50 meters.');
    }
    if (!addressLabel) {
      errors.push('Select a classroom location before saving.');
    } else if (addressLabel.length > 200) {
      errors.push('The location label must be 200 characters or fewer.');
    }
    if (!location || typeof location.enabled !== 'boolean') {
      errors.push('Location verification must be enabled or disabled.');
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      value: {
        latitude: latitude,
        longitude: longitude,
        radiusMeters: radiusMeters,
        addressLabel: addressLabel,
        enabled: Boolean(location && location.enabled),
      },
    };
  }

  return {
    ALLOWED_RADIUS_METERS: ALLOWED_RADIUS_METERS,
    isAuthorizedRole: isAuthorizedRole,
    normalizeRole: normalizeRole,
    validateLocation: validateLocation,
  };
});
