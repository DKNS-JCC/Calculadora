import { reactive } from 'vue'
import { onAuthChange, getUserEmpresa, logout as firebaseLogout } from './supabase'
import * as fsService from './supabaseService'
import { api } from './platform'
import { isStaleQuote, lastUpdateTs, ORDER_DISCARDED, ORDER_NEW } from './shared/backend.mjs'

export const store = reactive({
  /* ── Auth state ─────────────────────────────────────────────────────────── */
  authReady: false,   // true once onAuthStateChanged has fired at least once
  user: null,         // { uid, email }
  empresa: null,      // '3DCC' | 'SILAB3D'

  /* ── App state ──────────────────────────────────────────────────────────── */
  appData: null,
  isLoaded: false,
  lastResult: null,

  /* ── Solicitud web que se está presupuestando ───────────────────────────── */
  // { id (quote), codigo, orderId, prefill: {...} } — lo fija WebQuotesInbox;
  // Calculator lo precarga y, al guardar, recalcula ESE pedido (lo creó
  // Supabase al llegar la solicitud) en vez de crear otro.
  pendingWebQuote: null,
  // Solicitudes web en 'Nuevo' (badge de la pestaña Pedidos).
  webQuotesCount: 0,
  _autoRefreshOn: false,
  _lastLoadAt: 0,
  _cacheSyncTimer: null,

  /* ── Ghost mode (hidden: Ctrl+Shift+G) ──────────────────────────────────── */
  ghostMode: false,
  _ownAppData: null,
  _ownEmpresa: null,

  /* ── Auto-descarte de presupuestos sin respuesta ────────────────────────── */
  // Resultado del último barrido, para el aviso del Dashboard.
  // { at: ISO, orders: [{ id, cliente, descripcion, precio_final, dias }] }
  autoDiscardNotice: null,

  get isAuthenticated() {
    return !!this.user && !!this.empresa
  },

  /* ── Auth helpers ───────────────────────────────────────────────────────── */

  initAuth() {
    return new Promise((resolve) => {
      onAuthChange(async (fbUser) => {
        if (fbUser) {
          this.user = { uid: fbUser.uid, email: fbUser.email }
          const emp = await getUserEmpresa(fbUser.uid)
          // Only set empresa if not already set (e.g. by setSession during manual login).
          // The onAuthStateChanged callback fires again on manual login and its async
          // getUserEmpresa() can resolve after setSession(), overwriting the correct value.
          if (!this.empresa) {
            this.empresa = emp || null
          }
        } else {
          this.user = null
          this.empresa = null
          this.appData = null
          this.isLoaded = false
        }
        this.authReady = true
        resolve()
      })
    })
  },

  setSession(uid, email, empresa) {
    this.user = { uid, email }
    this.empresa = empresa
  },

  async logout() {
    await firebaseLogout()
    this.user = null
    this.empresa = null
    this.appData = null
    this.isLoaded = false
  },

  /* ── Data helpers ───────────────────────────────────────────────────────── */

  /**
   * Load data from Firestore (renderer, authenticated), send to main
   * process for normalisation, then cache locally.
   */
  async loadApp() {
    const raw = await fsService.loadAllData(this.empresa)
    const hasData = !!(raw.printers || raw.global_config || (raw.orders && raw.orders.length > 0))
    // Main process normalises + caches the data
    this.appData = await api.initData(hasData ? raw : null, this.empresa)
    // If brand-new empresa, persist defaults to Firestore
    if (!hasData) {
      await fsService.saveAllData(this.empresa, this.appData)
    }

    // Merge shared orders from partner empresa (read-only view)
    const partnerShared = await fsService.loadPartnerSharedOrders(this.empresa)
    if (partnerShared.length) {
      const ownIds = new Set(this.appData.orders.map(o => o.id))
      const newFromPartner = partnerShared.filter(o => !ownIds.has(o.id))
      this.appData.orders = [...this.appData.orders, ...newFromPartner]
    }

    this.isLoaded = true
    this._lastLoadAt = Date.now()
    this._contarSolicitudesWeb()
    this._startAutoRefresh()

    await this._migrateOrdersIfNeeded()
    await this._autoDiscardStaleQuotes()
  },

  _contarSolicitudesWeb() {
    this.webQuotesCount = (this.appData?.orders || [])
      .filter(o => !o._fromPartner && !o.archived && o.quote_id && o.estado === ORDER_NEW).length
  },

  /**
   * La web y el otro dispositivo cambian pedidos (estado, cobros, solicitudes
   * nuevas). Al volver a la ventana se relee todo, como mucho una vez por
   * minuto.
   */
  _startAutoRefresh() {
    if (this._autoRefreshOn || typeof window === 'undefined') return
    this._autoRefreshOn = true
    const alVolver = () => {
      if (document.visibilityState === 'hidden') return
      if (this.ghostMode || !this.isLoaded || !this.isAuthenticated) return
      if (Date.now() - this._lastLoadAt < 60000) return
      this.refresh().catch((e) => console.warn('[refresh] ', e?.message || e))
    }
    window.addEventListener('focus', alVolver)
    document.addEventListener('visibilitychange', alVolver)
  },

  /**
   * Sustituye un pedido en memoria por cómo quedó en el servidor (dinero del
   * libro de cobros, estado más reciente, enlace a su quote).
   */
  _mergeServerOrder(server) {
    if (!server || !this.appData) return null
    const idx = this.appData.orders.findIndex(o => o.id === server.id && !o._fromPartner)
    if (idx < 0) return null
    const merged = { ...server }
    this.appData.orders.splice(idx, 1, merged)
    this._contarSolicitudesWeb()
    this._syncCacheSoon()
    return merged
  },

  /** La caché del proceso principal (Electron) también debe ver lo del servidor. */
  _syncCacheSoon() {
    clearTimeout(this._cacheSyncTimer)
    this._cacheSyncTimer = setTimeout(async () => {
      try {
        // La caché del proceso principal no lleva los pedidos del socio (se
        // añaden en loadApp); si los recibiera, _applyOrdersUpdate los
        // duplicaría.
        const partner = this.appData.orders.filter(o => o._fromPartner)
        const propios = JSON.parse(JSON.stringify({ ...this.appData, orders: this.appData.orders.filter(o => !o._fromPartner) }))
        const normalized = await api.normalizeData(propios)
        this.appData = { ...normalized, orders: [...normalized.orders, ...partner] }
      } catch (e) {
        console.warn('[cache] no se pudo sincronizar:', e?.message || e)
      }
    }, 250)
  },

  /** ¿Se puede avisar al cliente por email desde aquí? */
  puedeAvisar(order) {
    if (this.ghostMode) return false
    // 3DCC: siempre por Supabase (notify-quote), en escritorio y en móvil.
    if (this.empresa === '3DCC' && !order?._fromPartner) return true
    return !!this.appData?.global_config?.email_enabled
  },

  /**
   * Barrido de presupuestos muertos.
   *
   * Un pedido que lleva AUTO_DISCARD_DAYS (15) en 'Presupuesto enviado' sin
   * que el cliente conteste ni pague adelanto pasa a 'Descartado' y se
   * archiva. Deja de contaminar el pendiente de cobro y las métricas.
   *
   * Se escribe igual que _migrateOrdersIfNeeded (fsService.saveOrder directo,
   * sin pasar por updateOrder) a propósito: así NO se dispara ningún email de
   * cambio de estado. Descartar es una limpieza interna — el cliente que no
   * contestó no debe recibir un correo diciéndoselo.
   *
   * El resultado queda en store.autoDiscardNotice para que el Dashboard avise.
   */
  async _autoDiscardStaleQuotes() {
    if (this.ghostMode) return
    const now = Date.now()
    const hoy = new Date().toLocaleDateString('es-ES')
    const discarded = []

    for (const order of this.appData.orders) {
      if (!isStaleQuote(order, now)) continue

      const dias = Math.floor((now - lastUpdateTs(order)) / 86400000)
      order.estado = ORDER_DISCARDED
      order.archived = true
      order.last_status_update = new Date().toISOString()
      order.auto_discarded_at = new Date().toISOString()
      order.notes = (order.notes ? order.notes + '\n' : '') +
        `[AUTO-DESCARTADO el ${hoy} · ${dias} días sin respuesta]`

      discarded.push({
        id: order.id,
        cliente: order.cliente || '(sin nombre)',
        descripcion: order.descripcion || '',
        precio_final: Number(order.precio_final || 0),
        dias,
      })
    }

    if (!discarded.length) return

    try {
      await Promise.all(
        discarded.map(d => fsService.saveOrder(this.empresa, this.appData.orders.find(o => o.id === d.id)))
      )
    } catch (e) {
      console.error('[auto-discard] no se pudo persistir:', e)
      return
    }

    this.autoDiscardNotice = { at: new Date().toISOString(), orders: discarded }
  },

  /** Cierra el aviso del Dashboard (no revierte nada). */
  dismissAutoDiscardNotice() {
    this.autoDiscardNotice = null
  },

  /**
   * Deshace el último barrido: devuelve los pedidos a 'Presupuesto enviado' y
   * los desarchiva. Al refrescar last_status_update el contador de 15 días
   * vuelve a empezar, así que no reaparecen en el siguiente arranque.
   */
  async undoAutoDiscard() {
    const notice = this.autoDiscardNotice
    if (!notice?.orders?.length) return
    const restored = []

    for (const { id } of notice.orders) {
      const order = this.appData.orders.find(o => o.id === id)
      if (!order) continue
      order.estado = 'Presupuesto enviado'
      order.archived = false
      order.last_status_update = new Date().toISOString()
      order.auto_discarded_at = ''
      order.notes = String(order.notes || '')
        .split('\n')
        .filter(l => !l.startsWith('[AUTO-DESCARTADO'))
        .join('\n')
      restored.push(order)
    }

    await Promise.all(restored.map(o => fsService.saveOrder(this.empresa, o)))
    this.autoDiscardNotice = null
    return restored.length
  },

  async _migrateOrdersIfNeeded() {
    const ordersToSave = []
    for (const order of this.appData.orders) {
      if (order._fromPartner) continue
      let changed = false

      // Normalizar fecha legado DD/M/YYYY → YYYY-MM-DD
      if (order.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(order.fecha)) {
        const parts = order.fecha.split('/')
        if (parts.length === 3) {
          const [d, m, y] = parts.map(Number)
          if (y > 1000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            order.fecha = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            changed = true
          }
        }
      }

      // Auto-archivar pedidos Entregado con pago completo
      if (!order.archived &&
          order.estado === 'Entregado' &&
          Number(order.precio_final || 0) > 0 &&
          Number(order.importe_pagado || 0) >= Number(order.precio_final || 0)) {
        order.archived = true
        changed = true
      }

      if (changed) ordersToSave.push(order)
    }

    if (ordersToSave.length) {
      await Promise.all(ordersToSave.map(o => fsService.saveOrder(this.empresa, o)))
    }

    // Un pedido aceptado desde la web queda con el material contabilizado,
    // pero su color no entra en el catálogo (eso lo hacía setOrderAccepted).
    const stock = this.appData.filament_stock || []
    const nuevos = []
    for (const order of this.appData.orders) {
      if (order._fromPartner || !order.material_contabilizado || order.is_multimaterial) continue
      const material = String(order.filamento || '').trim()
      const color = String(order.filamento_color || '').trim() || 'Negro'
      if (!material) continue
      const existe = [...stock, ...nuevos].some(
        (st) => st.material === material && String(st.color || '').toLowerCase() === color.toLowerCase(),
      )
      if (!existe) nuevos.push({ material, color, ajuste_g: 0 })
    }
    if (nuevos.length && !this.ghostMode) {
      this.appData.filament_stock = [...stock, ...nuevos]
      try {
        await fsService.saveInventory(this.empresa, this.appData.filament_stock)
      } catch (e) {
        console.warn('[inventario] no se pudo guardar el catálogo:', e?.message || e)
      }
    }
  },

  /**
   * Normalise current appData via main process, then persist config,
   * inventory and calc_state to Firestore.
   * Used by Configuration and Inventory after local mutations.
   */
  async saveApp() {
    if (this.ghostMode) return
    if (!this.appData) return
    try {
      const normalized = await api.normalizeData(JSON.parse(JSON.stringify(this.appData)))
      this.appData = normalized
      await Promise.all([
        fsService.saveConfig(this.empresa, {
          printers: normalized.printers,
          filament_types: normalized.filament_types,
          global_config: normalized.global_config,
          purge_config: normalized.purge_config,
        }),
        fsService.saveInventory(this.empresa, normalized.filament_stock),
        fsService.saveCalcState(this.empresa, normalized.calc_state),
      ])
    } catch (e) {
      console.error('Error saving app:', e)
      alert('Error saving data: ' + e.message)
    }
  },

  /**
   * Persist calculator form state (debounced from Calculator watcher).
   */
  async saveCalcState(payload) {
    const calcState = await api.updateCalcState(structuredClone(payload))
    this.appData.calc_state = calcState
    if (!this.ghostMode) await fsService.saveCalcState(this.empresa, calcState)
  },

  /**
   * Run budget calculation in main process, persist calc_state.
   */
  async calculate(payload) {
    const result = await api.calculate(structuredClone(payload))
    this.appData.calc_state = result.calcState
    this.lastResult = result
    if (!this.ghostMode) await fsService.saveCalcState(this.empresa, result.calcState)
    return result
  },

  /* ── Email notifications ────────────────────────────────────────────────── */

  /**
   * Build the calc payload from an order so we can regenerate the PDF.
   */
  _buildOrderCalcPayload(order) {
    return {
      empresa: order.empresa || this.empresa,
      cliente: order.cliente || '',
      cliente_email: order.cliente_email || '',
      fecha: order.fecha || '',
      descripcion: order.descripcion || '',
      impresora: order.impresora || '',
      filamento_tipo: order.filamento || '',
      filamento_color: order.filamento_color || '',
      peso_g: Number(order.peso_g) || 0,
      tiempo_h: Number(order.horas) || 1,
      cantidad: Number(order.cantidad) || 1,
      is_multimaterial: !!order.is_multimaterial,
      material_breakdown: Array.isArray(order.material_breakdown) ? order.material_breakdown.map(l => ({ ...l })) : [],
      is_shared: !!order.is_shared,
      partner_printers: order.is_shared ? JSON.parse(JSON.stringify(this.partnerInventory?.printers || [])) : [],
      shared_percent_3dcc: order.shared_split?.['3DCC'] ?? 50,
      shared_percent_silab3d: order.shared_split?.['SILAB3D'] ?? 50,
      gasto_misc: Number(order.gasto_misc || 0),
      diseno_modelado: order.diseno_modelado || 'No necesario',
      diseno_horas: Number(order.diseno_horas || 0),
      postprocesado: order.postprocesado_label || 'Limpio',
      probabilidad_error: order.probabilidad_error_label || 'Baja',
      markup: order.markup_label || 'Normal (230%)',
      urgencia_nivel: order.urgencia_nivel || 'Normal',
      deterioro_impresora: 'Autofinanciación',
    }
  },

  async _generateClientPdfBase64(order) {
    if (!api?.calculate || !api?.getTicketPdfBuffer) return null
    try {
      // Pedidos compartidos pueden usar una impresora del socio
      if (order.is_shared && !this.partnerInventory) await this.loadPartnerInventory()
      const payload = this._buildOrderCalcPayload(order)
      const calcResult = await api.calculate(structuredClone(payload))
      const summary = {
        kind: 'cliente',
        info: { ...(calcResult.info || {}), imagen_path: order.imagen_path || '' },
        breakdownDict: calcResult.breakdownDict || {},
      }
      const pdfRes = await api.getTicketPdfBuffer({ summary: structuredClone(summary) })
      if (pdfRes?.ok && pdfRes.base64) {
        return { filename: pdfRes.filename, contentBase64: pdfRes.base64, size: pdfRes.size || 0 }
      }
    } catch (e) {
      console.warn('[notify] PDF generation failed:', e?.message || e)
    }
    return null
  },

  /**
   * Send a status-change email if the order has a cliente_email and email
   * notifications are enabled. Records the attempt in order.notif_history
   * and persists. Failures are non-blocking.
   *
   * options.attachPdf — default true; when true generates the client PDF and
   * attaches it to the email.
   */
  async _notifyStatusChange(order, oldStatus, newStatus, options = {}) {
    if (this.ghostMode || !order) return null
    const email = String(order.cliente_email || '').trim()
    if (!email) return null
    if (oldStatus === newStatus) return null
    // Descartar es limpieza interna: al cliente que no contestó no se le
    // notifica que hemos dado su presupuesto por muerto. 'Nuevo' no tiene
    // aviso: la web ya le mandó el acuse al recibir la solicitud.
    if (newStatus === ORDER_DISCARDED || newStatus === ORDER_NEW) return null

    // 3DCC: todos los correos salen de Supabase (notify-quote) con las
    // plantillas de la web y el enlace de seguimiento, en escritorio y en
    // móvil. Cada pedido de 3DCC tiene su quote (migración 0027) y el
    // trigger ya le ha pasado el estado nuevo antes de llegar aquí.
    if (this.empresa === '3DCC' && !order._fromPartner) {
      try {
        // Al enviar el presupuesto, el PDF de la Calculadora va adjunto
        // (solo escritorio: en el móvil no se genera PDF).
        let adjunto = null
        if (newStatus === 'Presupuesto enviado' && options.attachPdf !== false) {
          const pdf = await this._generateClientPdfBase64(order)
          if (pdf) adjunto = { filename: pdf.filename, base64: pdf.contentBase64 }
        }
        const res = await fsService.notifyOrder(this.empresa, order.id, adjunto)
        const actual = this.appData.orders.find(o => o.id === order.id && !o._fromPartner) || order
        if (!Array.isArray(actual.notif_history)) actual.notif_history = []
        actual.notif_history.push({
          sent_at: new Date().toISOString(),
          to: email,
          from_status: oldStatus || '',
          to_status: newStatus,
          ok: !!res?.ok,
          attached_pdf: !!res?.adjunto,
          via: 'supabase',
          error: res?.ok ? '' : String(res?.error || ''),
        })
        await this._persistOrder(actual)
        return res
      } catch (e) {
        console.error('[notify] supabase failed:', e)
        return { ok: false, error: e.message }
      }
    }

    // SILAB3D (y pedidos compartidos del socio): su propio correo desde el
    // escritorio hasta que tenga remitente en Supabase.
    const cfg = this.appData?.global_config || {}
    if (!cfg.email_enabled) return null
    if (!api?.sendOrderStatusEmail) return null

    let pdfAttachment = null
    if (options.attachPdf !== false) {
      pdfAttachment = await this._generateClientPdfBase64(order)
    }

    try {
      const res = await api.sendOrderStatusEmail({
        order: JSON.parse(JSON.stringify(order)),
        empresa: this.empresa,
        config: JSON.parse(JSON.stringify(cfg)),
        pdfAttachment,
      })
      if (!Array.isArray(order.notif_history)) order.notif_history = []
      order.notif_history.push({
        sent_at: new Date().toISOString(),
        to: email,
        from_status: oldStatus || '',
        to_status: newStatus,
        ok: !!res?.ok,
        attached_pdf: !!res?.attachedPdf,
        error: res?.ok ? '' : String(res?.error || res?.reason || ''),
      })
      await fsService.saveOrder(this.empresa, order)
      return res
    } catch (e) {
      console.error('[notify] failed:', e)
      return { ok: false, error: e.message }
    }
  },

  /* ── Order operations ───────────────────────────────────────────────────── */

  _applyOrdersUpdate(newOrders) {
    if (!this.appData) return
    const partnerOrders = (this.appData.orders || []).filter(o => o._fromPartner)
    this.appData.orders = [...newOrders, ...partnerOrders]
  },

  /**
   * Guarda un pedido y comprueba que el guardado llega a Supabase.
   *
   * El orden importa: la api muta la caché en memoria y la interfaz se
   * repinta antes de esta llamada, así que si el guardado falla la pantalla
   * se queda enseñando un cambio que no existe en el servidor —parece
   * aplicado hasta que reinicias, y en el otro dispositivo no aparece—.
   * Al fallar se recarga desde el servidor para que lo que se ve sea lo que
   * hay de verdad, y se propaga el error para que la vista lo cante.
   */
  async _persistOrder(order) {
    try {
      const server = await fsService.saveOrder(this._getOrderEmpresaToSave(order), order)
      if (server && !order._fromPartner) return this._mergeServerOrder(server) || order
      return order
    } catch (e) {
      try { await this.loadApp() } catch { /* la recarga es best-effort */ }
      const err = new Error(`No se pudo guardar en el servidor: ${e.message}`)
      err.cause = e
      throw err
    }
  },

  /** Relee todo desde Supabase. Sin esto, cada dispositivo se queda con la
   *  foto que cargó al abrir y no ve lo que hizo el otro. */
  async refresh() {
    if (this.ghostMode) return
    this._lastLoadAt = Date.now()
    await this.loadApp()
  },

  _getOrderEmpresaToSave(order) {
    if (order && order._fromPartner && order._empresaOwner) {
      return order._empresaOwner
    }
    return this.empresa
  },

  async saveOrderFromResult(resultInfo, options = {}) {
    if (this.ghostMode) return
    const res = await api.saveOrderFromResult(JSON.parse(JSON.stringify(resultInfo)))
    this._applyOrdersUpdate(res.data.orders)
    // Supabase le crea su quote (código Q-… y seguimiento para el cliente).
    res.order = await this._persistOrder(res.order)

    // Initial state: notify "Presupuesto enviado" if email exists
    if (!options.skipNotification) {
      this._notifyStatusChange(res.order, '', res.order.estado, options).catch(() => {})
    }
    return res
  },

  async acceptOrder(orderId, options = {}) {
    if (this.ghostMode) return
    const order = this.appData.orders.find(o => o.id === orderId)
    const oldStatus = order?.estado || ''

    const res = await api.setOrderAccepted(orderId)
    this._applyOrdersUpdate(res.data.orders)
    if (res.data.filament_stock) this.appData.filament_stock = res.data.filament_stock
    const promises = [this._persistOrder(res.order)]
    // Se ha apuntado material gastado → guardar el catálogo
    if (res.inventory) {
      promises.push(fsService.saveInventory(this.empresa, res.inventory))
    }
    const [guardado] = await Promise.all(promises)
    if (guardado) res.order = guardado
    if (!options.skipNotification) {
      this._notifyStatusChange(res.order, oldStatus, res.order.estado, options).catch(() => {})
    }
    return res
  },

  async sendOrder(orderId, options = {}) {
    if (this.ghostMode) return
    const order = this.appData.orders.find(o => o.id === orderId)
    const oldStatus = order?.estado || ''
    const res = await api.setOrderSent(orderId)
    this._applyOrdersUpdate(res.data.orders)
    res.order = await this._persistOrder(res.order)
    if (!options.skipNotification) {
      this._notifyStatusChange(res.order, oldStatus, res.order.estado, options).catch(() => {})
    }
    return res
  },

  async removeOrder(orderId) {
    if (this.ghostMode) return
    const order = this.appData.orders.find(o => o.id === orderId)
    const res = await api.deleteOrder(orderId)
    this._applyOrdersUpdate(res.data.orders)
    await fsService.removeOrder(this._getOrderEmpresaToSave(order), orderId)
    return res
  },

  async updateOrder(params, options = {}) {
    if (this.ghostMode) return
    const prev = this.appData.orders.find(o => o.id === params.orderId)
    const oldStatus = prev?.estado || ''
    const res = await api.updateOrder(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    const pretendido = res.order?.estado
    res.order = await this._persistOrder(res.order)
    // Si el servidor conservó un estado más reciente (puesto en la web), no
    // se avisa de un cambio que no llegó a aplicarse.
    if (res.order && res.order.estado !== pretendido) {
      return res
    }
    
    // CRM: Ensure client exists or email is updated

    if (res.order && oldStatus !== res.order.estado && !options.skipNotification) {
      this._notifyStatusChange(res.order, oldStatus, res.order.estado, options).catch(() => {})
    }
    return res
  },

  async recalculateOrder(params) {
    if (this.ghostMode) return
    const res = await api.recalculateOrder(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    res.order = await this._persistOrder(res.order)
    return res
  },

  /**
   * Presupuestar una solicitud web: recalcula con los costes reales el pedido
   * que Supabase creó al llegar la solicitud y lo pasa a 'Presupuesto
   * enviado' (con su aviso al cliente, si no se pidió saltarlo).
   */
  async presupuestarSolicitud({ orderId, payload }, options = {}) {
    if (this.ghostMode) return
    const res = await this.recalculateOrder({ orderId, payload })
    const upd = await this.updateOrder({
      orderId,
      updates: {
        estado: 'Presupuesto enviado',
        ...(payload.cliente_email ? { cliente_email: payload.cliente_email } : {}),
      },
    }, options)
    this.pendingWebQuote = null
    return { ...res, order: upd?.order || res.order }
  },

  async addManualPayment(params) {
    if (this.ghostMode) return
    const res = await api.addManualOrderPayment(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    await this._persistOrder(res.order)
    return res
  },

  /**
   * Quitar un cobro = anularlo en el libro común (RPC anular_cobro). Borrarlo
   * solo del JSON no serviría: el servidor no deja que una copia del pedido
   * borre cobros, para que un dispositivo desactualizado no pierda dinero.
   */
  async removePaymentRecord(params) {
    if (this.ghostMode) return
    const order = this.appData.orders.find(o => o.id === params.orderId)
    if (order?._fromPartner) throw new Error('Los cobros de un pedido del socio se gestionan desde su cuenta.')
    const empresa = this._getOrderEmpresaToSave(order)
    await fsService.anularCobro(empresa, params.orderId, params.paymentId, 'Eliminado en la Calculadora')
    const server = await fsService.loadOrder(empresa, params.orderId)
    const merged = this._mergeServerOrder(server)
    return { ok: true, order: merged, pendingAfter: merged?.importe_pendiente }
  },

  async generatePaymentLink(params) {
    if (this.ghostMode) return
    const res = await api.generateOrderPaymentLink(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    await this._persistOrder(res.order)
    return res
  },

  async duplicateOrder(orderId) {
    if (this.ghostMode) return
    const res = await api.duplicateOrder(orderId)
    this._applyOrdersUpdate(res.data.orders)
    res.order = await this._persistOrder(res.order)
    return res
  },

  /* ── Ghost mode helpers ─────────────────────────────────────────────────── */

  async enterGhostMode() {
    const PARTNER = { '3DCC': 'SILAB3D', 'SILAB3D': '3DCC' }
    const partner = PARTNER[this.empresa]
    if (!partner) return
    this._ownAppData = this.appData
    this._ownEmpresa = this.empresa
    this.ghostMode = true
    this.empresa = partner
    this.isLoaded = false
    try {
      const raw = await fsService.loadAllData(partner)
      const hasData = !!(raw.printers || raw.global_config || (raw.orders && raw.orders.length > 0))
      this.appData = await api.initData(hasData ? raw : null, partner)
      this.isLoaded = true
    } catch (e) {
      this.ghostMode = false
      this.appData = this._ownAppData
      this.empresa = this._ownEmpresa
      this._ownAppData = null
      this._ownEmpresa = null
      this.isLoaded = true
      throw e
    }
  },

  async exitGhostMode() {
    if (!this.ghostMode) return
    this.ghostMode = false
    this.empresa = this._ownEmpresa
    this.appData = this._ownAppData
    this._ownAppData = null
    this._ownEmpresa = null
    // Resync backend cache with own data (fresh load from Firestore)
    await this.loadApp()
  },

  /* ── Partner inventory (shared orders) ──────────────────────────────────── */
  partnerInventory: null,

  async loadPartnerInventory() {
    try {
      this.partnerInventory = await fsService.loadPartnerInventory(this.empresa)
    } catch (e) {
      console.error('Error loading partner inventory:', e)
      this.partnerInventory = { filament_stock: [], filament_types: [], printers: [], partner: null }
    }
    return this.partnerInventory
  },
})
