(function () {
  'use strict';

  const DEFAULT_CENTER = { lat: 33.2108, lng: -97.1473 };
  const DEFAULT_RADIUS_METERS = 25;
  const MAP_ZOOM = 19;

  const firebaseApi = window.FaceRollFirebase;
  const utils = window.FaceRollCourseLocationUtils;
  const elements = {
    courseSelect: document.getElementById('course-select'),
    courseStatus: document.getElementById('course-status'),
    locationCard: document.getElementById('location-settings-card'),
    enabledToggle: document.getElementById('location-enabled-toggle'),
    enabledLabel: document.getElementById('verification-state-label'),
    searchForm: document.getElementById('location-search-form'),
    searchInput: document.getElementById('location-search-input'),
    searchButton: document.getElementById('location-search-button'),
    searchStatus: document.getElementById('search-status'),
    searchResults: document.getElementById('search-results'),
    mapContainer: document.getElementById('here-map'),
    mapPlaceholder: document.getElementById('map-placeholder'),
    mapStatus: document.getElementById('map-status'),
    address: document.getElementById('selected-address'),
    latitude: document.getElementById('selected-latitude'),
    longitude: document.getElementById('selected-longitude'),
    saveStatus: document.getElementById('save-status'),
    saveButton: document.getElementById('save-location-button'),
    radiusInputs: Array.from(document.querySelectorAll('input[name="radiusMeters"]')),
  };

  const state = {
    authUser: null,
    userProfile: null,
    authorized: false,
    courses: [],
    selectedCourse: null,
    location: null,
    enabled: false,
    radiusMeters: DEFAULT_RADIUS_METERS,
    map: null,
    behavior: null,
    searchService: null,
    marker: null,
    radiusCircle: null,
    mapReady: false,
    markerOffset: null,
    reverseRequestId: 0,
    saving: false,
    savedSnapshot: null,
  };

  function setStatus(element, message, variant) {
    if (!element) return;
    element.textContent = message || '';
    element.classList.remove('success', 'error', 'info', 'warning');
    if (variant) element.classList.add(variant);
  }

  function getFirstDefined(source, keys) {
    if (!source) return undefined;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        return source[key];
      }
    }
    return undefined;
  }

  function getCourseId(course) {
    return String(getFirstDefined(course, ['courseId', 'id', 'code']) || '').trim();
  }

  function getCourseName(course) {
    return String(getFirstDefined(course, ['courseName', 'name', 'title']) || getCourseId(course)).trim();
  }

  function setToggleValue(enabled) {
    state.enabled = Boolean(enabled);
    elements.enabledToggle.setAttribute('aria-checked', String(state.enabled));
    elements.enabledLabel.textContent = state.enabled ? 'Enabled' : 'Disabled';
  }

  function setRadiusValue(radiusMeters) {
    const radius = Number(radiusMeters);
    state.radiusMeters = utils.ALLOWED_RADIUS_METERS.includes(radius)
      ? radius
      : DEFAULT_RADIUS_METERS;

    elements.radiusInputs.forEach(function (input) {
      input.checked = Number(input.value) === state.radiusMeters;
    });
  }

  function setInteractiveControlsEnabled(enabled) {
    const courseReady = Boolean(enabled && state.selectedCourse && state.authorized);
    elements.enabledToggle.disabled = !courseReady;
    elements.radiusInputs.forEach(function (input) {
      input.disabled = !courseReady;
    });
    elements.searchInput.disabled = !courseReady || !state.mapReady;
    elements.searchButton.disabled = !courseReady || !state.mapReady;
    elements.locationCard.classList.toggle('is-disabled', !courseReady);
    updateSaveButton();
  }

  function getLocationCandidate() {
    return {
      latitude: state.location ? state.location.latitude : null,
      longitude: state.location ? state.location.longitude : null,
      radiusMeters: state.radiusMeters,
      addressLabel: state.location ? state.location.addressLabel : '',
      enabled: state.enabled,
    };
  }

  function locationSnapshot() {
    return JSON.stringify(getLocationCandidate());
  }

  function hasUnsavedChanges() {
    return Boolean(state.selectedCourse && state.savedSnapshot !== null &&
      locationSnapshot() !== state.savedSnapshot);
  }

  function updateSaveButton() {
    const validation = utils.validateLocation(getLocationCandidate());
    elements.saveButton.disabled =
      !state.authorized || !state.selectedCourse || state.saving || !validation.valid;
  }

  function showSelectedLocation() {
    if (!state.location) {
      elements.address.textContent = 'No classroom location selected.';
      elements.address.classList.add('empty');
      elements.latitude.textContent = '—';
      elements.longitude.textContent = '—';
      updateSaveButton();
      return;
    }

    elements.address.textContent = state.location.addressLabel;
    elements.address.classList.remove('empty');
    elements.latitude.textContent = Number(state.location.latitude).toFixed(6);
    elements.longitude.textContent = Number(state.location.longitude).toFixed(6);
    updateSaveButton();
  }

  function updateMapObjects(recenter) {
    if (!state.mapReady || !state.map) return;

    if (state.marker) state.map.removeObject(state.marker);
    if (state.radiusCircle) state.map.removeObject(state.radiusCircle);
    state.marker = null;
    state.radiusCircle = null;

    if (!state.location) return;

    const position = {
      lat: state.location.latitude,
      lng: state.location.longitude,
    };
    state.radiusCircle = new window.H.map.Circle(position, state.radiusMeters, {
      style: {
        strokeColor: 'rgba(29, 78, 216, 0.92)',
        lineWidth: 2,
        fillColor: 'rgba(59, 130, 246, 0.18)',
      },
    });
    state.marker = new window.H.map.Marker(position, { volatility: true });
    state.marker.draggable = true;
    state.marker.setData('classroom-marker');
    state.map.addObjects([state.radiusCircle, state.marker]);

    if (recenter) {
      state.map.setCenter(position, true);
      state.map.setZoom(MAP_ZOOM, true);
    }
  }

  function setLocation(latitude, longitude, addressLabel, recenter) {
    state.location = {
      latitude: Number(latitude),
      longitude: Number(longitude),
      addressLabel:
        String(addressLabel || '').trim() ||
        'Map selection (' + Number(latitude).toFixed(6) + ', ' + Number(longitude).toFixed(6) + ')',
    };
    showSelectedLocation();
    updateMapObjects(Boolean(recenter));
  }

  function markUnsaved(message) {
    setStatus(elements.saveStatus, message || 'You have unsaved location changes.', 'warning');
    updateSaveButton();
  }

  function reverseGeocode(latitude, longitude) {
    if (!state.searchService) return Promise.resolve(null);
    const requestId = ++state.reverseRequestId;

    return new Promise(function (resolve) {
      state.searchService.reverseGeocode(
        { at: latitude + ',' + longitude, limit: 1 },
        function (result) {
          if (requestId !== state.reverseRequestId) {
            resolve(null);
            return;
          }
          const item = result && result.items && result.items[0];
          resolve(item ? String((item.address && item.address.label) || item.title || '') : null);
        },
        function (error) {
          console.warn('HERE reverse geocoding failed:', error);
          resolve(null);
        }
      );
    });
  }

  async function selectMapPosition(latitude, longitude, initialLabel, recenter) {
    setLocation(latitude, longitude, initialLabel, recenter);
    setStatus(elements.mapStatus, 'Resolving the selected address...', 'info');
    markUnsaved();

    const resolvedLabel = await reverseGeocode(latitude, longitude);
    if (
      resolvedLabel &&
      state.location &&
      state.location.latitude === Number(latitude) &&
      state.location.longitude === Number(longitude)
    ) {
      state.location.addressLabel = resolvedLabel;
      showSelectedLocation();
    }
    setStatus(
      elements.mapStatus,
      'Location selected. Drag the marker if a more precise position is needed.',
      'success'
    );
  }

  function wireMapEvents() {
    state.map.addEventListener('tap', function (event) {
      if (!state.authorized || !state.selectedCourse || event.target === state.marker) return;
      const pointer = event.currentPointer;
      const geo = state.map.screenToGeo(pointer.viewportX, pointer.viewportY);
      selectMapPosition(geo.lat, geo.lng, '', false);
    });

    state.map.addEventListener('dragstart', function (event) {
      if (event.target === state.marker && state.behavior) {
        state.behavior.disable(window.H.mapevents.Behavior.Feature.PANNING);
        const pointer = event.currentPointer;
        const markerPosition = state.map.geoToScreen(state.marker.getGeometry());
        state.markerOffset = new window.H.math.Point(
          pointer.viewportX - markerPosition.x,
          pointer.viewportY - markerPosition.y
        );
      }
    });

    state.map.addEventListener('drag', function (event) {
      if (event.target !== state.marker) return;
      const pointer = event.currentPointer;
      const offset = state.markerOffset || { x: 0, y: 0 };
      const geo = state.map.screenToGeo(
        pointer.viewportX - offset.x,
        pointer.viewportY - offset.y
      );
      state.marker.setGeometry(geo);
      state.location.latitude = geo.lat;
      state.location.longitude = geo.lng;
      state.location.addressLabel =
        'Map selection (' + geo.lat.toFixed(6) + ', ' + geo.lng.toFixed(6) + ')';
      if (state.radiusCircle) state.radiusCircle.setCenter(geo);
      showSelectedLocation();
    });

    state.map.addEventListener('dragend', function (event) {
      if (event.target !== state.marker) return;
      if (state.behavior) state.behavior.enable(window.H.mapevents.Behavior.Feature.PANNING);
      state.markerOffset = null;
      const position = state.marker.getGeometry();
      selectMapPosition(position.lat, position.lng, state.location.addressLabel, false);
    });
  }

  function initializeMap() {
    const apiKey = String(
      (window.FaceRollConfig && window.FaceRollConfig.HERE_API_KEY) || ''
    ).trim();

    if (!apiKey) {
      elements.mapPlaceholder.querySelector('strong').textContent = 'HERE Maps is not configured';
      elements.mapPlaceholder.querySelector('span').textContent =
        'Add HERE_API_KEY to .env and run npm run build, then reload this page.';
      setStatus(elements.mapStatus, 'A HERE API key is required to load the map and search.', 'error');
      setInteractiveControlsEnabled(true);
      return;
    }

    if (!window.H || !window.H.service || !window.H.Map) {
      elements.mapPlaceholder.querySelector('strong').textContent = 'HERE Maps could not load';
      elements.mapPlaceholder.querySelector('span').textContent =
        'Check the network connection and the allowed domains on the HERE API key.';
      setStatus(elements.mapStatus, 'Unable to load the HERE Maps JavaScript API.', 'error');
      setInteractiveControlsEnabled(true);
      return;
    }

    try {
      const platform = new window.H.service.Platform({ apikey: apiKey });
      const defaultLayers = platform.createDefaultLayers();
      state.searchService = platform.getSearchService();
      state.map = new window.H.Map(elements.mapContainer, defaultLayers.vector.normal.map, {
        center: DEFAULT_CENTER,
        zoom: 16,
        pixelRatio: window.devicePixelRatio || 1,
      });
      const events = new window.H.mapevents.MapEvents(state.map);
      state.behavior = new window.H.mapevents.Behavior(events);
      window.H.ui.UI.createDefault(state.map, defaultLayers);
      state.mapReady = true;
      wireMapEvents();
      window.addEventListener('resize', function () {
        if (state.map) state.map.getViewPort().resize();
      });
      window.addEventListener('pagehide', function () {
        if (state.map) state.map.dispose();
      });

      elements.mapPlaceholder.classList.add('is-hidden');
      setStatus(
        elements.mapStatus,
        state.selectedCourse
          ? 'Search or click the map to place the classroom marker.'
          : 'Select a course, then search or click the map to place the classroom marker.',
        'info'
      );
      setInteractiveControlsEnabled(true);
      updateMapObjects(Boolean(state.location));
    } catch (error) {
      console.error('HERE Maps initialization failed:', error);
      elements.mapPlaceholder.querySelector('strong').textContent = 'HERE Maps could not start';
      elements.mapPlaceholder.querySelector('span').textContent =
        'Verify the HERE API key and its allowed website domains.';
      setStatus(elements.mapStatus, 'HERE Maps initialization failed.', 'error');
      setInteractiveControlsEnabled(true);
    }
  }

  function clearSearchResults() {
    elements.searchResults.innerHTML = '';
    elements.searchResults.classList.remove('has-results');
  }

  function renderSearchResults(items) {
    clearSearchResults();
    items.forEach(function (item) {
      if (!item.position) return;
      const button = document.createElement('button');
      const title = document.createElement('strong');
      const subtitle = document.createElement('span');
      button.type = 'button';
      button.className = 'search-result-button';
      title.textContent = String(item.title || 'Search result');
      subtitle.textContent = String((item.address && item.address.label) || item.title || '');
      button.appendChild(title);
      button.appendChild(subtitle);
      button.addEventListener('click', function () {
        clearSearchResults();
        elements.searchInput.value = subtitle.textContent;
        selectMapPosition(
          item.position.lat,
          item.position.lng,
          subtitle.textContent,
          true
        );
      });
      elements.searchResults.appendChild(button);
    });

    if (elements.searchResults.children.length) {
      elements.searchResults.classList.add('has-results');
    }
  }

  function searchLocations(query) {
    return new Promise(function (resolve, reject) {
      state.searchService.geocode(
        { q: query, limit: 6 },
        function (result) {
          resolve((result && result.items) || []);
        },
        reject
      );
    });
  }

  async function handleSearch(event) {
    event.preventDefault();
    clearSearchResults();
    const query = String(elements.searchInput.value || '').trim();

    if (!query) {
      setStatus(elements.searchStatus, 'Enter a campus building or address.', 'error');
      elements.searchInput.focus();
      return;
    }
    if (!state.searchService) {
      setStatus(elements.searchStatus, 'HERE location search is not available.', 'error');
      return;
    }

    elements.searchButton.disabled = true;
    elements.searchButton.textContent = 'Searching...';
    setStatus(elements.searchStatus, 'Searching HERE for “' + query + '”...', 'info');

    try {
      const items = await searchLocations(query);
      if (!items.length) {
        setStatus(elements.searchStatus, 'No matching locations found. Try a fuller address.', 'warning');
        return;
      }
      renderSearchResults(items);
      setStatus(elements.searchStatus, 'Choose one of ' + items.length + ' matching locations.', 'success');
    } catch (error) {
      console.error('HERE geocoding search failed:', error);
      setStatus(
        elements.searchStatus,
        'Location search failed. Check the HERE key and network connection, then try again.',
        'error'
      );
    } finally {
      elements.searchButton.textContent = 'Search';
      elements.searchButton.disabled = !state.mapReady || !state.selectedCourse;
    }
  }

  function resetLocationForm() {
    state.location = null;
    setToggleValue(false);
    setRadiusValue(DEFAULT_RADIUS_METERS);
    elements.searchInput.value = '';
    clearSearchResults();
    setStatus(elements.searchStatus, '', 'info');
    showSelectedLocation();
    updateMapObjects(false);
  }

  function loadSelectedCourseLocation(course) {
    resetLocationForm();
    const savedLocation = course && course.location;
    const validation = utils.validateLocation(savedLocation);

    if (savedLocation && validation.valid) {
      state.location = {
        latitude: validation.value.latitude,
        longitude: validation.value.longitude,
        addressLabel: validation.value.addressLabel,
      };
      setToggleValue(validation.value.enabled);
      setRadiusValue(validation.value.radiusMeters);
      showSelectedLocation();
      updateMapObjects(true);
      setStatus(
        elements.mapStatus,
        'Saved classroom location loaded. Drag the marker or search to update it.',
        'success'
      );
      setStatus(elements.saveStatus, 'This course’s saved location is shown.', 'success');
      return;
    }

    if (savedLocation) {
      setStatus(
        elements.saveStatus,
        'The saved location is incomplete. Select a valid classroom location and save it again.',
        'error'
      );
    } else {
      setStatus(
        elements.saveStatus,
        'No classroom location has been saved for this course yet.',
        'info'
      );
    }
    setStatus(elements.mapStatus, 'Search or click the map to place the classroom marker.', 'info');
  }

  function handleCourseChange() {
    const selectedId = String(elements.courseSelect.value || '');
    const previousId = state.selectedCourse ? getCourseId(state.selectedCourse) : '';
    if (selectedId === previousId) return;
    if (state.saving || (hasUnsavedChanges() && !window.confirm(
      'You have unsaved location changes. Discard them and switch courses?'
    ))) {
      elements.courseSelect.value = previousId;
      return;
    }
    ++state.reverseRequestId;
    state.savedSnapshot = null;
    state.selectedCourse =
      state.courses.find(function (course) {
        return getCourseId(course) === selectedId;
      }) || null;

    if (!state.selectedCourse) {
      resetLocationForm();
      setInteractiveControlsEnabled(false);
      setStatus(elements.saveStatus, 'Choose a course and classroom location to save.', 'info');
      return;
    }

    setInteractiveControlsEnabled(true);
    loadSelectedCourseLocation(state.selectedCourse);
    state.savedSnapshot = locationSnapshot();
    setInteractiveControlsEnabled(true);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('courseId', getCourseId(state.selectedCourse));
    window.history.replaceState({}, '', nextUrl);
  }

  function populateCourses(courses, preserveSelection) {
    const previousId = elements.courseSelect.value;
    elements.courseSelect.innerHTML = '<option value="">Select a course...</option>';
    courses.forEach(function (course) {
      const option = document.createElement('option');
      const courseId = getCourseId(course);
      option.value = courseId;
      option.textContent = getCourseName(course) + (getCourseName(course) === courseId ? '' : ' (' + courseId + ')');
      elements.courseSelect.appendChild(option);
    });
    elements.courseSelect.disabled = false;

    if (preserveSelection) {
      elements.courseSelect.value = previousId;
      return;
    }

    const requestedCourseId = new URLSearchParams(window.location.search).get('courseId');
    if (requestedCourseId && courses.some(function (course) { return getCourseId(course) === requestedCourseId; })) {
      elements.courseSelect.value = requestedCourseId;
      handleCourseChange();
    }
  }

  async function verifyAccessAndLoadCourses(preserveSelection) {
    if (!firebaseApi || !utils) {
      throw new Error('The dashboard data client did not initialize.');
    }

    const authUser = await firebaseApi.waitForAuthUser();
    if (!authUser) {
      throw new Error('Sign in with an instructor account to manage course locations.');
    }

    const profile = await firebaseApi.readDocument('users', authUser.uid);
    const role = getFirstDefined(profile, ['role', 'userType']);
    if (!utils.isAuthorizedRole(role)) {
      throw new Error('Only instructors or administrators can change course locations.');
    }

    state.authUser = authUser;
    state.userProfile = profile;
    state.authorized = true;

    const courses = await firebaseApi.readCollectionDocs('courses');
    state.courses = courses
      .filter(function (course) { return Boolean(getCourseId(course)); })
      .sort(function (first, second) {
        return getCourseName(first).localeCompare(getCourseName(second));
      });

    if (!state.courses.length) {
      elements.courseSelect.innerHTML = '<option value="">No courses available</option>';
      setStatus(
        elements.courseStatus,
        'No courses were found. Create a course above to configure its settings.',
        'warning'
      );
      return;
    }

    populateCourses(state.courses, preserveSelection);
    setStatus(
      elements.courseStatus,
      state.courses.length + (state.courses.length === 1 ? ' course available.' : ' courses available.'),
      'success'
    );
  }

  async function saveLocation() {
    const validation = utils.validateLocation(getLocationCandidate());
    if (!validation.valid) {
      setStatus(elements.saveStatus, validation.errors.join(' '), 'error');
      return;
    }
    if (!state.authorized || !state.authUser || !state.selectedCourse) {
      setStatus(elements.saveStatus, 'Instructor authorization is required to save.', 'error');
      return;
    }

    const savedCourse = state.selectedCourse;
    const submittedSnapshot = locationSnapshot();
    state.saving = true;
    elements.courseSelect.disabled = true;
    updateSaveButton();
    const originalButtonLabel = elements.saveButton.querySelector('span').textContent;
    elements.saveButton.querySelector('span').textContent = 'Saving...';
    setStatus(elements.saveStatus, 'Saving classroom location to this course...', 'info');

    const locationPayload = {
      latitude: validation.value.latitude,
      longitude: validation.value.longitude,
      radiusMeters: validation.value.radiusMeters,
      addressLabel: validation.value.addressLabel,
      enabled: validation.value.enabled,
      updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: state.authUser.uid,
    };

    try {
      const courseId = getCourseId(savedCourse);
      await firebaseApi.writeDocument('courses', courseId, { location: locationPayload });
      savedCourse.location = Object.assign({}, locationPayload, { updatedAt: new Date() });
      state.savedSnapshot = submittedSnapshot;
      setStatus(
        elements.saveStatus,
        'Classroom location saved successfully for ' + getCourseName(state.selectedCourse) + '.',
        'success'
      );
      setStatus(elements.mapStatus, 'Saved location and attendance radius are shown on the map.', 'success');
      if (hasUnsavedChanges()) markUnsaved('Your latest changes have not been saved yet.');
    } catch (error) {
      console.error('Failed to save course location:', error);
      const denied = error && String(error.code || '').includes('permission-denied');
      setStatus(
        elements.saveStatus,
        denied
          ? 'Save denied. Confirm this account has an instructor or administrator role.'
          : 'Could not save the classroom location. ' + (error && error.message ? error.message : 'Try again.'),
        'error'
      );
    } finally {
      state.saving = false;
      elements.courseSelect.disabled = false;
      elements.saveButton.querySelector('span').textContent = originalButtonLabel;
      updateSaveButton();
    }
  }

  function wireControls() {
    window.addEventListener('beforeunload', function (event) {
      if (!hasUnsavedChanges() && !state.saving) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('faceroll:courses-updated', async function () {
      try {
        await verifyAccessAndLoadCourses(true);
      } catch (error) {
        setStatus(elements.courseStatus, 'Unable to refresh courses. Reload the page to try again.', 'error');
      }
    });
    elements.courseSelect.addEventListener('change', handleCourseChange);
    elements.searchForm.addEventListener('submit', handleSearch);
    elements.enabledToggle.addEventListener('click', function () {
      setToggleValue(!state.enabled);
      markUnsaved('Location verification is now ' + (state.enabled ? 'enabled' : 'disabled') + '. Save to apply.');
    });
    elements.radiusInputs.forEach(function (input) {
      input.addEventListener('change', function () {
        if (!input.checked) return;
        setRadiusValue(input.value);
        updateMapObjects(false);
        markUnsaved('Attendance radius changed to ' + state.radiusMeters + ' meters. Save to apply.');
      });
    });
    elements.saveButton.addEventListener('click', saveLocation);
    document.addEventListener('click', function (event) {
      if (!elements.searchResults.contains(event.target) && event.target !== elements.searchInput) {
        clearSearchResults();
      }
    });
  }

  async function init() {
    wireControls();
    setInteractiveControlsEnabled(false);

    try {
      await verifyAccessAndLoadCourses();
    } catch (error) {
      console.error('Course settings initialization failed:', error);
      elements.courseSelect.innerHTML = '<option value="">Course access unavailable</option>';
      elements.courseSelect.disabled = true;
      setStatus(elements.courseStatus, error.message || 'Unable to load course settings.', 'error');
      setStatus(elements.saveStatus, 'Course location changes are unavailable.', 'error');
    }

    initializeMap();
    setInteractiveControlsEnabled(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
