(function (global) {
  const FIREBASE_INIT_TIMEOUT_MS = 10000;

  function waitForFirebase() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      function checkReady() {
        const firebaseReady =
          global.firebase &&
          typeof global.firebase.app === 'function' &&
          Array.isArray(global.firebase.apps) &&
          global.firebase.apps.length > 0;

        if (firebaseReady) {
          resolve(global.firebase.firestore());
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

  global.FaceRollFirebase = {
    readCollectionDocs,
    writeDocument,
  };
})(window);
