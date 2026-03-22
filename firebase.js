import { initializeApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore'

export const firebaseConfig = {
  apiKey: 'AIzaSyD7u4KYyuw783lBOUQX0wkZHMtVR1zRbhw',
  authDomain: 'hcpcalc.firebaseapp.com',
  projectId: 'hcpcalc',
  storageBucket: 'hcpcalc.firebasestorage.app',
  messagingSenderId: '115240944084',
  appId: '1:115240944084:web:33b9b5785179cecf729641',
  measurementId: 'G-CN3M2DB1C7',
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)
const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

export function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider)
}

export function signOutUser() {
  return signOut(auth)
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback)
}

export async function getUserState(uid) {
  const ref = doc(db, 'users', uid)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) return null
  const payload = snapshot.data()
  return payload?.data && typeof payload.data === 'object' ? payload.data : {}
}

export async function saveUserState(uid, data) {
  const ref = doc(db, 'users', uid)
  await setDoc(ref, {
    data,
    updatedAt: serverTimestamp(),
  }, { merge: true })
}
