/**
 * Firestore service — data for each empresa is split across subdocuments
 * and a subcollection instead of one monolithic document.
 *
 * Schema
 * ──────
 *   empresas/{slug}/data/config      → { printers, filament_types, global_config }
 *   empresas/{slug}/data/inventory   → { filament_stock }
 *   empresas/{slug}/data/calc_state  → { …calculator form state }
 *   empresas/{slug}/orders/{id}      → one document per order
 *
 * On first load the module checks for legacy single-document format
 * (`empresas/{slug}`) and migrates automatically.
 */

const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  getDocs,
  deleteDoc,
  collection,
} = require('firebase/firestore');

// Firebase config is read from environment variables. To use this module from
// the Electron main process, ensure the env vars are loaded (e.g. via dotenv).
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

let db = null;

/** Initialise the Firebase app & return the Firestore instance. */
function initFirestore() {
  if (db) return db;
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  return db;
}

/**
 * Sanitise an empresa name into a valid Firestore document ID.
 * E.g. "3DCC" → "3dcc", "Mi Empresa!" → "mi_empresa_"
 */
function empresaSlug(name) {
  return String(name || '3DCC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || '3dcc';
}

/* ── Document references ────────────────────────────────────────────────── */

function _ensure() { if (!db) initFirestore(); }

function configRef(slug)             { return doc(db, 'empresas', slug, 'data', 'config'); }
function inventoryRef(slug)          { return doc(db, 'empresas', slug, 'data', 'inventory'); }
function calcStateRef(slug)          { return doc(db, 'empresas', slug, 'data', 'calc_state'); }
function orderRef(slug, orderId)     { return doc(db, 'empresas', slug, 'orders', orderId); }
function ordersCol(slug)             { return collection(db, 'empresas', slug, 'orders'); }
function legacyRef(slug)             { return doc(db, 'empresas', slug); }

/* ── Load helpers ───────────────────────────────────────────────────────── */

async function loadConfig(empresaName) {
  _ensure();
  const snap = await getDoc(configRef(empresaSlug(empresaName)));
  return snap.exists() ? snap.data() : null;
}

async function loadInventory(empresaName) {
  _ensure();
  const snap = await getDoc(inventoryRef(empresaSlug(empresaName)));
  return snap.exists() ? snap.data() : null;
}

async function loadCalcState(empresaName) {
  _ensure();
  const snap = await getDoc(calcStateRef(empresaSlug(empresaName)));
  return snap.exists() ? snap.data() : null;
}

async function loadOrders(empresaName) {
  _ensure();
  const snap = await getDocs(ordersCol(empresaSlug(empresaName)));
  const orders = [];
  snap.forEach((d) => orders.push({ id: d.id, ...d.data() }));
  return orders;
}

/**
 * Load all data for an empresa. Returns a flat object compatible with
 * the in-memory `cachedData` shape used by main.js / backend.js.
 *
 * If no data exists in the new structure, checks for legacy format and
 * migrates automatically.
 */
async function loadAllData(empresaName) {
  _ensure();
  const slug = empresaSlug(empresaName);

  // Parallel fetch of all subdocuments + orders subcollection
  const [cfgSnap, invSnap, csSnap, ordSnap] = await Promise.all([
    getDoc(configRef(slug)),
    getDoc(inventoryRef(slug)),
    getDoc(calcStateRef(slug)),
    getDocs(ordersCol(slug)),
  ]);

  const hasNewData = cfgSnap.exists() || invSnap.exists() || csSnap.exists() || ordSnap.size > 0;

  if (hasNewData) {
    const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
    const inv = invSnap.exists() ? invSnap.data() : {};
    const cs  = csSnap.exists()  ? csSnap.data()  : null;
    const orders = [];
    ordSnap.forEach((d) => orders.push({ id: d.id, ...d.data() }));

    return {
      printers: cfg.printers || null,
      filament_types: cfg.filament_types || null,
      global_config: cfg.global_config || null,
      filament_stock: inv.filament_stock || null,
      calc_state: cs,
      orders,
    };
  }

  // ── Legacy migration: check for old single-document format ──────────
  const legSnap = await getDoc(legacyRef(slug));
  if (legSnap.exists()) {
    const legacy = legSnap.data();
    console.log(`[firestore] Migrating legacy document for "${empresaName}" to new schema…`);

    // Write into new structure
    await saveAllData(empresaName, {
      printers: legacy.printers,
      filament_types: legacy.filament_types,
      global_config: legacy.global_config,
      filament_stock: legacy.filament_stock,
      calc_state: legacy.calc_state,
      orders: legacy.orders || [],
    });

    // Delete old document to avoid confusion
    await deleteDoc(legacyRef(slug));
    console.log(`[firestore] Migration complete for "${empresaName}".`);

    return {
      printers: legacy.printers || null,
      filament_types: legacy.filament_types || null,
      global_config: legacy.global_config || null,
      filament_stock: legacy.filament_stock || null,
      calc_state: legacy.calc_state || null,
      orders: legacy.orders || [],
    };
  }

  // Nothing exists — return empty shell (will be filled with defaults)
  return { printers: null, filament_types: null, global_config: null, filament_stock: null, calc_state: null, orders: [] };
}

/* ── Save helpers (targeted writes) ─────────────────────────────────────── */

function _json(obj) { return JSON.parse(JSON.stringify(obj)); }

async function saveConfig(empresaName, { printers, filament_types, global_config }) {
  _ensure();
  await setDoc(configRef(empresaSlug(empresaName)), _json({ printers, filament_types, global_config }));
}

async function saveInventory(empresaName, filament_stock) {
  _ensure();
  await setDoc(inventoryRef(empresaSlug(empresaName)), _json({ filament_stock }));
}

async function saveCalcState(empresaName, calc_state) {
  _ensure();
  await setDoc(calcStateRef(empresaSlug(empresaName)), _json(calc_state));
}

async function saveOrder(empresaName, order) {
  _ensure();
  await setDoc(orderRef(empresaSlug(empresaName), order.id), _json(order));
}

async function removeOrder(empresaName, orderId) {
  _ensure();
  await deleteDoc(orderRef(empresaSlug(empresaName), orderId));
}

/**
 * Bulk save — used for migration and initial empresa creation.
 * Writes config, inventory, calc_state, and all orders in parallel.
 */
async function saveAllData(empresaName, data) {
  _ensure();
  const promises = [
    saveConfig(empresaName, {
      printers: data.printers,
      filament_types: data.filament_types,
      global_config: data.global_config,
    }),
    saveInventory(empresaName, data.filament_stock),
    saveCalcState(empresaName, data.calc_state),
  ];
  for (const order of (data.orders || [])) {
    promises.push(saveOrder(empresaName, order));
  }
  await Promise.all(promises);
}

module.exports = {
  initFirestore,
  empresaSlug,
  loadAllData,
  loadConfig,
  loadInventory,
  loadCalcState,
  loadOrders,
  saveConfig,
  saveInventory,
  saveCalcState,
  saveOrder,
  removeOrder,
  saveAllData,
};
