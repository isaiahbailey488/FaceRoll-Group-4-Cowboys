(function (global) {
  const FIREBASE_INIT_TIMEOUT_MS = 10000;

  function waitForFirebaseServices() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      function checkReady() {
        const firebaseReady =
          global.firebase &&
          typeof global.firebase.app === 'function' &&
          Array.isArray(global.firebase.apps) &&
          global.firebase.apps.length > 0;

        if (firebaseReady) {
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
    const db = await waitForFirebase();
    const snapshot = await db.collection(collectionName).get();

    // Return plain objects so the dashboard renderer stays independent from Firestore snapshots.
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  }

  async function writeDocument(collectionName, documentId, data) {
    const db = await waitForFirebase();
    await db.collection(collectionName).doc(documentId).set(data, { merge: true });
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

  global.FaceRollFirebase = {
    readCollectionDocs,
    writeDocument,
    signInWithEmail,
    registerWithEmail,
    sendPasswordReset,
  };
})(window);
