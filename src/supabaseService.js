/**
 * Supabase CRUD for the renderer process (authenticated).
 *
 * Drop-in replacement de firestoreService.js — misma API pública, de modo
 * que store.js solo cambia la línea de import. La RLS del servidor replica
 * las reglas anteriores: todo lo propio, lectura completa del socio (ghost
 * mode, pedidos compartidos) y escritura del inventario del socio (pool
 * compartido). Cualquier otra escritura cruzada la rechaza el servidor.
 *
 * Schema (migración 0016 del proyecto web)
 * ────────────────────────────────────────
 *   empresa_docs (empresa, doc, data)   doc ∈ config | inventory | clients | calc_state
 *   orders       (empresa, id, data)    el pedido completo vive en `data`
 */

import { supabase, supabaseUrl } from './supabase'

/* ── Slug helper ────────────────────────────────────────────────────────── */

export function empresaSlug(name) {
  return String(name || '3DCC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || '3dcc'
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function _json(obj) { return JSON.parse(JSON.stringify(obj)) }

/** Los tags de vista (_fromPartner/_empresaOwner/_webCodigo) no se persisten. */
function _cleanOrder(order) {
  const data = _json(order)
  delete data._fromPartner
  delete data._empresaOwner
  delete data._webCodigo
  return data
}

function _throw(error, ctx) {
  if (error) {
    const err = new Error(`[supabaseService] ${ctx}: ${error.message}`)
    err.cause = error
    throw err
  }
}

async function _upsertDoc(slug, doc, data) {
  const { error } = await supabase
    .from('empresa_docs')
    .upsert({ empresa: slug, doc, data: _json(data) ?? {} }, { onConflict: 'empresa,doc' })
  _throw(error, `guardando ${doc} de ${slug}`)
}

async function _loadDocs(slug) {
  const { data, error } = await supabase
    .from('empresa_docs')
    .select('doc, data')
    .eq('empresa', slug)
  _throw(error, `cargando docs de ${slug}`)
  const docs = {}
  for (const row of data || []) docs[row.doc] = row.data
  return docs
}

/* ── Load ───────────────────────────────────────────────────────────────── */

/**
 * Load all data for an empresa. Returns a flat object compatible with
 * the in-memory `appData` shape (idéntico a firestoreService.loadAllData).
 */
export async function loadAllData(empresaName) {
  const slug = empresaSlug(empresaName)

  const [docs, ordersRes] = await Promise.all([
    _loadDocs(slug),
    supabase.from('orders').select('id, data, quote_id, quotes ( codigo )').eq('empresa', slug),
  ])
  _throw(ordersRes.error, `cargando pedidos de ${slug}`)

  const cfg = docs.config || {}
  const inv = docs.inventory || {}
  const cl  = docs.clients || {}
  const cs  = Object.prototype.hasOwnProperty.call(docs, 'calc_state') ? docs.calc_state : null
  const orders = (ordersRes.data || []).map((r) => ({
    ...r.data,
    id: r.id,
    ...(r.quote_id ? { quote_id: r.quote_id, _webCodigo: r.quotes?.codigo || '' } : {}),
  }))

  return {
    printers: cfg.printers || null,
    filament_types: cfg.filament_types || null,
    global_config: cfg.global_config || null,
    purge_config: cfg.purge_config || null,
    filament_stock: inv.filament_stock || null,
    clients: cl.clients || [],
    calc_state: cs,
    orders,
  }
}

/* ── Save helpers (targeted writes) ─────────────────────────────────────── */

export async function saveConfig(empresaName, { printers, filament_types, global_config, purge_config }) {
  await _upsertDoc(empresaSlug(empresaName), 'config', {
    printers,
    filament_types,
    global_config,
    purge_config: purge_config || { colors: [], values: [], active_by_printer: {} },
  })
}

export async function saveInventory(empresaName, filament_stock) {
  await _upsertDoc(empresaSlug(empresaName), 'inventory', { filament_stock })
}

export async function saveCalcState(empresaName, calc_state) {
  await _upsertDoc(empresaSlug(empresaName), 'calc_state', calc_state || {})
}

export async function saveClients(empresaName, clients) {
  await _upsertDoc(empresaSlug(empresaName), 'clients', { clients })
}

export async function saveOrder(empresaName, order) {
  const slug = empresaSlug(empresaName)
  const { error } = await supabase
    .from('orders')
    .upsert({ empresa: slug, id: String(order.id), data: _cleanOrder(order) }, { onConflict: 'empresa,id' })
  _throw(error, `guardando pedido ${order.id} de ${slug}`)
}

export async function removeOrder(empresaName, orderId) {
  const slug = empresaSlug(empresaName)
  const { error } = await supabase
    .from('orders')
    .delete()
    .eq('empresa', slug)
    .eq('id', String(orderId))
  _throw(error, `eliminando pedido ${orderId} de ${slug}`)
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
 * Load the partner company's inventory + filament_types + printers so shared
 * orders can consume material from either side and print on either side's
 * machines.
 */
export async function loadPartnerInventory(currentEmpresa) {
  const partner = PARTNER[currentEmpresa]
  if (!partner) return { filament_stock: [], filament_types: [], printers: [], partner: null }
  const docs = await _loadDocs(empresaSlug(partner))
  const inv = docs.inventory || {}
  const cfg = docs.config || {}
  return {
    filament_stock: inv.filament_stock || [],
    filament_types: cfg.filament_types || [],
    printers: cfg.printers || [],
    partner,
  }
}

/**
 * Save the partner company's inventory after consuming shared material.
 * UPDATE (no upsert): la RLS solo permite modificar el doc inventory
 * existente del socio, no crear filas a su nombre.
 */
export async function savePartnerInventory(currentEmpresa, filament_stock) {
  const partner = PARTNER[currentEmpresa]
  if (!partner) return
  const { data, error } = await supabase
    .from('empresa_docs')
    .update({ data: _json({ filament_stock }) })
    .eq('empresa', empresaSlug(partner))
    .eq('doc', 'inventory')
    .select('doc')
  _throw(error, `guardando inventario del socio ${partner}`)
  if (!data || data.length === 0) {
    console.warn(`[supabaseService] savePartnerInventory: el doc inventory de ${partner} no existe aún.`)
  }
}

/* ── Presupuestos web (bandeja 3DCC, fase 2) ────────────────────────────── */

/**
 * Solicitudes activas del tasador web sin pedido enlazado todavía.
 * RLS: solo visible para usuarios de 3DCC (migración 0017).
 */
export async function loadWebQuotes() {
  const [quotesRes, linksRes] = await Promise.all([
    supabase
      .from('quotes')
      .select('id, codigo, estado, nombre, email, telefono, material, colores, cantidad, entrega, archivos, metricas, precio_total, precio_final, valido_hasta, created_at')
      .in('estado', ['nuevo', 'revisado', 'aceptado'])
      .eq('archivado', false)
      .order('created_at', { ascending: false }),
    supabase.from('orders').select('quote_id').not('quote_id', 'is', null),
  ])
  _throw(quotesRes.error, 'cargando presupuestos web')
  _throw(linksRes.error, 'cargando enlaces pedido-presupuesto')
  const linked = new Set((linksRes.data || []).map((r) => r.quote_id))
  return (quotesRes.data || []).filter((q) => !linked.has(q.id))
}

/**
 * URL de un archivo de la solicitud (edge function quote-file): sirve el
 * modelo descomprimido, apto para descargar o pasar a los deep links
 * orcaslicer:// y bambustudio://.
 */
export function quoteFileUrl(file, { download = false } = {}) {
  const path = String(file?.path || '')
  if (!path) return ''
  const params = new URLSearchParams({ path })
  const name = String(file?.nombre || '').trim()
  if (name) params.set('name', name)
  if (download) params.set('dl', '1')
  return `${supabaseUrl}/functions/v1/quote-file?${params.toString()}`
}

/**
 * Marca una solicitud web como rechazada (RPC calc_reject_quote, solo 3DCC).
 */
export async function rejectWebQuote(quoteId) {
  const { data, error } = await supabase.rpc('calc_reject_quote', { p_quote_id: quoteId })
  _throw(error, 'rechazando solicitud web')
  const row = Array.isArray(data) ? data[0] : data
  return { ok: !!row?.ok, estado: row?.estado || null }
}

/**
 * Avisa al cliente por email con la plantilla web del estado actual de su
 * quote (edge function notify-quote). Funciona en escritorio y móvil.
 */
export async function notifyWebQuote(quoteId) {
  const { data, error } = await supabase.functions.invoke('notify-quote', {
    body: { quote_id: quoteId },
  })
  if (error) {
    let detail = error.message
    try {
      const j = await error.context?.json?.()
      if (j?.error) detail = j.error
    } catch { /* sin detalle */ }
    return { ok: false, error: detail }
  }
  return { ok: true, ...(data || {}) }
}

/**
 * Enlaza un pedido con una solicitud web. A partir de aquí el trigger
 * project_order_to_quote mantiene la quote sincronizada con el pedido.
 * saveOrder nunca toca la columna quote_id, así que el enlace persiste.
 */
export async function linkOrderToQuote(empresaName, orderId, quoteId) {
  const { error } = await supabase
    .from('orders')
    .update({ quote_id: quoteId })
    .eq('empresa', empresaSlug(empresaName))
    .eq('id', String(orderId))
  _throw(error, `enlazando pedido ${orderId} con presupuesto web`)
}

/**
 * Load shared orders from the partner empresa.
 * Only returns orders where is_shared === true (y no archivados).
 * These are tagged with _fromPartner: true and _empresaOwner: partnerName.
 */
export async function loadPartnerSharedOrders(currentEmpresa) {
  const partner = PARTNER[currentEmpresa]
  if (!partner) return []
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id, data')
      .eq('empresa', empresaSlug(partner))
      .eq('is_shared', true)
      .eq('archived', false)
    if (error) throw error
    return (data || []).map((r) => ({ ...r.data, id: r.id, _fromPartner: true, _empresaOwner: partner }))
  } catch (e) {
    console.warn('[supabaseService] Could not load partner shared orders:', e.message)
    return []
  }
}
