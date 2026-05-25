import { reactive } from 'vue'
import { onAuthChange, getUserEmpresa, logout as firebaseLogout } from './firebase'
import * as fsService from './firestoreService'
import { api } from './platform'

export const store = reactive({
  /* ── Auth state ─────────────────────────────────────────────────────────── */
  authReady: false,   // true once onAuthStateChanged has fired at least once
  user: null,         // { uid, email }
  empresa: null,      // '3DCC' | 'SILAB3D'

  /* ── App state ──────────────────────────────────────────────────────────── */
  appData: null,
  isLoaded: false,
  lastResult: null,

  /* ── Ghost mode (hidden: Ctrl+Shift+G) ──────────────────────────────────── */
  ghostMode: false,
  _ownAppData: null,
  _ownEmpresa: null,

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

    // CRM Migration: If clients list is empty, populate from history
    if ((!this.appData.clients || this.appData.clients.length === 0) && this.appData.orders.length > 0) {
      await this._migrateClientsFromOrders()
    }

    await this._migrateOrdersIfNeeded()
  },

  async _migrateClientsFromOrders() {
    console.log('[CRM] Migrating clients from historical orders...')
    const clientMap = new Map()
    // Process orders from oldest to newest to capture the most recent email/details
    const sortedOrders = [...this.appData.orders].sort((a, b) => 
      (a.created_at || a.fecha || '').localeCompare(b.created_at || b.fecha || '')
    )

    for (const order of sortedOrders) {
      const name = String(order.cliente || '').trim()
      if (!name) continue
      
      const email = String(order.cliente_email || '').trim()
      const existing = clientMap.get(name)
      
      if (!existing) {
        clientMap.set(name, {
          id: `cl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          name,
          email,
          phone: '',
          tax_id: '',
          address: '',
          default_discount: 0,
          notes: 'Migrado automáticamente del historial.'
        })
      } else if (email && !existing.email) {
        existing.email = email
      }
    }

    if (clientMap.size > 0) {
      this.appData.clients = Array.from(clientMap.values())
      await fsService.saveClients(this.empresa, this.appData.clients)
      console.log(`[CRM] Migrated ${clientMap.size} clients.`)
    }
  },

  async _ensureClientExists(order) {
    if (!order.cliente) return
    const name = String(order.cliente).trim()
    if (!this.appData.clients) this.appData.clients = []
    
    const existing = this.appData.clients.find(c => c.name.toLowerCase() === name.toLowerCase())
    if (!existing) {
      await this.addClient({
        name,
        email: order.cliente_email || '',
        phone: '',
        tax_id: '',
        address: '',
        default_discount: 0,
        notes: `Creado automáticamente desde el pedido #${order.id}`
      })
    } else if (order.cliente_email && !existing.email) {
      // Update email if the order has one but the CRM entry doesn't
      await this.updateClient({ clientId: existing.id, updates: { email: order.cliente_email } })
    }
  },

  async addClient(client) {
    const newClient = { ...client, id: client.id || `cl_${Date.now()}` }
    if (!this.appData.clients) this.appData.clients = []
    this.appData.clients.push(newClient)
    await fsService.saveClients(this.empresa, this.appData.clients)
    return newClient
  },

  async updateClient({ clientId, updates }) {
    const idx = this.appData.clients.findIndex(c => c.id === clientId)
    if (idx !== -1) {
      this.appData.clients[idx] = { ...this.appData.clients[idx], ...updates }
      await fsService.saveClients(this.empresa, this.appData.clients)
    }
  },

  async removeClient(clientId) {
    this.appData.clients = this.appData.clients.filter(c => c.id !== clientId)
    await fsService.saveClients(this.empresa, this.appData.clients)
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
      shared_percent_3dcc: order.shared_split?.['3DCC'] ?? 50,
      shared_percent_silab3d: order.shared_split?.['SILAB3D'] ?? 50,
      gasto_misc: Number(order.gasto_misc || 0),
      diseno_modelado: order.diseno_modelado || 'No necesario',
      busqueda_modelos: order.busqueda_modelos || 'No',
      eliminacion_soportes: order.eliminacion_soportes || 'No',
      postprocesado: order.postprocesado_label || 'No',
      probabilidad_error: order.probabilidad_error_label || 'Baja',
      markup: order.markup_label || 'Normal (230%)',
      urgencia_nivel: order.urgencia_nivel || 'Normal',
      deterioro_impresora: 'Autofinanciación',
    }
  },

  async _generateClientPdfBase64(order) {
    if (!api?.calculate || !api?.getTicketPdfBuffer) return null
    try {
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
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
    
    // CRM: Ensure client exists in database
    await this._ensureClientExists(res.order)

    // Initial state: notify "Presupuesto enviado" if email exists
    if (!options.skipNotification) {
      this._notifyStatusChange(res.order, '', res.order.estado, options).catch(() => {})
    }
    return res
  },

  async acceptOrder(orderId, options = {}) {
    if (this.ghostMode) return
    // For shared orders, load partner inventory first
    const order = this.appData.orders.find(o => o.id === orderId)
    const oldStatus = order?.estado || ''
    let partnerInv = null
    if (order?.is_shared) {
      partnerInv = await fsService.loadPartnerInventory(this.empresa)
    }

    const res = await api.setOrderAccepted(orderId, partnerInv?.filament_stock || null)
    this._applyOrdersUpdate(res.data.orders)
    if (res.data.filament_stock) this.appData.filament_stock = res.data.filament_stock
    const promises = [fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)]
    // Material may have been consumed → save own inventory
    if (res.inventory) {
      promises.push(fsService.saveInventory(this.empresa, res.inventory))
    }
    // If partner stock was also consumed, persist it
    if (res.partnerStockUsed && res.partnerStock) {
      promises.push(fsService.savePartnerInventory(this.empresa, res.partnerStock))
    }
    await Promise.all(promises)
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
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
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
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
    
    // CRM: Ensure client exists or email is updated
    if (res.order) await this._ensureClientExists(res.order)

    if (res.order && oldStatus !== res.order.estado && !options.skipNotification) {
      this._notifyStatusChange(res.order, oldStatus, res.order.estado, options).catch(() => {})
    }
    return res
  },

  async recalculateOrder(params) {
    if (this.ghostMode) return
    const res = await api.recalculateOrder(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
    return res
  },

  async addManualPayment(params) {
    if (this.ghostMode) return
    const res = await api.addManualOrderPayment(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
    return res
  },

  async removePaymentRecord(params) {
    if (this.ghostMode) return
    const res = await api.removeOrderPaymentRecord(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
    return res
  },

  async generatePaymentLink(params) {
    if (this.ghostMode) return
    const res = await api.generateOrderPaymentLink(structuredClone(params))
    this._applyOrdersUpdate(res.data.orders)
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
    return res
  },

  async duplicateOrder(orderId) {
    if (this.ghostMode) return
    const res = await api.duplicateOrder(orderId)
    this._applyOrdersUpdate(res.data.orders)
    await fsService.saveOrder(this._getOrderEmpresaToSave(res.order), res.order)
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
      this.partnerInventory = { filament_stock: [], filament_types: [], partner: null }
    }
    return this.partnerInventory
  },
})
