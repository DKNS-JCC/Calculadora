/**
 * Supabase Auth helpers for the renderer process.
 *
 * Drop-in replacement de firebase.js: mismas exports y mismas formas de
 * retorno ({ uid, email }), de modo que store.js y Login.vue no cambian
 * de lógica. La sesión persiste en localStorage (renderer de Electron y
 * webview de Capacitor), igual que hacía browserLocalPersistence.
 *
 * Diferencia deliberada con firebase.js: la empresa NO la elige el usuario
 * al hacer login — se deriva de la tabla `empresa_users` (sembrada a mano
 * en Supabase). saveUserEmpresa() pasa a ser un validador.
 */

import { createClient } from '@supabase/supabase-js'

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

/**
 * Traduce errores de Supabase a los códigos estilo Firebase que Login.vue
 * ya sabe convertir en mensajes amables.
 */
function toAuthError(error) {
  const err = new Error(error?.message || 'Error desconocido.')
  const msg = String(error?.message || '').toLowerCase()
  const status = Number(error?.status || 0)
  if (msg.includes('invalid login credentials')) err.code = 'auth/invalid-credential'
  else if (msg.includes('invalid email') || msg.includes('validate email')) err.code = 'auth/invalid-email'
  else if (status === 429 || msg.includes('rate limit')) err.code = 'auth/too-many-requests'
  else if (msg.includes('fetch') || msg.includes('network')) err.code = 'auth/network-request-failed'
  else err.code = error?.code || 'auth/unknown'
  return err
}

export async function loginWithEmail(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw toAuthError(error)
  return { uid: data.user.id, email: data.user.email }
}

export async function logout() {
  await supabase.auth.signOut()
}

/**
 * Listen for auth state changes. Returns the unsubscribe function.
 * supabase-js emite INITIAL_SESSION al suscribirse, así que el callback
 * se dispara al menos una vez (igual que onAuthStateChanged).
 */
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    const u = session?.user
    callback(u ? { uid: u.id, email: u.email } : null)
  })
  return () => data.subscription.unsubscribe()
}

/* ── User → Empresa mapping (tabla empresa_users) ────────────────────────── */

/**
 * Get the empresa associated with a user UID.
 * Returns the empresa display name (e.g. '3DCC') or null.
 */
export async function getUserEmpresa(uid) {
  const { data, error } = await supabase
    .from('empresa_users')
    .select('empresa, empresas ( nombre )')
    .eq('user_id', uid)
    .maybeSingle()
  if (error) {
    console.error('[supabase] getUserEmpresa:', error.message)
    return null
  }
  return data?.empresas?.nombre || null
}

/**
 * Antes (Firebase): guardaba el mapeo usuario→empresa que eligiera el user.
 * Ahora: valida que la empresa seleccionada en el login coincide con la
 * asignada en `empresa_users`. Lanza error si no hay mapeo o no coincide.
 */
export async function saveUserEmpresa(uid, empresa, _email) {
  const asignada = await getUserEmpresa(uid)
  if (!asignada) {
    const err = new Error('Esta cuenta no tiene empresa asignada. Contacta con el administrador.')
    err.code = 'auth/no-empresa'
    throw err
  }
  if (empresa && empresa !== asignada) {
    const err = new Error(`Esta cuenta pertenece a ${asignada}. Selecciona esa empresa.`)
    err.code = 'auth/empresa-mismatch'
    throw err
  }
}
