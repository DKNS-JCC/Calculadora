/**
 * Pedidos estancados: sin actualización de estado en más de 7 días.
 *
 * Lógica compartida entre la pestaña PEDIDOS (banner de avisos) y el
 * DASHBOARD (sección de avisos). Las acciones devuelven promesas; la UI
 * que las llame decide confirmaciones, toasts y flujo de email.
 */
import { computed } from 'vue'
import { store } from '../store'
import { AUTO_DISCARD_DAYS, ORDER_DISCARDED, lastUpdateTs, isStaleQuote } from '../shared/backend.mjs'

export const STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Umbral de auto-descarte para presupuestos sin respuesta (15 días). */
export const AUTO_DISCARD_MS = AUTO_DISCARD_DAYS * 24 * 60 * 60 * 1000

// Re-export: la lógica pura vive en backend.mjs (sin dependencia del store,
// para que store.js pueda importarla sin ciclo).
export { lastUpdateTs, isStaleQuote, ORDER_DISCARDED, AUTO_DISCARD_DAYS }

export function useStaleOrders() {
    const staleOrders = computed(() =>
        (store.appData?.orders || []).filter(o => {
            if (o.archived || o._fromPartner) return false
            if (o.notif_snooze_until && new Date(o.notif_snooze_until).getTime() > Date.now()) return false
            const ts = lastUpdateTs(o)
            return ts > 0 && (Date.now() - ts) > STALE_MS
        })
    )

    const staleDays = (o) => Math.floor((Date.now() - lastUpdateTs(o)) / (1000 * 60 * 60 * 24))

    /** Pospone el aviso 7 días (no cambia el estado del pedido). */
    const snoozeStale = (o) => store.updateOrder({
        orderId: o.id,
        updates: { notif_snooze_until: new Date(Date.now() + STALE_MS).toISOString() },
    }, { skipNotification: true })

    /** Archiva el pedido como rechazado (deja de avisar mientras esté archivado). */
    const rejectStale = (o) => store.updateOrder({
        orderId: o.id,
        updates: {
            estado: ORDER_DISCARDED,
            archived: true,
            notes: (o.notes ? o.notes + '\n' : '') + `[DESCARTADO el ${new Date().toLocaleDateString('es-ES')}]`,
        },
    }, { skipNotification: true })

    /** Marca Entregado y archiva. `options` controla la notificación por email. */
    const finishStale = (o, options = { skipNotification: true }) => store.updateOrder({
        orderId: o.id,
        updates: { estado: 'Entregado', archived: true },
    }, options)

    return { staleOrders, staleDays, snoozeStale, rejectStale, finishStale }
}
