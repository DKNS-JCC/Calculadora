/**
 * Firestore CRUD for the renderer process (authenticated).
 *
 * Uses the `db` instance from firebase.js which is already signed in via
 * Firebase Auth, so all operations satisfy `request.auth != null` rules.
 *
 * Schema
 * ──────
 *   empresas/{slug}/data/config      → { printers, filament_types, global_config }
 *   empresas/{slug}/data/inventory   → { filament_stock }
 *   empresas/{slug}/data/calc_state  → { …calculator form state }
 *   empresas/{slug}/orders/{id}      → one document per order
 */

import { db } from './firebase'
import {
  doc,
  getDoc,
  setDoc,
  getDocs,
  deleteDoc,
  collection,
  query,
  where,
} from 'firebase/firestore'

/* ── Slug helper ────────────────────────────────────────────────────────── */

export function empresaSlug(name) {
  return String(name || '3DCC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || '3dcc'
}

/* ── Document references ────────────────────────────────────────────────── */

function configRef(slug)          { return doc(db, 'empresas', slug, 'data', 'config') }
function inventoryRef(slug)       { return doc(db, 'empresas', slug, 'data', 'inventory') }
function calcStateRef(slug)       { return doc(db, 'empresas', slug, 'data', 'calc_state') }
function orderRef(slug, orderId)  { return doc(db, 'empresas', slug, 'orders', orderId) }
function ordersCol(slug)          { return collection(db, 'empresas', slug, 'orders') }
function legacyRef(slug)          { return doc(db, 'empresas', slug) }

/* ── Load ───────────────────────────────────────────────────────────────── */

/**
 * Load all data for an empresa.  Returns a flat object compatible with
 * the in-memory `appData` shape.
 *
 * If no data exists in the new structure, checks for legacy single-document
 * format (`empresas/{slug}`) and migrates automatically.
 */
export async function loadAllData(empresaName) {
  const slug = empresaSlug(empresaName)

  const [cfgSnap, invSnap, csSnap, ordSnap] = await Promise.all([
    getDoc(configRef(slug)),
    getDoc(inventoryRef(slug)),
    getDoc(calcStateRef(slug)),
    getDocs(ordersCol(slug)),
  ])

  const hasNewData = cfgSnap.exists() || invSnap.exists() || csSnap.exists() || ordSnap.size > 0

  if (hasNewData) {
    const cfg = cfgSnap.exists() ? cfgSnap.data() : {}
    const inv = invSnap.exists() ? invSnap.data() : {}
    const cs  = csSnap.exists()  ? csSnap.data()  : null
    const orders = []
    ordSnap.forEach((d) => orders.push({ id: d.id, ...d.data() }))

    return {
      printers: cfg.printers || null,
      filament_types: cfg.filament_types || null,
      global_config: cfg.global_config || null,
      purge_config: cfg.purge_config || null,
      filament_stock: inv.filament_stock || null,
      calc_state: cs,
      orders,
    }
  }

  // ── Legacy migration ─────────────────────────────────────────────────
  const legSnap = await getDoc(legacyRef(slug))
  if (legSnap.exists()) {
    const legacy = legSnap.data()
    console.log(`[firestoreService] Migrating legacy doc for "${empresaName}"…`)

    await saveAllData(empresaName, {
      printers: legacy.printers,
      filament_types: legacy.filament_types,
      global_config: legacy.global_config,
      filament_stock: legacy.filament_stock,
      calc_state: legacy.calc_state,
      orders: legacy.orders || [],
    })
    await deleteDoc(legacyRef(slug))
    console.log(`[firestoreService] Migration complete for "${empresaName}".`)

    return {
      printers: legacy.printers || null,
      filament_types: legacy.filament_types || null,
      global_config: legacy.global_config || null,
      purge_config: legacy.purge_config || null,
      filament_stock: legacy.filament_stock || null,
      calc_state: legacy.calc_state || null,
      orders: legacy.orders || [],
    }
  }

  return { printers: null, filament_types: null, global_config: null, filament_stock: null, calc_state: null, orders: [] }
}

/* ── Save helpers (targeted writes) ─────────────────────────────────────── */

function _json(obj) { return JSON.parse(JSON.stringify(obj)) }

export async function saveConfig(empresaName, { printers, filament_types, global_config, purge_config }) {
  await setDoc(configRef(empresaSlug(empresaName)), _json({ printers, filament_types, global_config, purge_config: purge_config || { colors: [], values: [] } }))
}

export async function saveInventory(empresaName, filament_stock) {
  await setDoc(inventoryRef(empresaSlug(empresaName)), _json({ filament_stock }))
}

export async function saveCalcState(empresaName, calc_state) {
  await setDoc(calcStateRef(empresaSlug(empresaName)), _json(calc_state))
}

export async function saveOrder(empresaName, order) {
  await setDoc(orderRef(empresaSlug(empresaName), order.id), _json(order))
}

export async function removeOrder(empresaName, orderId) {
  await deleteDoc(orderRef(empresaSlug(empresaName), orderId))
}

/**
 * Bulk save — used for migration and initial empresa creation.
 */
export async function saveAllData(empresaName, data) {
  const promises = [
    saveConfig(empresaName, {
      printers: data.printers,
      filament_types: data.filament_types,
      global_config: data.global_config,
      purge_config: data.purge_config,
    }),
    saveInventory(empresaName, data.filament_stock),
    saveCalcState(empresaName, data.calc_state),
  ]
  for (const order of (data.orders || [])) {
    promises.push(saveOrder(empresaName, order))
  }
  await Promise.all(promises)
}

/* ── Partner inventory (for shared orders) ──────────────────────────────── */

const PARTNER = { '3DCC': 'SILAB3D', 'SILAB3D': '3DCC' }

/**
 * Load the partner company's inventory + filament_types so shared orders
 * can consume material from either side.
 */
export async function loadPartnerInventory(currentEmpresa) {
  const partner = PARTNER[currentEmpresa]
  if (!partner) return { filament_stock: [], filament_types: [], partner: null }
  const slug = empresaSlug(partner)
  const [invSnap, cfgSnap] = await Promise.all([
    getDoc(inventoryRef(slug)),
    getDoc(configRef(slug)),
  ])
  const inv = invSnap.exists() ? invSnap.data() : {}
  const cfg = cfgSnap.exists() ? cfgSnap.data() : {}
  return {
    filament_stock: inv.filament_stock || [],
    filament_types: cfg.filament_types || [],
    partner,
  }
}

/**
 * Save the partner company's inventory after consuming shared material.
 */
export async function savePartnerInventory(currentEmpresa, filament_stock) {
  const partner = PARTNER[currentEmpresa]
  if (!partner) return
  await saveInventory(partner, filament_stock)
}

/**
 * Load shared orders from the partner empresa's collection.
 * Only returns orders where is_shared === true.
 * These are tagged with _fromPartner: true and _empresaOwner: partnerName.
 */
export async function loadPartnerSharedOrders(currentEmpresa) {
  const partner = PARTNER[currentEmpresa]
  if (!partner) return []
  const slug = empresaSlug(partner)
  try {
    const q = query(ordersCol(slug), where('is_shared', '==', true))
    const snap = await getDocs(q)
    const orders = []
    snap.forEach((d) => {
      const data = d.data()
      if (!data.archived) orders.push({ id: d.id, ...data, _fromPartner: true, _empresaOwner: partner })
    })
    return orders
  } catch (e) {
    console.warn('[firestoreService] Could not load partner shared orders:', e.message)
    return []
  }
}
