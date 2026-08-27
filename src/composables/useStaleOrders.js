/**
 * Pedidos estancados: sin actualización de estado en más de 7 días.
 *
 * Lógica compartida entre la pestaña PEDIDOS (banner de avisos) y el
 * DASHBOARD (sección de avisos). Las acciones devuelven promesas; la UI
 * que las llame decide confirmaciones, toasts y flujo de email.
 */
import { computed } from 'vue'
import { store } from '../store'

export const STALE_MS = 7 * 24 * 60 * 60 * 1000

export function lastUpdateTs(o) {
    for (const c of [o.last_status_update, o.created_at]) {
        if (!c) continue
        const t = new Date(c).getTime()
        if (!Number.isNaN(t)) return t
    }
    // Fallback: fecha del pedido (YYYY-MM-DD o DD/MM/YYYY)
    const f = String(o.fecha || '')
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return new Date(f + 'T00:00:00').getTime()
    const p = f.split('/')
    if (p.length === 3) {
        const t = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0])).getTime()
        if (!Number.isNaN(t)) return t
    }
    return 0
}

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
            archived: true,
            notes: (o.notes ? o.notes + '\n' : '') + `[RECHAZADO el ${new Date().toLocaleDateString('es-ES')}]`,
        },
    }, { skipNotification: true })

    /** Marca Entregado y archiva. `options` controla la notificación por email. */
    const finishStale = (o, options = { skipNotification: true }) => store.updateOrder({
        orderId: o.id,
        updates: { estado: 'Entregado', archived: true },
    }, options)

    return { staleOrders, staleDays, snoozeStale, rejectStale, finishStale }
}
