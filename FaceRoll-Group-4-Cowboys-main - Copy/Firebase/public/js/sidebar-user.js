(function () {
  const profileNameElement = document.querySelector('.sidebar-footer .profile-name');
  const profileRoleElement = document.querySelector('.sidebar-footer .profile-role');
  const profileMiniElement = document.querySelector('.sidebar-footer .profile-mini');

  if (!profileNameElement || !profileRoleElement || !profileMiniElement || !window.FaceRollFirebase) {
    return;
  }

  const firebaseApi = window.FaceRollFirebase;
  const sidebarState = {
    authUser: null,
    users: [],
  };

  function getFirstDefined(source, keys) {
    if (!source) {
      return undefined;
    }

    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        return source[key];
      }
    }

    return undefined;
  }

  function formatRoleLabel(roleValue) {
    const role = String(roleValue || 'User').trim();
    if (!role) {
      return 'User';
    }

    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  function getUserDisplayName(user, authUser) {
    if (authUser && authUser.displayName) {
      return String(authUser.displayName);
    }

    const directName = getFirstDefined(user, ['name', 'fullName', 'displayName']);
    if (directName) {
      return String(directName);
    }

    const firstName = getFirstDefined(user, ['fname', 'firstName', 'first_name']);
    const lastName = getFirstDefined(user, ['lname', 'lastName', 'last_name']);
    const joinedName = [firstName, lastName].filter(Boolean).join(' ').trim();

    if (joinedName) {
      return joinedName;
    }

    if (authUser && authUser.email) {
      return String(authUser.email);
    }

    return 'Not signed in';
  }

  function findMatchedUser(authUser, users) {
    // Match Firebase Auth to the Firestore user profile by uid or email.
    if (!authUser) {
      return null;
    }

    const uid = String(authUser.uid || '');
    const email = String(authUser.email || '').toLowerCase();

    return (
      users.find((user) => String(user.id || '') === uid) ||
      users.find((user) => String(getFirstDefined(user, ['uid', 'userId', 'authUid']) || '') === uid) ||
      users.find((user) => String(getFirstDefined(user, ['email']) || '').toLowerCase() === email) ||
      null
    );
  }

  function publishSidebarUser(matchedUser, authUser) {
    // Other dashboard scripts can read this instead of repeating user lookup.
    window.FaceRollCurrentUser = {
      authUid: authUser ? String(authUser.uid || '') : '',
      email: authUser ? String(authUser.email || '') : '',
      profile: matchedUser || null,
    };

    window.dispatchEvent(
      new CustomEvent('faceroll:current-user-changed', {
        detail: window.FaceRollCurrentUser,
      })
    );
  }

  function renderSidebarUser() {
    const authUser = sidebarState.authUser;
    const matchedUser = findMatchedUser(authUser, sidebarState.users);

    profileNameElement.textContent = getUserDisplayName(matchedUser, authUser);
    profileRoleElement.textContent = formatRoleLabel(getFirstDefined(matchedUser, ['role', 'userType']));

    publishSidebarUser(matchedUser, authUser);
  }

  function ensureAccountMenuStyles() {
    if (document.getElementById('faceroll-account-menu-styles')) return;

    const style = document.createElement('style');
    style.id = 'faceroll-account-menu-styles';
    style.textContent = [
      '.sidebar-footer{position:relative;}',
      '.sidebar-footer .profile-mini{cursor:pointer;}',
      '.sidebar-footer .profile-mini:focus{outline:2px solid rgba(37,99,235,0.25);outline-offset:3px;}',
      '.faceroll-account-menu{position:absolute;left:12px;right:12px;bottom:calc(100% + 10px);z-index:50;background:#ffffff;border:1px solid #dbe4f0;border-radius:8px;box-shadow:0 18px 40px rgba(15,23,42,0.16);padding:0.65rem;display:none;}',
      '.faceroll-account-menu.is-open{display:block;}',
      '.faceroll-account-name{font-weight:700;color:#0f172a;font-size:0.9rem;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.faceroll-account-email{color:#64748b;font-size:0.78rem;line-height:1.2;margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.faceroll-account-role{color:#475569;font-size:0.78rem;line-height:1.2;margin-top:0.35rem;}',
      '.faceroll-account-divider{height:1px;background:#e2e8f0;margin:0.65rem 0;}',
      '.faceroll-account-action{width:100%;display:flex;align-items:center;justify-content:flex-start;border:0;background:#ffffff;color:#b91c1c;border-radius:6px;padding:0.55rem 0.6rem;font-weight:600;font-size:0.875rem;cursor:pointer;}',
      '.faceroll-account-action:hover,.faceroll-account-action:focus{background:#fef2f2;outline:none;}',
      '.faceroll-account-action:disabled{opacity:0.65;cursor:wait;}',
    ].join('');
    document.head.appendChild(style);
  }

  function ensureAccountMenu() {
    // Builds the small profile popup when the instructor clicks the sidebar name.
    let menu = document.getElementById('facerollAccountMenu');
    if (menu) return menu;

    ensureAccountMenuStyles();
    profileMiniElement.setAttribute('role', 'button');
    profileMiniElement.setAttribute('tabindex', '0');
    profileMiniElement.setAttribute('aria-haspopup', 'menu');
    profileMiniElement.setAttribute('aria-expanded', 'false');

    menu = document.createElement('div');
    menu.id = 'facerollAccountMenu';
    menu.className = 'faceroll-account-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = [
      '<div class="faceroll-account-name"></div>',
      '<div class="faceroll-account-email"></div>',
      '<div class="faceroll-account-role"></div>',
      '<div class="faceroll-account-divider"></div>',
      '<button type="button" class="faceroll-account-action" role="menuitem">Log Out</button>',
    ].join('');

    profileMiniElement.parentElement.appendChild(menu);
    return menu;
  }

  function setAccountMenuOpen(isOpen) {
    const menu = ensureAccountMenu();
    menu.classList.toggle('is-open', isOpen);
    profileMiniElement.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function renderAccountMenu() {
    const menu = ensureAccountMenu();
    const authUser = sidebarState.authUser;
    const matchedUser = findMatchedUser(authUser, sidebarState.users);

    menu.querySelector('.faceroll-account-name').textContent = getUserDisplayName(matchedUser, authUser);
    menu.querySelector('.faceroll-account-email').textContent = authUser && authUser.email ? String(authUser.email) : '';
    menu.querySelector('.faceroll-account-role').textContent = formatRoleLabel(getFirstDefined(matchedUser, ['role', 'userType']));
  }

  async function signOutAndRedirect(button) {
    // Log out through Firebase Auth, then send the instructor back to login.
    try {
      button.disabled = true;
      button.textContent = 'Logging out...';
      if (!window.firebase || typeof window.firebase.auth !== 'function') {
        throw new Error('Firebase Auth is not available.');
      }
      await window.firebase.auth().signOut();
      window.location.href = './index.html';
    } catch (error) {
      console.error('Failed to log out:', error);
      button.disabled = false;
      button.textContent = 'Log Out';
    }
  }

  function initAccountMenu() {
    const menu = ensureAccountMenu();
    const logoutButton = menu.querySelector('.faceroll-account-action');

    profileMiniElement.addEventListener('click', function (event) {
      event.stopPropagation();
      renderAccountMenu();
      setAccountMenuOpen(!menu.classList.contains('is-open'));
    });

    profileMiniElement.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      renderAccountMenu();
      setAccountMenuOpen(!menu.classList.contains('is-open'));
    });

    logoutButton.addEventListener('click', function (event) {
      event.stopPropagation();
      signOutAndRedirect(logoutButton);
    });

    document.addEventListener('click', function (event) {
      if (menu.contains(event.target) || profileMiniElement.contains(event.target)) return;
      setAccountMenuOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    });
  }

  initAccountMenu();

  firebaseApi
    .subscribeAuthState(
      // Keep the sidebar in sync with Firebase Auth changes.
      function (authUser) {
        sidebarState.authUser = authUser;
        renderSidebarUser();
        renderAccountMenu();
      },
      function (error) {
        console.error('Failed to watch auth state for sidebar user:', error);
      }
    )
    .catch(function (error) {
      console.error('Failed to start auth subscription for sidebar user:', error);
    });

  firebaseApi
    .subscribeCollectionDocs(
      'users',
      // Watch user profiles so display name/role changes show without refresh.
      function (users) {
        sidebarState.users = users;
        renderSidebarUser();
        renderAccountMenu();
      },
      function (error) {
        console.error('Failed to watch users collection for sidebar user:', error);
      }
    )
    .catch(function (error) {
      console.error('Failed to start users subscription for sidebar user:', error);
    });
})();
