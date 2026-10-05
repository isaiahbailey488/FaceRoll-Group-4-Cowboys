(function (global) {
  const FIREBASE_INIT_TIMEOUT_MS = 10000;
  const DATA_REQUEST_TIMEOUT_MS = 12000;
  const LEGACY_INSTRUCTOR_SNAPSHOT_CACHE_KEY = 'faceroll.instructor-snapshot.v1';
  const AUTH_USER_CACHE_KEY = 'faceroll.auth-user.v2';
  const INSTRUCTOR_CACHE_USERS_KEY = 'faceroll.instructor-cache-users.v2';
  const INSTRUCTOR_CACHE_PREFIX = 'faceroll.instructor-cache.v2';
  const INSTRUCTOR_CACHE_PARTS = ['instructor', 'profile', 'users', 'courses', 'sessions', 'attendance', 'enrollments'];
  const INSTRUCTOR_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
  const SHARED_DATA_CACHE_KEY = 'faceroll.shared-data-cache.v1';
  const SHARED_DATA_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
  const SHARED_DATA_CACHE_LIMIT = 80;
  let localEmulatorsConfigured = false;
  let firebaseServicesPromise = null;
  let firestorePersistencePromise = null;
  let connectionWasInterrupted = false;
  let lastReconnectNotificationAt = 0;
  const reconnectHandlers = new Set();
  const memoryDataCache = new Map();
  const inFlightReads = new Map();

  function logClientMessage(level, message, error) {
    if (!global.console || typeof global.console[level] !== 'function') return;
    if (error) global.console[level](message, error);
    else global.console[level](message);
  }

  function notifyConnectionRestored(reason) {
    const now = Date.now();
    if (now - lastReconnectNotificationAt < 500) return;
    lastReconnectNotificationAt = now;
    connectionWasInterrupted = false;
    reconnectHandlers.forEach(function (handler) {
      try { handler({ reason: reason || 'firestore' }); }
      catch (error) { logClientMessage('error', 'Firebase reconnect handler failed:', error); }
    });
    if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new global.CustomEvent('faceroll:firebase-reconnected', {
        detail: { reason: reason || 'firestore' },
      }));
    }
  }

  function markFirestoreAvailable(snapshot) {
    const fromCache = Boolean(snapshot && snapshot.metadata && snapshot.metadata.fromCache);
    if (fromCache) return;
    if (connectionWasInterrupted) notifyConnectionRestored('firestore');
  }

  function markFirestoreUnavailable(error) {
    const code = String(error && error.code || '').toLowerCase();
    const message = String(error && error.message || '').toLowerCase();
    if (code.includes('unavailable') || code.includes('deadline-exceeded') ||
        code.includes('network') || message.includes('offline') || message.includes('backend') ||
        message.includes('timed out')) {
      connectionWasInterrupted = true;
    }
  }

  function onConnectionRestored(handler) {
    if (typeof handler !== 'function') return function () {};
    reconnectHandlers.add(handler);
    return function () { reconnectHandlers.delete(handler); };
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('offline', function () { connectionWasInterrupted = true; });
    global.addEventListener('online', function () {
      if (connectionWasInterrupted) notifyConnectionRestored('browser-online');
    });
  }

  function stableCacheValue(value) {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableCacheValue);
    const normalized = {};
    Object.keys(value).sort().forEach(function (key) {
      normalized[key] = stableCacheValue(value[key]);
    });
    return normalized;
  }

  function cacheFingerprint(value) {
    return JSON.stringify(stableCacheValue(value));
  }

  function instructorSnapshotFingerprint(snapshot) {
    const value = snapshot || {};
    return cacheFingerprint({
      instructorUid: value.instructor && value.instructor.uid || '',
      users: value.users || [],
      courses: value.courses || [],
      sessions: value.sessions || [],
      attendance: value.attendance || [],
      enrollments: value.enrollments || [],
    });
  }

  function readStoredDataCache() {
    if (!global.sessionStorage) return {};
    try {
      const stored = JSON.parse(global.sessionStorage.getItem(SHARED_DATA_CACHE_KEY) || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch (error) {
      return {};
    }
  }

  function writeStoredDataCache(entries) {
    if (!global.sessionStorage) return;
    try {
      const currentEntries = Object.entries(entries).sort(function (left, right) {
        return Number(right[1] && right[1].savedAt || 0) - Number(left[1] && left[1].savedAt || 0);
      }).slice(0, SHARED_DATA_CACHE_LIMIT);
      global.sessionStorage.setItem(SHARED_DATA_CACHE_KEY, JSON.stringify(Object.fromEntries(currentEntries)));
    } catch (error) {}
  }

  function getCachedValue(key) {
    let entry = memoryDataCache.get(key);
    if (!entry) {
      entry = readStoredDataCache()[key];
      if (entry) memoryDataCache.set(key, entry);
    }
    if (!entry || !Number.isFinite(entry.savedAt) ||
        Date.now() - entry.savedAt > SHARED_DATA_CACHE_MAX_AGE_MS) return null;
    return entry.value;
  }

  function setCachedValue(key, value) {
    const entry = { savedAt: Date.now(), value: value };
    memoryDataCache.set(key, entry);
    let serializedLength = Infinity;
    try { serializedLength = JSON.stringify(value).length; } catch (error) {}
    // Large result sets live in the split instructor cache instead of being
    // duplicated inside the general query cache.
    if (serializedLength > 64 * 1024) return;
    const entries = readStoredDataCache();
    entries[key] = entry;
    writeStoredDataCache(entries);
  }

  function clearSharedDataCache() {
    memoryDataCache.clear();
    inFlightReads.clear();
    if (!global.sessionStorage) return;
    try { global.sessionStorage.removeItem(SHARED_DATA_CACHE_KEY); } catch (error) {}
  }

  function pickCacheFields(record, fields) {
    const output = {};
    (fields || []).forEach(function (field) {
      if (record && record[field] !== undefined) output[field] = record[field];
    });
    return output;
  }

  function summarizeCachedRows(part, rows) {
    const fieldsByPart = {
      users: ['id', 'uid', 'userId', 'authUid', 'studentId', 'studentNumber', 'schoolId',
        'email', 'role', 'userType', 'name', 'fullName', 'displayName', 'fname', 'firstName',
        'first_name', 'lname', 'lastName', 'last_name', 'createdAt'],
      courses: ['id', 'courseId', 'courseName', 'name', 'title', 'code', 'instructorId',
        'location', 'createdAt', 'updatedAt'],
      sessions: ['id', 'sessionId', 'courseId', 'startTime', 'endTime', 'date', 'createdAt',
        'status', 'gracePeriodMinutes'],
      attendance: ['id', 'sessionId', 'courseId', 'uid', 'userId', 'studentId', 'email',
        'status', 'time', 'createdAt', 'method', 'studentName', 'displayName',
        'recognitionLabel', 'recognitionConfidence', 'recognitionDistance'],
      enrollments: ['id', 'courseId', 'course_id', 'uid', 'userId', 'studentUid', 'status',
        'createdAt', 'updatedAt'],
    };
    const fields = fieldsByPart[part];
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return fields ? pickCacheFields(row, fields) : row;
    });
  }

  function instructorCacheKey(instructorUid, part) {
    return INSTRUCTOR_CACHE_PREFIX + '.' + encodeURIComponent(String(instructorUid)) + '.' + part;
  }

  function attendanceBucketDate(record) {
    const value = record && (record.time || record.createdAt || record.date);
    if (!value) return 'undated';
    let date = null;
    if (value instanceof Date) date = value;
    else if (typeof value.toDate === 'function') date = value.toDate();
    else if (typeof value === 'object' && Number.isFinite(
      value.seconds !== undefined ? value.seconds : value._seconds
    )) {
      date = new Date(Number(value.seconds !== undefined ? value.seconds : value._seconds) * 1000);
    } else date = new Date(value);
    return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : 'undated';
  }

  function attendanceBucketName(record) {
    const courseId = String(record && (record.courseId || record.course_id) || 'unassigned');
    return encodeURIComponent(courseId) + '~' + attendanceBucketDate(record);
  }

  function clearAttendanceBuckets(instructorUid) {
    if (!global.sessionStorage || !instructorUid) return;
    const bucketNames = readSessionEntry(instructorCacheKey(instructorUid, 'attendance'));
    (Array.isArray(bucketNames) ? bucketNames : []).forEach(function (bucketName) {
      try { global.sessionStorage.removeItem(instructorCacheKey(instructorUid, 'attendance-' + bucketName)); }
      catch (error) {}
    });
    try { global.sessionStorage.removeItem(instructorCacheKey(instructorUid, 'attendance')); }
    catch (error) {}
  }

  function cacheAttendanceBuckets(instructorUid, attendance) {
    if (!global.sessionStorage || !instructorUid) return;
    clearAttendanceBuckets(instructorUid);
    const buckets = new Map();
    summarizeCachedRows('attendance', attendance).forEach(function (record) {
      const bucketName = attendanceBucketName(record);
      if (!buckets.has(bucketName)) buckets.set(bucketName, []);
      buckets.get(bucketName).push(record);
    });
    buckets.forEach(function (rows, bucketName) {
      writeSessionEntry(instructorCacheKey(instructorUid, 'attendance-' + bucketName), rows);
    });
    writeSessionEntry(instructorCacheKey(instructorUid, 'attendance'), Array.from(buckets.keys()));
  }

  function readCachedAttendance(instructorUid, options) {
    if (!instructorUid) return null;
    const settings = options || {};
    const bucketNames = readSessionEntry(instructorCacheKey(instructorUid, 'attendance'));
    if (!Array.isArray(bucketNames)) return null;
    const courseIds = Array.isArray(settings.courseIds)
      ? new Set(settings.courseIds.map(function (value) { return String(value); })) : null;
    const date = settings.date ? String(settings.date) : '';
    const selected = bucketNames.filter(function (bucketName) {
      const separator = bucketName.lastIndexOf('~');
      const courseId = decodeURIComponent(separator >= 0 ? bucketName.slice(0, separator) : bucketName);
      const bucketDate = separator >= 0 ? bucketName.slice(separator + 1) : 'undated';
      return (!courseIds || courseIds.has(courseId)) && (!date || bucketDate === date);
    });
    const rows = [];
    for (const bucketName of selected) {
      const bucket = readSessionEntry(instructorCacheKey(instructorUid, 'attendance-' + bucketName));
      if (!Array.isArray(bucket)) return null;
      rows.push(...bucket);
    }
    return rows;
  }

  function readSessionEntry(key) {
    if (!global.sessionStorage) return null;
    try {
      const entry = JSON.parse(global.sessionStorage.getItem(key) || 'null');
      if (!entry || !Number.isFinite(entry.savedAt) ||
          Date.now() - entry.savedAt > INSTRUCTOR_SNAPSHOT_MAX_AGE_MS) return null;
      return entry.value;
    } catch (error) {
      return null;
    }
  }

  function writeSessionEntry(key, value) {
    if (!global.sessionStorage) return;
    try {
      global.sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value: value }));
    } catch (error) {}
  }

  function rememberInstructorCacheUser(instructorUid) {
    if (!global.sessionStorage || !instructorUid) return;
    try {
      const users = JSON.parse(global.sessionStorage.getItem(INSTRUCTOR_CACHE_USERS_KEY) || '[]');
      const normalized = Array.isArray(users) ? users.map(String) : [];
      if (!normalized.includes(String(instructorUid))) normalized.push(String(instructorUid));
      global.sessionStorage.setItem(INSTRUCTOR_CACHE_USERS_KEY, JSON.stringify(normalized));
    } catch (error) {}
  }

  function summarizeAuthUser(authUser) {
    if (!authUser || !authUser.uid) return null;
    return {
      uid: String(authUser.uid),
      email: String(authUser.email || ''),
      displayName: String(authUser.displayName || ''),
    };
  }

  function cacheAuthUserSummary(authUser) {
    const summary = summarizeAuthUser(authUser);
    if (summary) writeSessionEntry(AUTH_USER_CACHE_KEY, summary);
    return summary;
  }

  function readCachedAuthUserSummary() {
    return readSessionEntry(AUTH_USER_CACHE_KEY);
  }

  function cacheUserProfile(instructorUid, profile) {
    if (!instructorUid || !profile) return;
    rememberInstructorCacheUser(instructorUid);
    writeSessionEntry(instructorCacheKey(instructorUid, 'profile'),
      summarizeCachedRows('users', [profile])[0] || null);
  }

  function readCachedUserProfile(instructorUid) {
    if (!instructorUid) return null;
    return readSessionEntry(instructorCacheKey(instructorUid, 'profile'));
  }

  function readCachedCourseSummaries(instructorUid) {
    if (!instructorUid) return null;
    return readSessionEntry(instructorCacheKey(instructorUid, 'courses'));
  }

  function cacheCourseSummaries(instructorUid, courses) {
    if (!instructorUid || instructorUid === 'signed-out') return;
    rememberInstructorCacheUser(instructorUid);
    writeSessionEntry(instructorCacheKey(instructorUid, 'courses'), summarizeCachedRows('courses', courses));
  }

  function getSignedInScope(firebase) {
    try {
      const user = firebase && typeof firebase.auth === 'function' && firebase.auth().currentUser;
      return user && user.uid ? String(user.uid) : 'signed-out';
    } catch (error) {
      return 'signed-out';
    }
  }

  function buildDataCacheKey(firebase, kind, collectionName, details) {
    return [getSignedInScope(firebase), kind, collectionName, cacheFingerprint(details || {})].join('|');
  }

  function runSharedRead(key, operation) {
    if (inFlightReads.has(key)) return inFlightReads.get(key);
    const promise = Promise.resolve().then(operation).then(function (value) {
      setCachedValue(key, value);
      return value;
    }).finally(function () {
      if (inFlightReads.get(key) === promise) inFlightReads.delete(key);
    });
    inFlightReads.set(key, promise);
    return promise;
  }

  function runDeduplicatedRead(key, operation) {
    if (inFlightReads.has(key)) return inFlightReads.get(key);
    const promise = Promise.resolve().then(operation).finally(function () {
      if (inFlightReads.get(key) === promise) inFlightReads.delete(key);
    });
    inFlightReads.set(key, promise);
    return promise;
  }

  function withDataTimeout(operation, label) {
    if (typeof global.setTimeout !== 'function' || typeof global.clearTimeout !== 'function') {
      return operation;
    }
    let timer;
    const timeout = new Promise(function (_resolve, reject) {
      timer = global.setTimeout(function () {
        const error = new Error(label + ' timed out. Check the Firebase emulator connection and retry.');
        error.code = 'faceroll/data-timeout';
        reject(error);
      }, DATA_REQUEST_TIMEOUT_MS);
    });
    return Promise.race([operation, timeout]).finally(function () {
      global.clearTimeout(timer);
    });
  }

  function isLocalDashboard() {
    if (!global.location) return false;
    const hostname = String(global.location.hostname || '').toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    const parts = hostname.split('.').map(Number);
    if (parts.length !== 4 || parts.some(function (part) {
      return !Number.isInteger(part) || part < 0 || part > 255;
    })) return false;
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }

  function getAuthEmulatorConfig(auth) {
    return auth && (auth.emulatorConfig || (auth._delegate && auth._delegate.emulatorConfig)) || null;
  }

  function isAuthUsingLocalEmulator(auth) {
    const config = getAuthEmulatorConfig(auth);
    if (!config) return false;
    return Number(config.port) === 9099 ||
      String(config.url || '').includes(':9099') ||
      String(config.host || '').includes(':9099');
  }

  function getFirestoreHost(db) {
    const settings = db && (db._settings || (db._delegate && db._delegate._settings));
    return settings && settings.host ? String(settings.host) : '';
  }

  function configureLocalEmulators(firebase) {
    if (!isLocalDashboard() || localEmulatorsConfigured) return;

    // Keep local dashboard testing isolated from the live Firebase project.
    const auth = firebase.auth();
    const db = firebase.firestore();
    if (!isAuthUsingLocalEmulator(auth)) {
      auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    }
    if (!getFirestoreHost(db).includes(':8080')) {
      db.useEmulator('127.0.0.1', 8080);
    }
    localEmulatorsConfigured = true;
    console.info('FaceRoll local-only mode: Auth and Firestore are using the emulators.');
  }

  function enableFirestorePersistence(firebase) {
    if (firestorePersistencePromise) return firestorePersistencePromise;
    const db = firebase.firestore();
    if (!db || typeof db.enablePersistence !== 'function') {
      firestorePersistencePromise = Promise.resolve(false);
      return firestorePersistencePromise;
    }
    firestorePersistencePromise = db.enablePersistence({ synchronizeTabs: true }).then(function () {
      logClientMessage('info', 'FaceRoll Firestore persistent cache is enabled.');
      return true;
    }).catch(function (error) {
      // Firestore remains usable with its normal in-memory cache when the
      // browser blocks IndexedDB or another incompatible tab owns the lease.
      logClientMessage('warn', 'Firestore persistent cache is unavailable; using memory cache.', error);
      return false;
    });
    return firestorePersistencePromise;
  }

  function waitForFirebaseServices() {
    if (firebaseServicesPromise) return firebaseServicesPromise;
    // Firebase Hosting injects the app config, but it can arrive after our page scripts.
    firebaseServicesPromise = new Promise((resolve, reject) => {
      const startedAt = Date.now();

      function checkReady() {
        // Fresh machines may have no Hosting CLI credentials or cached web
        // configuration. This placeholder key is only used with local emulators.
        if (isLocalDashboard() && global.firebase &&
            Array.isArray(global.firebase.apps) && global.firebase.apps.length === 0 &&
            typeof global.firebase.initializeApp === 'function') {
          try {
            global.firebase.initializeApp({
              projectId: 'rollcall-2669b',
              apiKey: 'demo-faceroll-local-only',
              authDomain: 'localhost',
            });
          } catch (error) {
            reject(error);
            return;
          }
        }
        const firebaseReady =
          global.firebase &&
          typeof global.firebase.app === 'function' &&
          Array.isArray(global.firebase.apps) &&
          global.firebase.apps.length > 0;

        if (firebaseReady) {
          try {
            configureLocalEmulators(global.firebase);
            enableFirestorePersistence(global.firebase).then(function () {
              resolve(global.firebase);
            }, reject);
          } catch (error) {
            reject(error);
          }
          return;
        }

        if (Date.now() - startedAt >= FIREBASE_INIT_TIMEOUT_MS) {
          reject(
            new Error(
              'Firebase Hosting auto-init was not detected. Make sure this page is served with Firebase Hosting or the Firebase emulator.'
            )
          );
          return;
        }

        global.setTimeout(checkReady, 100);
      }

      checkReady();
    });
    firebaseServicesPromise.catch(function () { firebaseServicesPromise = null; });
    return firebaseServicesPromise;
  }

  async function waitForFirebase() {
    const firebase = await waitForFirebaseServices();
    return firebase.firestore();
  }

  async function waitForAuth() {
    const firebase = await waitForFirebaseServices();

    if (typeof firebase.auth !== 'function') {
      throw new Error('Firebase Auth is not available on this page.');
    }

    return firebase.auth();
  }

  async function readCollectionDocs(collectionName) {
    // One-time read used by pages that render a snapshot of Firestore data.
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const cacheKey = buildDataCacheKey(firebase, 'collection', collectionName);
    return runSharedRead(cacheKey, async function () {
      const snapshot = await getSnapshotWithCacheFallback(
        db.collection(collectionName), 'Loading ' + collectionName
      );
      return snapshotToDocs(snapshot);
    });
  }

  async function getSnapshotWithCacheFallback(reference, label) {
    try {
      const snapshot = await withDataTimeout(reference.get(), label);
      markFirestoreAvailable(snapshot);
      return snapshot;
    } catch (error) {
      markFirestoreUnavailable(error);
      try {
        return await reference.get({ source: 'cache' });
      } catch (cacheError) {
        throw error;
      }
    }
  }

  function buildCollectionQuery(db, collectionName, options) {
    const settings = options || {};
    let query = db.collection(collectionName);
    const filters = Array.isArray(settings.filters) ? settings.filters : [];

    filters.forEach(function (filter) {
      if (!filter || typeof filter.field !== 'string' || !filter.field.trim() ||
          typeof filter.operator !== 'string') {
        throw new Error('Firestore query filters require a field and operator.');
      }
      query = query.where(filter.field.trim(), filter.operator, filter.value);
    });

    if (settings.orderBy) {
      if (typeof settings.orderBy.field !== 'string' || !settings.orderBy.field.trim()) {
        throw new Error('Firestore query ordering requires a field.');
      }
      query = query.orderBy(
        settings.orderBy.field.trim(),
        settings.orderBy.direction === 'desc' ? 'desc' : 'asc'
      );
    }

    if (settings.limit !== undefined) {
      const maximum = Number(settings.limit);
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5000) {
        throw new Error('Firestore query limit must be an integer from 1 to 5000.');
      }
      query = query.limit(maximum);
    }
    return query;
  }

  async function readQueryDocs(collectionName, options) {
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const cacheKey = buildDataCacheKey(firebase, 'query', collectionName, options);
    return runSharedRead(cacheKey, async function () {
      const snapshot = await getSnapshotWithCacheFallback(
        buildCollectionQuery(db, collectionName, options), 'Loading filtered ' + collectionName
      );
      const rows = snapshotToDocs(snapshot);
      if (collectionName === 'courses') cacheCourseSummaries(getSignedInScope(firebase), rows);
      return rows;
    });
  }

  async function readDocument(collectionName, documentId) {
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const cacheKey = buildDataCacheKey(firebase, 'document', collectionName, { documentId: documentId });
    return runSharedRead(cacheKey, async function () {
      const snapshot = await getSnapshotWithCacheFallback(
        db.collection(collectionName).doc(documentId), 'Loading ' + collectionName + ' profile'
      );
      if (!snapshot.exists) return null;
      return { id: snapshot.id, ...snapshot.data() };
    });
  }

  async function readCollectionDocsSWR(collectionName, onUpdate) {
    const firebase = await waitForFirebaseServices();
    const cacheKey = buildDataCacheKey(firebase, 'collection', collectionName);
    const cached = getCachedValue(cacheKey);
    if (cached !== null && typeof onUpdate === 'function') onUpdate(cached, { source: 'cache' });
    const fresh = await readCollectionDocs(collectionName);
    if (typeof onUpdate === 'function' && (cached === null || cacheFingerprint(cached) !== cacheFingerprint(fresh))) {
      onUpdate(fresh, { source: 'firestore' });
    }
    return fresh;
  }

  async function readQueryDocsSWR(collectionName, options, onUpdate) {
    const firebase = await waitForFirebaseServices();
    const cacheKey = buildDataCacheKey(firebase, 'query', collectionName, options);
    let cached = getCachedValue(cacheKey);
    if (cached === null && collectionName === 'courses') {
      cached = readCachedCourseSummaries(getSignedInScope(firebase));
    }
    if (cached !== null && typeof onUpdate === 'function') onUpdate(cached, { source: 'cache' });
    const fresh = await readQueryDocs(collectionName, options);
    if (typeof onUpdate === 'function' && (cached === null || cacheFingerprint(cached) !== cacheFingerprint(fresh))) {
      onUpdate(fresh, { source: 'firestore' });
    }
    return fresh;
  }

  async function readDocumentSWR(collectionName, documentId, onUpdate) {
    const firebase = await waitForFirebaseServices();
    const cacheKey = buildDataCacheKey(firebase, 'document', collectionName, { documentId: documentId });
    const cached = getCachedValue(cacheKey);
    if (cached !== null && typeof onUpdate === 'function') onUpdate(cached, { source: 'cache' });
    const fresh = await readDocument(collectionName, documentId);
    if (typeof onUpdate === 'function' && (cached === null || cacheFingerprint(cached) !== cacheFingerprint(fresh))) {
      onUpdate(fresh, { source: 'firestore' });
    }
    return fresh;
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(function (value) {
      return String(value || '').trim();
    }).filter(Boolean)));
  }

  async function readQueryChunks(collectionName, field, values) {
    const normalized = uniqueStrings(values);
    if (!normalized.length) return [];
    const chunks = [];
    for (let index = 0; index < normalized.length; index += 30) {
      chunks.push(normalized.slice(index, index + 30));
    }
    const results = await Promise.all(chunks.map(function (chunk) {
      return readQueryDocs(collectionName, {
        filters: [{ field: field, operator: chunk.length === 1 ? '==' : 'in',
          value: chunk.length === 1 ? chunk[0] : chunk }],
      });
    }));
    const byId = new Map();
    results.flat().forEach(function (row) { byId.set(String(row.id), row); });
    return Array.from(byId.values());
  }

  async function readDocuments(collectionName, documentIds) {
    const normalized = uniqueStrings(documentIds);
    if (!normalized.length) return [];
    const firebase = await waitForFirebaseServices();
    const cacheKey = buildDataCacheKey(firebase, 'documents', collectionName, { documentIds: normalized.slice().sort() });
    return runSharedRead(cacheKey, async function () {
    const fieldPath = firebase.firestore && firebase.firestore.FieldPath;
    if (!fieldPath || typeof fieldPath.documentId !== 'function') {
      const rows = await Promise.all(normalized.map(function (documentId) {
        return readDocument(collectionName, documentId);
      }));
      return rows.filter(Boolean);
    }
    const db = firebase.firestore();
    const chunks = [];
    for (let index = 0; index < normalized.length; index += 30) {
      chunks.push(normalized.slice(index, index + 30));
    }
    const snapshots = await Promise.all(chunks.map(function (chunk) {
      return getSnapshotWithCacheFallback(
        db.collection(collectionName).where(fieldPath.documentId(), 'in', chunk),
        'Loading referenced ' + collectionName
      );
    }));
    return snapshots.map(snapshotToDocs).flat();
    });
  }

  function readCachedInstructorSnapshot(instructorUid) {
    if (!global.sessionStorage || !instructorUid) return null;
    try {
      const instructor = readSessionEntry(instructorCacheKey(instructorUid, 'instructor'));
      const values = {};
      ['users', 'courses', 'sessions', 'enrollments'].forEach(function (part) {
        values[part] = readSessionEntry(instructorCacheKey(instructorUid, part));
      });
      values.attendance = readCachedAttendance(instructorUid);
      if (instructor && Object.values(values).every(function (value) { return Array.isArray(value); })) {
        return { instructor: instructor, ...values };
      }

      // Migrate the previous single-payload cache once, then stop parsing it.
      const legacy = JSON.parse(global.sessionStorage.getItem(LEGACY_INSTRUCTOR_SNAPSHOT_CACHE_KEY) || 'null');
      if (!legacy || legacy.instructorUid !== String(instructorUid) || !legacy.snapshot ||
          !Number.isFinite(legacy.savedAt) || Date.now() - legacy.savedAt > INSTRUCTOR_SNAPSHOT_MAX_AGE_MS) {
        return null;
      }
      cacheInstructorSnapshot(legacy.snapshot);
      global.sessionStorage.removeItem(LEGACY_INSTRUCTOR_SNAPSHOT_CACHE_KEY);
      return readCachedInstructorSnapshot(instructorUid);
    } catch (error) {
      return null;
    }
  }

  function cacheInstructorSnapshot(snapshot) {
    if (!global.sessionStorage || !snapshot || !snapshot.instructor || !snapshot.instructor.uid) return;
    const instructorUid = String(snapshot.instructor.uid);
    rememberInstructorCacheUser(instructorUid);
    const instructor = summarizeAuthUser(snapshot.instructor) || { uid: instructorUid, email: '', displayName: '' };
    cacheAuthUserSummary(snapshot.instructor);
    writeSessionEntry(instructorCacheKey(instructorUid, 'instructor'), instructor);
    ['users', 'courses', 'sessions', 'enrollments'].forEach(function (part) {
      writeSessionEntry(instructorCacheKey(instructorUid, part), summarizeCachedRows(part, snapshot[part]));
    });
    cacheAttendanceBuckets(instructorUid, snapshot.attendance);
  }

  function clearInstructorSnapshotCache() {
    if (global.sessionStorage) {
      try {
        const users = JSON.parse(global.sessionStorage.getItem(INSTRUCTOR_CACHE_USERS_KEY) || '[]');
        (Array.isArray(users) ? users : []).forEach(function (instructorUid) {
          INSTRUCTOR_CACHE_PARTS.forEach(function (part) {
            if (part === 'attendance') clearAttendanceBuckets(instructorUid);
            else global.sessionStorage.removeItem(instructorCacheKey(instructorUid, part));
          });
        });
        global.sessionStorage.removeItem(INSTRUCTOR_CACHE_USERS_KEY);
        global.sessionStorage.removeItem(LEGACY_INSTRUCTOR_SNAPSHOT_CACHE_KEY);
        global.sessionStorage.removeItem(AUTH_USER_CACHE_KEY);
      } catch (error) {}
    }
    clearSharedDataCache();
  }

  function invalidateInstructorDataCache(collectionName, documentId) {
    clearSharedDataCache();
    if (!global.sessionStorage) return;
    const partByCollection = {
      users: 'users', courses: 'courses', sessions: 'sessions',
      attendance: 'attendance', enrollments: 'enrollments',
    };
    const part = partByCollection[collectionName];
    if (!part) return;
    try {
      const users = JSON.parse(global.sessionStorage.getItem(INSTRUCTOR_CACHE_USERS_KEY) || '[]');
      (Array.isArray(users) ? users : []).forEach(function (instructorUid) {
        if (part === 'attendance') clearAttendanceBuckets(instructorUid);
        else global.sessionStorage.removeItem(instructorCacheKey(instructorUid, part));
        if (collectionName === 'users' && String(documentId || '') === String(instructorUid)) {
          global.sessionStorage.removeItem(instructorCacheKey(instructorUid, 'profile'));
        }
      });
      global.sessionStorage.removeItem(LEGACY_INSTRUCTOR_SNAPSHOT_CACHE_KEY);
    } catch (error) {}
  }

  async function readInstructorSnapshot(options) {
    const settings = options || {};
    const instructor = await waitForAuthUser();
    if (!instructor || !instructor.uid) throw new Error('Sign in to load instructor data.');
    const requestKey = 'instructor-snapshot|' + instructor.uid + '|' + cacheFingerprint({
      includeEnrollments: settings.includeEnrollments !== false,
      includeAttendance: settings.includeAttendance !== false,
      includeUsers: settings.includeUsers !== false,
    });
    return runDeduplicatedRead(requestKey, async function () {
      const courses = await readQueryDocs('courses', {
        filters: [{ field: 'instructorId', operator: '==', value: instructor.uid }],
      });
      const courseIds = uniqueStrings(courses.map(function (course) {
        return course.courseId || course.id;
      }));
      const values = await Promise.all([
        readQueryChunks('sessions', 'courseId', courseIds),
        settings.includeEnrollments === false ? [] : readQueryChunks('enrollments', 'courseId', courseIds),
        settings.includeAttendance === false ? [] : readQueryChunks('attendance', 'courseId', courseIds),
      ]);
      const sessions = values[0];
      const enrollments = values[1];
      const attendance = values[2];
      const userIds = uniqueStrings(
        enrollments.map(function (entry) { return entry.uid || entry.userId; })
          .concat(attendance.map(function (entry) { return entry.uid || entry.userId; }))
      );
      const users = settings.includeUsers === false ? [] : await readDocuments('users', userIds);
      const snapshot = { instructor: instructor, users: users, courses: courses, sessions: sessions,
        attendance: attendance, enrollments: enrollments };
      const previous = readCachedInstructorSnapshot(instructor.uid) || {};
      cacheInstructorSnapshot({
        instructor: instructor,
        users: settings.includeUsers === false ? (previous.users || []) : users,
        courses: courses,
        sessions: sessions,
        attendance: settings.includeAttendance === false ? (previous.attendance || []) : attendance,
        enrollments: settings.includeEnrollments === false ? (previous.enrollments || []) : enrollments,
      });
      return snapshot;
    });
  }

  async function readInstructorSnapshotSWR(options, onUpdate) {
    const settings = options || {};
    const instructor = await waitForAuthUser();
    if (!instructor || !instructor.uid) throw new Error('Sign in to load instructor data.');
    const cached = readCachedInstructorSnapshot(instructor.uid);
    if (cached && typeof onUpdate === 'function') onUpdate(cached, { source: 'cache' });
    const refresh = readInstructorSnapshot(settings).then(function (fresh) {
      if (typeof onUpdate === 'function' &&
          (!cached || instructorSnapshotFingerprint(cached) !== instructorSnapshotFingerprint(fresh))) {
        onUpdate(fresh, { source: 'firestore' });
      }
      return fresh;
    });
    if (cached) {
      refresh.catch(function (error) {
        console.error('Background Firestore refresh failed:', error);
      });
      return cached;
    }
    return refresh;
  }

  function isSevenDigitStudentId(value) {
    return /^\d{7}$/.test(String(value || ''));
  }

  function generateStudentId() {
    return String(1000000 + Math.floor(Math.random() * 9000000));
  }

  async function ensureSevenDigitStudentId(userDocumentId) {
    const documentId = String(userDocumentId || '').trim();
    if (!documentId) throw new Error('A user document ID is required.');

    const db = await waitForFirebase();
    const userRef = db.collection('users').doc(documentId);

    return db.runTransaction(async function (transaction) {
      const snapshot = await transaction.get(userRef);
      if (!snapshot.exists) return null;

      const profile = snapshot.data() || {};
      const role = String(profile.role || profile.userType || '').toLowerCase();
      if (role !== 'student' && role !== 'learner') return null;
      if (isSevenDigitStudentId(profile.studentId)) return String(profile.studentId);

      const studentId = generateStudentId();
      transaction.set(userRef, { studentId: studentId }, { merge: true });
      return studentId;
    });
  }

  function snapshotToDocs(snapshot) {
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  }

  function attachSnapshotListener(reference, onNext, onError) {
    const next = function (snapshot) {
      markFirestoreAvailable(snapshot);
      onNext(snapshot);
    };
    const fail = function (error) {
      markFirestoreUnavailable(error);
      if (typeof onError === 'function') onError(error);
    };
    // The production compat SDK accepts metadata options. The shorter form
    // keeps small test doubles and older compatible SDK builds working.
    if (reference.onSnapshot.length === 1) return reference.onSnapshot(next);
    return reference.onSnapshot({ includeMetadataChanges: true }, next, fail);
  }

  async function subscribeCollectionDocs(collectionName, onNext, onError) {
    // Live listener used when a page should update as Firestore changes.
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const cacheKey = buildDataCacheKey(firebase, 'collection', collectionName);
    let lastFingerprint = null;
    const cached = getCachedValue(cacheKey);
    if (cached !== null) {
      lastFingerprint = cacheFingerprint(cached);
      onNext(cached, { source: 'cache' });
    }

    let initialTimer = typeof global.setTimeout === 'function' && typeof global.clearTimeout === 'function' ? global.setTimeout(function () {
      const error = new Error('Live ' + collectionName + ' connection timed out. Retry or reload the page.');
      markFirestoreUnavailable(error);
      if (typeof onError === 'function') onError(error);
    }, DATA_REQUEST_TIMEOUT_MS) : null;
    const unsubscribe = attachSnapshotListener(db.collection(collectionName),
      (snapshot) => {
        if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
        initialTimer = null;
        const rows = snapshotToDocs(snapshot);
        setCachedValue(cacheKey, rows);
        const fingerprint = cacheFingerprint(rows);
        if (fingerprint !== lastFingerprint) onNext(rows, { source: 'firestore' });
        lastFingerprint = fingerprint;
      },
      (error) => {
        if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
        initialTimer = null;
        if (typeof onError === 'function') {
          onError(error);
        }
      }
    );
    return function () {
      if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
      unsubscribe();
    };
  }

  async function subscribeQueryDocs(collectionName, options, onNext, onError) {
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const cacheKey = buildDataCacheKey(firebase, 'query', collectionName, options);
    let lastFingerprint = null;
    const cached = getCachedValue(cacheKey);
    if (cached !== null) {
      lastFingerprint = cacheFingerprint(cached);
      onNext(cached, { source: 'cache' });
    }
    let initialTimer = typeof global.setTimeout === 'function' && typeof global.clearTimeout === 'function' ? global.setTimeout(function () {
      const error = new Error('Live ' + collectionName + ' connection timed out. Retry or reload the page.');
      markFirestoreUnavailable(error);
      if (typeof onError === 'function') onError(error);
    }, DATA_REQUEST_TIMEOUT_MS) : null;
    const unsubscribe = attachSnapshotListener(buildCollectionQuery(db, collectionName, options),
      function (snapshot) {
        if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
        initialTimer = null;
        const rows = snapshotToDocs(snapshot);
        setCachedValue(cacheKey, rows);
        const fingerprint = cacheFingerprint(rows);
        if (fingerprint !== lastFingerprint) onNext(rows, { source: 'firestore' });
        lastFingerprint = fingerprint;
      },
      function (error) {
        if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
        initialTimer = null;
        if (typeof onError === 'function') onError(error);
      }
    );
    return function () {
      if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
      unsubscribe();
    };
  }

  async function subscribeQueryChunks(collectionName, field, values, onNext, onError) {
    const normalized = uniqueStrings(values);
    if (!normalized.length) {
      onNext([]);
      return function () {};
    }
    const chunks = [];
    for (let index = 0; index < normalized.length; index += 30) {
      chunks.push(normalized.slice(index, index + 30));
    }
    const latest = new Map();
    const ready = new Set();
    const unsubscribeHandlers = await Promise.all(chunks.map(function (chunk, index) {
      return subscribeQueryDocs(collectionName, {
        filters: [{ field: field, operator: chunk.length === 1 ? '==' : 'in',
          value: chunk.length === 1 ? chunk[0] : chunk }],
      }, function (rows) {
        latest.set(index, rows);
        ready.add(index);
        if (ready.size !== chunks.length) return;
        const byId = new Map();
        Array.from(latest.values()).flat().forEach(function (row) {
          byId.set(String(row.id), row);
        });
        onNext(Array.from(byId.values()));
      }, onError);
    }));
    return function () {
      unsubscribeHandlers.forEach(function (unsubscribe) {
        if (typeof unsubscribe === 'function') unsubscribe();
      });
    };
  }

  async function subscribeDocument(collectionName, documentId, onNext, onError) {
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const cacheKey = buildDataCacheKey(firebase, 'document', collectionName, { documentId: documentId });
    let lastFingerprint = null;
    const cached = getCachedValue(cacheKey);
    if (cached !== null) {
      lastFingerprint = cacheFingerprint(cached);
      onNext(cached, { source: 'cache', fromCache: true, hasPendingWrites: false });
    }
    let initialTimer = typeof global.setTimeout === 'function' && typeof global.clearTimeout === 'function' ? global.setTimeout(function () {
      const error = new Error('Instructor profile connection timed out. Retry or reload the page.');
      markFirestoreUnavailable(error);
      if (typeof onError === 'function') onError(error);
    }, DATA_REQUEST_TIMEOUT_MS) : null;
    const unsubscribe = attachSnapshotListener(db.collection(collectionName).doc(documentId),
      function (snapshot) {
        if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
        initialTimer = null;
        const value = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
        setCachedValue(cacheKey, value);
        const fingerprint = cacheFingerprint(value);
        if (fingerprint === lastFingerprint) {
          lastFingerprint = fingerprint;
          return;
        }
        lastFingerprint = fingerprint;
        onNext(value, {
          source: 'firestore',
          fromCache: Boolean(snapshot.metadata && snapshot.metadata.fromCache),
          hasPendingWrites: Boolean(snapshot.metadata && snapshot.metadata.hasPendingWrites),
        });
      },
      function (error) {
        if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
        initialTimer = null;
        if (typeof onError === 'function') onError(error);
      }
    );
    return function () {
      if (initialTimer && typeof global.clearTimeout === 'function') global.clearTimeout(initialTimer);
      unsubscribe();
    };
  }

  async function subscribeCollections(collectionNames, onNext, onError) {
    // Wait until every collection has returned once before rendering combined data.
    const latestByCollection = {};
    const readyCollections = new Set();
    const unsubscribeHandlers = [];

    function emitIfReady() {
      if (readyCollections.size !== collectionNames.length) {
        return;
      }

      onNext({ ...latestByCollection });
    }

    await Promise.all(
      collectionNames.map(async (collectionName) => {
        const unsubscribe = await subscribeCollectionDocs(
          collectionName,
          (docs) => {
            latestByCollection[collectionName] = docs;
            readyCollections.add(collectionName);
            emitIfReady();
          },
          onError
        );

        unsubscribeHandlers.push(unsubscribe);
      })
    );

    return function unsubscribeAll() {
      unsubscribeHandlers.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      });
    };
  }

  async function writeDocument(collectionName, documentId, data) {
    // Merge writes keep existing fields instead of replacing whole documents.
    const firebase = await waitForFirebaseServices();
    const db = firebase.firestore();
    const authUser = typeof firebase.auth === 'function' ? firebase.auth().currentUser : null;
    const existingProfile = collectionName === 'users' && authUser && String(authUser.uid) === String(documentId)
      ? readCachedUserProfile(authUser.uid) : null;
    await db.collection(collectionName).doc(documentId).set(data, { merge: true });
    invalidateInstructorDataCache(collectionName, documentId);
    if (collectionName === 'users') {
      if (authUser && String(authUser.uid) === String(documentId)) {
        cacheAuthUserSummary(authUser);
        cacheUserProfile(authUser.uid, {
          ...(existingProfile || {}), id: String(documentId), ...data,
        });
      }
    }
  }

  async function createDocumentIfAbsent(collectionName, documentId, data) {
    const db = await waitForFirebase();
    const documentRef = db.collection(collectionName).doc(documentId);
    return db.runTransaction(async (transaction) => {
      const existing = await transaction.get(documentRef);
      if (existing.exists) return false;
      transaction.set(documentRef, data);
      return true;
    }).then(function (created) {
      if (created) invalidateInstructorDataCache(collectionName, documentId);
      return created;
    });
  }

  async function deleteDocument(collectionName, documentId) {
    const db = await waitForFirebase();
    await db.collection(collectionName).doc(documentId).delete();
    invalidateInstructorDataCache(collectionName, documentId);
  }

  async function signInWithEmail(email, password) {
    const auth = await waitForAuth();
    if (typeof auth.setPersistence === 'function') await auth.setPersistence('local');
    const credential = await auth.signInWithEmailAndPassword(email, password);
    cacheAuthUserSummary(credential.user);
    return credential.user;
  }

  async function registerWithEmail(email, password) {
    const auth = await waitForAuth();
    if (typeof auth.setPersistence === 'function') await auth.setPersistence('local');
    const credential = await auth.createUserWithEmailAndPassword(email, password);
    cacheAuthUserSummary(credential.user);
    return credential.user;
  }

  async function signOutUser() {
    const auth = await waitForAuth();
    await auth.signOut();
    clearInstructorSnapshotCache();
  }

  async function sendPasswordReset(email) {
    const auth = await waitForAuth();
    await auth.sendPasswordResetEmail(email);
  }

  async function getCurrentAuthUser() {
    const auth = await waitForAuth();
    if (auth.currentUser) cacheAuthUserSummary(auth.currentUser);
    return auth.currentUser || null;
  }

  async function waitForAuthUser() {
    // Use this when a page must wait for Firebase Auth to finish loading.
    const auth = await waitForAuth();

    if (auth.currentUser) {
      cacheAuthUserSummary(auth.currentUser);
      return auth.currentUser;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = function () {};
      const timer = typeof global.setTimeout === 'function' && typeof global.clearTimeout === 'function' ? global.setTimeout(function () {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error('Sign-in restoration timed out. Check Firebase Auth and retry.'));
      }, DATA_REQUEST_TIMEOUT_MS) : null;
      unsubscribe = auth.onAuthStateChanged((user) => {
        if (settled) return;
        settled = true;
        if (timer && typeof global.clearTimeout === 'function') global.clearTimeout(timer);
        unsubscribe();
        if (user) cacheAuthUserSummary(user);
        resolve(user || null);
      });
    });
  }

  async function subscribeAuthState(onNext, onError) {
    const auth = await waitForAuth();

    return auth.onAuthStateChanged(
      (user) => {
        if (user) cacheAuthUserSummary(user);
        onNext(user || null);
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      }
    );
  }

  global.FaceRollFirebase = {
    // Shared API used by the dashboard pages.
    readCollectionDocs,
    readCollectionDocsSWR,
    readQueryDocs,
    readQueryDocsSWR,
    readDocument,
    readDocumentSWR,
    readDocuments,
    readQueryChunks,
    readInstructorSnapshot,
    readInstructorSnapshotSWR,
    readCachedInstructorSnapshot,
    readCachedAuthUserSummary,
    cacheAuthUserSummary,
    readCachedUserProfile,
    cacheUserProfile,
    readCachedCourseSummaries,
    readCachedAttendance,
    clearInstructorSnapshotCache,
    ensureSevenDigitStudentId,
    subscribeCollectionDocs,
    subscribeQueryDocs,
    subscribeQueryChunks,
    subscribeDocument,
    subscribeCollections,
    writeDocument,
    createDocumentIfAbsent,
    deleteDocument,
    signInWithEmail,
    registerWithEmail,
    signOutUser,
    sendPasswordReset,
    getCurrentAuthUser,
    waitForAuthUser,
    subscribeAuthState,
    onConnectionRestored,
  };
})(window);
