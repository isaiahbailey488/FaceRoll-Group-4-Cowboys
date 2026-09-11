(function (global) {
  const FIREBASE_INIT_TIMEOUT_MS = 10000;
  let localEmulatorsConfigured = false;

  function isLocalDashboard() {
    return (
      global.location &&
      (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1')
    );
  }

  function configureLocalEmulators(firebase) {
    if (!isLocalDashboard() || localEmulatorsConfigured) return;

    // Keep local dashboard testing isolated from the live Firebase project.
    const auth = firebase.auth();
    const db = firebase.firestore();
    auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    db.useEmulator('127.0.0.1', 8080);
    localEmulatorsConfigured = true;
    console.info('FaceRoll is using the local Firebase Auth and Firestore emulators.');
  }

  function waitForFirebaseServices() {
    // Firebase Hosting injects the app config, but it can arrive after our page scripts.
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      function checkReady() {
        const firebaseReady =
          global.firebase &&
          typeof global.firebase.app === 'function' &&
          Array.isArray(global.firebase.apps) &&
          global.firebase.apps.length > 0;

        if (firebaseReady) {
          configureLocalEmulators(global.firebase);
          resolve(global.firebase);
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
    const db = await waitForFirebase();
    const snapshot = await db.collection(collectionName).get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  }

  async function readDocument(collectionName, documentId) {
    const db = await waitForFirebase();
    const snapshot = await db.collection(collectionName).doc(documentId).get();

    if (!snapshot.exists) {
      return null;
    }

    return {
      id: snapshot.id,
      ...snapshot.data(),
    };
  }

  function snapshotToDocs(snapshot) {
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  }

  async function subscribeCollectionDocs(collectionName, onNext, onError) {
    // Live listener used when a page should update as Firestore changes.
    const db = await waitForFirebase();

    return db.collection(collectionName).onSnapshot(
      (snapshot) => {
        onNext(snapshotToDocs(snapshot));
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      }
    );
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
    const db = await waitForFirebase();
    await db.collection(collectionName).doc(documentId).set(data, { merge: true });
  }

  async function createDocumentIfAbsent(collectionName, documentId, data) {
    const db = await waitForFirebase();
    const documentRef = db.collection(collectionName).doc(documentId);
    return db.runTransaction(async (transaction) => {
      const existing = await transaction.get(documentRef);
      if (existing.exists) return false;
      transaction.set(documentRef, data);
      return true;
    });
  }

  async function deleteDocument(collectionName, documentId) {
    const db = await waitForFirebase();
    await db.collection(collectionName).doc(documentId).delete();
  }

  async function signInWithEmail(email, password) {
    const auth = await waitForAuth();
    const credential = await auth.signInWithEmailAndPassword(email, password);
    return credential.user;
  }

  async function registerWithEmail(email, password) {
    const auth = await waitForAuth();
    const credential = await auth.createUserWithEmailAndPassword(email, password);
    return credential.user;
  }

  async function sendPasswordReset(email) {
    const auth = await waitForAuth();
    await auth.sendPasswordResetEmail(email);
  }

  async function getCurrentAuthUser() {
    const auth = await waitForAuth();
    return auth.currentUser || null;
  }

  async function waitForAuthUser() {
    // Use this when a page must wait for Firebase Auth to finish loading.
    const auth = await waitForAuth();

    if (auth.currentUser) {
      return auth.currentUser;
    }

    return new Promise((resolve) => {
      const unsubscribe = auth.onAuthStateChanged((user) => {
        unsubscribe();
        resolve(user || null);
      });
    });
  }

  async function subscribeAuthState(onNext, onError) {
    const auth = await waitForAuth();

    return auth.onAuthStateChanged(
      (user) => {
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
    readDocument,
    subscribeCollectionDocs,
    subscribeCollections,
    writeDocument,
    createDocumentIfAbsent,
    deleteDocument,
    signInWithEmail,
    registerWithEmail,
    sendPasswordReset,
    getCurrentAuthUser,
    waitForAuthUser,
    subscribeAuthState,
  };
})(window);
