(function () {
  const sidebarMenuList = document.querySelector('.sidebar-menu-list');
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
    profileResolved: false,
  };
  const SIDEBAR_PROFILE_CACHE_KEY = 'faceroll.sidebar-profile.v1';
  let profileUnsubscribe = null;
  let profileSubscriptionGeneration = 0;
  const sidebarItems = [
    { href: './instructor-dashboard.html', label: 'Dashboard', icon: 'lucide-home' },
    { href: './live-session.html', label: 'Live Session', icon: 'lucide-calendar-check' },
    { href: './student-roster.html', label: 'Students', icon: 'lucide-users' },
    { href: './reports.html', label: 'Reports', icon: 'lucide-bar-chart-3' },
    { href: './courses.html', label: 'Courses', icon: 'lucide-book-open' },
    { href: './settings.html', label: 'Settings', icon: 'lucide-settings' },
  ];

  function normalizePageName(value) {
    return String(value || '').split('?')[0].split('#')[0].split('/').pop() || '';
  }

  function getCurrentPageName() {
    return normalizePageName(window.location.pathname) || 'index.html';
  }

  function renderSidebarMenu() {
    if (!sidebarMenuList) {
      return;
    }

    const currentPage = getCurrentPageName();

    sidebarMenuList.innerHTML = sidebarItems.map(function (item) {
      const itemPage = normalizePageName(item.href);
      const isActive =
        currentPage === itemPage ||
        (currentPage === 'student-profile.html' && itemPage === 'student-roster.html');
      const linkClass = isActive ? 'sidebar-link-active' : 'sidebar-link';
      const iconColor = isActive ? '%230f172a' : '%2364748b';
      const ariaCurrent = isActive ? ' aria-current="page"' : '';

      return [
        '<li>',
        '<a href="', item.href, '" class="', linkClass, '"', ariaCurrent, '>',
        '<img src="https://api.iconify.design/', item.icon, '.svg?color=', iconColor, '" alt="" class="sidebar-icon"/>',
        '<span class="sidebar-link-label">', item.label, '</span>',
        '</a>',
        '</li>',
      ].join('');
    }).join('');
  }

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

    if (authUser && authUser.displayName &&
        String(authUser.displayName).toLowerCase() !== String(authUser.email || '').toLowerCase()) {
      return String(authUser.displayName);
    }

    if (authUser && authUser.email) {
      return String(authUser.email);
    }

    return 'Not signed in';
  }

  function readCachedProfile(authUser) {
    if (!authUser || !authUser.uid) return null;
    if (typeof firebaseApi.readCachedUserProfile === 'function') {
      const sharedProfile = firebaseApi.readCachedUserProfile(authUser.uid);
      if (sharedProfile) return sharedProfile;
    }
    if (!globalThis.sessionStorage) return null;
    try {
      const cached = JSON.parse(globalThis.sessionStorage.getItem(SIDEBAR_PROFILE_CACHE_KEY) || 'null');
      if (!cached || cached.authUid !== String(authUser.uid) || !cached.profile) return null;
      if (typeof firebaseApi.cacheUserProfile === 'function') {
        firebaseApi.cacheUserProfile(authUser.uid, cached.profile);
        globalThis.sessionStorage.removeItem(SIDEBAR_PROFILE_CACHE_KEY);
      }
      return cached.profile;
    } catch (error) {
      return null;
    }
  }

  function cacheProfile(authUser, profile) {
    if (!authUser || !authUser.uid || !profile) return;
    if (typeof firebaseApi.cacheUserProfile === 'function') {
      firebaseApi.cacheUserProfile(authUser.uid, profile);
      return;
    }
    if (!globalThis.sessionStorage) return;
    const cachedProfile = { id: profile.id || String(authUser.uid) };
    ['uid', 'userId', 'authUid', 'email', 'role', 'userType', 'name', 'fullName',
      'displayName', 'fname', 'firstName', 'first_name', 'lname', 'lastName', 'last_name']
      .forEach(function (key) {
        if (profile[key] !== undefined) cachedProfile[key] = profile[key];
      });
    try {
      globalThis.sessionStorage.setItem(SIDEBAR_PROFILE_CACHE_KEY, JSON.stringify({
        authUid: String(authUser.uid),
        profile: cachedProfile,
      }));
    } catch (error) {}
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

    if (authUser && !sidebarState.profileResolved && !matchedUser) {
      profileNameElement.textContent = 'Loading...';
      profileRoleElement.textContent = 'Loading...';
      publishSidebarUser(null, authUser);
      return;
    }

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

    const isLoadingProfile = Boolean(authUser && !sidebarState.profileResolved && !matchedUser);
    menu.querySelector('.faceroll-account-name').textContent = isLoadingProfile
      ? 'Loading...'
      : getUserDisplayName(matchedUser, authUser);
    menu.querySelector('.faceroll-account-email').textContent = authUser && authUser.email ? String(authUser.email) : '';
    menu.querySelector('.faceroll-account-role').textContent = isLoadingProfile
      ? 'Loading...'
      : formatRoleLabel(getFirstDefined(matchedUser, ['role', 'userType']));
  }

  async function signOutAndRedirect(button) {
    // Log out through Firebase Auth, then send the instructor back to login.
    try {
      button.disabled = true;
      button.textContent = 'Logging out...';
      if (typeof firebaseApi.signOutUser !== 'function') {
        throw new Error('Firebase sign-out is not available.');
      }
      await firebaseApi.signOutUser();
      try {
        if (globalThis.sessionStorage) globalThis.sessionStorage.removeItem(SIDEBAR_PROFILE_CACHE_KEY);
      } catch (error) {}
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

  renderSidebarMenu();
  initAccountMenu();
  if (typeof firebaseApi.readCachedAuthUserSummary === 'function') {
    const cachedAuthUser = firebaseApi.readCachedAuthUserSummary();
    if (cachedAuthUser && cachedAuthUser.uid) {
      sidebarState.authUser = cachedAuthUser;
      const cachedProfile = readCachedProfile(cachedAuthUser);
      sidebarState.users = cachedProfile ? [cachedProfile] : [];
      sidebarState.profileResolved = Boolean(cachedProfile);
      renderSidebarUser();
      renderAccountMenu();
    }
  }

  function stopProfileSubscription() {
    profileSubscriptionGeneration += 1;
    if (typeof profileUnsubscribe === 'function') profileUnsubscribe();
    profileUnsubscribe = null;
  }

  async function watchSignedInProfile(authUser) {
    stopProfileSubscription();
    if (!authUser || !authUser.uid) {
      sidebarState.users = [];
      sidebarState.profileResolved = true;
      renderSidebarUser();
      renderAccountMenu();
      return;
    }
    const generation = profileSubscriptionGeneration;
    try {
      const unsubscribe = await firebaseApi.subscribeDocument(
        'users',
        authUser.uid,
        function (profile, snapshotInfo) {
          if (generation !== profileSubscriptionGeneration) return;
          if (!profile && snapshotInfo && snapshotInfo.fromCache) {
            return;
          }
          sidebarState.users = profile ? [profile] : [];
          sidebarState.profileResolved = true;
          if (profile) cacheProfile(authUser, profile);
          renderSidebarUser();
          renderAccountMenu();
        },
        function (error) {
          console.error('Failed to watch instructor profile:', error);
        }
      );
      if (generation === profileSubscriptionGeneration) profileUnsubscribe = unsubscribe;
      else if (typeof unsubscribe === 'function') unsubscribe();
    } catch (error) {
      console.error('Failed to start instructor profile subscription:', error);
    }
  }

  firebaseApi
    .subscribeAuthState(
      // Keep the sidebar in sync with Firebase Auth changes.
      function (authUser) {
        sidebarState.authUser = authUser;
        if (!authUser) {
          if (typeof firebaseApi.clearInstructorSnapshotCache === 'function') {
            firebaseApi.clearInstructorSnapshotCache();
          }
          try {
            if (globalThis.sessionStorage) globalThis.sessionStorage.removeItem(SIDEBAR_PROFILE_CACHE_KEY);
          } catch (error) {}
        }
        const cachedProfile = readCachedProfile(authUser);
        sidebarState.users = cachedProfile ? [cachedProfile] : [];
        sidebarState.profileResolved = Boolean(cachedProfile) || !authUser;
        renderSidebarUser();
        renderAccountMenu();
        watchSignedInProfile(authUser);
      },
      function (error) {
        console.error('Failed to watch auth state for sidebar user:', error);
      }
    )
    .catch(function (error) {
      console.error('Failed to start auth subscription for sidebar user:', error);
    });

  window.addEventListener('pagehide', stopProfileSubscription);
})();
