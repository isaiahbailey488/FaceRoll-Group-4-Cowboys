(function () {
  const TERMS_VERSION = '2026-10-05';

  function getFriendlyAuthMessage(error, fallbackMessage) {
    const code = error && error.code ? String(error.code) : '';

    if (
      code === 'auth/invalid-credential' ||
      code === 'auth/user-not-found' ||
      code === 'auth/wrong-password'
    ) {
      return 'Invalid email or password.';
    }

    if (code === 'auth/email-already-in-use') {
      return 'An account with this email already exists.';
    }

    if (code === 'auth/invalid-email') {
      return 'Enter a valid email address.';
    }

    if (code === 'auth/weak-password') {
      return 'Password should be at least 6 characters long.';
    }

    if (code === 'auth/too-many-requests') {
      return 'Too many attempts right now. Please wait a moment and try again.';
    }

    return error && error.message ? error.message : fallbackMessage;
  }

  function splitName(fullName) {
    const parts = String(fullName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    return {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' '),
    };
  }

  function ensureFirebaseClient() {
    if (!window.FaceRollFirebase) {
      throw new Error('Firebase client is not ready on this page.');
    }

    return window.FaceRollFirebase;
  }

  function setupLoginPage() {
    const loginForm = document.getElementById('loginForm');
    const emailInput = document.getElementById('email-2');
    const passwordInput = document.getElementById('password-2');
    const loginMessage = document.getElementById('loginMessage');
    const submitButton = loginForm ? loginForm.querySelector('button[type="submit"]') : null;

    if (!loginForm || !emailInput || !passwordInput || !loginMessage || !submitButton) {
      return;
    }

    function setMessage(message) {
      loginMessage.textContent = message;
    }

    loginForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      setMessage('');
      submitButton.disabled = true;
      submitButton.textContent = 'Logging in...';

      try {
        const firebaseClient = ensureFirebaseClient();
        await firebaseClient.signInWithEmail(String(emailInput.value || '').trim(), passwordInput.value);
        submitButton.textContent = 'Loading dashboard...';
        window.location.href = './instructor-dashboard.html';
      } catch (error) {
        console.error('Login failed:', error);
        setMessage(getFriendlyAuthMessage(error, 'Login failed. Please try again.'));
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Login';
      }
    });
  }

  function setupRegisterPage() {
    const registrationForm = document.getElementById('i6kz3');
    const roleInput = document.getElementById('role');
    const fullNameInput = document.getElementById('full-name');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const confirmPasswordInput = document.getElementById('confirm-password');
    const termsInput = document.getElementById('terms');
    const registerMessage = document.getElementById('registerMessage');
    const submitButton = document.getElementById('irnt2i');

    if (
      !registrationForm ||
      !roleInput ||
      !fullNameInput ||
      !emailInput ||
      !passwordInput ||
      !confirmPasswordInput ||
      !termsInput ||
      !registerMessage ||
      !submitButton
    ) {
      return;
    }

    function setMessage(message) {
      registerMessage.textContent = message;
    }

    registrationForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      setMessage('');

      if (passwordInput.value !== confirmPasswordInput.value) {
        setMessage('Passwords do not match.');
        return;
      }

      if (termsInput.disabled || termsInput.dataset.termsReviewed !== 'true') {
        setMessage('Open the Terms of Use and Privacy Notice and scroll to the bottom before accepting.');
        const openTermsButton = document.getElementById('openTermsButton');
        if (openTermsButton && typeof openTermsButton.focus === 'function') openTermsButton.focus();
        return;
      }

      if (!termsInput.checked) {
        setMessage('Select the checkbox to accept the Terms of Use and Privacy Notice.');
        if (typeof termsInput.focus === 'function') termsInput.focus();
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = 'Creating account...';

      try {
        const firebaseClient = ensureFirebaseClient();
        const user = await firebaseClient.registerWithEmail(
          String(emailInput.value || '').trim(),
          passwordInput.value
        );
        const nameParts = splitName(fullNameInput.value);
        const registeredAt = new Date().toISOString();

        await firebaseClient.writeDocument('users', user.uid, {
          uid: user.uid,
          userId: user.uid,
          email: String(emailInput.value || '').trim(),
          role: roleInput.value,
          userType: roleInput.value,
          fname: nameParts.firstName,
          lname: nameParts.lastName,
          name: String(fullNameInput.value || '').trim(),
          fullName: String(fullNameInput.value || '').trim(),
          displayName: String(fullNameInput.value || '').trim(),
          createdAt: registeredAt,
          termsAcceptedAt: registeredAt,
          termsVersion: TERMS_VERSION,
        });

        const activeUser = await firebaseClient.waitForAuthUser();
        if (!activeUser || activeUser.uid !== user.uid) {
          throw new Error('Registration completed, but the local sign-in session was not restored. Please register again.');
        }
        submitButton.textContent = 'Loading dashboard...';
        window.location.href = './instructor-dashboard.html';
      } catch (error) {
        console.error('Registration failed:', error);
        setMessage(getFriendlyAuthMessage(error, 'Registration failed. Please try again.'));
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
      }
    });
  }

  function setupTermsDialog() {
    const dialog = document.getElementById('termsDialog');
    const dialogBody = document.getElementById('termsDialogBody');
    const openButton = document.getElementById('openTermsButton');
    const closeButton = document.getElementById('closeTermsButton');
    const termsInput = document.getElementById('terms');
    const reviewStatus = document.getElementById('termsReviewStatus');

    if (!dialog || !dialogBody || !openButton || !closeButton || !termsInput || !reviewStatus) return;

    function hasReachedBottom() {
      return dialogBody.scrollTop + dialogBody.clientHeight >= dialogBody.scrollHeight - 8;
    }

    function completeReview() {
      termsInput.disabled = false;
      termsInput.dataset.termsReviewed = 'true';
      closeButton.disabled = false;
      closeButton.textContent = 'Done — return to registration';
      reviewStatus.textContent = 'Agreement reviewed. Select the checkbox to accept.';
      reviewStatus.classList.add('is-complete');
    }

    function updateReviewProgress() {
      if (termsInput.dataset.termsReviewed === 'true') {
        completeReview();
        return;
      }
      if (hasReachedBottom()) completeReview();
    }

    function openDialog() {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      updateReviewProgress();
      if (typeof dialogBody.focus === 'function') dialogBody.focus();
    }

    function closeDialog() {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
      openButton.focus();
    }

    openButton.addEventListener('click', openDialog);
    closeButton.addEventListener('click', closeDialog);
    dialogBody.addEventListener('scroll', updateReviewProgress, { passive: true });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });
  }

  function init() {
    setupLoginPage();
    setupRegisterPage();
    setupTermsDialog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
