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
 *
 * Sincronización con la web (migraciones 0026-0028)
 * ─────────────────────────────────────────────────
 *   · Cada pedido de 3DCC tiene su quote (el registro que ve el cliente) y
 *     cada solicitud del tasador llega ya como pedido en 'Nuevo'.
 *   · El estado viaja en los dos sentidos; si guardas una copia vieja de un
 *     pedido, el servidor conserva el estado más reciente.
 *   · El dinero sale del libro `cobros`: importe_pagado, payment_status y
 *     payment_history los recalcula el servidor en cada guardado. Por eso
 *     saveOrder devuelve el pedido tal y como quedó allí.
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
  // El enlace vive en la columna orders.quote_id, no en el JSON.
  delete data.quote_id
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
  const orders = (ordersRes.data || []).map(_rowToOrder)

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

/** Fila de orders → pedido en memoria (mismos tags que loadAllData). */
function _rowToOrder(r) {
  return {
    ...r.data,
    id: r.id,
    ...(r.quote_id ? { quote_id: r.quote_id, _webCodigo: r.quotes?.codigo || '' } : {}),
  }
}

/**
 * Guarda el pedido y devuelve cómo quedó en el servidor: los triggers pueden
 * haber recalculado el dinero (libro de cobros), conservado un estado más
 * reciente puesto desde la web o creado su quote.
 */
export async function saveOrder(empresaName, order) {
  const slug = empresaSlug(empresaName)
  const { data, error } = await supabase
    .from('orders')
    .upsert({ empresa: slug, id: String(order.id), data: _cleanOrder(order) }, { onConflict: 'empresa,id' })
    .select('id, data, quote_id, quotes ( codigo )')
    .maybeSingle()
  _throw(error, `guardando pedido ${order.id} de ${slug}`)
  return data ? _rowToOrder(data) : null
}

/** Relee un pedido del servidor. */
export async function loadOrder(empresaName, orderId) {
  const slug = empresaSlug(empresaName)
  const { data, error } = await supabase
    .from('orders')
    .select('id, data, quote_id, quotes ( codigo )')
    .eq('empresa', slug)
    .eq('id', String(orderId))
    .maybeSingle()
  _throw(error, `cargando pedido ${orderId} de ${slug}`)
  return data ? _rowToOrder(data) : null
}

/* ── Libro de cobros (migración 0028) ───────────────────────────────────── */

/**
 * Anula un cobro. `paymentId` es el id que ve la app en payment_history (el
 * del apunte original o el del libro). Quitarlo del JSON no basta: el
 * servidor no borra cobros por una copia del pedido que no los trae.
 */
export async function anularCobro(empresaName, orderId, paymentId, motivo = '') {
  const { data, error } = await supabase.rpc('anular_cobro', {
    p_empresa: empresaSlug(empresaName),
    p_order_id: String(orderId),
    p_payment_id: String(paymentId),
    p_motivo: motivo,
  })
  _throw(error, 'anulando cobro')
  return !!data
}

/**
 * Justificante PDF de un cobro (Edge Function recibo-emitir), el mismo que
 * emite la web. Opcional.
 */
export async function emitirJustificante(cobroId, { enviarEmail = false, concepto = '' } = {}) {
  const { data, error } = await supabase.functions.invoke('recibo-emitir', {
    body: { action: 'emitir', cobro_id: cobroId, enviar_email: enviarEmail, concepto },
  })
  if (error) return { ok: false, error: await _detalle(error) }
  if (data?.error) return { ok: false, error: data.error }
  return { ok: true, ...(data || {}) }
}

async function _detalle(error) {
  try {
    const j = await error.context?.json?.()
    if (j?.error) return j.error
  } catch { /* sin detalle */ }
  return error.message
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

/* ── Solicitudes web (bandeja 3DCC) ─────────────────────────────────────── */

/**
 * Datos de las quotes de unos pedidos (archivos, mensaje, entrega…) para la
 * bandeja de solicitudes. Los pedidos en sí ya están en appData: Supabase
 * los crea al llegar la solicitud (0027).
 * RLS: solo visible para usuarios de 3DCC (migración 0017).
 */
export async function loadQuotesByIds(ids) {
  const lista = [...new Set((ids || []).filter(Boolean))]
  if (!lista.length) return []
  const { data, error } = await supabase
    .from('quotes')
    .select('id, codigo, estado, nombre, email, telefono, mensaje, material, colores, cantidad, entrega, direccion, archivos, metricas, precio_total, precio_final, valido_hasta, created_at')
    .in('id', lista)
  _throw(error, 'cargando solicitudes web')
  return data || []
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
 * pedido (edge function notify-quote). Es el canal de correo de 3DCC en
 * escritorio y móvil: mismas plantillas y remitente que la web, sin
 * contraseñas en la app. `adjunto` = { filename, base64 } (PDF, opcional).
 */
export async function notifyOrder(empresaName, orderId, adjunto = null) {
  return _invokeNotify({
    empresa: empresaSlug(empresaName),
    order_id: String(orderId),
    ...(adjunto ? { adjunto } : {}),
  })
}

export async function notifyWebQuote(quoteId) {
  return _invokeNotify({ quote_id: quoteId })
}

async function _invokeNotify(body) {
  const { data, error } = await supabase.functions.invoke('notify-quote', { body })
  if (error) return { ok: false, error: await _detalle(error) }
  return { ok: true, ...(data || {}) }
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
