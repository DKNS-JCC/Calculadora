/**
 * Shared business logic — ÚNICA FUENTE DE VERDAD.
 *
 * Este módulo corre tanto en el proceso main de Electron (PC) como en el
 * navegador (Capacitor/Web). Solo computación pura: sin fs, path, PDFKit
 * ni Stripe. La parte Stripe (requiere Node) vive en electron-main/backend.js,
 * que reexporta este módulo y añade generateStripePaymentLink.
 *
 * ⚠️ No dupliques lógica de negocio en electron-main: cualquier cambio aquí
 * aplica automáticamente a PC y móvil.
 */

import { formatHoras } from './formatos.mjs'

// Fecha local en YYYY-MM-DD: toISOString() da la de UTC (de 00:00 a 02:00 en España, el día anterior)
const hoyLocalISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ── Lookup tables ─────────────────────────────────────────────────────── */

/* Tarifas de mano de obra ─ expresadas en MINUTOS y valoradas a
 * su coste/hora. Son dos costes distintos, porque diseñar y lijar no valen lo
 * mismo por hora y, colgando del mismo número, no se podía subir uno sin subir
 * el otro: DISEÑO usa global_config.labor_cost_h y POST-PROCESADO usa
 * global_config.postproc_cost_h. Con ambos a 15 €/h sale el tarifario base:
 *
 *   DISEÑO           No necesario 0,00 · Básica 2,25 · Búsqueda 3,75
 *                    Media 7,50 · Alta 15,00 · A medida = horas × coste/h
 *   POST-PROCESADO   Limpio 0,00 · Sencillo 5,00 · Medio 10,00 · Avanzado 20,00
 *
 * El diseño se cobra una vez por pedido; el post-procesado se multiplica por
 * la cantidad de piezas, porque lijar/pintar 10 unidades cuesta 10 veces más.
 */

export const DISENO_A_MEDIDA = 'A medida (por horas)'

export const DISENO_MODELADO = {
  'No necesario': 0,
  'Básica (slicer)': 9,
  'Búsqueda de modelos': 15,
  'Media (Fusion <1h)': 30,
  'Alta (Fusion >1h / Artístico)': 60,
  [DISENO_A_MEDIDA]: 0, // se sustituye por diseno_horas × 60
}

export const POSTPROCESADO = {
  Limpio: 0,
  'Sencillo (lijado)': 20,
  'Medio (lijado + ensamblado)': 40,
  'Avanzado (+ pintura)': 80,
}

/* Descripciones largas para la interfaz (mismo orden que las tablas). */
export const DISENO_MODELADO_DESC = {
  'No necesario': 'El cliente aporta el archivo listo para imprimir',
  'Básica (slicer)': 'Solo ajustes en el laminador: escala, orientación, corte',
  'Búsqueda de modelos': 'Localizar y verificar un modelo existente en repositorios',
  'Media (Fusion <1h)': 'Modelado o edición en Fusion de menos de una hora',
  'Alta (Fusion >1h / Artístico)': 'Modelado de más de una hora, orgánico o artístico',
  [DISENO_A_MEDIDA]: 'Encargo grande: se cobran las horas reales al coste/hora',
}

export const POSTPROCESADO_DESC = {
  Limpio: 'Pocos soportes, sin lijado. Sale de la cama y se entrega',
  'Sencillo (lijado)': 'Pocos soportes con lijado de las marcas',
  'Medio (lijado + ensamblado)': 'Lijado y ensamblado, o soportes comprometidos',
  'Avanzado (+ pintura)': 'Lijado / ensamblado / soportes difíciles más pintura',
}

/* ── Compatibilidad con pedidos anteriores al tarifario ───────────────── */

/* Antes había cuatro desplegables: Diseño, Búsqueda, Soportes y Postprocesado.
 * Búsqueda se fusionó en Diseño y Soportes en Post-procesado. Estas tablas
 * solo sirven para releer pedidos guardados con las etiquetas antiguas. */

export const BUSQUEDA_MODELOS = {
  No: 0,
  'Sí': 15,
}

export const ELIMINACION_SOPORTES = {
  No: 0,
  'Pocos / Baja dificultad': 15,
  'Muchos / Elevada dificultad': 45,
}

const DISENO_LEGACY = {
  'Chorrada - En Slicer': 'Básica (slicer)',
  "Fácil - Fusión 30'": 'Media (Fusion <1h)',
  "Medio - Fusión 60'": 'Media (Fusion <1h)',
  'Avanzado - AI + Remesh': 'Alta (Fusion >1h / Artístico)',
}

const POSTPROC_LEGACY = {
  No: 'Limpio',
  'Sencillo (Lijado ligero)': 'Sencillo (lijado)',
  'Medio (Lijado + Ensamblado)': 'Medio (lijado + ensamblado)',
  'Complejo (Lijado + Pintura)': 'Avanzado (+ pintura)',
}

/* Un pedido antiguo con soportes marcados sube de tramo de post-procesado:
 * los soportes ya no son un campo aparte, forman parte del tramo. */
const SOPORTES_A_POSTPROC = {
  'Pocos / Baja dificultad': 'Sencillo (lijado)',
  'Muchos / Elevada dificultad': 'Medio (lijado + ensamblado)',
}

const POSTPROC_ORDEN = Object.keys(POSTPROCESADO)

/** Fusiona las etiquetas antiguas de soportes y post-procesado en un tramo. */
export function migratePostprocesado(postprocLabel, soportesLabel) {
  const base = POSTPROCESADO[postprocLabel] !== undefined
    ? postprocLabel
    : (POSTPROC_LEGACY[postprocLabel] || 'Limpio')
  const porSoportes = SOPORTES_A_POSTPROC[soportesLabel]
  if (!porSoportes) return base
  // Se queda el más caro de los dos: el trabajo de soportes ya está incluido.
  return POSTPROC_ORDEN.indexOf(porSoportes) > POSTPROC_ORDEN.indexOf(base) ? porSoportes : base
}

/**
 * Opciones de mano de obra listas para un desplegable, con el importe ya
 * valorado al coste/hora vigente. Única fuente de verdad para la interfaz:
 * si cambia la tabla de tarifas, los desplegables cambian solos.
 */
export function disenoCostH(gconfig) {
  return Math.max(0, Number(gconfig?.labor_cost_h) || 0)
}

/** Coste/hora del post-procesado. Si no está fijado, hereda el de diseño,
 *  de modo que una instalación anterior a los dos costes no cambia de precio. */
export function postprocCostH(gconfig) {
  const propio = Number(gconfig?.postproc_cost_h)
  return Number.isFinite(propio) && propio > 0 ? propio : disenoCostH(gconfig)
}

export function laborOptions(gconfig) {
  const build = (table, descs, costeH) => Object.entries(table).map(([value, minutes]) => ({
    value,
    label: value,
    desc: descs[value] || '',
    minutes,
    eur: (minutes / 60) * costeH,
    custom: value === DISENO_A_MEDIDA,
  }))
  return {
    diseno: build(DISENO_MODELADO, DISENO_MODELADO_DESC, disenoCostH(gconfig)),
    postproc: build(POSTPROCESADO, POSTPROCESADO_DESC, postprocCostH(gconfig)),
  }
}

/** Fusiona la antigua casilla "Búsqueda de modelos" en el tramo de diseño. */
export function migrateDiseno(disenoLabel, busquedaLabel) {
  if (DISENO_MODELADO[disenoLabel] !== undefined) {
    return disenoLabel === 'No necesario' && busquedaLabel === 'Sí'
      ? 'Búsqueda de modelos'
      : disenoLabel
  }
  const mapped = DISENO_LEGACY[disenoLabel]
  if (mapped) return mapped
  return busquedaLabel === 'Sí' ? 'Búsqueda de modelos' : 'No necesario'
}

export const PROBABILIDAD_ERROR = {
  'Exenta (0%)': 0,
  'Mínima (10%)': 0.1,
  'Baja (25%)': 0.25,
  'Media (50%)': 0.5,
  'Alta (100%)': 1,
  'Muy Alta (150%)': 1.5,
  'Crítica (200%)': 2,
}

export const MARKUP = {
  'Normal (230%)': 2.3,
}

export const URGENCIA = {
  Normal: 0,
  Urgente: 0.5,
}

/**
 * Ciclo de vida del pedido. Es el vocabulario común con la web: la tabla
 * pedido_estados de Supabase (migración 0026 del proyecto web) tiene estas
 * mismas etiquetas, en este orden, y su equivalencia en la web. Si cambias
 * esta lista, cambia también esa tabla.
 *
 * 'Nuevo' es una solicitud del tasador web que aún no tiene presupuesto
 * enviado: la crea Supabase sola al recibirla.
 */
export const ORDER_NEW = 'Nuevo'

export const ORDER_LIFECYCLE = [
  ORDER_NEW,
  'Presupuesto enviado',
  'Aceptado',
  'En producción',
  'Post-procesado',
  'Listo para entregar',
  'Entregado',
]

/**
 * Estado terminal fuera del ciclo de vida: el presupuesto se envió y el
 * cliente nunca respondió. No es un fracaso de producción, es un lead frío.
 * Se separa de ORDER_LIFECYCLE para que no aparezca como "siguiente paso"
 * ni cuente en las métricas de producción.
 */
export const ORDER_DISCARDED = 'Descartado'

/** Todos los estados seleccionables a mano en la UI. */
export const ORDER_STATUS_ALL = [...ORDER_LIFECYCLE, ORDER_DISCARDED]

/**
 * Días que un presupuesto puede quedarse en 'Presupuesto enviado' sin
 * respuesta antes de auto-descartarse.
 */
export const AUTO_DISCARD_DAYS = 15

export function normalizeEstado(value) {
  const v = String(value || '').trim()
  if (!v) return 'Presupuesto enviado'
  if (v === 'Enviado') return 'Presupuesto enviado'
  if (v === 'Rechazado' || v === 'descartado') return ORDER_DISCARDED
  return v
}

/**
 * Timestamp del último movimiento del pedido, con degradación:
 * last_status_update → created_at → fecha (YYYY-MM-DD o DD/MM/YYYY).
 * Devuelve 0 si no hay ninguna fecha utilizable.
 */
export function lastUpdateTs(o) {
  for (const c of [o?.last_status_update, o?.created_at]) {
    if (!c) continue
    const t = new Date(c).getTime()
    if (!Number.isNaN(t)) return t
  }
  const f = String(o?.fecha || '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return new Date(f + 'T00:00:00').getTime()
  const p = f.split('/')
  if (p.length === 3) {
    const t = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0])).getTime()
    if (!Number.isNaN(t)) return t
  }
  return 0
}

/**
 * ¿Es un presupuesto muerto? Lleva más de AUTO_DISCARD_DAYS en el estado
 * inicial sin respuesta del cliente.
 *
 * Se excluyen a propósito:
 *  - pedidos archivados o de la empresa socia (no son nuestros)
 *  - cualquier estado posterior a 'Presupuesto enviado' (ya hay compromiso)
 *  - los que tienen algún importe pagado (hubo adelanto: está vivo)
 */
export function isStaleQuote(o, now = Date.now()) {
  if (!o || o.archived || o._fromPartner) return false
  if (normalizeEstado(o.estado) !== 'Presupuesto enviado') return false
  if (Number(o.importe_pagado || 0) > 0) return false
  const ts = lastUpdateTs(o)
  return ts > 0 && (now - ts) > AUTO_DISCARD_DAYS * 86400000
}

/* ── Dinero real ────────────────────────────────────────────────────────
   Tres cosas que la app ya guarda pero que las métricas venían ignorando:

   1. `payment_history` es el libro de caja: cada cobro con su fecha y su
      método. `importe_pagado` sólo dice el acumulado y `payment_method`
      guarda el método del ÚLTIMO cobro, así que un pedido cobrado mitad en
      efectivo y mitad por Bizum figuraba entero como Bizum.
   2. `repeticiones_error` son reimpresiones que se pagaron de verdad: el
      coste real es el bruto tantas veces como hubo que repetir.
   3. `gasto_misc` es un desembolso que se repercute al cliente a precio de
      coste; `beneficio_neto` no lo descuenta y por eso infla el margen.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Estados con compromiso económico: el cliente ya dijo que sí. Los únicos
 * que suman en facturación. 'Nuevo' y 'Presupuesto enviado' son ofertas
 * abiertas y 'Descartado' un lead frío: ninguno de ellos es dinero.
 */
export const ORDER_COMMITTED = ORDER_LIFECYCLE.slice(ORDER_LIFECYCLE.indexOf('Aceptado'))

export function isCommitted(o) {
  return ORDER_COMMITTED.includes(normalizeEstado(o?.estado))
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

/**
 * Movimientos de caja de un pedido, con la fecha en la que entró el dinero
 * (no la del pedido). Descarta los apuntes de `recalculation`, que registran
 * cambios de precio con importe 0 y no son cobros.
 *
 * Si el historial no llega a `importe_pagado` —pedidos anteriores al libro
 * de caja— el resto se imputa a la fecha del pedido para no perder caja.
 *
 * @returns {{ts:number, amount:number, method:string}[]}
 */
export function orderCashEvents(o) {
  const events = []
  for (const p of Array.isArray(o?.payment_history) ? o.payment_history : []) {
    const amount = Number(p?.amount || 0)
    if (!amount) continue
    const ts = new Date(p?.created_at).getTime()
    events.push({
      ts: Number.isNaN(ts) ? lastUpdateTs(o) : ts,
      amount,
      method: String(p?.method || '').trim() || 'Sin registrar',
    })
  }
  const registrado = events.reduce((s, e) => s + e.amount, 0)
  const resto = round2(Number(o?.importe_pagado || 0) - registrado)
  if (resto > 0.009) {
    events.push({
      ts: lastUpdateTs(o),
      amount: resto,
      method: String(o?.payment_method || '').trim() || 'Sin registrar',
    })
  }
  return events
}

/**
 * Lo que el pedido costó de verdad: material + luz + desgaste por cada
 * pasada que hubo que imprimir, más los extras pagados de bolsillo.
 */
export function orderRealCost(o) {
  const reps = Math.max(0, Math.floor(Number(o?.repeticiones_error) || 0))
  return round2(Number(o?.coste_bruto || 0) * (1 + reps) + Number(o?.gasto_misc || 0))
}

/** Precio cobrado menos coste real. Puede ser negativo: un pedido puede salir mal. */
export function orderRealProfit(o) {
  return round2(Number(o?.precio_final || 0) - orderRealCost(o))
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

function generateId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000
}

export function roundMoney(value) {
  return Math.round(Math.max(0, Number(value || 0)) * 100) / 100
}

function roundUpToNickel(value) {
  const amount = Math.max(0, Number(value || 0))
  // Redondeo a céntimo tras el múltiplo de 0,05: evita colas de coma flotante
  return Math.round(Math.ceil((amount + Number.EPSILON) / 0.05) * 0.05 * 100) / 100
}

/* ── Default data ──────────────────────────────────────────────────────── */

export function createDefaultData() {
  return {
    printers: [
      {
        name: 'Creality K1SE Combo',
        material_diameter_mm: 1.75,
        price_eur: 738,
        depreciation_time_h: 3000,
        service_costs_life_eur: 100,
        energy_consumption_kwh: 0.15,
      },
    ],
    filament_types: [
      { name: 'PLA', price_per_kg: 20 },
      { name: 'PETG', price_per_kg: 18 },
      { name: 'PLA SILK/MARBLE', price_per_kg: 23 },
      { name: 'ASA', price_per_kg: 24 },
      { name: 'TPU', price_per_kg: 21 },
    ],
    filament_stock: [
      { material: 'PLA', color: 'Negro', used_g: 0 },
      { material: 'PLA', color: 'Blanco', used_g: 0 },
      { material: 'PETG', color: 'Transparente', used_g: 0 },
    ],
    global_config: {
      energy_cost_kwh: 0.24,
      labor_cost_h: 15,
      postproc_cost_h: 15,
      money_unit: '€',
      precio_minimo: 3,
      stripe_secret_key: '',
      stripe_success_url: 'https://example.com/pago-exitoso',
      stripe_cancel_url: 'https://example.com/pago-cancelado',
      pdf_default_path: '',
      brand_color: '#3b82f6',
      // PDF branding (client quote). Empty values fall back to the
      // per-business preset in electron-main/main.js (resolveBranding).
      pdf_show_logo: true,
      pdf_logo_path: '',
      pdf_primary_color: '',
      pdf_header_style: '',
      pdf_company_legal: '',
      pdf_tagline: '',
      pdf_contact_email: '',
      pdf_contact_phone: '',
      pdf_contact_web: '',
      pdf_contact_address: '',
      pdf_conditions: '',
      pdf_footer_note: '',
      email_enabled: false,
      email_from: '',
      email_app_password: '',
      email_sender_name: '',
      email_reply_to: '',
      email_whatsapp: '',
      email_instagram: '',
      email_website: '',
      email_footer_note: '',
    },
    calc_state: {
      empresa: '3DCC',
      cliente: '',
      descripcion: '',
      impresora: 'Creality K1SE Combo',
      filamento_tipo: 'PLA',
      filamento_color: 'Negro',
      is_multimaterial: false,
      material_breakdown: [],
      peso_g: '50',
      tiempo_h: '1',
      diseno_modelado: 'No necesario',
      diseno_horas: 0,
      deterioro_impresora: 'Autofinanciación',
      postprocesado: 'Limpio',
      probabilidad_error: 'Baja (25%)',
      markup: 'Normal (230%)',
      urgencia_nivel: 'Normal',
      gasto_misc: 0,
    },
    orders: [],
    purge_config: { colors: [], values: [], active_by_printer: {} },
  }
}

/* ── Order normalisation ───────────────────────────────────────────────── */

function normalizeDate(str) {
  if (!str) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  const parts = str.split('/')
  if (parts.length === 3) {
    const [d, m, y] = parts.map(Number)
    if (y > 1000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }
  return str
}

function paymentStatusFromOrder(order) {
  const total = roundMoney(order.precio_final || 0)
  const paid = roundMoney(order.importe_pagado || 0)
  if (paid <= 0) return 'Pendiente'
  if (paid >= total) return 'Pagado'
  return 'Parcial'
}

export function refreshOrderPaymentFields(order) {
  order.precio_final = roundMoney(order.precio_final || 0)
  order.importe_pagado = roundMoney(order.importe_pagado || 0)
  order.importe_pendiente = roundMoney(Math.max(0, order.precio_final - order.importe_pagado))
  order.payment_status = paymentStatusFromOrder(order)
  return order
}

function normalizeOrder(input) {
  const order = {
    ...input,
    id: String(input?.id || generateId()),
    created_at: String(input?.created_at || new Date().toISOString()),
    fecha: normalizeDate(String(input?.fecha || '')),
    empresa: String(input?.empresa || '3DCC'),
    cliente: String(input?.cliente || ''),
    descripcion: String(input?.descripcion || ''),
    impresora: String(input?.impresora || ''),
    filamento: String(input?.filamento || ''),
    filamento_color: String(input?.filamento_color || ''),
    peso_g: String(input?.peso_g ?? '0'),
    horas: String(input?.horas ?? '0'),
    cantidad: Math.max(1, Math.floor(Number(input?.cantidad) || 1)),
    precio_final: roundMoney(input?.precio_final || 0),
    coste_bruto: roundMoney(input?.coste_bruto || 0),
    beneficio_neto: roundMoney(input?.beneficio_neto || 0),
    markup: Number(input?.markup || 2.3),
    error_rate: Number(input?.error_rate || 0.5),
    urgencia_nivel: String(input?.urgencia_nivel || 'Normal'),
    urgencia_rate: Number(input?.urgencia_rate || 0),
    recargo_urgencia: roundMoney(input?.recargo_urgencia || 0),
    stripe_payment_url: String(input?.stripe_payment_url || ''),
    stripe_session_id: String(input?.stripe_session_id || ''),
    importe_pagado: roundMoney(input?.importe_pagado || 0),
    estado: normalizeEstado(input?.estado),
    cliente_email: String(input?.cliente_email || '').trim(),
    notif_history: Array.isArray(input?.notif_history) ? input.notif_history : [],
    is_multimaterial: !!input?.is_multimaterial,
    material_breakdown: Array.isArray(input?.material_breakdown) ? input.material_breakdown : [],
    material_contabilizado: !!input?.material_contabilizado,
    diseno_modelado: migrateDiseno(input?.diseno_modelado, input?.busqueda_modelos),
    diseno_horas: Math.max(0, Number(input?.diseno_horas) || 0),
    postprocesado_label: migratePostprocesado(input?.postprocesado_label, input?.eliminacion_soportes),
    probabilidad_error_label: String(input?.probabilidad_error_label || 'Baja'),
    markup_label: String(input?.markup_label || 'Normal (230%)'),
    is_shared: !!input?.is_shared,
    shared_split: (input?.is_shared && input?.shared_split && typeof input.shared_split === 'object')
      ? (() => { const a = Math.max(0, Math.min(100, Number(input.shared_split['3DCC'] ?? 50))); return { '3DCC': a, 'SILAB3D': 100 - a } })()
      : null,
    payment_method: String(input?.payment_method || ''),
    notes: String(input?.notes || ''),
    repeticiones_error: Math.max(0, Math.floor(Number(input?.repeticiones_error) || 0)),
    imagen_path: String(input?.imagen_path || ''),
    archived: !!input?.archived,
    gasto_misc: roundMoney(input?.gasto_misc || 0),
    accepted_at: String(input?.accepted_at || ''),
    last_status_update: String(input?.last_status_update || ''),
    notif_snooze_until: String(input?.notif_snooze_until || ''),
    payment_history: Array.isArray(input?.payment_history)
      ? input.payment_history.map((p) => ({
          id: String(p?.id || generateId()),
          created_at: String(p?.created_at || new Date().toISOString()),
          method: String(p?.method || 'Manual'),
          amount: roundMoney(p?.amount || 0),
          note: String(p?.note || ''),
          source: String(p?.source || 'manual'),
          // Apunte del libro de cobros común con la web (lo pone el servidor).
          ...(p?.cobro_id ? { cobro_id: String(p.cobro_id) } : {}),
        }))
      : [],
  }
  // Campos fusionados en el tarifario actual: ya viven dentro de los dos tramos.
  delete order.busqueda_modelos
  delete order.eliminacion_soportes
  return refreshOrderPaymentFields(order)
}

/* ── Data normalisation ────────────────────────────────────────────────── */

export function normalizeData(raw) {
  const defaults = createDefaultData()
  const data = { ...defaults, ...(raw || {}) }

  if (!Array.isArray(data.printers) || data.printers.length === 0) data.printers = defaults.printers
  if (!Array.isArray(data.filament_types) || data.filament_types.length === 0) data.filament_types = defaults.filament_types
  if (!Array.isArray(data.filament_stock) || data.filament_stock.length === 0) data.filament_stock = defaults.filament_stock
  // El inventario ya no lleva stock restante ni umbral de compra: solo cuánto
  // se ha gastado de cada color. Los campos antiguos se descartan al cargar.
  data.filament_stock = data.filament_stock.map((item) => ({
    material: String(item?.material || ''),
    color: String(item?.color || ''),
    ...(item?.color_hex ? { color_hex: String(item.color_hex) } : {}),
    // Gramos que no salen de ningún pedido: purgas, fallos, bobina estropeada.
    ajuste_g: Math.max(0, Number(item?.ajuste_g) || 0),
  }))
  if (!Array.isArray(data.orders)) data.orders = []
  data.orders = data.orders.map((order) => normalizeOrder(order))

  // Ojo con el orden: el spread mete el postproc_cost_h por defecto (15) aunque
  // la instalación tuviera otro coste/hora, lo que le cambiaría los precios sin
  // avisar. Si el campo no existía, hereda el coste de diseño ya guardado.
  const teniaPostprocCostH = Object.prototype.hasOwnProperty.call(data.global_config || {}, 'postproc_cost_h')
  const laborGuardado = Number(data.global_config?.labor_cost_h)
  data.global_config = { ...defaults.global_config, ...(data.global_config || {}) }
  if (!teniaPostprocCostH && Number.isFinite(laborGuardado) && laborGuardado > 0) {
    data.global_config.postproc_cost_h = laborGuardado
  }
  data.calc_state = { ...defaults.calc_state, ...(data.calc_state || {}) }

  if (!data.purge_config || typeof data.purge_config !== 'object') data.purge_config = { colors: [], values: [], active_by_printer: {} }
  if (!Array.isArray(data.purge_config.colors)) data.purge_config.colors = []
  if (!Array.isArray(data.purge_config.values)) data.purge_config.values = []
  if (!data.purge_config.active_by_printer || typeof data.purge_config.active_by_printer !== 'object') data.purge_config.active_by_printer = {}

  if (data.calc_state.fecha) data.calc_state.fecha = normalizeDate(data.calc_state.fecha)
  data.calc_state.empresa = data.calc_state.empresa || '3DCC'
  data.calc_state.markup = MARKUP[data.calc_state.markup] ? data.calc_state.markup : 'Normal (230%)'
  const probErrorKey = String(data.calc_state.probabilidad_error ?? '')
  data.calc_state.probabilidad_error = Object.prototype.hasOwnProperty.call(PROBABILIDAD_ERROR, probErrorKey)
    ? probErrorKey
    : 'Baja (25%)'
  data.calc_state.urgencia_nivel = URGENCIA[data.calc_state.urgencia_nivel] !== undefined
    ? data.calc_state.urgencia_nivel
    : 'Normal'

  // Tarifario actual: dos tramos. Un calc_state guardado con las etiquetas
  // antiguas se pliega aquí para que el formulario nunca abra en un valor huérfano.
  data.calc_state.diseno_modelado = migrateDiseno(data.calc_state.diseno_modelado, data.calc_state.busqueda_modelos)
  data.calc_state.postprocesado = migratePostprocesado(data.calc_state.postprocesado, data.calc_state.eliminacion_soportes)
  data.calc_state.diseno_horas = Math.max(0, Number(data.calc_state.diseno_horas) || 0)
  delete data.calc_state.busqueda_modelos
  delete data.calc_state.eliminacion_soportes

  return data
}

/* ── Cost calculation ──────────────────────────────────────────────────── */

function getDepreciationPerHour(printer) {
  const hours = Number(printer.depreciation_time_h || 0)
  if (hours <= 0) return 0
  return (Number(printer.price_eur || 0) + Number(printer.service_costs_life_eur || 0)) / hours
}

function calculateCost({ peso_g, horas, filament_price_per_kg, printer, gconfig, diseno_str, diseno_horas, postproc_str, cantidad }) {
  const costeDiseno = disenoCostH(gconfig)
  const costePostproc = postprocCostH(gconfig)
  const unidades = Math.max(1, Math.floor(Number(cantidad) || 1))

  const filamento = (peso_g * filament_price_per_kg) / 1000
  const electricidad = horas * Number(printer.energy_consumption_kwh || 0) * Number(gconfig.energy_cost_kwh || 0)
  const deterioro = horas * getDepreciationPerHour(printer)

  // Diseño: se cobra una sola vez por pedido, se impriman 1 o 50 piezas.
  const disenoMin = diseno_str === DISENO_A_MEDIDA
    ? Math.max(0, Number(diseno_horas) || 0) * 60
    : (DISENO_MODELADO[diseno_str] || 0)
  const diseno = (disenoMin / 60) * costeDiseno

  // Post-procesado: trabajo manual pieza a pieza, escala con la cantidad.
  const postproc = ((POSTPROCESADO[postproc_str] || 0) / 60) * costePostproc * unidades

  return {
    filamento: round4(filamento),
    electricidad: round4(electricidad),
    diseno_modelado: round4(diseno),
    deterioro_impresora: round4(deterioro),
    postprocesado: round4(postproc),
  }
}

function subtotalAfectableError(bd) {
  return bd.filamento + bd.electricidad + bd.deterioro_impresora
}

function subtotalNoAfectableError(bd) {
  return Number(bd.diseno_modelado || 0) + Number(bd.postprocesado || 0)
}

function subtotal(bd) {
  return subtotalAfectableError(bd) + subtotalNoAfectableError(bd)
}

function conError(bd, errorRate) {
  const bruto = subtotalAfectableError(bd)
  const resto = subtotalNoAfectableError(bd)
  return bruto * (1 + errorRate) + resto
}

function subtotalTrasMarkup(bd, errorRate, markup) {
  const bruto = subtotalAfectableError(bd)
  const resto = subtotalNoAfectableError(bd)
  return (bruto * markup) + (bruto * errorRate) + resto
}

function precioFinal(bd, errorRate, markup, precioMinimo = 3) {
  const precio = subtotalTrasMarkup(bd, errorRate, markup)
  return roundUpToNickel(Math.max(precio, precioMinimo))
}

function recargoUrgencia(bd, errorRate, markup, urgenciaRate, precioMinimo = 3) {
  const baseAntesUrgencia = subtotalTrasMarkup(bd, errorRate, markup)
  return baseAntesUrgencia * urgenciaRate
}

function precioFinalConUrgencia(bd, errorRate, markup, urgenciaRate, precioMinimo = 3) {
  const baseAntesUrgencia = subtotalTrasMarkup(bd, errorRate, markup)
  const precio = baseAntesUrgencia * (1 + urgenciaRate)
  return roundUpToNickel(Math.max(precio, precioMinimo))
}

export function costAsDict(bd) {
  return {
    Filamento: bd.filamento,
    Electricidad: bd.electricidad,
    'Deterioro imp.': bd.deterioro_impresora,
    'Diseño': bd.diseno_modelado,
    'Post-procesado': bd.postprocesado,
    ...(bd.gasto_misc > 0 ? { 'Extras / Misc.': bd.gasto_misc } : {}),
  }
}

/* ── Calc state ────────────────────────────────────────────────────────── */

export function updateCalcState(payload, info) {
  const source = payload || {}
  const state = {
    empresa: source.empresa || '3DCC',
    cliente: source.cliente || '',
    cliente_email: String(source.cliente_email || '').trim(),
    descripcion: source.descripcion || '',
    impresora: source.impresora || '',
    filamento_tipo: source.filamento_tipo || '',
    filamento_color: source.filamento_color || '',
    is_multimaterial: !!source.is_multimaterial,
    material_breakdown: Array.isArray(source.material_breakdown) ? source.material_breakdown : [],
    peso_g: String(source.peso_g ?? ''),
    tiempo_h: String(source.tiempo_h ?? ''),
    cantidad: Math.max(1, Math.floor(Number(source.cantidad) || 1)),
    diseno_modelado: migrateDiseno(source.diseno_modelado, source.busqueda_modelos),
    diseno_horas: Math.max(0, Number(source.diseno_horas) || 0),
    deterioro_impresora: source.deterioro_impresora || 'Autofinanciación',
    postprocesado: migratePostprocesado(source.postprocesado, source.eliminacion_soportes),
    probabilidad_error: source.probabilidad_error || 'Baja',
    markup: source.markup || 'Normal (230%)',
    urgencia_nivel: source.urgencia_nivel || 'Normal',
    is_shared: !!source.is_shared,
    shared_percent_3dcc: Number(source.shared_percent_3dcc ?? 50),
    shared_percent_silab3d: Number(source.shared_percent_silab3d ?? 50),
    gasto_misc: Math.max(0, Number(source.gasto_misc || 0)),
  }
  if (info) {
    state.peso_g = String(info.peso ?? state.peso_g)
    state.filamento_tipo = String(info.filamento || state.filamento_tipo)
    state.filamento_color = String(info.filamento_color || state.filamento_color || 'Negro')
  }
  return state
}

/* ── Budget calculation ────────────────────────────────────────────────── */

export function calculateBudget(data, payload) {
  const gconfig = data.global_config

  const pesoInput = Number(payload.peso_g)
  const horas = Number(payload.tiempo_h)
  if (!Number.isFinite(pesoInput) || !Number.isFinite(horas)) {
    throw new Error('Peso y horas deben ser numéricos.')
  }

  let printer = data.printers.find((p) => p.name === payload.impresora)
  // Impresoras compartidas: si no es propia, buscar entre las del socio
  // (el caller las adjunta en payload.partner_printers para pedidos compartidos)
  if (!printer && Array.isArray(payload.partner_printers)) {
    printer = payload.partner_printers.find((p) => p && p.name === payload.impresora)
  }
  if (!printer) throw new Error('Selecciona una impresora.')

  const isMulti = !!payload.is_multimaterial
  let breakdown = Array.isArray(payload.material_breakdown) ? payload.material_breakdown : []
  let peso = pesoInput
  let filamentCostOverride = null
  let filamentDisplayName = payload.filamento_tipo
  let filamentDisplayColor = payload.filamento_color || 'Negro'
  let effectivePricePerKg = 0

  if (isMulti) {
    if (breakdown.length < 2) throw new Error('En modo multicolor/multimaterial debes configurar al menos 2 líneas de mezcla.')
    let totalWeight = 0
    let totalCost = 0
    const materialsUsed = []

    for (let i = 0; i < breakdown.length; i += 1) {
      const item = breakdown[i]
      const material = String(item.material || '').trim()
      const grams = Number(item.grams)
      if (!material) throw new Error(`Línea ${i + 1}: material vacío en la mezcla.`)
      if (!Number.isFinite(grams) || grams <= 0) throw new Error(`Línea ${i + 1}: gramos inválidos en la mezcla.`)
      const filament = data.filament_types.find((f) => f.name === material)
      if (!filament) throw new Error(`Línea ${i + 1}: el material '${material}' no existe en Tipos de Material.`)
      totalWeight += grams
      totalCost += grams * Number(filament.price_per_kg || 0) / 1000
      if (!materialsUsed.includes(material)) materialsUsed.push(material)
    }

    if (totalWeight <= 0) throw new Error('La mezcla multicolor no tiene peso válido.')
    peso = Math.round(totalWeight * 100) / 100
    filamentCostOverride = round4(totalCost)
    effectivePricePerKg = (totalCost * 1000) / totalWeight
    filamentDisplayName = materialsUsed.join(' + ')
    filamentDisplayColor = 'Multicolor'
  } else {
    const filament = data.filament_types.find((f) => f.name === payload.filamento_tipo)
    if (!filament) throw new Error('Selecciona un tipo de filamento.')
    effectivePricePerKg = Number(filament.price_per_kg || 0)
    filamentDisplayName = filament.name
    filamentDisplayColor = payload.filamento_color || 'Negro'
    breakdown = []
  }

  const markup = MARKUP[payload.markup] ?? 2.3
  const payloadProbError = payload.probabilidad_error
  const payloadProbErrorKey = String(payloadProbError ?? '')
  const payloadProbErrorNum = Number(payloadProbError)
  const errorRate = Object.prototype.hasOwnProperty.call(PROBABILIDAD_ERROR, payloadProbErrorKey)
    ? Number(PROBABILIDAD_ERROR[payloadProbErrorKey])
    : (Number.isFinite(payloadProbErrorNum) ? payloadProbErrorNum : Number(PROBABILIDAD_ERROR['Baja (25%)'] || 0.25))
  const urgenciaRate = URGENCIA[payload.urgencia_nivel] ?? 0
  const cantidad = Math.max(1, Math.floor(Number(payload.cantidad) || 1))

  // Los payloads antiguos traían Búsqueda y Soportes como campos aparte;
  // se pliegan sobre los dos tramos actuales antes de valorar nada.
  const disenoLabel = migrateDiseno(payload.diseno_modelado, payload.busqueda_modelos)
  const postprocLabel = migratePostprocesado(payload.postprocesado, payload.eliminacion_soportes)
  const disenoHoras = disenoLabel === DISENO_A_MEDIDA
    ? Math.max(0, Number(payload.diseno_horas) || 0)
    : 0

  const bd = calculateCost({
    peso_g: peso, horas,
    filament_price_per_kg: effectivePricePerKg,
    printer, gconfig,
    diseno_str: disenoLabel,
    diseno_horas: disenoHoras,
    postproc_str: postprocLabel,
    cantidad,
  })

  if (filamentCostOverride !== null) bd.filamento = filamentCostOverride

  const gastoMisc = round4(Math.max(0, Number(payload.gasto_misc || 0)))
  bd.gasto_misc = gastoMisc

  const precioCalculado = subtotalTrasMarkup(bd, errorRate, markup)
  const precioCalculadoConUrgencia = precioCalculado * (1 + urgenciaRate)
  const precioBase = precioFinal(bd, errorRate, markup, Number(gconfig.precio_minimo || 3))
  const recargo = recargoUrgencia(bd, errorRate, markup, urgenciaRate, Number(gconfig.precio_minimo || 3))
  const precioSinMisc = precioFinalConUrgencia(bd, errorRate, markup, urgenciaRate, Number(gconfig.precio_minimo || 3))
  const precio = roundUpToNickel(precioSinMisc + gastoMisc)
  const precioMinAplicado = precioSinMisc > precioCalculadoConUrgencia

  const info = {
    empresa: payload.empresa,
    cliente: payload.cliente,
    cliente_email: String(payload.cliente_email || '').trim(),
    fecha: payload.fecha,
    descripcion: payload.descripcion,
    impresora: printer.name,
    filamento: filamentDisplayName,
    filamento_color: filamentDisplayColor,
    is_multimaterial: isMulti,
    material_breakdown: breakdown,
    precio_kg: effectivePricePerKg,
    peso: String(peso),
    horas: String(horas),
    unit: gconfig.money_unit,
    error_rate: errorRate,
    markup,
    urgencia_nivel: payload.urgencia_nivel,
    urgencia_rate: urgenciaRate,
    recargo_urgencia: recargo,
    gasto_misc: gastoMisc,
    con_error: conError(bd, errorRate),
    precio_base: precioBase,
    precio_final: precio,
    precio_minimo: Number(gconfig.precio_minimo || 3),
    precio_minimo_aplicado: precioMinAplicado,
    diseno: disenoLabel,
    diseno_horas: disenoHoras,
    deterioro: payload.deterioro_impresora,
    postproc: postprocLabel,
    prob_error: payload.probabilidad_error,
    markup_label: payload.markup || 'Normal (230%)',
    coste_bruto_impresion: subtotalAfectableError(bd),
    beneficio_neto: precio - subtotalAfectableError(bd),
    stripe_payment_url: '',
    stripe_session_id: '',
    importe_pagado: 0,
    cantidad,
    precio_unitario: roundMoney(precio / cantidad),
    is_shared: !!payload.is_shared,
    shared_split: payload.is_shared ? {
      '3DCC': Number(payload.shared_percent_3dcc ?? 50),
      'SILAB3D': Number(payload.shared_percent_silab3d ?? 50),
    } : null,
  }

  return { breakdown: bd, breakdownDict: costAsDict(bd), subtotal: subtotal(bd), info }
}

/* ── Order operations ──────────────────────────────────────────────────── */

export function saveOrderFromResult(data, resultInfo) {
  const info = resultInfo.info
  const order = normalizeOrder({
    id: generateId(),
    fecha: info.fecha,
    empresa: info.empresa,
    cliente: info.cliente,
    descripcion: info.descripcion,
    impresora: info.impresora,
    filamento: info.filamento,
    filamento_color: info.filamento_color || '',
    peso_g: String(info.peso),
    horas: String(info.horas),
    cantidad: Number(info.cantidad || 1),
    precio_final: Number(info.precio_final || 0),
    coste_bruto: Number(info.coste_bruto_impresion || 0),
    beneficio_neto: Number(info.beneficio_neto || 0),
    markup: Number(info.markup || 2.3),
    error_rate: Number(info.error_rate || 0.5),
    urgencia_nivel: info.urgencia_nivel || 'Normal',
    urgencia_rate: Number(info.urgencia_rate || 0),
    recargo_urgencia: Number(info.recargo_urgencia || 0),
    stripe_payment_url: info.stripe_payment_url || '',
    stripe_session_id: info.stripe_session_id || '',
    importe_pagado: roundMoney(info.importe_pagado || 0),
    estado: 'Presupuesto enviado',
    cliente_email: String(info.cliente_email || '').trim(),
    is_multimaterial: !!info.is_multimaterial,
    material_breakdown: Array.isArray(info.material_breakdown) ? info.material_breakdown : [],
    material_contabilizado: false,
    diseno_modelado: info.diseno || 'No necesario',
    diseno_horas: Number(info.diseno_horas || 0),
    postprocesado_label: info.postproc || 'Limpio',
    probabilidad_error_label: info.prob_error || 'Baja',
    markup_label: info.markup_label || 'Normal (230%)',
    is_shared: !!info.is_shared,
    shared_split: info.shared_split || null,
    gasto_misc: roundMoney(info.gasto_misc || 0),
    payment_method: '',
    notes: '',
    payment_history: [],
  })
  data.orders.push(order)
  return order
}

export function findOrder(data, orderId) {
  const idx = data.orders.findIndex((o) => o.id === orderId)
  if (idx < 0) throw new Error('Pedido no encontrado.')
  return { idx, order: data.orders[idx] }
}

/* ── Order recalculation (post-calc modification) ──────────────────────── */

export function recalculateOrder(data, params) {
  const { order } = findOrder(data, params.orderId)
  const payload = params.payload

  // Run budget calculation with new parameters
  const result = calculateBudget(data, payload)
  const info = result.info

  const oldPrice = roundMoney(order.precio_final)

  // Update identification / description fields
  order.cliente = String(payload.cliente || order.cliente)
  if (payload.cliente_email !== undefined) order.cliente_email = String(payload.cliente_email || '').trim()
  order.descripcion = String(payload.descripcion || order.descripcion)
  order.fecha = String(payload.fecha || order.fecha)

  // Update technical parameters
  order.impresora = info.impresora
  order.filamento = info.filamento
  order.filamento_color = info.filamento_color || ''
  order.peso_g = String(info.peso)
  order.horas = String(info.horas)
  order.is_multimaterial = !!info.is_multimaterial
  order.material_breakdown = Array.isArray(info.material_breakdown) ? info.material_breakdown : []
  order.cantidad = Number(info.cantidad || 1)

  // Update calculated values
  order.precio_final = roundMoney(info.precio_final)
  order.coste_bruto = roundMoney(info.coste_bruto_impresion)
  order.beneficio_neto = roundMoney(info.beneficio_neto)
  order.markup = Number(info.markup || 2.3)
  order.error_rate = Number(info.error_rate || 0.5)
  order.urgencia_nivel = info.urgencia_nivel || 'Normal'
  order.urgencia_rate = Number(info.urgencia_rate || 0)
  order.recargo_urgencia = roundMoney(info.recargo_urgencia || 0)
  order.gasto_misc = roundMoney(info.gasto_misc || 0)

  // Store cost-factor labels
  order.diseno_modelado = info.diseno || 'No necesario'
  order.diseno_horas = Number(info.diseno_horas || 0)
  order.postprocesado_label = info.postproc || 'Limpio'
  order.probabilidad_error_label = payload.probabilidad_error || 'Baja (25%)'
  order.markup_label = payload.markup || 'Normal (230%)'

  // Shared order
  order.is_shared = !!payload.is_shared
  order.shared_split = payload.is_shared ? {
    '3DCC': Number(payload.shared_percent_3dcc ?? 50),
    'SILAB3D': Number(payload.shared_percent_silab3d ?? 50),
  } : null

  // Track price change in history
  const newPrice = order.precio_final
  const delta = roundMoney(newPrice - oldPrice)
  if (delta !== 0) {
    const sign = delta > 0 ? '+' : ''
    if (!Array.isArray(order.payment_history)) order.payment_history = []
    order.payment_history.push({
      id: generateId(),
      created_at: new Date().toISOString(),
      method: 'Modificación',
      amount: 0,
      note: `Precio modificado: ${oldPrice.toFixed(2)} → ${newPrice.toFixed(2)} (${sign}${delta.toFixed(2)})`,
      source: 'recalculation',
    })
  }

  refreshOrderPaymentFields(order)

  return { ok: true, order, result, oldPrice, newPrice, delta }
}

/**
 * Apunta el material que se lleva un pedido al aceptarlo. No hay stock que
 * descontar: solo se acumula cuánto se ha gastado de cada color.
 */
function consumeOrderMaterial(data, order) {
  const lines = []

  if (order.is_multimaterial) {
    if (!Array.isArray(order.material_breakdown) || order.material_breakdown.length < 2) {
      throw new Error('Este pedido está marcado como multimaterial, pero no tiene desglose válido.')
    }
    for (const item of order.material_breakdown) {
      const material = String(item.material || '').trim()
      const color = String(item.color || '').trim() || 'Negro'
      const grams = Math.max(0, Number(item.grams || 0))
      if (material && grams > 0) lines.push({ material, color, grams })
    }
    if (lines.length < 2) throw new Error('La mezcla debe contener al menos 2 líneas válidas con gramos > 0.')
  } else {
    const material = String(order.filamento || '').trim()
    const color = String(order.filamento_color || '').trim() || 'Negro'
    const grams = Math.max(0, Number(order.peso_g || 0))
    if (!material) throw new Error('El pedido no tiene material asignado.')
    lines.push({ material, color, grams })
  }

  for (const line of lines) {
    const existe = data.filament_stock.some(
      (s) => s.material === line.material && String(s.color || '').toLowerCase() === line.color.toLowerCase(),
    )
    // Color usado por primera vez: entra en el catálogo para poder elegirlo.
    if (!existe) data.filament_stock.push({ material: line.material, color: line.color, ajuste_g: 0 })
  }

  order.material_contabilizado = true
}

/* ── Gasto de material ──────────────────────────────────────────────────
 * Se deriva del historial de pedidos en vez de llevar un contador. Así los
 * pedidos antiguos y archivados cuentan solos, y editar o borrar un pedido
 * corrige el total sin que nada se quede descuadrado. */

function claveColor(material, color) {
  return `${String(material || '').trim()}|${String(color || '').trim().toLowerCase()}`
}

/** Gramos gastados por color, sumando los pedidos ya contabilizados. */
export function filamentUsageByColor(data) {
  const uso = new Map()
  const suma = (material, color, grams) => {
    const g = Math.max(0, Number(grams) || 0)
    if (!material || g <= 0) return
    const k = claveColor(material, color || 'Negro')
    uso.set(k, round4((uso.get(k) || 0) + g))
  }

  for (const order of data.orders || []) {
    // Solo cuentan los pedidos cuyo material se dio por consumido al aceptarlos.
    if (!order.material_contabilizado) continue
    if (order.is_multimaterial && Array.isArray(order.material_breakdown) && order.material_breakdown.length) {
      for (const linea of order.material_breakdown) suma(linea.material, linea.color, linea.grams)
    } else {
      suma(order.filamento, order.filamento_color, order.peso_g)
    }
  }
  return uso
}

/** Gramos gastados de un color: lo del historial más el ajuste manual. */
export function filamentSpendG(item, usage) {
  const delHistorial = usage?.get(claveColor(item?.material, item?.color)) || 0
  return round4(delHistorial + Math.max(0, Number(item?.ajuste_g) || 0))
}

/** Ese mismo gasto en euros, al precio por kilo vigente de su material. */
export function filamentSpendEur(item, filamentTypes, usage) {
  const tipo = (filamentTypes || []).find((f) => f.name === item?.material)
  return roundMoney((filamentSpendG(item, usage) * Number(tipo?.price_per_kg || 0)) / 1000)
}

export function setOrderAccepted(data, orderId) {
  const { order } = findOrder(data, orderId)
  if (!(order.estado === 'Aceptado' && order.material_contabilizado)) {
    if (!order.material_contabilizado) consumeOrderMaterial(data, order)
    order.estado = 'Aceptado'
    order.accepted_at = order.accepted_at || new Date().toISOString()
    order.last_status_update = new Date().toISOString()
  }
  return { ok: true }
}

export function setOrderSent(data, orderId) {
  const { order } = findOrder(data, orderId)
  if (order.estado !== 'Presupuesto enviado') order.last_status_update = new Date().toISOString()
  order.estado = 'Presupuesto enviado'
}

export function deleteOrder(data, orderId) {
  const { idx } = findOrder(data, orderId)
  data.orders.splice(idx, 1)
}

export function updateOrder(data, params) {
  const { order } = findOrder(data, params.orderId)
  const updates = params.updates || {}

  if (updates.fecha !== undefined) order.fecha = String(updates.fecha || '').trim()
  if (updates.cliente !== undefined) order.cliente = String(updates.cliente || '').trim()
  if (updates.cliente_email !== undefined) order.cliente_email = String(updates.cliente_email || '').trim()
  if (updates.descripcion !== undefined) order.descripcion = String(updates.descripcion || '').trim()
  if (updates.estado !== undefined) {
    const nuevoEstado = normalizeEstado(updates.estado)
    if (nuevoEstado !== order.estado) order.last_status_update = new Date().toISOString()
    order.estado = nuevoEstado
  }
  if (updates.notif_snooze_until !== undefined) order.notif_snooze_until = String(updates.notif_snooze_until || '')
  if (updates.notes !== undefined) order.notes = String(updates.notes || '').trim()
  if (updates.payment_method !== undefined) order.payment_method = String(updates.payment_method || '').trim()
  if (updates.repeticiones_error !== undefined) order.repeticiones_error = Math.max(0, Math.floor(Number(updates.repeticiones_error) || 0))
  if (updates.imagen_path !== undefined) order.imagen_path = String(updates.imagen_path || '')
  if (updates.archived !== undefined) order.archived = !!updates.archived

  if (updates.is_shared !== undefined) {
    order.is_shared = !!updates.is_shared
    if (order.is_shared && updates.shared_split && typeof updates.shared_split === 'object') {
      const _a = Math.max(0, Math.min(100, Number(updates.shared_split['3DCC'] ?? 50)))
      order.shared_split = { '3DCC': _a, 'SILAB3D': 100 - _a }
    } else if (!order.is_shared) {
      order.shared_split = null
    }
  }

  if (updates.importe_pagado !== undefined) {
    const oldPaid = roundMoney(order.importe_pagado || 0)
    const newPaid = roundMoney(updates.importe_pagado || 0)
    order.importe_pagado = newPaid
    const delta = roundMoney(newPaid - oldPaid)
    if (delta !== 0) {
      if (!Array.isArray(order.payment_history)) order.payment_history = []
      order.payment_history.push({
        id: generateId(),
        created_at: new Date().toISOString(),
        method: order.payment_method || 'Ajuste manual',
        amount: delta,
        note: String(params.adjustmentNote || 'Ajuste manual de cobro'),
        source: 'manual-adjustment',
      })
    }
  }

  refreshOrderPaymentFields(order)
  return { ok: true, order }
}

export function duplicateOrder(data, orderId) {
  const { order } = findOrder(data, orderId)
  const newOrder = normalizeOrder({
    ...order,
    id: undefined,
    fecha: hoyLocalISO(),
    estado: 'Presupuesto enviado',
    importe_pagado: 0,
    payment_history: [],
    notif_history: [],
    stripe_payment_url: null,
    stripe_session_id: null,
    archived: false,
  })
  data.orders.push(newOrder)
  return { ok: true, order: newOrder }
}

export function addManualOrderPayment(data, params) {
  const { order } = findOrder(data, params.orderId)
  const amount = roundMoney(params.amount || 0)
  if (!amount || amount <= 0) throw new Error('El importe manual debe ser mayor que 0.')
  const method = String(params.method || '').trim()
  if (!method) throw new Error('Debes indicar un método de cobro (Efectivo, Bizum, etc.).')

  if (!Array.isArray(order.payment_history)) order.payment_history = []
  order.payment_history.push({
    id: generateId(),
    created_at: new Date().toISOString(),
    method,
    amount,
    note: String(params.note || ''),
    source: 'manual-payment',
  })

  order.importe_pagado = roundMoney(order.importe_pagado + amount)
  order.payment_method = method
  refreshOrderPaymentFields(order)

  return { ok: true, amount, pendingAfter: order.importe_pendiente, order }
}

export function removeOrderPaymentRecord(data, params) {
  const { order } = findOrder(data, params.orderId)
  const paymentId = String(params.paymentId || '').trim()
  if (!paymentId) throw new Error('Debes indicar el ID del movimiento a eliminar.')
  if (!Array.isArray(order.payment_history) || order.payment_history.length === 0) {
    throw new Error('Este pedido no tiene historial de cobros.')
  }

  const idx = order.payment_history.findIndex((p) => String(p?.id || '') === paymentId)
  if (idx < 0) throw new Error('No se encontró el movimiento en el historial.')

  const [removed] = order.payment_history.splice(idx, 1)
  order.importe_pagado = roundMoney(Math.max(0, Number(order.importe_pagado || 0) - Number(removed.amount || 0)))
  refreshOrderPaymentFields(order)

  return { ok: true, removed, pendingAfter: order.importe_pendiente, order }
}

/* ── Stripe (requires server-side — throws on web/mobile) ──────────────── */

export function currencyFromUnit(unit) {
  const map = { '€': 'eur', EUR: 'eur', '$': 'usd', USD: 'usd', '£': 'gbp', GBP: 'gbp' }
  return map[String(unit || '').trim()] || 'eur'
}

/* ── Tickets (text output) ─────────────────────────────────────────────── */

export function getTickets(resultInfo) {
  const info = resultInfo.info
  const bd = resultInfo.breakdown
  const breakdownDict = resultInfo.breakdownDict || costAsDict(bd)
  const entries = Object.entries(breakdownDict).map(([name, val]) => ({ name, value: Number(val || 0) }))

  const isBruto = (label) => ['Filamento', 'Electricidad', 'Deterioro imp.', 'Desgaste impresora'].includes(String(label || '').trim())
  const costeBruto = entries.filter((item) => isBruto(item.name)).reduce((acc, item) => acc + item.value, 0)
  const brutoVal = costeBruto
  const complementoVal = entries.filter((item) => !isBruto(item.name)).reduce((acc, item) => acc + item.value, 0)

  const cantidad = Math.max(1, Math.floor(Number(info.cantidad) || 1))
  const precioTotal = Number(info.precio_final || 0)
  const precioUnitario = roundMoney(precioTotal / cantidad)

  const errorRate = Number(info.error_rate || 0)
  const markup = Number(info.markup || 1)
  const markupVal = Math.max(0, costeBruto * (markup - 1))
  const errorVal = Math.max(0, costeBruto * errorRate)
  const recargoUrgencia = Number(info.recargo_urgencia || 0)

  // Real Net Benefit
  const beneficioNeto = markupVal + errorVal + recargoUrgencia

  const fillRight = (text, len) => text.padEnd(len, ' ')
  const fillLeft = (text, len) => text.padStart(len, ' ')

  const clienteLines = [
    '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
    `┃  ${fillRight((info.empresa + ' · RESUMEN DE PEDIDO').toUpperCase(), 44)}  ┃`,
    '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    `  CLIENTE:      ${info.cliente}`,
    `  FECHA:        ${info.fecha}`,
    `  PROYECTO:     ${info.descripcion}`,
    '',
    '  [ DETALLES TÉCNICOS ]',
    `  • Material:   ${info.filamento} (${info.filamento_color || '-'})`,
    `  • Peso est.:  ${info.peso} g`,
    `  • Tiempo req: ${formatHoras(info.horas)}`,
    `  • Urgencia:   ${info.urgencia_nivel}`,
    '',
    '  [ PRESUPUESTO ]',
    `  Precio unitario:       ${fillLeft(precioUnitario.toFixed(2), 7)} ${info.unit}`,
    `  Cantidad:              ${fillLeft(cantidad.toString(), 7)} ud.`,
    '  ────────────────────────────────────────────────',
    `  TOTAL A ABONAR:        ${fillLeft(precioTotal.toFixed(2), 7)} ${info.unit}`,
    '  ────────────────────────────────────────────────',
    '',
    '  📝 TÉRMINOS Y CONDICIONES',
    '  • El coste arriba reflejado es el precio final cerrado e',
    '    incluye todos los gastos del proceso productivo.',
    '  • Si no se ha acordado una entrega express, el tiempo final',
    '    vendrá marcado por la cola de impresión y complejidad.',
    '  • Se solicita un 50% por adelantado para confirmar el encargo.',
    '',
  ]

  const empresaLines = [
    '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
    `┃  ${fillRight((info.empresa + ' · HOJA INTERNA DE TALLER').toUpperCase(), 44)}  ┃`,
    '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    `  CLIENTE:      ${info.cliente}`,
    `  PROYECTO:     ${info.descripcion}`,
    `  IMPRESORA:    ${info.impresora}`,
    '',
    `  [ DESGLOSE DE COSTES (${cantidad} ud.) ]`,
  ]

  // BRUTO
  empresaLines.push('  ▼ Materia Prima y Maquinaria (Bruto)')
  entries.filter(i => isBruto(i.name)).forEach(item => {
    empresaLines.push(`    • ${fillRight(item.name, 19)}: ${fillLeft(item.value.toFixed(2), 6)} ${info.unit}`)
  })
  empresaLines.push(`    > SUBTOTAL BRUTO ........: ${fillLeft(brutoVal.toFixed(2), 6)} ${info.unit}`)
  empresaLines.push('')

  // COMPLEMENTOS
  if (complementoVal > 0) {
    empresaLines.push('  ▼ Mano de Obra y Tareas Extra')
    entries.filter(i => !isBruto(i.name)).forEach(item => {
      empresaLines.push(`    • ${fillRight(item.name, 19)}: ${fillLeft(item.value.toFixed(2), 6)} ${info.unit}`)
    })
    empresaLines.push(`    > SUBTOTAL M.OBRA .......: ${fillLeft(complementoVal.toFixed(2), 6)} ${info.unit}`)
    empresaLines.push('')
  }

  // MARGEN
  empresaLines.push('  ▼ Márgenes y Beneficio')
  empresaLines.push(`    • Beneficio Base (x${markup.toFixed(1)}) : +${fillLeft(markupVal.toFixed(2), 5)} ${info.unit}`)
  if (errorVal > 0) {
    empresaLines.push(`    • Fondo Error (${info.prob_error.substring(0, 6)})   : +${fillLeft(errorVal.toFixed(2), 5)} ${info.unit}`)
  }
  if (recargoUrgencia > 0) {
    empresaLines.push(`    • Plus Urgencia         : +${fillLeft(recargoUrgencia.toFixed(2), 5)} ${info.unit}`)
  }
  empresaLines.push(`    > BENEFICIO NETO ........: ${fillLeft(beneficioNeto.toFixed(2), 6)} ${info.unit}`)
  empresaLines.push('')

  if (info.precio_minimo_aplicado) {
    empresaLines.push(`  (Aviso: Se aplicó tarifa mínima de ${Number(info.precio_minimo || 0).toFixed(2)} ${info.unit})`)
  }

  empresaLines.push(
    '  ────────────────────────────────────────────────',
    `  PRECIO UNIDAD:     ${fillLeft(precioUnitario.toFixed(2), 7)} ${info.unit}`,
    `  CANTIDAD TOTAL:    ${fillLeft(cantidad.toString(), 7)} ud.`,
    `  PVP VENTA FINAL:   ${fillLeft(precioTotal.toFixed(2), 7)} ${info.unit}`,
    '  ────────────────────────────────────────────────',
    '',
    `  [!] Opciones Elegidas: Dis=${info.diseno} | Busq=${info.busqueda} | Sop=${info.soportes} | Det=${info.deterioro} | Post=${info.postproc} | Err=${info.prob_error} | Urg=${info.urgencia_nivel}`
  )

  return { cliente: clienteLines.join('\n'), empresa: empresaLines.join('\n') }
}
