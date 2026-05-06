/**
 * Firebase Auth + Firestore helpers for the renderer process.
 *
 * Auth persistence uses browserLocalPersistence (works in Electron's Chromium
 * renderer), so sessions survive across app restarts with zero extra writes.
 */

import { initializeApp } from 'firebase/app'
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence,
} from 'firebase/auth'
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore'
import { empresaSlug } from './firestoreService'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const firebaseApp = initializeApp(firebaseConfig, 'renderer-auth')
const auth = getAuth(firebaseApp)
const db = getFirestore(firebaseApp)

// Ensure session persists across restarts (IndexedDB in Electron renderer)
setPersistence(auth, browserLocalPersistence)

export { auth, db }

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

export async function loginWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password)
  return cred.user
}

export async function logout() {
  await signOut(auth)
}

/**
 * Listen for auth state changes. Returns the unsubscribe function.
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback)
}

/* ── User → Empresa mapping (Firestore) ──────────────────────────────────── */

/**
 * Get the empresa associated with a user UID.
 * Returns the empresa display name (e.g. '3DCC') or null.
 */
export async function getUserEmpresa(uid) {
  const ref = doc(db, 'users', uid)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    return snap.data().empresa || null
  }
  return null
}

/**
 * Save the empresa association for a user.
 * Stores both the display name (`empresa`) and the Firestore-safe slug
 * (`empresaSlug`) so security rules can verify ownership without JS logic.
 * Reads first to skip the write if the value is unchanged.
 */
export async function saveUserEmpresa(uid, empresa, email) {
  const slug = empresaSlug(empresa)
  const ref = doc(db, 'users', uid)
  const snap = await getDoc(ref)
  if (snap.exists() && snap.data().empresa === empresa && snap.data().empresaSlug === slug) return

  await setDoc(ref, { empresa, empresaSlug: slug, email, updatedAt: Date.now() }, { merge: true })
}
