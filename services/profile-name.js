'use strict';

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isEmailAddress(value) {
  const cleaned = cleanName(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned);
}

function fallbackNameFromEmail(email) {
  const localPart = String(email || '').split('@')[0] || 'student';
  const cleaned = localPart.replace(/[._-]+/g, ' ').trim();
  const words = cleaned
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

  if (!words.length) return { firstName: 'Student', lastName: 'User' };
  if (words.length === 1) return { firstName: words[0], lastName: 'User' };
  return { firstName: words[0], lastName: words.slice(1).join(' ') };
}

function getStudentDisplayName(profile, email) {
  const data = profile || {};
  const effectiveEmail = cleanName(email || data.email);
  const emailFallback = fallbackNameFromEmail(effectiveEmail);
  const emailLocalPart = cleanName(effectiveEmail.split('@')[0]).toLowerCase();
  const emailDerivedNames = new Set([
    emailLocalPart,
    cleanName(emailFallback.firstName).toLowerCase(),
    cleanName(`${emailFallback.firstName} ${emailFallback.lastName}`).toLowerCase(),
  ]);
  const firstName = isEmailAddress(data.fname) ? '' : cleanName(data.fname);
  const lastName = isEmailAddress(data.lname) ? '' : cleanName(data.lname);
  const combinedName = cleanName([firstName, lastName].filter(Boolean).join(' '));
  const candidates = [data.fullName, data.name, combinedName, data.displayName];

  for (const candidate of candidates) {
    const cleaned = cleanName(candidate);
    if (cleaned && !isEmailAddress(cleaned) && !emailDerivedNames.has(cleaned.toLowerCase())) {
      return cleaned;
    }
  }

  return 'Student';
}

module.exports = {
  fallbackNameFromEmail,
  getStudentDisplayName,
  isEmailAddress,
};
