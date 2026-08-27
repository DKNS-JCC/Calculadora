<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { store } from '../store'
import { api } from '../platform'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Slider from 'primevue/slider'
import Checkbox from 'primevue/checkbox'
import Divider from 'primevue/divider'
import DatePicker from 'primevue/datepicker'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import OrderPurgeTable from './OrderPurgeTable.vue'
import EmailNotifyDialog from './EmailNotifyDialog.vue'
import WebQuotesInbox from './WebQuotesInbox.vue'
import { useEmailConfirm } from '../composables/useEmailConfirm'
import { useStaleOrders } from '../composables/useStaleOrders'
import { laborOptions, DISENO_A_MEDIDA, MARKUP } from '../shared/backend.mjs'
import { useIsHandheld } from '../composables/useMediaQuery'

const selectedOrder = ref()

/* Móvil y escritorio montan listas distintas, no la misma escondida con CSS. */
const isHandheld = useIsHandheld()
const cardLimit = ref(20)
const ordersForCards = computed(() => ordersForTable.value.slice(0, cardLimit.value))

/* Señales que en la tabla eran iconos sueltos de 12 px imposibles de acertar. */
const mobileOrderActions = computed(() => {
    const o = selectedOrder.value
    const bloqueado = !o || isPartnerOrder.value
    return [
        { label: 'Avanzar', icon: 'pi pi-step-forward', disabled: bloqueado, run: advanceStatusFast },
        { label: 'Modificar', icon: 'pi pi-pencil', disabled: bloqueado, run: openModifyDialog },
        { label: 'Ticket', icon: 'pi pi-file', disabled: !o, run: () => generateOrderTicket('cliente') },
        { label: 'Cobro', icon: 'pi pi-wallet', disabled: bloqueado, run: openLinkDialog },
        { label: 'Duplicar', icon: 'pi pi-copy', disabled: bloqueado, run: duplicateOrder },
        { label: o?.archived ? 'Recuperar' : 'Archivar', icon: o?.archived ? 'pi pi-arrow-up-right-and-arrow-down-left-from-center' : 'pi pi-inbox', disabled: bloqueado, run: toggleArchive },
        { label: 'Copiar link', icon: 'pi pi-link', disabled: !o?.stripe_payment_url, run: copyGeneratedLink },
        { label: 'Enviado', icon: 'pi pi-send', disabled: bloqueado, run: markSent },
    ]
})

const cardBadges = (o) => {
    const badges = []
    const dias = daysPending(o)
    if (dias !== null) badges.push({
        text: `${dias} d pendiente`,
        icon: 'pi pi-clock',
        class: dias > 30
            ? 'bg-red-500/10 text-red-500'
            : dias > 14 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-black/[0.05] dark:bg-white/[0.06] text-surface-500',
    })
    if (o.is_shared) badges.push({ text: 'Compartido', icon: 'pi pi-users', class: 'bg-indigo-500/10 text-indigo-500' })
    if (o.quote_id) badges.push({ text: 'Web', icon: 'pi pi-globe', class: 'bg-sky-500/10 text-sky-500' })
    if (o._fromPartner) badges.push({ text: o._empresaOwner, icon: 'pi pi-building', class: 'bg-black/[0.05] dark:bg-white/[0.06] text-surface-500' })
    if (o.notes) badges.push({ text: 'Notas', icon: 'pi pi-comment', class: 'bg-black/[0.05] dark:bg-white/[0.06] text-surface-500' })
    return badges
}
const detailDialogVisible = ref(false)
const ticketDialogVisible = ref(false)
const ticketTitle = ref('')
const ticketContent = ref('')
const ticketKind = ref('cliente')
const ticketLoading = ref(false)
const toast = useToast()
const confirmDlg = useConfirm()
const { state: emailConfirmState, ask: askEmailConfirm, answer: answerEmailConfirm } = useEmailConfirm()
const linkDialog = reactive({ visible: false, pending: 0, amount: 0 })
const showArchived = ref(localStorage.getItem('orders_show_archived') === 'true')
const filterStatus = ref(null)  // null = todos, 'Pendiente' | 'Parcial' | 'Pagado'
const compactMode = ref(localStorage.getItem('orders_compact') === 'true')
const pendingDelete = reactive({ order: null, timer: null })

const PAYMENT_METHODS = ['Efectivo', 'Bizum', 'Transferencia', 'Stripe', 'Otro']
const ORDER_STATUS = [
    'Presupuesto enviado',
    'Aceptado',
    'En producción',
    'Post-procesado',
    'Listo para entregar',
    'Entregado',
]

const orders = computed(() => store.appData.orders)
const isPartnerOrder = computed(() => !!selectedOrder.value?._fromPartner)
const beneficioReal = computed(() => {
    const o = selectedOrder.value
    if (!o) return 0
    const reps = Number(o.repeticiones_error || 0)
    const costeBrutoReal = Number(o.coste_bruto || 0) * (1 + reps)
    return Math.round((Number(o.precio_final || 0) - costeBrutoReal) * 100) / 100
})
const total = computed(() => orders.value.length)
const archivedCount = computed(() => orders.value.filter(o => o.archived).length)
const activosCount = computed(() => orders.value.filter(o => !o.archived).length)
const pendientesCount = computed(() => orders.value.filter(o => !o.archived && ['Presupuesto enviado', 'Enviado'].includes(o.estado)).length)
const enProduccionCount = computed(() => orders.value.filter(o => !o.archived && ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar'].includes(o.estado)).length)

const parseFechaTsRobust = (o) => {
    if (!o.fecha) return 0
    let baseTs = 0
    if (/^\d{4}-\d{2}-\d{2}$/.test(o.fecha)) {
        baseTs = new Date(o.fecha + 'T00:00:00').getTime()
    } else {
        const p = o.fecha.split('/')
        if (p.length === 3) baseTs = new Date(p[2], p[1] - 1, p[0]).getTime()
    }

    if (o.created_at) {
        const d = new Date(o.created_at)
        if (!isNaN(d.getTime())) {
            // Add the time part of created_at to the base date timestamp to ensure 
            // orders from the same day are sorted by creation time.
            const timePart = (d.getHours() * 3600000) + (d.getMinutes() * 60000) + (d.getSeconds() * 1000) + d.getMilliseconds()
            return baseTs + timePart
        }
    }
    return baseTs
}
const fmtFecha = (v) => {
    if (!v) return '-'
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m, d] = v.split('-')
        return `${parseInt(d)}/${parseInt(m)}/${y}`
    }
    return v
}
const ordersForTable = computed(() =>
    orders.value
        .filter(o => !pendingDelete.order || o.id !== pendingDelete.order.id)
        .filter(o => showArchived.value ? !!o.archived : !o.archived)
        .filter(o => !filterStatus.value || paymentStatus(o) === filterStatus.value)
        .map(o => ({ ...o, _fecha_ts: parseFechaTsRobust(o) }))
)

const toggleShowArchived = () => {
    showArchived.value = !showArchived.value
    localStorage.setItem('orders_show_archived', showArchived.value)
    filterStatus.value = null
    selectedOrder.value = null
}

const toggleCompact = () => {
    compactMode.value = !compactMode.value
    localStorage.setItem('orders_compact', compactMode.value)
}

const rowClass = (data) => {
    const days = daysPending(data)
    if (days !== null && days > 30) return '!border-l-2 !border-l-red-500/70'
    return ''
}

/* ── Payment helpers ── */
const paymentPct = (o) => {
    const total = Number(o.precio_final || 0)
    if (total <= 0) return 0
    return Math.min(100, Math.round(Number(o.importe_pagado || 0) / total * 100))
}
const paymentBarColor = (o) => {
    const pct = paymentPct(o)
    if (pct >= 100) return 'bg-green-500'
    if (pct > 0) return 'bg-amber-400'
    return 'bg-red-400'
}
const daysPending = (o) => {
    if (o.estado !== 'Aceptado' || paymentPct(o) >= 100) return null
    const ts = parseFechaTsRobust(o)
    if (!ts) return null
    return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24))
}

/* ── Avisos: pedidos sin actualización de estado en 7 días ── */
const { staleOrders, staleDays, snoozeStale, rejectStale, finishStale } = useStaleOrders()

const staleReject = (o) => {
    confirmDlg.require({
        message: `¿Marcar el pedido #${o.id} de ${o.cliente} como rechazado? Se archivará y dejará de generar avisos mientras esté archivado.`,
        header: 'Pedido rechazado',
        icon: 'pi pi-times-circle',
        rejectLabel: 'Cancelar',
        acceptLabel: 'Rechazar y archivar',
        acceptProps: { severity: 'danger' },
        accept: async () => {
            try {
                await rejectStale(o)
                toast.add({ severity: 'warn', summary: 'Pedido rechazado', detail: `#${o.id} archivado`, life: 3000 })
            } catch (e) {
                toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
            }
        },
    })
}

const staleInProduction = async (o) => {
    try {
        await snoozeStale(o)
        toast.add({ severity: 'info', summary: 'Aviso pospuesto', detail: `#${o.id}: si no hay cambios, volverá a avisar en 7 días`, life: 3200 })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

const staleFinish = async (o) => {
    try {
        const decision = await _maybeAskEmailFor(o, 'Entregado', 'Notificar pedido entregado')
        if (!decision.proceed) return
        await finishStale(o, decision.options)
        toast.add({ severity: 'success', summary: 'Pedido finalizado', detail: `#${o.id} entregado y archivado`, life: 3000 })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

/* ── Detail DatePicker computed ── */
const detailFechaDate = computed({
    get: () => {
        if (!detail.fecha) return null
        const [y, m, d] = detail.fecha.split('-').map(Number)
        return new Date(y, m - 1, d)
    },
    set: (val) => {
        if (!val) { detail.fecha = ''; return }
        detail.fecha = `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}-${String(val.getDate()).padStart(2, '0')}`
    }
})

/* ── Copy helpers ── */
const copyOrderId = async () => {
    await api.copyText(selectedOrder.value.id)
    toast.add({ severity: 'info', summary: `ID #${selectedOrder.value.id} copiado`, life: 1500 })
}
const copyClientName = async (cliente) => {
    if (!cliente) return
    await api.copyText(cliente)
    toast.add({ severity: 'info', summary: 'Cliente copiado', life: 1500 })
}

const copyOrderIdFast = async (id) => {
    if (!id) return
    await api.copyText(id)
    toast.add({ severity: 'info', summary: `ID #${id} copiado`, life: 1500 })
}

const unit = computed(() => store.appData.global_config.money_unit)
const globalFilter = ref('')
watch([globalFilter, () => showArchived.value, () => filterStatus.value], () => { cardLimit.value = 20 })

const detail = reactive({
    fecha: '',
    cliente: '',
    cliente_email: '',
    descripcion: '',
    estado: 'Presupuesto enviado',
    importe_pagado: 0,
    payment_method: 'Efectivo',
    notes: '',
    is_shared: false,
    shared_percent_3dcc: 50,
    shared_percent_silab3d: 50,
    repeticiones_error: 0,
    imagen_path: '',
})

const buildOrderPayload = (order) => ({
    empresa: order.empresa || store.empresa,
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
    partner_printers: order.is_shared ? JSON.parse(JSON.stringify(store.partnerInventory?.printers || [])) : [],
    shared_percent_3dcc: order.shared_split?.['3DCC'] ?? 50,
    shared_percent_silab3d: order.shared_split?.['SILAB3D'] ?? 50,
    gasto_misc: Number(order.gasto_misc || 0),
    diseno_modelado: order.diseno_modelado || 'No necesario',
    diseno_horas: Number(order.diseno_horas || 0),
    postprocesado: order.postprocesado_label || 'Limpio',
    probabilidad_error: normalizeProbLabel(order.probabilidad_error_label),
    markup: order.markup_label || 'Normal (230%)',
    urgencia_nivel: order.urgencia_nivel || 'Normal',
    deterioro_impresora: 'Autofinanciación',
})

const imageDataUrl = ref('')
const imageLoading = ref(false)
const orderBreakdownObj = ref(null)

watch(selectedOrder, async (order) => {
    if (!order) {
        orderBreakdownObj.value = null
        return
    }
    
    // Asynchronously calculate breakdown for display
    try {
        // Pedidos compartidos pueden usar una impresora del socio
        if (order.is_shared && !store.partnerInventory) await store.loadPartnerInventory()
        const payload = buildOrderPayload(order)
        const calcRes = await api.calculate(payload)
        const info = calcRes.info || {}
        const rawBreakdown = calcRes.breakdownDict || {}
        const allRows = Object.entries(rawBreakdown).map(([label, value]) => ({
            label,
            value: Number(value || 0)
        }))

        const isBrutoRaw = (label) => label === 'Filamento' || label === 'Electricidad' || label === 'Deterioro imp.'
        const brutoRows = allRows.filter((row) => isBrutoRaw(row.label))
        const brutoTotal = brutoRows.reduce((acc, row) => acc + row.value, 0)

        const isComplemento = (label) => !isBrutoRaw(label)
        const complementosRows = allRows.filter((row) => isComplemento(row.label))
        const complementosTotal = complementosRows.reduce((acc, row) => acc + row.value, 0)

        const costeBrutoFormula = Number(info.coste_bruto_impresion || 0)
        const markup = Number(info.markup || 2.3)
        const errorRate = Number(info.error_rate || 0)
        const markupSupplement = Math.max(0, costeBrutoFormula * (markup - 1))
        const errorSupplement = Math.max(0, costeBrutoFormula * errorRate)
        const recargoUrgencia = Number(info.recargo_urgencia || 0)
        const beneficioTotal = markupSupplement + errorSupplement + recargoUrgencia

        orderBreakdownObj.value = {
            dict: rawBreakdown,
            brutoRows, brutoTotal, complementosRows, complementosTotal,
            markupSupplement, errorSupplement, recargoUrgencia,
            gastoMisc: Number(info.gasto_misc || 0), beneficioTotal,
            markup, errorRate, tasaErrorLabel: info.prob_error || order.probabilidad_error_label || 'Baja',
            cantidad: Number(order.cantidad) || 1
        }
    } catch {
        orderBreakdownObj.value = null
    }

    detail.fecha = order.fecha || ''
    detail.cliente = order.cliente || ''
    detail.cliente_email = order.cliente_email || ''
    detail.descripcion = order.descripcion || ''
    detail.estado = order.estado || 'Presupuesto enviado'
    detail.importe_pagado = Number(order.importe_pagado || 0)
    detail.payment_method = order.payment_method || 'Efectivo'
    detail.notes = order.notes || ''
    detail.repeticiones_error = Number(order.repeticiones_error || 0)
    detail.imagen_path = order.imagen_path || ''
    detail.is_shared = !!order.is_shared
    // Load image preview
    imageDataUrl.value = ''
    if (order.imagen_path && api?.readImageAsBase64) {
        imageLoading.value = true
        api.readImageAsBase64(order.imagen_path).then((res) => {
            if (res?.ok && res.data) imageDataUrl.value = `data:${res.mimeType};base64,${res.data}`
            imageLoading.value = false
        }).catch(() => { imageLoading.value = false })
    }
    detail.shared_percent_3dcc = order.shared_split?.['3DCC'] ?? 50
    detail.shared_percent_silab3d = order.shared_split?.['SILAB3D'] ?? 50
})

const fmt = (v) => Number(v).toFixed(2) + ' ' + unit.value
const bdCost = (label) => Number(orderBreakdownObj.value?.dict?.[label] || 0)

/* ── Historial unificado del pedido (cobros + ciclo de vida) ── */
const orderHistory = computed(() => {
    const o = selectedOrder.value
    if (!o) return []
    const ev = []
    if (o.created_at || o.fecha) ev.push({ ts: o.created_at || o.fecha, icon: 'pi pi-plus-circle text-blue-400', label: 'Creado' })
    const aceptadoOMas = ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'].includes(o.estado)
    if (o.accepted_at || aceptadoOMas) ev.push({ ts: o.accepted_at || '', icon: 'pi pi-check-circle text-green-400', label: 'Aceptado' })
    for (const pago of (o.payment_history || [])) {
        ev.push({ ts: pago.created_at, icon: 'pi pi-credit-card text-amber-400', label: pago.method || 'Cobro', amount: pago.amount, note: pago.note, payment: pago })
    }
    if (o.last_status_update) ev.push({ ts: o.last_status_update, icon: 'pi pi-sync text-indigo-400', label: `Estado: ${o.estado}` })
    if (o.archived) ev.push({ ts: '', icon: 'pi pi-inbox text-surface-400', label: 'Archivado' })
    return ev.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
})
const fmtDate = (v) => {
    if (!v) return '-'
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return v
    return d.toLocaleString('es-ES')
}
const paymentStatus = (order) => {
    if (order.payment_status) return order.payment_status
    const paid = Number(order.importe_pagado || 0)
    const totalPrice = Number(order.precio_final || 0)
    if (paid <= 0) return 'Pendiente'
    if (paid >= totalPrice) return 'Pagado'
    return 'Parcial'
}
const paymentSeverity = (status) => {
    const map = { Pendiente: 'danger', Parcial: 'warn', Pagado: 'success' }
    return map[status] || 'secondary'
}

const getSeverity = (status) => {
    const map = {
        'Presupuesto enviado': 'info',
        'Enviado': 'info',
        'Aceptado': 'success',
        'En producción': 'warn',
        'Post-procesado': 'help',
        'Listo para entregar': 'info',
        'Entregado': 'success',
    }
    return map[status] || 'secondary'
}

const syncSelection = (id) => {
    selectedOrder.value = store.appData.orders.find(o => o.id === id) || null
}

const openDetail = (event) => {
    selectedOrder.value = event.data
    detailDialogVisible.value = true
}

const closeDetail = () => {
    detailDialogVisible.value = false
    selectedOrder.value = null
}

const _maybeAskEmailFor = async (order, newStatus, title) => {
    const emailEnabled = !!store.appData.global_config?.email_enabled
    if (!emailEnabled || !order?.cliente_email || order.estado === newStatus) return { proceed: true, options: {} }
    const choice = await askEmailConfirm({
        order: { ...order, estado: newStatus },
        oldStatus: order.estado,
        newStatus,
        recipientEmail: order.cliente_email,
        title,
    })
    if (choice === 'cancel') return { proceed: false, options: {} }
    if (choice === 'skip') return { proceed: true, options: { skipNotification: true } }
    // user might have edited the email inside the dialog — propagate it
    if (emailConfirmState.recipientEmail && emailConfirmState.recipientEmail !== order.cliente_email) {
        await store.updateOrder({ orderId: order.id, updates: { cliente_email: emailConfirmState.recipientEmail } }, { skipNotification: true })
    }
    return { proceed: true, options: {} }
}

const markAccepted = async () => {
    if (!selectedOrder.value) return
    try {
        const decision = await _maybeAskEmailFor(selectedOrder.value, 'Aceptado', 'Notificar pedido aceptado')
        if (!decision.proceed) {
            toast.add({ severity: 'secondary', summary: 'Acción cancelada', life: 2200 })
            return
        }
        await store.acceptOrder(selectedOrder.value.id, decision.options)
        selectedOrder.value = null
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    }
}

const markSent = async () => {
    if (!selectedOrder.value) return
    const decision = await _maybeAskEmailFor(selectedOrder.value, 'Presupuesto enviado', 'Notificar presupuesto enviado')
    if (!decision.proceed) {
        toast.add({ severity: 'secondary', summary: 'Acción cancelada', life: 2200 })
        return
    }
    await store.sendOrder(selectedOrder.value.id, decision.options)
    selectedOrder.value = null
}

const quickChangeStatus = async (order, newStatus) => {
    if (order.estado === newStatus) return
    
    try {
        const decision = await _maybeAskEmailFor(order, newStatus, 'Notificar cambio de estado')
        if (!decision.proceed) {
            toast.add({ severity: 'secondary', summary: 'Cambio cancelado', life: 2800 })
            return
        }

        const isFullyPaid = Number(order.importe_pagado) > 0 &&
            Number(order.importe_pagado) >= Number(order.precio_final || 0)
        const shouldAutoArchive = isFullyPaid && newStatus === 'Entregado' && !order.archived

        await store.updateOrder({
            orderId: order.id,
            updates: {
                estado: newStatus,
                ...(shouldAutoArchive ? { archived: true } : {})
            }
        }, decision.options)

        const emailEnabled = !!store.appData.global_config?.email_enabled
        const willEmail = emailEnabled && !!order.cliente_email && !decision.options.skipNotification
        
        if (shouldAutoArchive) {
            toast.add({ severity: 'success', summary: 'Pedido archivado', detail: 'Totalmente pagado automáticamente', life: 3500 })
        } else if (willEmail) {
            toast.add({ severity: 'success', summary: 'Estado actualizado', detail: `Notificando a ${order.cliente_email}…`, life: 3500 })
        } else if (decision.options.skipNotification) {
            toast.add({ severity: 'info', summary: 'Estado actualizado', detail: 'Sin notificar al cliente', life: 2800 })
        } else {
            toast.add({ severity: 'success', summary: 'Estado actualizado', life: 2600 })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error al cambiar estado', detail: e.message, life: 3500 })
    }
}

const advanceStatusFast = async () => {
    if (!selectedOrder.value) return
    const idx = ORDER_STATUS.indexOf(selectedOrder.value.estado)
    if (idx === -1 || idx >= ORDER_STATUS.length - 1) {
        toast.add({ severity: 'info', summary: 'Estado final', detail: 'El pedido ya está en el último estado.', life: 2000 })
        return
    }
    const nextStatus = ORDER_STATUS[idx + 1]
    await quickChangeStatus(selectedOrder.value, nextStatus)
}

const deleteOrder = () => {
    if (!selectedOrder.value) return
    const order = { ...selectedOrder.value }
    closeDetail()

    // Clear any previous pending delete immediately
    if (pendingDelete.timer) {
        clearTimeout(pendingDelete.timer)
        store.removeOrder(pendingDelete.order.id)  // flush previous delete
    }

    pendingDelete.order = order
    pendingDelete.timer = setTimeout(async () => {
        await store.removeOrder(order.id)
        pendingDelete.order = null
        pendingDelete.timer = null
    }, 5500)
}

const undoDelete = () => {
    if (!pendingDelete.order) return
    clearTimeout(pendingDelete.timer)
    pendingDelete.order = null
    pendingDelete.timer = null
    toast.add({ severity: 'info', summary: 'Eliminación cancelada', life: 2000 })
}

const duplicateOrder = async () => {
    if (!selectedOrder.value) return
    try {
        const res = await store.duplicateOrder(selectedOrder.value.id)
        toast.add({ severity: 'success', summary: 'Pedido duplicado', detail: `Nuevo pedido #${res.order.id} creado como Enviado`, life: 3000 })
        selectedOrder.value = null
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

const toggleArchive = async () => {
    if (!selectedOrder.value) return
    const newArchived = !selectedOrder.value.archived
    try {
        await store.updateOrder({ orderId: selectedOrder.value.id, updates: { archived: newArchived } })
        syncSelection(selectedOrder.value.id)
        closeDetail()
        toast.add({ severity: 'info', summary: newArchived ? 'Pedido archivado' : 'Pedido recuperado', life: 2200 })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

const exportCsv = () => {
    const headers = ['ID', 'Fecha', 'Cliente', 'Descripción', 'Estado', 'Total', 'Cobrado', 'Pendiente', 'Pago', 'Material', 'Impresora', 'Notas']
    const rows = ordersForTable.value.map(o => [
        o.id,
        fmtFecha(o.fecha),
        o.cliente,
        o.descripcion,
        o.estado,
        Number(o.precio_final || 0).toFixed(2),
        Number(o.importe_pagado || 0).toFixed(2),
        Number(o.importe_pendiente || 0).toFixed(2),
        paymentStatus(o),
        o.filamento || '',
        o.impresora || '',
        o.notes || ''
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`))
    const csv = [headers.map(h => `"${h}"`), ...rows].map(r => r.join(',')).join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pedidos_${showArchived.value ? 'archivados' : 'activos'}_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.add({ severity: 'success', summary: 'CSV exportado', detail: `${ordersForTable.value.length} pedidos`, life: 2500 })
}

const copyGeneratedLink = async () => {
    const url = selectedOrder.value?.stripe_payment_url
    if (!url) return
    try {
        await api.copyText(url)
        toast.add({ severity: 'success', summary: 'Link copiado', detail: 'Enlace de pago copiado al portapapeles', life: 2200 })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3000 })
    }
}

const attachImage = async () => {
    if (!api?.openImageFilePicker) return
    try {
        const res = await api.openImageFilePicker()
        if (res.canceled || !res.filePath) return
        detail.imagen_path = res.filePath
        imageLoading.value = true
        const imgRes = await api.readImageAsBase64(res.filePath)
        if (imgRes?.ok && imgRes.data) imageDataUrl.value = `data:${imgRes.mimeType};base64,${imgRes.data}`
        imageLoading.value = false
    } catch { imageLoading.value = false }
}

const removeImage = () => {
    detail.imagen_path = ''
    imageDataUrl.value = ''
}

const removePaymentRecord = async (payment) => {
    const orderId = selectedOrder.value?.id
    if (!orderId || !payment?.id) return
    confirmDlg.require({
        message: '¿Eliminar este movimiento de cobro?',
        header: 'Confirmar',
        icon: 'pi pi-exclamation-triangle',
        rejectLabel: 'Cancelar',
        acceptLabel: 'Eliminar',
        acceptProps: { severity: 'danger' },
        accept: async () => {
            try {
                await store.removePaymentRecord({ orderId, paymentId: payment.id })
                syncSelection(orderId)
                detail.importe_pagado = Number(selectedOrder.value?.importe_pagado || 0)
                const updated = store.appData.orders.find(o => o.id === orderId)
                if (updated?.archived && Number(updated.importe_pagado || 0) < Number(updated.precio_final || 0)) {
                    await store.updateOrder({ orderId, updates: { archived: false } })
                    syncSelection(orderId)
                    toast.add({ severity: 'warn', summary: 'Pedido recuperado', detail: 'Pago incompleto — el pedido se ha desarchivado', life: 3000 })
                } else {
                    toast.add({ severity: 'success', summary: 'Movimiento eliminado', detail: 'El pedido se recalculó automáticamente', life: 2600 })
                }
            } catch (e) {
                toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
            }
        }
    })
}

const openLinkDialog = () => {
    if (!selectedOrder.value) return
    const order = selectedOrder.value
    const pending = Math.max(0, Number(order.precio_final) - Number(order.importe_pagado || 0))
    linkDialog.pending = pending
    linkDialog.amount = pending > 0 ? pending : 1
    linkDialog.visible = true
}

const generateLink = async () => {
    if (!selectedOrder.value) return
    linkDialog.visible = false
    try {
        const res = await store.generatePaymentLink({ orderId: selectedOrder.value.id, amountToCharge: linkDialog.amount })
        syncSelection(selectedOrder.value.id)
        toast.add({ severity: 'success', summary: 'Link generado', detail: 'Cópialo con el botón de enlace', life: 3000 })
        confirmDlg.require({
            message: `¿Abrir el enlace en el navegador?`,
            header: 'Enlace generado',
            icon: 'pi pi-external-link',
            acceptLabel: 'Abrir',
            rejectLabel: 'Cerrar',
            accept: () => api.openUrl(res.url)
        })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

const markAsLoss = () => {
    if (!selectedOrder.value) return
    const debt = Number(selectedOrder.value.precio_final || 0) - Number(selectedOrder.value.importe_pagado || 0)
    confirmDlg.require({
        message: `¿Dar por perdido el cobro pendiente de ${fmt(debt)} y archivar el pedido? Esta acción moverá el pedido a Archivados y lo quitará de las cuentas pendientes.`,
        header: 'Cerrar con pérdida',
        icon: 'pi pi-exclamation-circle',
        rejectLabel: 'Cancelar',
        acceptLabel: 'Confirmar pérdida',
        acceptProps: { severity: 'danger' },
        accept: async () => {
            try {
                await store.updateOrder({
                    orderId: selectedOrder.value.id,
                    updates: {
                        archived: true,
                        notes: (selectedOrder.value.notes ? selectedOrder.value.notes + '\n' : '') + `[PÉRDIDA: ${fmt(debt)} el ${new Date().toLocaleDateString()}]`
                    }
                })
                closeDetail()
                toast.add({ severity: 'warn', summary: 'Pedido cerrado con pérdida', detail: 'Se ha movido a archivados', life: 4000 })
            } catch (e) {
                toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
            }
        }
    })
}

const saveOrderEdits = async () => {
    if (!selectedOrder.value) return
    try {
        const oldStatus = selectedOrder.value.estado
        const statusChanged = oldStatus !== detail.estado
        const emailEnabled = !!store.appData.global_config?.email_enabled

        // Ask for confirmation if status changed and we'd send an email
        let storeOptions = {}
        if (statusChanged && emailEnabled && detail.cliente_email) {
            const choice = await askEmailConfirm({
                order: { ...selectedOrder.value, cliente_email: detail.cliente_email, estado: detail.estado },
                oldStatus,
                newStatus: detail.estado,
                recipientEmail: detail.cliente_email,
                title: 'Notificar cambio de estado',
            })
            if (choice === 'cancel') {
                toast.add({ severity: 'secondary', summary: 'Guardado cancelado', detail: 'Corrige los datos y vuelve a guardar.', life: 2800 })
                return
            }
            if (choice === 'skip') storeOptions = { skipNotification: true }
        }

        const isFullyPaid = Number(detail.importe_pagado) > 0 &&
            Number(detail.importe_pagado) >= Number(selectedOrder.value.precio_final || 0)
        const shouldAutoArchive = isFullyPaid && detail.estado === 'Entregado' && !selectedOrder.value.archived

        await store.updateOrder({
            orderId: selectedOrder.value.id,
            updates: {
                fecha: detail.fecha,
                cliente: detail.cliente,
                cliente_email: detail.cliente_email,
                descripcion: detail.descripcion,
                estado: detail.estado,
                importe_pagado: detail.importe_pagado,
                payment_method: detail.payment_method,
                notes: detail.notes,
                repeticiones_error: detail.repeticiones_error,
                imagen_path: detail.imagen_path,
                is_shared: detail.is_shared,
                shared_split: detail.is_shared ? {
                    '3DCC': detail.shared_percent_3dcc,
                    'SILAB3D': detail.shared_percent_silab3d
                } : null,
                ...(shouldAutoArchive ? { archived: true } : {})
            },
            adjustmentNote: 'Pago recibido'
        }, storeOptions)
        syncSelection(selectedOrder.value.id)
        const willEmail = statusChanged && emailEnabled && !!detail.cliente_email && !storeOptions.skipNotification
        if (shouldAutoArchive) {
            closeDetail()
            toast.add({ severity: 'success', summary: 'Pedido archivado automáticamente', detail: 'Totalmente pagado — puedes verlo en Archivados', life: 3500 })
        } else if (willEmail) {
            toast.add({ severity: 'success', summary: 'Pedido actualizado', detail: `Enviando email + PDF a ${detail.cliente_email}…`, life: 3500 })
        } else if (statusChanged && storeOptions.skipNotification) {
            toast.add({ severity: 'info', summary: 'Pedido actualizado', detail: 'Cambio guardado sin notificar al cliente.', life: 2800 })
        } else {
            toast.add({ severity: 'success', summary: 'Pedido actualizado', detail: 'Cambios guardados correctamente', life: 2600 })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

/* ── Tickets from order ──────────────────────────────────────────────── */

const generateOrderTicket = async (type) => {
    if (!selectedOrder.value) return
    ticketLoading.value = true
    try {
        const payload = buildOrderPayload(selectedOrder.value)
        const calcResult = await api.calculate(structuredClone(payload))
        const tickets = await api.getTickets(structuredClone(calcResult))
        ticketKind.value = type
        ticketTitle.value = type === 'cliente' ? 'Ticket Cliente' : 'Ticket Empresa'
        ticketContent.value = type === 'cliente' ? tickets.cliente : tickets.empresa
        ticketDialogVisible.value = true
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message || 'No se pudo generar el ticket', life: 4000 })
    }
    ticketLoading.value = false
}

const copyTicket = () => {
    api.copyText(ticketContent.value)
    toast.add({ severity: 'info', summary: 'Copiado', detail: 'Texto copiado al portapapeles', life: 2000 })
}

const pdfTicket = async () => {
    try {
        const payload = buildOrderPayload(selectedOrder.value)
        const calcResult = await api.calculate(structuredClone(payload))
        const summary = structuredClone({ kind: ticketKind.value, info: { ...calcResult.info || {}, imagen_path: selectedOrder.value?.imagen_path || '' }, breakdownDict: calcResult.breakdownDict || {} })
        const res = await api.saveTicketPdf({
            title: ticketTitle.value,
            content: ticketContent.value,
            summary,
        })
        if (!res.canceled) {
            toast.add({ severity: 'success', summary: 'PDF guardado', detail: 'Pulsa para abrir la carpeta', life: 5000, data: { folderPath: res.filePath } })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'PDF', detail: e.message || 'No se pudo generar el PDF', life: 4000 })
    }
}

const exportBothOrderPdfs = async () => {
    if (!selectedOrder.value) return
    try {
        const payload = buildOrderPayload(selectedOrder.value)
        const calcResult = await api.calculate(structuredClone(payload))
        const summary = structuredClone({ info: { ...calcResult.info || {}, imagen_path: selectedOrder.value?.imagen_path || '' }, breakdownDict: calcResult.breakdownDict || {} })
        const res = await api.saveBothPdfs({ summary })
        if (!res.canceled) {
            toast.add({ severity: 'success', summary: 'PDFs guardados', detail: 'Pulsa para abrir la carpeta', life: 5000, data: { folderPath: res.files?.[0] } })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'PDF', detail: e.message || 'No se pudieron generar los PDFs', life: 4000 })
    }
}

/* ── Modify order (recalculate) ──────────────────────────────────────── */

const editTarifas = computed(() => laborOptions(store.appData.global_config))
const editLaborCostH = computed(() => Number(store.appData.global_config.labor_cost_h || 0))
const editEsDisenoAMedida = computed(() => editForm.diseno_modelado === DISENO_A_MEDIDA)
const editCantidadUds = computed(() => Math.max(1, Math.floor(Number(editForm.cantidad) || 1)))
const editMarkupOptions = computed(() => Object.keys(MARKUP))

const EDIT_OPTIONS = {
    probError: [
        { label: 'Baja (25%)', value: 'Baja (25%)' },
        { label: 'Media (50%)', value: 'Media (50%)' },
        { label: 'Alta (100% ≈ 1 fallo)', value: 'Alta (100%)' },
        { label: 'Muy Alta (150%)', value: 'Muy Alta (150%)' },
        { label: 'Crítica (200% ≈ 2 fallos)', value: 'Crítica (200%)' },
    ],
    urgencia: ['Normal', 'Urgente'],
}

const PROB_ERROR_MAP = { 0.25: 'Baja (25%)', 0.5: 'Media (50%)', 1: 'Alta (100%)', 1.5: 'Muy Alta (150%)', 2: 'Crítica (200%)' }
const MARKUP_MAP = { 2.3: 'Normal (230%)' }
const PROB_LEVELS = ['Baja (25%)', 'Media (50%)', 'Alta (100%)', 'Muy Alta (150%)', 'Crítica (200%)']
const PROB_LEGACY_MAP = { 'Exenta (0%)': 'Baja (25%)', 'Mínima (10%)': 'Baja (25%)', 'Baja': 'Baja (25%)', 'Media': 'Media (50%)', 'Alta': 'Alta (100%)', 'Muy Alta': 'Muy Alta (150%)', 'Crítica': 'Crítica (200%)' }
const normalizeProbLabel = (label) => {
    if (PROB_LEVELS.includes(label)) return label
    return PROB_LEGACY_MAP[label] || 'Baja (25%)'
}

const modifyDialogVisible = ref(false)
const modifyPreview = ref(null)
const modifyLoading = ref(false)

const editForm = reactive({
    cliente: '',
    cliente_email: '',
    fecha: '',
    descripcion: '',
    impresora: '',
    filamento_tipo: '',
    filamento_color: '',
    peso_g: 50,
    tiempo_h: 1,
    cantidad: 1,
    is_multimaterial: false,
    is_shared: false,
    shared_percent_3dcc: 50,
    shared_percent_silab3d: 50,
    gasto_misc: 0,
    diseno_modelado: 'No necesario',
    diseno_horas: 1,
    postprocesado: 'Limpio',
    probabilidad_error: 'Baja (25%)',
    markup: 'Normal (230%)',
    urgencia_nivel: 'Normal',
})

const editMixLines = reactive([
    { material: '', color: '', grams: 0 },
    { material: '', color: '', grams: 0 },
])

const addEditMixLine = () => {
    editMixLines.push({ material: editForm.filamento_tipo || '', color: '', grams: 0 })
}
const removeEditMixLine = (idx) => {
    if (editMixLines.length > 2) editMixLines.splice(idx, 1)
}
const editMixLineCost = (line) => {
    const f = store.appData.filament_types.find(ft => ft.name === line.material)
    if (!f || !line.grams) return 0
    return (line.grams * Number(f.price_per_kg || 0)) / 1000
}
const editMixTotalGrams = computed(() => editMixLines.reduce((acc, l) => acc + Number(l.grams || 0), 0))
const editMixTotalCost = computed(() => editMixLines.reduce((acc, l) => acc + editMixLineCost(l), 0))
const editUnit = computed(() => store.appData.global_config.money_unit)

const printerOptions = computed(() => {
    const options = store.appData.printers.map(p => ({ label: p.name, value: p.name }))
    // Impresoras compartidas: en pedidos compartidos se puede imprimir en las del socio
    if (editForm.is_shared && store.partnerInventory?.printers?.length) {
        const ownNames = new Set(store.appData.printers.map(p => p.name))
        const partnerName = store.partnerInventory.partner || 'Socio'
        for (const p of store.partnerInventory.printers) {
            if (p?.name && !ownNames.has(p.name)) options.push({ label: `${p.name} · ${partnerName}`, value: p.name })
        }
    }
    return options
})

watch(() => editForm.is_shared, (val) => {
    if (val && !store.partnerInventory) store.loadPartnerInventory()
})
const filamentOptions = computed(() => store.appData.filament_types.map(f => f.name))

const HEX_COLOR_MAP = {
    Negro: '#111827', Blanco: '#F9FAFB', Gris: '#6B7280', Rojo: '#EF4444',
    Azul: '#3B82F6', Verde: '#10B981', Amarillo: '#FACC15', Naranja: '#F97316',
    Morado: '#8B5CF6', Rosa: '#EC4899', Transparente: '#D1D5DB'
}
const normalizeHex = (v) => { const r = String(v||'').trim().replace('#',''); return r ? `#${r}` : '#94A3B8' }
const colorHex = (name) => HEX_COLOR_MAP[name] || '#94A3B8'

const getColorOptionsByMaterial = (material) => {
    if (!material) return []
    const s = store.appData.filament_stock.filter(s => s.material === material)
    const byName = new Map()
    s.forEach(item => {
        const name = String(item.color || '').trim()
        if (!name || byName.has(name)) return
        const hex = item.color_hex ? normalizeHex(item.color_hex) : colorHex(name)
        byName.set(name, { label: name, value: name, hex })
    })
    const colors = [...byName.values()]
    return colors.length ? colors : [{ label: 'Negro', value: 'Negro', hex: colorHex('Negro') }]
}

const editColorOptions = computed(() => getColorOptionsByMaterial(editForm.filamento_tipo))

const onEditMixMaterialChange = (idx) => {
    const line = editMixLines[idx]
    const valid = getColorOptionsByMaterial(line.material).map(o => o.value)
    if (!valid.includes(line.color)) line.color = valid[0] || ''
}

// Auto-sync weight when multicolor lines change
watch(editMixLines, () => {
    if (!editForm.is_multimaterial) return
    editForm.peso_g = editMixTotalGrams.value
}, { deep: true })

const openModifyDialog = () => {
    if (!selectedOrder.value) return
    const o = selectedOrder.value
    if (o.is_shared && !store.partnerInventory) store.loadPartnerInventory()

    // Populate form from order's stored parameters
    Object.assign(editForm, {
        cliente: o.cliente || '',
        cliente_email: o.cliente_email || '',
        fecha: o.fecha || '',
        descripcion: o.descripcion || '',
        impresora: o.impresora || (store.appData.printers[0]?.name || ''),
        filamento_tipo: o.filamento || (store.appData.filament_types[0]?.name || ''),
        filamento_color: o.filamento_color || '',
        peso_g: Number(o.peso_g) || 50,
        tiempo_h: Number(o.horas) || 1,
        cantidad: Number(o.cantidad) || 1,
        is_multimaterial: !!o.is_multimaterial,
        is_shared: !!o.is_shared,
        shared_percent_3dcc: o.shared_split?.['3DCC'] ?? 50,
        shared_percent_silab3d: o.shared_split?.['SILAB3D'] ?? 50,
        gasto_misc: Number(o.gasto_misc || 0),
        // Restore labels from order (or fall back to reverse-mapped values)
        diseno_modelado: o.diseno_modelado || 'No necesario',
        diseno_horas: Number(o.diseno_horas) || 1,
        postprocesado: o.postprocesado_label || 'Limpio',
        probabilidad_error: normalizeProbLabel(o.probabilidad_error_label || PROB_ERROR_MAP[o.error_rate]),
        markup: o.markup_label || MARKUP_MAP[o.markup] || 'Normal (230%)',
        urgencia_nivel: o.urgencia_nivel || 'Normal',
    })

    // Restore mix lines if multimaterial
    if (o.is_multimaterial && Array.isArray(o.material_breakdown)) {
        editMixLines.splice(0, editMixLines.length)
        o.material_breakdown.forEach((line) => {
            editMixLines.push({ material: line.material || '', color: line.color || '', grams: Number(line.grams || 0) })
        })
        while (editMixLines.length < 2) editMixLines.push({ material: '', color: '', grams: 0 })
    } else {
        editMixLines.splice(0, editMixLines.length, { material: '', color: '', grams: 0 }, { material: '', color: '', grams: 0 })
    }

    modifyPreview.value = null
    modifyDialogVisible.value = true
}

// Reset preview when edit form changes so user must recalculate
watch(editForm, () => { modifyPreview.value = null }, { deep: true })

const buildModifyPayload = () => {
    const mixBreakdown = editForm.is_multimaterial
        ? editMixLines.filter(l => l.material && l.color && l.grams > 0).map(l => ({ ...l }))
        : []
    return {
        empresa: store.empresa,
        ...editForm,
        material_breakdown: mixBreakdown,
        partner_printers: editForm.is_shared ? JSON.parse(JSON.stringify(store.partnerInventory?.printers || [])) : [],
        deterioro_impresora: 'Autofinanciación',
    }
}

const previewModify = async () => {
    modifyLoading.value = true
    try {
        const payload = buildModifyPayload()
        const res = await api.calculate(structuredClone(payload))
        modifyPreview.value = {
            oldPrice: selectedOrder.value.precio_final,
            newPrice: res.info.precio_final,
            delta: res.info.precio_final - selectedOrder.value.precio_final,
            newCoste: res.info.coste_bruto_impresion,
            newBeneficio: res.info.beneficio_neto,
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
        modifyPreview.value = null
    }
    modifyLoading.value = false
}

const onEmailDialogSend = () => {
    // Sync edited recipient back into detail in case user fixed it inside the dialog
    if (emailConfirmState.recipientEmail) detail.cliente_email = emailConfirmState.recipientEmail
    answerEmailConfirm('send')
}
const onEmailDialogSkip = () => answerEmailConfirm('skip')
const onEmailDialogCancel = () => answerEmailConfirm('cancel')

const saveModify = async () => {
    if (!selectedOrder.value) return
    modifyLoading.value = true
    try {
        const payload = buildModifyPayload()
        const res = await store.recalculateOrder({
            orderId: selectedOrder.value.id,
            payload,
        })
        syncSelection(selectedOrder.value.id)
        modifyDialogVisible.value = false
        const sign = res.delta > 0 ? '+' : ''
        const deltaTxt = res.delta !== 0 ? ` (${sign}${res.delta.toFixed(2)} ${unit.value})` : ''
        toast.add({
            severity: 'success',
            summary: 'Pedido modificado',
            detail: `Nuevo precio: ${res.newPrice.toFixed(2)} ${unit.value}${deltaTxt}`,
            life: 4000,
        })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    }
    modifyLoading.value = false
}
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- ═══ Bandeja de presupuestos web (solo 3DCC) ═══ -->
        <WebQuotesInbox v-if="store.empresa === '3DCC' && !store.ghostMode" />

        <!-- ═══ Avisos: pedidos sin actualizar ═══ -->
        <div v-if="staleOrders.length" class="rounded-2xl border border-amber-300/60 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30 p-3 flex flex-col gap-2">
            <div class="flex items-center gap-2 text-amber-700 dark:text-amber-300 text-sm font-semibold">
                <i class="pi pi-bell" />
                <span>{{ staleOrders.length }} pedido{{ staleOrders.length !== 1 ? 's' : '' }} sin actualizar desde hace más de 7 días</span>
            </div>
            <div class="flex flex-col gap-1.5 max-h-44 overflow-auto">
                <div v-for="o in staleOrders" :key="o.id" class="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-white/70 dark:bg-black/20">
                    <span class="font-mono text-xs text-surface-400">#{{ o.id }}</span>
                    <span class="text-sm font-medium">{{ o.cliente }}</span>
                    <span class="text-sm text-surface-500 truncate flex-1 min-w-[8rem]" :title="o.descripcion">{{ o.descripcion }}</span>
                    <span class="text-[10px] text-amber-600 dark:text-amber-400 font-semibold whitespace-nowrap">{{ staleDays(o) }} días</span>
                    <div class="flex gap-1.5 ml-auto">
                        <Button label="Rechazado" size="small" severity="danger" outlined @click="staleReject(o)" v-tooltip.bottom="'Archiva el pedido y deja de avisar'" />
                        <Button label="En producción" size="small" severity="info" outlined @click="staleInProduction(o)" v-tooltip.bottom="'Pospone este aviso 7 días'" />
                        <Button label="Finalizado" size="small" severity="success" outlined @click="staleFinish(o)" v-tooltip.bottom="'Marca Entregado y archiva'" />
                    </div>
                </div>
            </div>
        </div>

        <!-- ═══ Stats ═══ -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div class="card rounded-2xl px-3 py-3">
                <div class="text-[10px] text-surface-500 dark:text-white/40 font-medium uppercase tracking-widest">Pedidos totales</div>
                <div class="text-2xl font-semibold mt-0.5 tracking-tight">{{ total }}</div>
                <div class="text-[10px] text-surface-400 dark:text-white/30 mt-0.5">{{ archivedCount }} archivados</div>
            </div>
            <div class="card rounded-2xl px-3 py-3">
                <div class="text-[10px] text-blue-500 font-medium uppercase tracking-widest">Pedidos activos</div>
                <div class="text-2xl font-semibold text-blue-600 dark:text-blue-300 mt-0.5 tracking-tight">{{ activosCount }}</div>
                <div class="text-[10px] text-surface-400 dark:text-white/30 mt-0.5">No archivados</div>
            </div>
            <div class="card rounded-2xl px-3 py-3">
                <div class="text-[10px] text-amber-500 font-medium uppercase tracking-widest">Pedidos pendientes</div>
                <div class="text-2xl font-semibold text-amber-600 dark:text-amber-400 mt-0.5 tracking-tight">{{ pendientesCount }}</div>
                <div class="text-[10px] text-surface-400 dark:text-white/30 mt-0.5">Aún sin aceptar</div>
            </div>
            <div class="card rounded-2xl px-3 py-3">
                <div class="text-[10px] text-emerald-500 font-medium uppercase tracking-widest">En producción</div>
                <div class="text-2xl font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5 tracking-tight">{{ enProduccionCount }}</div>
                <div class="text-[10px] text-surface-400 dark:text-white/30 mt-0.5">Aceptado → listo para entregar</div>
            </div>
        </div>

        <!-- ═══ Barra móvil ═══
             La barra de escritorio son 17 botones de icono de 32 px sin
             etiqueta: en un móvil es un muro de círculos grises y los tooltips
             no existen al tacto. Aquí solo buscador y archivados; las acciones
             de cada pedido viven dentro de su ficha. -->
        <div v-if="isHandheld" class="flex items-center gap-2">
            <span class="relative flex-1">
                <i class="pi pi-search absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 text-sm pointer-events-none" aria-hidden="true" />
                <InputText v-model="globalFilter" placeholder="Buscar pedido…" class="w-full !pl-9 !h-11" aria-label="Buscar pedido" />
            </span>
            <Button
                :icon="showArchived ? 'pi pi-list' : 'pi pi-inbox'"
                :severity="showArchived ? 'warn' : 'secondary'"
                :aria-label="showArchived ? 'Ver pedidos activos' : 'Ver pedidos archivados'"
                outlined class="!w-11 !h-11 shrink-0"
                @click="toggleShowArchived"
            />
            <Button icon="pi pi-file-export" severity="secondary" outlined class="!w-11 !h-11 shrink-0"
                aria-label="Exportar CSV" @click="exportCsv" />
        </div>

        <!-- ═══ Toolbar (escritorio) ═══ -->
        <div v-if="!isHandheld" class="flex flex-wrap items-center justify-between gap-2 p-1.5 rounded-2xl card">
            <div class="flex flex-wrap gap-1.5">
                <Button icon="pi pi-check" severity="success" size="small" rounded text v-tooltip.bottom="'Aceptar'" @click="markAccepted" :disabled="!selectedOrder || isPartnerOrder" />
                <Button icon="pi pi-send" severity="warn" size="small" rounded text v-tooltip.bottom="'Enviado'" @click="markSent" :disabled="!selectedOrder || isPartnerOrder" />
                <Button icon="pi pi-step-forward" severity="success" size="small" rounded text v-tooltip.bottom="'Avanzar estado'" @click="advanceStatusFast" :disabled="!selectedOrder || isPartnerOrder" />
                <Button icon="pi pi-pencil" severity="info" size="small" rounded text v-tooltip.bottom="'Modificar'" @click="openModifyDialog" :disabled="!selectedOrder || isPartnerOrder" />
                <Button icon="pi pi-wallet" severity="help" size="small" rounded text v-tooltip.bottom="'Link Pago'" @click="openLinkDialog" :disabled="!selectedOrder || isPartnerOrder" />
                <Button icon="pi pi-link" severity="secondary" size="small" rounded text v-tooltip.bottom="'Copiar link'" @click="copyGeneratedLink" :disabled="!selectedOrder?.stripe_payment_url || isPartnerOrder" />
                <Divider layout="vertical" class="mx-1 !h-6 self-center" />
                <Button icon="pi pi-file" severity="secondary" size="small" rounded text v-tooltip.bottom="'Ticket Cliente'" @click="generateOrderTicket('cliente')" :disabled="!selectedOrder" :loading="ticketLoading" />
                <Button icon="pi pi-file-plus" severity="secondary" size="small" rounded text v-tooltip.bottom="'Ticket Empresa'" @click="generateOrderTicket('empresa')" :disabled="!selectedOrder" :loading="ticketLoading" />
                <Button icon="pi pi-folder-plus" severity="secondary" size="small" rounded text v-tooltip.bottom="'Ambos PDFs'" @click="exportBothOrderPdfs" :disabled="!selectedOrder" />
                <Divider layout="vertical" class="mx-1 !h-6 self-center" />
                <Button
                    :icon="selectedOrder?.archived ? 'pi pi-arrow-up-right-and-arrow-down-left-from-center' : 'pi pi-inbox'"
                    severity="secondary" size="small" rounded text
                    v-tooltip.bottom="selectedOrder?.archived ? 'Recuperar pedido' : 'Archivar pedido'"
                    @click="toggleArchive" :disabled="!selectedOrder || isPartnerOrder"
                />
                <Button icon="pi pi-trash" severity="danger" size="small" rounded text v-tooltip.bottom="'Eliminar'" @click="deleteOrder" :disabled="!selectedOrder || isPartnerOrder" />
                <Button icon="pi pi-copy" severity="secondary" size="small" rounded text v-tooltip.bottom="'Duplicar pedido'" @click="duplicateOrder" :disabled="!selectedOrder || isPartnerOrder" />
                <Divider layout="vertical" class="mx-1 !h-6 self-center" />
                <Button :icon="compactMode ? 'pi pi-expand' : 'pi pi-compress'" severity="secondary" size="small" rounded text v-tooltip.bottom="compactMode ? 'Vista normal' : 'Vista compacta'" @click="toggleCompact" />
                <Button icon="pi pi-file-export" severity="secondary" size="small" rounded text v-tooltip.bottom="'Exportar CSV'" @click="exportCsv" />
            </div>
            <div class="flex items-center gap-2">
                <Button
                    :icon="showArchived ? 'pi pi-list' : 'pi pi-inbox'"
                    :label="showArchived ? 'Activos' : `Archivados${archivedCount ? ' (' + archivedCount + ')' : ''}`"
                    :severity="showArchived ? 'warn' : 'secondary'"
                    size="small" text
                    @click="toggleShowArchived"
                />
                <InputText v-model="globalFilter" placeholder="Buscar..." class="w-44 text-sm" size="small" />
            </div>
        </div>

        <!-- ═══ Filter chips ═══ -->
        <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs font-semibold uppercase tracking-wider text-surface-400 mr-1">Cobro:</span>
            <button v-for="f in [null, 'Pendiente', 'Parcial', 'Pagado']" :key="String(f)"
                @click="filterStatus = f; selectedOrder = null"
                class="px-4 min-h-11 lg:min-h-0 lg:py-1 rounded-full text-xs font-medium transition-colors cursor-pointer"
                :class="filterStatus === f
                    ? 'bg-black/80 dark:bg-white/90 text-white dark:text-black shadow-sm'
                    : 'bg-black/[0.05] dark:bg-white/[0.06] text-surface-600 dark:text-white/60 hover:bg-black/[0.08] dark:hover:bg-white/[0.10]'"
            >{{ f === null ? 'Todos' : f }}</button>
            <span class="text-xs text-surface-400 dark:text-white/30 ml-auto">{{ ordersForTable.length }} pedido{{ ordersForTable.length !== 1 ? 's' : '' }}</span>
        </div>

        <!-- ═══ Lista de tarjetas (móvil) ═══
             Sustituye a la tabla: 10 columnas en 390 px obligaban a hacer
             scroll horizontal y a abrir con doble toque. Aquí la tarjeta
             entera abre la ficha con un solo toque. -->
        <div v-if="isHandheld" class="flex flex-col gap-2">
            <button
                v-for="o in ordersForCards"
                :key="o.id"
                type="button"
                class="card rounded-2xl p-4 w-full text-left flex flex-col gap-3 transition-transform active:scale-[0.99]"
                :class="o.archived ? 'opacity-60' : ''"
                @click="openDetail({ data: o })"
            >
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <div class="font-semibold truncate">{{ o.cliente || 'Sin cliente' }}</div>
                        <div class="text-sm text-surface-500 dark:text-surface-400 truncate">{{ o.descripcion || '—' }}</div>
                    </div>
                    <Tag :value="o.estado" :severity="getSeverity(o.estado)" class="text-[10px] shrink-0 max-w-[7.5rem] truncate" />
                </div>

                <div class="flex items-end justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-xl font-semibold tracking-tight">{{ fmt(o.precio_final) }}</div>
                        <div class="text-[11px] text-surface-400 dark:text-white/40">
                            {{ paymentStatus(o) }}<template v-if="paymentPct(o) > 0 && paymentPct(o) < 100"> · {{ fmt(o.importe_pagado) }} cobrado</template>
                        </div>
                    </div>
                    <div class="text-right shrink-0">
                        <div class="text-[11px] text-surface-400 dark:text-white/40">{{ fmtFecha(o.fecha) }}</div>
                        <div class="text-[11px] font-mono text-surface-400 dark:text-white/40">#{{ o.id }}</div>
                    </div>
                </div>

                <div class="h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden">
                    <div class="h-full rounded-full" :class="paymentBarColor(o)" :style="{ width: paymentPct(o) + '%' }" />
                </div>

                <div v-if="cardBadges(o).length" class="flex items-center gap-2 flex-wrap">
                    <span v-for="b in cardBadges(o)" :key="b.text"
                        class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full"
                        :class="b.class">
                        <i :class="b.icon" class="text-[9px]" aria-hidden="true" />{{ b.text }}
                    </span>
                </div>
            </button>

            <Button v-if="ordersForCards.length < ordersForTable.length"
                :label="`Ver más (${ordersForTable.length - ordersForCards.length} restantes)`"
                severity="secondary" outlined class="!h-11" @click="cardLimit += 20" />

            <div v-if="!ordersForTable.length" class="flex flex-col items-center justify-center py-14 gap-3 text-center">
                <div class="w-16 h-16 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
                    <i class="pi pi-inbox text-3xl text-surface-400" aria-hidden="true" />
                </div>
                <p class="font-semibold text-surface-600 dark:text-surface-300">
                    {{ showArchived ? 'No hay pedidos archivados' : 'No hay pedidos activos' }}
                </p>
                <p class="text-sm text-surface-400 px-8">
                    {{ showArchived ? 'Los pedidos totalmente pagados aparecen aquí automáticamente' : 'Crea un presupuesto en la pestaña Calculadora para empezar' }}
                </p>
            </div>
        </div>

        <!-- ═══ Tabla (escritorio) ═══ -->
        <DataTable
            v-if="!isHandheld"
            v-model:selection="selectedOrder"
            :value="ordersForTable"
            selectionMode="single"
            dataKey="id"
            :globalFilterFields="['id', 'cliente', 'descripcion', 'filamento', 'impresora', 'estado', 'payment_status']"
            :filters="{ global: { value: globalFilter, matchMode: 'contains' } }"
            :paginator="true"
            :rows="14"
            :rowsPerPageOptions="[10, 20, 50]"
            sortField="_fecha_ts"
            :sortOrder="-1"
            :size="compactMode ? 'small' : undefined"
            tableStyle="min-width: 50rem"
            scrollable
            scrollHeight="flex"
            @row-dblclick="openDetail"
            :rowClass="rowClass"
            :pt="{ bodyRow: { class: compactMode ? '!py-0' : '' } }"
            class="rounded-2xl overflow-hidden card"
        >
            <template #empty>
                <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
                    <div class="w-16 h-16 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
                        <i class="pi pi-inbox text-3xl text-surface-400" />
                    </div>
                    <div>
                        <p class="font-semibold text-surface-600 dark:text-surface-300">
                            {{ showArchived ? 'No hay pedidos archivados' : 'No hay pedidos activos' }}
                        </p>
                        <p class="text-sm text-surface-400 mt-1">
                            {{ showArchived ? 'Los pedidos totalmente pagados aparecen aquí automáticamente' : 'Crea un presupuesto en la pestaña Calculadora para empezar' }}
                        </p>
                    </div>
                    <Button v-if="!showArchived" label="Ir a Calculadora" icon="pi pi-calculator" size="small" text severity="info" />
                </div>
            </template>
            <Column field="id" header="Código" sortable style="width: 6rem">
                <template #body="{ data }">
                    <span class="font-mono text-xs cursor-pointer hover:text-blue-500 transition-colors" @click.stop="copyOrderIdFast(data.id)" v-tooltip.top="'Copiar código'">#{{ data.id }}</span>
                </template>
            </Column>
            <Column field="_fecha_ts" header="Fecha" sortable style="width: 7rem; max-width: 7rem">
                <template #body="{ data }">
                    <span>{{ fmtFecha(data.fecha) }}</span>
                </template>
            </Column>
            <Column field="cliente" header="Cliente" sortable style="min-width: 8rem; max-width: 12rem">
                <template #body="{ data }">
                    <span class="block truncate" :title="data.cliente">{{ data.cliente }}</span>
                    <span v-if="daysPending(data) !== null" class="text-[9px] font-semibold"
                        :class="daysPending(data) > 30 ? 'text-red-400' : daysPending(data) > 14 ? 'text-amber-400' : 'text-surface-400'">
                        +{{ daysPending(data) }}d
                    </span>
                </template>
            </Column>
            <Column field="descripcion" header="Descripción" style="min-width: 10rem; max-width: 18rem">
                <template #body="{ data }">
                    <span class="block truncate text-surface-500 dark:text-surface-400" :title="data.descripcion">{{ data.descripcion }}</span>
                </template>
            </Column>
            <Column field="Cantidad" header="Cant." sortable style="width: 4rem">
                <template #body="{ data }">
                    <span>{{ data.cantidad || 1 }}</span>
                </template>
            </Column>
            <Column field="precio_final" header="Total" sortable style="width: 6.5rem">
                <template #body="{ data }">
                    <span class="font-semibold">{{ fmt(data.precio_final) }}</span>
                </template>
            </Column>
            <Column field="importe_pagado" header="Cobrado" sortable style="width: 6.5rem">
                <template #body="{ data }">
                    <span class="text-green-600 dark:text-green-400 font-semibold">{{ fmt(data.importe_pagado) }}</span>
                </template>
            </Column>
            <Column header="Cobro" style="width: 7rem">
                <template #body="{ data }">
                    <div class="flex flex-col gap-1 min-w-0">
                        <div class="h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden">
                            <div class="h-full rounded-full transition-all" :class="paymentBarColor(data)" :style="{ width: paymentPct(data) + '%' }" />
                        </div>
                        <div class="flex items-center justify-between">
                            <span class="text-[9px] text-surface-400">{{ paymentStatus(data) }}</span>
                            <span class="text-[9px] font-mono text-surface-400">{{ paymentPct(data) }}%</span>
                        </div>
                    </div>
                </template>
            </Column>
            <Column field="estado" header="Estado" sortable style="min-width: 9rem; max-width: 10rem">
                <template #body="{ data }">
                    <Select
                        :modelValue="data.estado"
                        @update:modelValue="(val) => quickChangeStatus(data, val)"
                        :options="ORDER_STATUS"
                        :disabled="data._fromPartner"
                        class="w-full"
                        :pt="{ 
                            root: 'border-0 bg-transparent shadow-none hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors h-7 -my-1 -mx-2 w-[calc(100%+1rem)]', 
                            label: 'px-2 py-0 flex items-center pr-0', 
                            dropdown: 'w-6 h-7 text-surface-400'
                        }"
                    >
                        <template #value="slotProps">
                            <Tag :value="slotProps.value" :severity="getSeverity(slotProps.value)" class="text-[10px] w-full block text-center truncate" />
                        </template>
                        <template #option="slotProps">
                            <Tag :value="slotProps.option" :severity="getSeverity(slotProps.option)" class="text-[10px]" />
                        </template>
                    </Select>
                </template>
            </Column>
            <Column header="" style="width: 5.5rem">
                <template #body="{ data }">
                    <div class="flex items-center gap-1">
                        <i v-if="data.is_shared" class="pi pi-users text-indigo-400 text-xs" v-tooltip.top="'Compartido'" />
                        <i v-if="data.notes" class="pi pi-comment text-surface-300 text-xs" v-tooltip.top="data.notes" />
                        <Tag v-if="data.quote_id" value="WEB" severity="info" class="text-[9px] px-1.5 py-0" v-tooltip.top="data._webCodigo ? `Enlazado a ${data._webCodigo} — la web se actualiza sola` : 'Enlazado a presupuesto web'" />
                        <Tag v-if="data._fromPartner" :value="data._empresaOwner" severity="secondary" class="text-[9px] px-1.5 py-0" />
                        <Button
                            v-if="paymentPct(data) < 100 && !data._fromPartner && !data.archived"
                            icon="pi pi-credit-card"
                            size="small" text rounded severity="success"
                            class="!w-6 !h-6 shrink-0"
                            v-tooltip.top="'Cobrar'"
                            @click.stop="openDetail({ data })"
                        />
                    </div>
                </template>
            </Column>
        </DataTable>
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════
         Detail Dialog — opens on row click
         ═══════════════════════════════════════════════════════════════════ -->
    <Dialog v-model:visible="detailDialogVisible" modal :closable="true"
        :style="isHandheld ? { width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', margin: '0' } : { width: 'min(96vw, 52rem)' }"
        @hide="selectedOrder = null" class="!p-0"
        :pt="{ root: { class: isHandheld ? 'overflow-hidden !rounded-none' : 'rounded-3xl overflow-hidden' }, content: { class: '!p-0' }, header: { class: isHandheld ? '' : 'rounded-t-3xl' }, footer: { class: isHandheld ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]' : 'rounded-b-3xl' } }">
        <template #header>
            <div v-if="selectedOrder" class="flex items-center gap-3 w-full">
                <span class="font-bold text-lg">#{{ selectedOrder.id }}</span>
                <Button icon="pi pi-copy" size="small" text rounded class="!w-5 !h-5 shrink-0" severity="secondary" @click="copyOrderId" v-tooltip.top="'Copiar ID'" />
                <span class="text-surface-400">·</span>
                <span class="font-medium truncate max-w-[12rem]">{{ selectedOrder.cliente }}</span>
                <Button icon="pi pi-copy" size="small" text rounded class="!w-5 !h-5 shrink-0" severity="secondary" @click="copyClientName(selectedOrder.cliente)" v-tooltip.top="'Copiar cliente'" />
                <Tag :value="selectedOrder.estado" :severity="getSeverity(selectedOrder.estado)" class="ml-auto text-[10px]" />
                <Tag :value="paymentStatus(selectedOrder)" :severity="paymentSeverity(paymentStatus(selectedOrder))" class="text-[10px]" />
                <Tag v-if="selectedOrder.archived" value="Archivado" severity="secondary" class="text-[10px]" />
                <Tag v-if="selectedOrder.is_shared" value="Compartido" severity="info" class="text-[10px]" />
            </div>
        </template>

        <div v-if="selectedOrder" class="flex flex-col gap-0" @keydown.ctrl.s.prevent="saveOrderEdits">
            <!-- Partner read-only banner -->
            <div v-if="isPartnerOrder" class="flex items-center gap-2 px-5 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-sm">
                <i class="pi pi-eye text-amber-500" />
                <span class="text-amber-700 dark:text-amber-300">Pedido de <strong>{{ selectedOrder._empresaOwner }}</strong> — sólo lectura</span>
            </div>

            <!-- ── Precios del proyecto ── -->
            <div class="border-b border-black/[0.04] dark:border-white/[0.06]">
                <div class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-surface-500">Precios del proyecto</div>
                <div class="grid grid-cols-3 md:grid-cols-6">
                    <div class="px-3 py-3 text-center border-r border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Precio total</div>
                        <div class="text-lg font-bold mt-0.5">{{ fmt(selectedOrder.precio_final) }}</div>
                        <div v-if="(selectedOrder.cantidad || 1) > 1" class="text-[9px] text-surface-400 mt-0.5">{{ selectedOrder.cantidad }} ud.</div>
                    </div>
                    <div class="px-3 py-3 text-center border-r border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-orange-500 uppercase tracking-wider font-semibold">Coste bruto</div>
                        <div class="text-lg font-bold text-orange-600 dark:text-orange-400 mt-0.5">{{ fmt(selectedOrder.coste_bruto || 0) }}</div>
                    </div>
                    <div class="px-3 py-3 text-center border-r border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-purple-400 uppercase tracking-wider font-semibold">Beneficio teórico</div>
                        <div class="text-lg font-bold text-purple-600 dark:text-purple-400 mt-0.5">{{ fmt(selectedOrder.beneficio_neto || 0) }}</div>
                    </div>
                    <div class="px-3 py-3 text-center border-r border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Beneficio real</div>
                        <div class="text-lg font-bold mt-0.5" :class="beneficioReal >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-red-500'">{{ fmt(beneficioReal) }}</div>
                        <div v-if="(selectedOrder.repeticiones_error || 0) > 0" class="text-[9px] text-surface-400 mt-0.5">+{{ selectedOrder.repeticiones_error }} reimpresión(es)</div>
                    </div>
                    <div class="px-3 py-3 text-center border-r border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-green-500 uppercase tracking-wider font-semibold">Cobrado</div>
                        <div class="text-lg font-bold text-green-600 dark:text-green-400 mt-0.5">{{ fmt(selectedOrder.importe_pagado) }}</div>
                    </div>
                    <div class="px-3 py-3 text-center">
                        <div class="text-[10px] text-amber-500 uppercase tracking-wider font-semibold">Pendiente</div>
                        <div class="text-lg font-bold text-amber-600 dark:text-amber-400 mt-0.5">{{ fmt(Math.max(0, selectedOrder.importe_pendiente ?? (selectedOrder.precio_final - selectedOrder.importe_pagado))) }}</div>
                    </div>
                </div>
            </div>

            <!-- ── Main content 2-column ── -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 p-5">
                <!-- Left: Información del proyecto + Cobro -->
                <div class="flex flex-col gap-4">
                    <!-- Información del proyecto -->
                    <div class="rounded-xl card-inset overflow-hidden">
                        <div class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-surface-500 border-b border-black/[0.04] dark:border-white/[0.06]">
                            Información del proyecto
                        </div>
                        <div class="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Cliente</label>
                            <InputText v-model="detail.cliente" class="w-full" size="small" autocomplete="off" />
                        </div>
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                                <i class="pi pi-envelope text-[10px]" />
                                Email del cliente
                                <span class="text-surface-400 normal-case font-normal">— opcional, para recibir notificaciones</span>
                            </label>
                            <InputText v-model="detail.cliente_email" type="email" placeholder="cliente@ejemplo.com" class="w-full" size="small" :disabled="isPartnerOrder" />
                            <small v-if="detail.cliente_email && !store.appData.global_config?.email_enabled" class="text-amber-500">
                                <i class="pi pi-exclamation-triangle text-[10px] mr-1" />Las notificaciones por email están desactivadas en Configuración.
                            </small>
                            <small v-else-if="detail.cliente_email" class="text-surface-400">
                                <i class="pi pi-info-circle text-[10px] mr-1" />Recibirá un correo cuando cambies el estado del pedido.
                            </small>
                        </div>
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Descripción</label>
                            <Textarea v-model="detail.descripcion" rows="2" autoResize class="w-full text-sm" />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Fecha</label>
                            <DatePicker v-model="detailFechaDate" dateFormat="dd/mm/yy" showIcon iconDisplay="input" class="w-full" size="small" />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Estado</label>
                            <Select v-model="detail.estado" :options="ORDER_STATUS" class="w-full" size="small" />
                        </div>
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Repeticiones por error</label>
                            <InputNumber v-model="detail.repeticiones_error" :min="0" :step="1" class="w-32" size="small" :disabled="isPartnerOrder" inputClass="text-center" v-tooltip.top="'Nº de reimpresiones por fallo (para estadísticas reales)'" />
                        </div>
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Notas internas</label>
                            <Textarea v-model="detail.notes" rows="2" autoResize class="w-full text-sm" />
                        </div>
                        <!-- Image attachment (Electron only) -->
                        <div v-if="api?.openImageFilePicker" class="col-span-full flex flex-col gap-2">
                            <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Imagen de referencia</label>
                            <div v-if="imageDataUrl" class="relative rounded-xl overflow-hidden border border-black/[0.06] dark:border-white/[0.08]">
                                <img :src="imageDataUrl" class="w-full max-h-48 object-contain bg-surface-50 dark:bg-surface-800" alt="Imagen del pedido" />
                                <Button icon="pi pi-times" severity="danger" rounded size="small" class="absolute top-2 right-2 !w-7 !h-7"
                                    @click="removeImage" :disabled="isPartnerOrder" v-tooltip.left="'Quitar imagen'" />
                            </div>
                            <div v-else class="flex items-center gap-2">
                                <Button label="Adjuntar foto" icon="pi pi-image" size="small" severity="secondary" outlined
                                    @click="attachImage" :disabled="isPartnerOrder || imageLoading" :loading="imageLoading" />
                                <span v-if="detail.imagen_path" class="text-[10px] text-surface-400 truncate">{{ detail.imagen_path }}</span>
                            </div>
                        </div>
                        </div>
                    </div>

                    <!-- Payment fields -->
                    <div class="rounded-xl card-inset p-4">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-surface-500 mb-3">Cobro</div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Cobrado total</label>
                                <InputNumber v-model="detail.importe_pagado" :min="0" :minFractionDigits="2" :maxFractionDigits="2" class="w-full" size="small" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold">Método</label>
                                <Select v-model="detail.payment_method" :options="PAYMENT_METHODS" class="w-full" size="small" />
                            </div>
                        </div>
                        <div class="flex gap-2 mt-3">
                            <Button
                                label="Anticipo 50%"
                                size="small" severity="warn" outlined class="flex-1"
                                :disabled="isPartnerOrder || detail.importe_pagado >= selectedOrder.precio_final * 0.5"
                                @click="detail.importe_pagado = Math.round(selectedOrder.precio_final * 0.5 * 100) / 100"
                            />
                            <Button
                                label="Pago completo"
                                size="small" severity="success" outlined class="flex-1"
                                :disabled="isPartnerOrder || detail.importe_pagado >= selectedOrder.precio_final"
                                @click="detail.importe_pagado = selectedOrder.precio_final"
                            />
                        </div>
                    </div>

                    <!-- Shared split -->
                    <div class="rounded-xl card-inset p-4">
                        <div class="flex items-center gap-3 mb-1">
                            <Checkbox v-model="detail.is_shared" binary inputId="order-shared" />
                            <label for="order-shared" class="text-sm cursor-pointer font-medium">Compartido (3DCC + SILAB3D)</label>
                        </div>
                        <div v-if="detail.is_shared" class="mt-3">
                            <div class="flex items-center gap-3">
                                <div class="flex flex-col items-center min-w-[50px]">
                                    <span class="text-[10px] font-semibold text-blue-500">3DCC</span>
                                    <span class="text-sm font-bold text-blue-600 dark:text-blue-400">{{ detail.shared_percent_3dcc }}%</span>
                                </div>
                                <Slider v-model="detail.shared_percent_3dcc" :min="0" :max="100" :step="5" class="flex-1"
                                    @update:modelValue="(v) => { detail.shared_percent_silab3d = 100 - v }" />
                                <div class="flex flex-col items-center min-w-[50px]">
                                    <span class="text-[10px] font-semibold text-purple-500">SILAB3D</span>
                                    <span class="text-sm font-bold text-purple-600 dark:text-purple-400">{{ detail.shared_percent_silab3d }}%</span>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-2 mt-3 text-center text-xs">
                                <div class="p-2 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                                    <div class="text-blue-500 font-semibold text-[10px]">3DCC</div>
                                    <div class="font-bold text-blue-700 dark:text-blue-300">{{ fmt(selectedOrder.precio_final * detail.shared_percent_3dcc / 100) }}</div>
                                </div>
                                <div class="p-2 bg-purple-50 dark:bg-purple-950/30 rounded-lg">
                                    <div class="text-purple-500 font-semibold text-[10px]">SILAB3D</div>
                                    <div class="font-bold text-purple-700 dark:text-purple-300">{{ fmt(selectedOrder.precio_final * detail.shared_percent_silab3d / 100) }}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right: Parámetros + Historial -->
                <div class="flex flex-col gap-4">
                    <!-- Parámetros y costes -->
                    <div v-if="orderBreakdownObj" class="rounded-xl card-inset p-4">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-surface-500 mb-3 flex justify-between items-center">
                            <span>Parámetros del proyecto</span>
                            <span class="text-primary-500 font-bold">~{{ fmt(orderBreakdownObj.beneficioTotal) }} de margen neto</span>
                        </div>

                        <!-- Parámetros básicos -->
                        <div class="mb-4">
                            <div class="text-[10px] uppercase font-bold text-surface-400 mb-1 border-b border-surface-100 dark:border-surface-800 pb-1">Parámetros básicos</div>
                            <div class="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs items-center">
                                <span class="text-surface-400">Material</span>
                                <span class="text-right text-surface-600 dark:text-surface-300 truncate">{{ selectedOrder.filamento || '—' }} ({{ selectedOrder.filamento_color || '—' }}) · {{ selectedOrder.peso_g }} g</span>
                                <span class="font-medium text-right">{{ fmt(bdCost('Filamento')) }}</span>
                                <span class="text-surface-400">Electricidad</span>
                                <span class="text-right text-surface-600 dark:text-surface-300 truncate">{{ selectedOrder.horas }} h</span>
                                <span class="font-medium text-right">{{ fmt(bdCost('Electricidad')) }}</span>
                                <span class="text-surface-400">Impresora</span>
                                <span class="text-right text-surface-600 dark:text-surface-300 truncate">{{ selectedOrder.impresora || '—' }}</span>
                                <span class="font-medium text-right">{{ fmt(bdCost('Deterioro imp.')) }}</span>
                                <span class="col-span-2 font-semibold text-surface-900 dark:text-surface-100 mt-1">Subtotal básicos</span>
                                <span class="font-semibold text-right mt-1">{{ fmt(orderBreakdownObj.brutoTotal) }}</span>
                            </div>
                        </div>

                        <!-- Parámetros complementarios -->
                        <div class="mb-4">
                            <div class="text-[10px] uppercase font-bold text-surface-400 mb-1 border-b border-surface-100 dark:border-surface-800 pb-1">Parámetros complementarios</div>
                            <div class="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs items-center">
                                <span class="text-surface-400">Diseño</span>
                                <span class="text-right text-surface-600 dark:text-surface-300 truncate">{{ selectedOrder.diseno_modelado || 'No necesario' }}<template v-if="Number(selectedOrder.diseno_horas) > 0"> · {{ selectedOrder.diseno_horas }} h</template></span>
                                <span class="font-medium text-right">{{ fmt(bdCost('Diseño')) }}</span>
                                <span class="text-surface-400">Post-procesado</span>
                                <span class="text-right text-surface-600 dark:text-surface-300 truncate">{{ selectedOrder.postprocesado_label || 'Limpio' }}<template v-if="Number(selectedOrder.cantidad) > 1"> × {{ selectedOrder.cantidad }} uds.</template></span>
                                <span class="font-medium text-right">{{ fmt(bdCost('Post-procesado')) }}</span>
                                <template v-if="bdCost('Extras / Misc.') > 0">
                                    <span class="text-surface-400">Extras / Misc.</span>
                                    <span class="text-right text-surface-600 dark:text-surface-300 truncate">—</span>
                                    <span class="font-medium text-right">{{ fmt(bdCost('Extras / Misc.')) }}</span>
                                </template>
                                <span class="col-span-2 font-semibold text-surface-900 dark:text-surface-100 mt-1">Subtotal complementarios</span>
                                <span class="font-semibold text-right mt-1">{{ fmt(orderBreakdownObj.complementosTotal) }}</span>
                            </div>
                        </div>

                        <!-- Beneficio / Markup -->
                        <div>
                            <div class="text-[10px] uppercase font-bold text-surface-400 mb-1 border-b border-surface-100 dark:border-surface-800 pb-1">Margen + Error</div>
                            <div class="flex flex-col gap-1 text-xs text-surface-600 dark:text-surface-300">
                                <div class="flex justify-between items-center">
                                    <span>Beneficio (x{{ orderBreakdownObj.markup }})</span>
                                    <span class="font-medium text-green-600 dark:text-green-400">+{{ fmt(orderBreakdownObj.markupSupplement) }}</span>
                                </div>
                                <div v-if="orderBreakdownObj.errorRate > 0" class="flex justify-between items-center">
                                    <span>Margen de Error ({{ orderBreakdownObj.tasaErrorLabel }})</span>
                                    <span class="font-medium text-orange-600 dark:text-orange-400">+{{ fmt(orderBreakdownObj.errorSupplement) }}</span>
                                </div>
                                <div v-if="orderBreakdownObj.recargoUrgencia > 0" class="flex justify-between items-center">
                                    <span>Recargo Urgencia</span>
                                    <span class="font-medium text-purple-600 dark:text-purple-400">+{{ fmt(orderBreakdownObj.recargoUrgencia) }}</span>
                                </div>
                                
                                <div class="w-full h-px bg-surface-100 dark:bg-surface-800 my-1"></div>
                                <div class="flex justify-between items-center p-2 bg-surface-100 dark:bg-surface-800 rounded">
                                    <span class="font-semibold text-surface-900 dark:text-surface-100">Beneficio Neto Calculado</span>
                                    <span class="font-bold text-lg text-primary-500">{{ fmt(orderBreakdownObj.beneficioTotal) }}</span>
                                </div>

                                <div v-if="detail.repeticiones_error > 0" class="flex justify-between items-center mt-2 text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded-t">
                                    <span>Costo piezas fallidas ({{ detail.repeticiones_error }} ud.)</span>
                                    <span class="font-bold">-{{ fmt((orderBreakdownObj.brutoTotal / orderBreakdownObj.cantidad) * detail.repeticiones_error) }}</span>
                                </div>
                                <div v-if="detail.repeticiones_error > 0" class="flex justify-between items-center bg-green-100 dark:bg-green-900/30 p-2 rounded-b border-t border-green-200 dark:border-green-800">
                                    <span class="font-bold text-surface-900 dark:text-surface-100">Beneficio REAL final</span>
                                    <span class="font-bold text-xl text-green-600 dark:text-green-400">{{ fmt(orderBreakdownObj.beneficioTotal - ((orderBreakdownObj.brutoTotal / orderBreakdownObj.cantidad) * detail.repeticiones_error)) }}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Historial del pedido (cobros + ciclo de vida) -->
                    <div class="rounded-xl card-inset overflow-hidden">
                        <div class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-surface-500 border-b border-black/[0.04] dark:border-white/[0.06] flex items-center justify-between">
                            <span>Historial del pedido</span>
                            <span class="text-surface-400">{{ orderHistory.length }}</span>
                        </div>
                        <div v-if="!orderHistory.length" class="px-3 py-4 text-sm text-surface-400 text-center">
                            Sin actividad
                        </div>
                        <div v-else class="max-h-56 overflow-auto divide-y divide-black/[0.04] dark:divide-white/[0.06]">
                            <div v-for="(ev, i) in orderHistory" :key="i" class="px-3 py-2 flex items-start gap-2 text-sm hover:bg-surface-50 dark:hover:bg-surface-800/60">
                                <i :class="ev.icon" class="text-sm shrink-0 mt-0.5" />
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center justify-between">
                                        <span class="font-medium text-xs">{{ ev.label }}</span>
                                        <span v-if="Number(ev.amount || 0) !== 0" class="font-mono font-semibold text-xs" :class="Number(ev.amount) >= 0 ? 'text-green-500' : 'text-red-500'">
                                            {{ Number(ev.amount) >= 0 ? '+' : '' }}{{ fmt(ev.amount) }}
                                        </span>
                                    </div>
                                    <div v-if="ev.ts" class="text-[10px] text-surface-400">{{ fmtDate(ev.ts) }}</div>
                                    <div v-if="ev.note" class="text-[10px] text-surface-400 truncate" :title="ev.note">{{ ev.note }}</div>
                                </div>
                                <Button v-if="ev.payment" icon="pi pi-times" severity="danger" text size="small" rounded class="!w-6 !h-6 shrink-0"
                                    @click="removePaymentRecord(ev.payment)" :disabled="isPartnerOrder" v-tooltip.left="'Eliminar cobro'" />
                            </div>
                        </div>
                    </div>

                    <!-- Email notifications log -->
                    <div v-if="selectedOrder.cliente_email" class="rounded-xl card-inset overflow-hidden">
                        <div class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-surface-500 border-b border-black/[0.04] dark:border-white/[0.06] flex items-center justify-between">
                            <span class="flex items-center gap-1.5"><i class="pi pi-envelope text-[10px]" />Notificaciones enviadas</span>
                            <span class="text-surface-400">{{ selectedOrder.notif_history?.length || 0 }}</span>
                        </div>
                        <div v-if="!selectedOrder.notif_history?.length" class="px-3 py-3 text-xs text-surface-400 text-center">
                            Aún no se ha enviado ningún email. Se mandará automáticamente al cambiar de estado.
                        </div>
                        <div v-else class="max-h-32 overflow-auto divide-y divide-black/[0.04] dark:divide-white/[0.06]">
                            <div v-for="(n, i) in selectedOrder.notif_history" :key="i" class="px-3 py-2 text-xs">
                                <div class="flex items-center justify-between">
                                    <span class="font-medium flex items-center gap-1">
                                        <i :class="n.ok ? 'pi pi-check-circle text-green-500' : 'pi pi-times-circle text-red-500'" class="text-[10px]" />
                                        {{ n.to_status }}
                                    </span>
                                    <span class="text-[10px] text-surface-400">{{ fmtDate(n.sent_at) }}</span>
                                </div>
                                <div class="text-[10px] text-surface-400 truncate" :title="n.error || n.to">{{ n.error || n.to }}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ── Purge table (multicolor orders only) ── -->
            <div
                v-if="selectedOrder.is_multimaterial && selectedOrder.material_breakdown?.length > 1"
                class="mx-5 mb-5 p-4 rounded-xl card-inset border border-indigo-200/50 dark:border-indigo-800/40"
            >
                <OrderPurgeTable
                    :printer="selectedOrder.impresora"
                    :colors="selectedOrder.material_breakdown.map(b => b.color)"
                />
            </div>
        </div>

        <template #footer>
            <!-- Acciones en móvil: la barra de escritorio no se muestra, así que
                 viven aquí, ancladas abajo (zona del pulgar) y con etiqueta.
                 Eliminar se queda fuera a propósito: no se pone una acción
                 destructiva pegada a las de uso diario. -->
            <div v-if="isHandheld" class="flex flex-col gap-2 w-full">
                <div class="grid grid-cols-4 gap-2">
                    <button v-for="a in mobileOrderActions" :key="a.label" type="button"
                        class="flex flex-col items-center justify-center gap-1 min-h-14 rounded-xl card-inset transition-transform active:scale-95 disabled:opacity-40"
                        :disabled="a.disabled" @click="a.run()">
                        <i :class="a.icon" class="text-base" :style="a.color ? { color: a.color } : null" aria-hidden="true" />
                        <span class="text-[10px] font-medium leading-none">{{ a.label }}</span>
                    </button>
                </div>
                <div class="flex items-center gap-2">
                    <Button label="Cerrar" severity="secondary" outlined class="flex-1 !h-11" @click="closeDetail" />
                    <Button label="Guardar" icon="pi pi-save" severity="info" class="flex-1 !h-11" @click="saveOrderEdits" :disabled="isPartnerOrder" />
                </div>
            </div>

            <div v-else class="flex items-center justify-between w-full">
                <div class="flex items-center gap-1">
                    <Button
                        :label="selectedOrder?.archived ? 'Recuperar' : 'Archivar'"
                        :icon="selectedOrder?.archived ? 'pi pi-arrow-up-right-and-arrow-down-left-from-center' : 'pi pi-inbox'"
                        severity="secondary" text size="small"
                        @click="toggleArchive" :disabled="isPartnerOrder"
                    />
                    <Button
                        v-if="!selectedOrder?.archived && (Number(selectedOrder?.precio_final || 0) - Number(selectedOrder?.importe_pagado || 0)) > 0.01"
                        label="Cerrar con pérdida"
                        icon="pi pi-exclamation-circle"
                        severity="danger" text size="small"
                        @click="markAsLoss" :disabled="isPartnerOrder"
                        v-tooltip.top="'Archivar el pedido asumiendo que no se cobrará lo pendiente'"
                    />
                </div>
                <div class="flex items-center gap-2">
                    <Button label="Cerrar" severity="secondary" text size="small" @click="closeDetail" />
                    <Button label="Guardar cambios" icon="pi pi-save" severity="info" size="small" @click="saveOrderEdits" :disabled="isPartnerOrder" />
                </div>
            </div>
        </template>
    </Dialog>

    <!-- ═══════════════════════════════════════════════════════════════════
         Ticket Dialog
         ═══════════════════════════════════════════════════════════════════ -->
    <Dialog v-model:visible="ticketDialogVisible" modal :header="ticketTitle" :style="{ width: 'min(95vw, 42rem)' }">
        <pre class="whitespace-pre-wrap font-mono text-sm leading-relaxed p-4 rounded-xl card-inset max-h-[60vh] overflow-auto">{{ ticketContent }}</pre>
        <template #footer>
            <div class="flex items-center justify-end gap-2">
                <Button label="Copiar" icon="pi pi-copy" severity="secondary" text size="small" @click="copyTicket" />
                <Button label="Guardar PDF" icon="pi pi-file-pdf" severity="info" size="small" @click="pdfTicket" />
            </div>
        </template>
    </Dialog>

    <!-- ═══════════════════════════════════════════════════════════════════
         Modify / Recalculate Order Dialog
         ═══════════════════════════════════════════════════════════════════ -->
    <Dialog v-model:visible="modifyDialogVisible" modal header="Modificar Pedido" :style="{ width: 'min(95vw, 56rem)' }">
        <div class="flex flex-col gap-4">
            <div class="flex items-center gap-2 text-sm text-surface-500">
                <i class="pi pi-hashtag" />
                <span class="font-semibold">{{ selectedOrder?.id }}</span>
                <span>·</span>
                <span>{{ selectedOrder?.cliente }}</span>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <!-- Left: Project + Print -->
                <div class="flex flex-col gap-4">
                    <div class="p-3 card-inset rounded-xl">
                        <div class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-3">Proyecto</div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Cliente</label>
                                <InputText v-model="editForm.cliente" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Fecha</label>
                                <InputText v-model="editForm.fecha" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 col-span-full min-w-0">
                                <label class="text-xs text-surface-400">Descripción</label>
                                <InputText v-model="editForm.descripcion" class="w-full" />
                            </div>
                        </div>
                    </div>

                    <div class="p-3 card-inset rounded-xl">
                        <div class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-3">Impresión</div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Impresora</label>
                                <Select v-model="editForm.impresora" :options="printerOptions" optionLabel="label" optionValue="value" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Material</label>
                                <Select v-model="editForm.filamento_tipo" :options="filamentOptions" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Color</label>
                                <Select v-model="editForm.filamento_color" :options="editColorOptions" optionLabel="label" optionValue="value" :disabled="editForm.is_multimaterial" class="w-full">
                                    <template #option="slotProps">
                                        <div class="flex items-center gap-2">
                                            <span class="inline-block w-3 h-3 rounded-full border border-surface-300 dark:border-surface-600" :style="{ backgroundColor: slotProps.option.hex }" />
                                            <span>{{ slotProps.option.label }}</span>
                                        </div>
                                    </template>
                                </Select>
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Peso (g)</label>
                                <InputNumber v-model="editForm.peso_g" :disabled="editForm.is_multimaterial" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Tiempo (h)</label>
                                <InputNumber v-model="editForm.tiempo_h" :minFractionDigits="1" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Cantidad (ud.)</label>
                                <InputNumber v-model="editForm.cantidad" :min="1" :step="1" class="w-full" />
                            </div>
                        </div>
                        <div class="flex items-center gap-3 mt-3 p-2 bg-surface-100 dark:bg-surface-800 rounded-lg">
                            <Checkbox v-model="editForm.is_multimaterial" binary inputId="edit-multi" />
                            <label for="edit-multi" class="text-sm cursor-pointer">Multicolor / Multimaterial</label>
                        </div>
                        <div v-if="editForm.is_multimaterial" class="mt-3 flex flex-col gap-2 p-3 border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 rounded-lg">
                            <div class="flex items-center justify-between mb-1">
                                <span class="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Mezcla de colores</span>
                                <Button icon="pi pi-plus" size="small" text severity="success" @click="addEditMixLine" v-tooltip.top="'Añadir color'" />
                            </div>
                            <div v-for="(line, idx) in editMixLines" :key="idx" class="flex items-end gap-2">
                                <div class="flex flex-col gap-1 flex-1">
                                    <label v-if="idx === 0" class="text-[11px] text-surface-400">Material</label>
                                    <Select v-model="line.material" :options="filamentOptions" placeholder="Material" class="w-full" @update:modelValue="onEditMixMaterialChange(idx)" />
                                </div>
                                <div class="flex flex-col gap-1 flex-1">
                                    <label v-if="idx === 0" class="text-[11px] text-surface-400">Color</label>
                                    <Select v-model="line.color" :options="getColorOptionsByMaterial(line.material)" optionLabel="label" optionValue="value" placeholder="Color" class="w-full">
                                        <template #option="slotProps">
                                            <div class="flex items-center gap-2">
                                                <span class="inline-block w-3 h-3 rounded-full border border-surface-300 dark:border-surface-600" :style="{ backgroundColor: slotProps.option.hex }" />
                                                <span>{{ slotProps.option.label }}</span>
                                            </div>
                                        </template>
                                    </Select>
                                </div>
                                <div class="flex flex-col gap-1 w-20">
                                    <label v-if="idx === 0" class="text-[11px] text-surface-400">Peso (g)</label>
                                    <InputNumber v-model="line.grams" placeholder="g" suffix=" g" class="w-full" />
                                </div>
                                <div class="flex flex-col gap-1 w-20 shrink-0">
                                    <label v-if="idx === 0" class="text-[11px] text-surface-400">Gasto</label>
                                    <span class="text-sm font-mono font-semibold text-amber-600 dark:text-amber-400 py-2 text-center">{{ editMixLineCost(line).toFixed(2) }} {{ editUnit }}</span>
                                </div>
                                <Button v-if="editMixLines.length > 2" icon="pi pi-times" size="small" text severity="danger" class="shrink-0 mb-0.5" @click="removeEditMixLine(idx)" v-tooltip.top="'Quitar'" />
                            </div>
                            <div class="flex items-center justify-between mt-2 pt-2 border-t border-amber-200 dark:border-amber-700">
                                <span class="text-xs text-surface-500">Total: <strong>{{ editMixTotalGrams.toFixed(0) }} g</strong></span>
                                <span class="text-sm font-mono font-bold text-amber-600 dark:text-amber-400">{{ editMixTotalCost.toFixed(2) }} {{ editUnit }}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right: Cost factors + Shared -->
                <div class="flex flex-col gap-4">
                    <div class="p-3 card-inset rounded-xl">
                        <div class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-3">Factores de Coste</div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div class="flex flex-col gap-1 col-span-full min-w-0">
                                <label class="text-xs text-surface-400 flex items-center justify-between gap-2">
                                    <span>Diseño</span>
                                    <span class="text-[10px] text-surface-400">una vez por pedido</span>
                                </label>
                                <Select v-model="editForm.diseno_modelado" :options="editTarifas.diseno" optionLabel="label" optionValue="value" class="w-full">
                                    <template #option="{ option }">
                                        <div class="flex items-baseline justify-between gap-3 w-full min-w-0">
                                            <span class="truncate">{{ option.label }}</span>
                                            <span class="font-mono text-xs shrink-0" :class="option.eur > 0 || option.custom ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">
                                                {{ option.custom ? fmt(editLaborCostH) + '/h' : fmt(option.eur) }}
                                            </span>
                                        </div>
                                    </template>
                                </Select>
                                <InputNumber v-if="editEsDisenoAMedida" v-model="editForm.diseno_horas" :min="0" :step="0.25"
                                    :minFractionDigits="0" :maxFractionDigits="2" suffix=" h" class="w-full mt-1" />
                            </div>
                            <div class="flex flex-col gap-1 col-span-full min-w-0">
                                <label class="text-xs text-surface-400 flex items-center justify-between gap-2">
                                    <span>Post-procesado <span class="text-[10px]">(incluye soportes)</span></span>
                                    <span v-if="editCantidadUds > 1" class="text-[10px] text-amber-600 dark:text-amber-400">× {{ editCantidadUds }} uds.</span>
                                </label>
                                <Select v-model="editForm.postprocesado" :options="editTarifas.postproc" optionLabel="label" optionValue="value" class="w-full">
                                    <template #option="{ option }">
                                        <div class="flex items-baseline justify-between gap-3 w-full min-w-0">
                                            <span class="truncate">{{ option.label }}</span>
                                            <span class="font-mono text-xs shrink-0" :class="option.eur > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">
                                                {{ fmt(option.eur) }}<span v-if="editCantidadUds > 1" class="text-surface-400">/ud.</span>
                                            </span>
                                        </div>
                                    </template>
                                </Select>
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Prob. Error</label>
                                <Select v-model="editForm.probabilidad_error" :options="EDIT_OPTIONS.probError" optionLabel="label" optionValue="value" class="w-full" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label class="text-xs text-surface-400">Markup</label>
                                <Select v-if="editMarkupOptions.length > 1" v-model="editForm.markup" :options="editMarkupOptions" class="w-full" />
                                <div v-else class="flex items-center gap-2 px-3 py-2.5 rounded-lg card-inset text-xs text-surface-500">
                                    <span>{{ editForm.markup }}</span>
                                    <i class="pi pi-lock text-[10px] ml-auto" />
                                </div>
                            </div>
                            <div class="flex flex-col gap-1 col-span-full min-w-0">
                                <label class="text-xs text-surface-400">Urgencia</label>
                                <Select v-model="editForm.urgencia_nivel" :options="EDIT_OPTIONS.urgencia" class="w-full" />
                            </div>
                        </div>
                    </div>

                    <!-- Shared toggle -->
                    <div class="p-3 card-inset rounded-xl">
                        <div class="flex items-center gap-3">
                            <Checkbox v-model="editForm.is_shared" binary inputId="edit-shared" />
                            <label for="edit-shared" class="text-sm cursor-pointer font-medium">Compartido (3DCC + SILAB3D)</label>
                        </div>
                        <div v-if="editForm.is_shared" class="mt-3">
                            <div class="flex items-center gap-3">
                                <div class="flex flex-col items-center min-w-[50px]">
                                    <span class="text-xs font-semibold text-blue-500">3DCC</span>
                                    <span class="text-sm font-bold text-blue-600 dark:text-blue-400">{{ editForm.shared_percent_3dcc }}%</span>
                                </div>
                                <Slider v-model="editForm.shared_percent_3dcc" :min="0" :max="100" :step="5" class="flex-1"
                                    @update:modelValue="(v) => { editForm.shared_percent_silab3d = 100 - v }" />
                                <div class="flex flex-col items-center min-w-[50px]">
                                    <span class="text-xs font-semibold text-purple-500">SILAB3D</span>
                                    <span class="text-sm font-bold text-purple-600 dark:text-purple-400">{{ editForm.shared_percent_silab3d }}%</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Extras / Misc -->
                    <div class="p-3 card-inset rounded-xl">
                        <div class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                            <i class="pi pi-tag text-xs" /> Extras / Misceláneos
                        </div>
                        <InputNumber v-model="editForm.gasto_misc" :min="0" :minFractionDigits="2" :maxFractionDigits="2"
                            class="w-full" placeholder="Anillas, llaveros, embalaje..." />
                        <small class="text-surface-400 mt-1 block">Importe directo añadido al precio final (sin markup)</small>
                    </div>

                    <!-- Price comparison -->
                    <div class="p-3 card-inset rounded-xl">
                        <div class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-3">Comparación de precio</div>
                        <div class="grid grid-cols-2 gap-3 text-center">
                            <div>
                                <div class="text-xs text-surface-400">Precio actual</div>
                                <div class="text-xl font-bold">{{ (selectedOrder?.precio_final ?? 0).toFixed(2) }} {{ unit }}</div>
                            </div>
                            <div v-if="modifyPreview">
                                <div class="text-xs text-surface-400">Nuevo precio</div>
                                <div class="text-xl font-bold" :class="modifyPreview.delta > 0 ? 'text-red-500' : modifyPreview.delta < 0 ? 'text-green-500' : ''">
                                    {{ modifyPreview.newPrice.toFixed(2) }} {{ unit }}
                                </div>
                                <div v-if="modifyPreview.delta !== 0" class="text-xs mt-1" :class="modifyPreview.delta > 0 ? 'text-red-400' : 'text-green-400'">
                                    {{ modifyPreview.delta > 0 ? '+' : '' }}{{ modifyPreview.delta.toFixed(2) }} {{ unit }}
                                </div>
                            </div>
                            <div v-else>
                                <div class="text-xs text-surface-400">Nuevo precio</div>
                                <div class="text-lg text-surface-400 mt-1">Pulsa recalcular</div>
                            </div>
                        </div>
                        <div v-if="modifyPreview" class="grid grid-cols-2 gap-3 text-center mt-3 text-xs">
                            <div>
                                <span class="text-surface-400">Coste: </span>
                                <span class="font-semibold">{{ modifyPreview.newCoste.toFixed(2) }} {{ unit }}</span>
                            </div>
                            <div>
                                <span class="text-surface-400">Beneficio: </span>
                                <span class="font-semibold text-green-500">{{ modifyPreview.newBeneficio.toFixed(2) }} {{ unit }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <template #footer>
            <div class="flex items-center justify-between w-full">
                <Button label="Cancelar" severity="secondary" text @click="modifyDialogVisible = false" />
                <div class="flex gap-2">
                    <Button label="Recalcular" icon="pi pi-refresh" severity="warn" outlined @click="previewModify" :loading="modifyLoading" />
                    <Button label="Guardar Cambios" icon="pi pi-save" severity="success" @click="saveModify" :loading="modifyLoading" :disabled="!modifyPreview" />
                </div>
            </div>
        </template>
    </Dialog>

    <!-- ═══ Link amount Dialog ═══ -->
    <Dialog v-model:visible="linkDialog.visible" modal header="Generar enlace de pago" :style="{ width: 'min(90vw, 26rem)' }">
        <div class="flex flex-col gap-4 p-1">
            <div class="text-sm text-surface-500">Pendiente: <strong>{{ fmt(linkDialog.pending) }}</strong></div>
            <div class="flex flex-col gap-1 min-w-0">
                <label class="text-xs text-surface-500 uppercase tracking-wider font-semibold">Importe a cobrar</label>
                <InputNumber v-model="linkDialog.amount" :min="0.01" :minFractionDigits="2" :maxFractionDigits="2" class="w-full" />
                <small class="text-surface-400">Puede ser mayor que el pendiente (incluye propina)</small>
            </div>
        </div>
        <template #footer>
            <Button label="Cancelar" severity="secondary" text @click="linkDialog.visible = false" />
            <Button label="Generar enlace" icon="pi pi-wallet" severity="help" @click="generateLink" :disabled="!linkDialog.amount || linkDialog.amount <= 0" />
        </template>
    </Dialog>

    <!-- ═══ Email notification confirmation ═══ -->
    <EmailNotifyDialog
        v-model:visible="emailConfirmState.visible"
        :order="emailConfirmState.order"
        :old-status="emailConfirmState.oldStatus"
        :new-status="emailConfirmState.newStatus"
        :recipient-email="emailConfirmState.recipientEmail"
        :title="emailConfirmState.title"
        @update:recipient-email="(v) => emailConfirmState.recipientEmail = v"
        @confirm="onEmailDialogSend"
        @skip="onEmailDialogSkip"
        @cancel="onEmailDialogCancel"
    />

    <!-- ═══ Undo delete banner ═══ -->
    <Transition name="fade-up">
        <div v-if="pendingDelete.order"
            class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border bg-surface-800 dark:bg-surface-700 border-surface-600 text-white">
            <i class="pi pi-trash text-red-400" />
            <span class="text-sm">Pedido <strong>#{{ pendingDelete.order.id }}</strong> eliminado</span>
            <Button label="Deshacer" size="small" text @click="undoDelete" class="!text-amber-400 hover:!text-amber-300 font-semibold !p-0 ml-1" />
        </div>
    </Transition>
</template>

<style scoped>
.fade-up-enter-active, .fade-up-leave-active { transition: all 0.25s ease; }
.fade-up-enter-from, .fade-up-leave-to { opacity: 0; transform: translateX(-50%) translateY(12px); }
</style>
