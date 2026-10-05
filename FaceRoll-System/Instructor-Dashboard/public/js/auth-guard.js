(function (global) {
  'use strict';

  const body = global.document && global.document.body;
  if (!body || body.getAttribute('data-auth-required') !== 'true') return;

  const firebaseApi = global.FaceRollFirebase;
  const LOGIN_URL = './index.html';
  const TOKEN_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const terminalAuthCodes = new Set([
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/invalid-user-token',
    'auth/user-disabled',
    'auth/user-not-found',
    'auth/user-token-expired',
  ]);
  let currentUser = null;
  let redirecting = false;
  let authUnsubscribe = null;
  let validationInFlight = null;

  function revealProtectedPage() {
    body.removeAttribute('data-auth-required');
  }

  function clearLocalUserData() {
    if (firebaseApi && typeof firebaseApi.clearInstructorSnapshotCache === 'function') {
      firebaseApi.clearInstructorSnapshotCache();
    }
  }

  function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    clearLocalUserData();
    global.location.replace(LOGIN_URL);
  }

  function isExpiredSessionError(error) {
    return terminalAuthCodes.has(String(error && error.code || '').toLowerCase());
  }

  async function validateSession(user) {
    if (!user) {
      redirectToLogin();
      return false;
    }
    if (validationInFlight) return validationInFlight;
    validationInFlight = Promise.resolve().then(async function () {
      try {
        if (typeof user.getIdToken === 'function') await user.getIdToken(true);
        if (currentUser !== user || redirecting) return false;
        revealProtectedPage();
        return true;
      } catch (error) {
        if (isExpiredSessionError(error)) {
          redirectToLogin();
          return false;
        }
        // A network interruption does not invalidate an otherwise restored
        // Firebase session. Firestore's offline cache can continue serving it.
        if (currentUser === user && !redirecting) revealProtectedPage();
        return true;
      } finally {
        validationInFlight = null;
      }
    });
    return validationInFlight;
  }

  function revalidateCurrentSession() {
    if (!currentUser || redirecting) return;
    validateSession(currentUser);
  }

  if (!firebaseApi || typeof firebaseApi.subscribeAuthState !== 'function') {
    redirectToLogin();
    return;
  }

  firebaseApi.subscribeAuthState(function (user) {
    currentUser = user;
    if (!user) {
      redirectToLogin();
      return;
    }
    validateSession(user);
  }, function (error) {
    if (isExpiredSessionError(error)) redirectToLogin();
  }).then(function (unsubscribe) {
    authUnsubscribe = unsubscribe;
  }).catch(function () {
    redirectToLogin();
  });

  const validationTimer = typeof global.setInterval === 'function'
    ? global.setInterval(revalidateCurrentSession, TOKEN_CHECK_INTERVAL_MS)
    : null;

  global.addEventListener('focus', revalidateCurrentSession);
  global.document.addEventListener('visibilitychange', function () {
    if (global.document.visibilityState === 'visible') revalidateCurrentSession();
  });
  global.addEventListener('pagehide', function () {
    if (validationTimer && typeof global.clearInterval === 'function') global.clearInterval(validationTimer);
    if (typeof authUnsubscribe === 'function') authUnsubscribe();
  });
})(window);
