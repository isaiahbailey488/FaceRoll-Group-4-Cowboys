// Called only by the isolated integration test. No production or demo data.
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } = require('firebase/auth');
const { initializeFirestore, doc, setDoc, getDoc } = require('firebase/firestore/lite');
const [authUrl, firestoreUrl] = process.argv.slice(2);
const allowed = new Set([authUrl, firestoreUrl]);
for (const url of allowed) assert.equal(new URL(url).hostname, '127.0.0.1');
const nativeFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.ok(allowed.has(url.origin), 'SDK attempted a request outside the isolated HTTPS gateways.');
  assert.equal(url.protocol, 'https:');
  return nativeFetch(input, options);
};
(async () => {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: 'demo-faceroll-step1' });
  try {
    const auth = getAuth(app); connectAuthEmulator(auth, authUrl, { disableWarnings: true });
    const db = initializeFirestore(app, { host: new URL(firestoreUrl).host, ssl: true });
    const credential = await createUserWithEmailAndPassword(auth, `transport-${Date.now()}@example.test`, 'Synthetic-test-password-483');
    const uid = credential.user.uid;
    const reference = doc(db, 'users', uid);
    await setDoc(reference, { uid, userId: uid, role: 'student', studentId: '1234567', name: 'Synthetic transport test' });
    assert.equal((await getDoc(reference)).data().studentId, '1234567');
    await assert.rejects(getDoc(doc(db, 'users', 'unrelated-student')), { code: 'permission-denied' });
    console.log('Firebase SDK HTTPS verification passed.');
  } finally { await deleteApp(app); }
})().catch(error => { console.error('SDK transport verification failed:', error.code || error.message); process.exitCode = 1; });
