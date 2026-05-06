/**
 * Platform abstraction layer.
 *
 * Provides the same `api` interface that the store and components use,
 * backed by either:
 *   - Electron IPC (when `window.api` exists — injected by preload.js)
 *   - In-browser business logic + Capacitor plugins (mobile / PWA)
 *
 * Usage:  import { api, isElectron, isCapacitor } from './platform'
 */

import * as backend from './shared/backend.js'

/* ── Platform detection ────────────────────────────────────────────────── */

export function isElectron() {
  return !!(window && window.api)
}

export function isCapacitor() {
  return !!(window && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
}

export function isMobile() {
  return isCapacitor()
}

/* ── In-memory data cache (used when NOT running on Electron) ──────────── */

let cachedData = null
let currentEmpresa = '3DCC'

/* ── Capacitor plugin lazy imports ─────────────────────────────────────── */

async function getClipboardPlugin() {
  const { Clipboard } = await import(/* @vite-ignore */ '@capacitor/clipboard')
  return Clipboard
}

async function getSharePlugin() {
  const { Share } = await import(/* @vite-ignore */ '@capacitor/share')
  return Share
}

async function getBrowserPlugin() {
  const { Browser } = await import(/* @vite-ignore */ '@capacitor/browser')
  return Browser
}

/* ── Web / Capacitor implementation of the api ─────────────────────────── */

const webApi = {
  /* ── Data management ─── */
  async initData(rawData, empresa) {
    empresa = empresa || '3DCC'
    currentEmpresa = empresa
    if (rawData) {
      cachedData = backend.normalizeData(rawData)
    } else {
      cachedData = backend.normalizeData(backend.createDefaultData())
    }
    cachedData.calc_state.empresa = empresa
    return cachedData
  },

  async normalizeData(data) {
    cachedData = backend.normalizeData(data)
    cachedData.calc_state.empresa = currentEmpresa
    return cachedData
  },

  /* ── Calculator ─── */
  async calculate(payload) {
    const result = backend.calculateBudget(cachedData, payload)
    cachedData.calc_state = backend.updateCalcState(payload, result.info)
    cachedData.calc_state.empresa = currentEmpresa
    return { ...result, calcState: cachedData.calc_state }
  },

  async updateCalcState(payload) {
    cachedData.calc_state = backend.updateCalcState(payload, null)
    cachedData.calc_state.empresa = currentEmpresa
    return cachedData.calc_state
  },

  /* ── Orders ─── */
  async saveOrderFromResult(resultInfo) {
    const order = backend.saveOrderFromResult(cachedData, resultInfo)
    order.empresa = currentEmpresa
    return { order, data: cachedData }
  },

  async setOrderAccepted(orderId, partnerStock) {
    const response = backend.setOrderAccepted(cachedData, orderId, partnerStock || null)
    const order = cachedData.orders.find((o) => o.id === orderId)
    return { ...response, order, inventory: cachedData.filament_stock, data: cachedData }
  },

  async setOrderSent(orderId) {
    backend.setOrderSent(cachedData, orderId)
    const order = cachedData.orders.find((o) => o.id === orderId)
    return { ok: true, order, data: cachedData }
  },

  async deleteOrder(orderId) {
    backend.deleteOrder(cachedData, orderId)
    return { ok: true, orderId, data: cachedData }
  },

  async updateOrder(params) {
    const result = backend.updateOrder(cachedData, params)
    return { ...result, data: cachedData }
  },

  async recalculateOrder(params) {
    const result = backend.recalculateOrder(cachedData, params)
    return { ...result, data: cachedData }
  },

  async addManualOrderPayment(params) {
    const result = backend.addManualOrderPayment(cachedData, params)
    return { ...result, data: cachedData }
  },

  async removeOrderPaymentRecord(params) {
    const result = backend.removeOrderPaymentRecord(cachedData, params)
    return { ...result, data: cachedData }
  },

  async duplicateOrder(orderId) {
    const result = backend.duplicateOrder(cachedData, orderId)
    return { ...result, data: cachedData }
  },

  async generateOrderPaymentLink(_params) {
    // Stripe requires a server-side key — not available in browser.
    // On mobile, users should set up a cloud function or use the desktop app.
    throw new Error(
      'La generación de enlaces de pago con Stripe no está disponible en la versión móvil. ' +
      'Usa la app de escritorio o configura una Cloud Function.',
    )
  },

  /* ── Email (not available outside Electron) ─── */
  async sendOrderStatusEmail() {
    return { ok: false, skipped: true, reason: 'El envío de correos sólo está disponible en la app de escritorio.' }
  },

  async sendTestEmail() {
    return { ok: false, error: 'El envío de correos sólo está disponible en la app de escritorio.' }
  },

  async getTicketPdfBuffer() {
    return { ok: false, error: 'La generación de PDF en buffer sólo está disponible en la app de escritorio.' }
  },

  /* ── Tickets ─── */
  async getTickets(info) {
    return backend.getTickets(info)
  },

  /**
   * PDF saving on mobile/web: we can't use Node's PDFKit.
   * Instead we offer to share the ticket text or download a simple text file.
   */
  async saveTicketPdf(payload) {
    const summary = payload?.summary || {}
    const info = summary?.info || {}
    const kind = summary?.kind || (/empresa|interno/i.test(String(payload?.title || '')) ? 'empresa' : 'cliente')

    // Build text content
    const tickets = backend.getTickets({ info, breakdown: summary.breakdown || {}, breakdownDict: summary.breakdownDict || {} })
    const text = kind === 'empresa' ? tickets.empresa : tickets.cliente

    if (isCapacitor()) {
      try {
        const Share = await getSharePlugin()
        await Share.share({
          title: `Ticket ${kind === 'empresa' ? 'Interno' : 'Cliente'} - ${info.cliente || ''}`,
          text,
          dialogTitle: 'Compartir ticket',
        })
        return { canceled: false, filePath: '' }
      } catch {
        return { canceled: true }
      }
    }

    // Web fallback: download as text file
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ticket_${kind}_${info.cliente || 'doc'}_${(info.descripcion || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}_${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
    return { canceled: false, filePath: '' }
  },

  async saveBothPdfs(payload) {
    const summary = payload?.summary || {}
    const info = summary?.info || {}

    const tickets = backend.getTickets({ info, breakdown: summary.breakdown || {}, breakdownDict: summary.breakdownDict || {} })
    const combined = `=== TICKET CLIENTE ===\n\n${tickets.cliente}\n\n\n=== TICKET EMPRESA ===\n\n${tickets.empresa}`

    if (isCapacitor()) {
      try {
        const Share = await getSharePlugin()
        await Share.share({
          title: `Tickets - ${info.cliente || ''}`,
          text: combined,
          dialogTitle: 'Compartir tickets',
        })
        return { canceled: false, files: [] }
      } catch {
        return { canceled: true }
      }
    }

    // Web fallback
    const blob = new Blob([combined], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tickets_${info.cliente || 'doc'}_${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
    return { canceled: false, files: [] }
  },

  /* ── Shell / utilities ─── */
  async openUrl(url) {
    if (isCapacitor()) {
      const Browser = await getBrowserPlugin()
      await Browser.open({ url })
    } else {
      window.open(url, '_blank')
    }
    return { ok: true }
  },

  async openFile(_filePath) {
    // Not applicable on mobile — files are shared, not opened by path
    return { ok: true }
  },

  async showItemInFolder(_filePath) {
    // Not applicable on mobile/web
    return { ok: true }
  },

  async openImageFilePicker() {
    // Not applicable on mobile/web
    return { canceled: true, filePath: '' }
  },

  async readImageAsBase64(_filePath) {
    // Not applicable on mobile/web
    return { ok: false, data: '', mimeType: '' }
  },

  async selectFolder() {
    // Not applicable on mobile
    return { canceled: true, path: '' }
  },

  async copyText(text) {
    if (isCapacitor()) {
      try {
        const Clipboard = await getClipboardPlugin()
        await Clipboard.write({ string: String(text || '') })
      } catch {
        // Fallback to web API
        await navigator.clipboard.writeText(String(text || ''))
      }
    } else {
      await navigator.clipboard.writeText(String(text || ''))
    }
    return { ok: true }
  },
}

/* ── Unified api export ────────────────────────────────────────────────── */

/**
 * Returns the correct api implementation:
 *  - On Electron → window.api (IPC-based, injected by preload.js)
 *  - On Capacitor / Web → webApi (business logic runs in-browser)
 */
export const api = isElectron() ? window.api : webApi
