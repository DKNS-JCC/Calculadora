<script setup>
/**
 * Estadísticas — qué dinero ha entrado de verdad, no cuánto se ha presupuestado.
 *
 * Tres lecturas que antes iban mezcladas y ahora van separadas:
 *
 *   FACTURADO  se imputa a la fecha del PEDIDO. Es lo comprometido.
 *   CAJA       se imputa a la fecha del COBRO, leyendo `payment_history`.
 *              Un pedido de marzo cobrado en mayo es caja de mayo.
 *   PENDIENTE  es un saldo a día de hoy: no depende del rango elegido.
 *
 * El coste que se usa aquí es `orderRealCost`: descuenta las reimpresiones y
 * los gastos extra, cosas que `beneficio_neto` no descuenta y que inflaban el
 * margen. Ver el bloque "Dinero real" de shared/backend.mjs.
 */
import { computed, ref } from 'vue'
import { store } from '../store'
import { orderShare as _orderShare } from '../utils/orderShare'
import {
    ORDER_DISCARDED,
    isCommitted,
    orderCashEvents,
    orderRealCost,
    normalizeEstado,
} from '../shared/backend.mjs'
import ChartCard from './ChartCard.vue'
import DatePicker from 'primevue/datepicker'
import Select from 'primevue/select'

/* ── Base ──────────────────────────────────────────────────────────────── */
const orders = computed(() => store.appData.orders || [])
const unit = computed(() => store.appData.global_config.money_unit)
const orderShare = (o) => _orderShare(o, store.empresa)

const DAY = 86400000
const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMoney = (v) => `${nf.format(Number(v) || 0)} ${unit.value}`
const fmtShort = (v) => {
    const n = Number(v) || 0
    return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0)
}

const parseDate = (str) => {
    if (!str) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, d] = str.split('-').map(Number)
        return new Date(y, m - 1, d)
    }
    const parts = String(str).split('/')
    if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0])
    const d = new Date(str)
    return isNaN(d.getTime()) ? null : d
}
const monthKey = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const monthName = (key) => {
    const [y, m] = key.split('-').map(Number)
    const mes = new Date(y, m - 1, 1).toLocaleString('es-ES', { month: 'short' }).replace('.', '')
    return `${mes} ${String(y).slice(2)}`
}
const median = (arr) => {
    if (!arr.length) return 0
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* ── Rango de fechas ───────────────────────────────────────────────────── */
const rangeFrom = ref(null)
const rangeTo = ref(null)

const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const endOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()

/** Fechas de pedido presentes en los datos, para poder resolver "sin límite". */
const orderTimestamps = computed(() =>
    orders.value.map(o => parseDate(o.fecha)).filter(Boolean).map(d => d.getTime())
)

const effFrom = computed(() =>
    rangeFrom.value
        ? startOf(rangeFrom.value)
        : (orderTimestamps.value.length ? Math.min(...orderTimestamps.value) : 0)
)
const effTo = computed(() =>
    rangeTo.value
        ? endOf(rangeTo.value)
        : (orderTimestamps.value.length ? Math.max(...orderTimestamps.value, Date.now()) : Date.now())
)
const curSpan = computed(() => ({ from: effFrom.value, to: effTo.value }))
/** Periodo anterior de la misma longitud, pegado al inicio del actual. */
const prevSpan = computed(() => {
    const len = effTo.value - effFrom.value
    return { from: effFrom.value - len - 1, to: effFrom.value - 1 }
})

const inSpan = (ts, span) => ts >= span.from && ts <= span.to
const orderTs = (o) => {
    const d = parseDate(o.fecha)
    return d ? d.getTime() : null
}

/* ── Cortes de pedidos ─────────────────────────────────────────────────── */
/** Todos los pedidos con fecha dentro del rango, sea cual sea su estado. */
const inRange = computed(() => orders.value.filter(o => {
    const ts = orderTs(o)
    return ts !== null && inSpan(ts, curSpan.value)
}))
/** Comprometidos: los únicos que cuentan como facturación. */
const committed = computed(() => inRange.value.filter(isCommitted))
const committedPrev = computed(() => orders.value.filter(o => {
    const ts = orderTs(o)
    return ts !== null && inSpan(ts, prevSpan.value) && isCommitted(o)
}))

/** Fila con todo lo económico ya prorrateado por el reparto del pedido. */
const money = (o) => {
    const s = orderShare(o)
    const facturado = Number(o.precio_final || 0) * s
    const coste = orderRealCost(o) * s
    return { facturado, coste, beneficio: facturado - coste, pagado: Number(o.importe_pagado || 0) * s }
}
const sumMoney = (list) => list.reduce((acc, o) => {
    const m = money(o)
    acc.facturado += m.facturado
    acc.coste += m.coste
    acc.beneficio += m.beneficio
    return acc
}, { facturado: 0, coste: 0, beneficio: 0 })

const cur = computed(() => sumMoney(committed.value))
const prev = computed(() => sumMoney(committedPrev.value))
/** Sólo se comparan periodos si el anterior tiene algo con lo que comparar. */
const hasPrev = computed(() => committedPrev.value.length > 0)

/* ── Caja: cobros por su propia fecha ──────────────────────────────────── */
/** Todos los cobros de todos los pedidos, prorrateados y con fecha real. */
const allCash = computed(() => {
    const out = []
    for (const o of orders.value) {
        const s = orderShare(o)
        for (const e of orderCashEvents(o)) {
            if (!e.ts) continue
            out.push({ ts: e.ts, amount: e.amount * s, method: e.method })
        }
    }
    return out.sort((a, b) => a.ts - b.ts)
})
const cashIn = (span) => allCash.value.filter(e => inSpan(e.ts, span)).reduce((s, e) => s + e.amount, 0)
const cobrado = computed(() => cashIn(curSpan.value))
const cobradoPrev = computed(() => cashIn(prevSpan.value))
const cashInRange = computed(() => allCash.value.filter(e => inSpan(e.ts, curSpan.value)))

/* ── Pendiente de cobro: saldo a día de hoy, ajeno al rango ────────────── */
const deudas = computed(() => {
    const now = Date.now()
    return orders.value
        .filter(isCommitted)
        .map(o => {
            const s = orderShare(o)
            const saldo = (Number(o.precio_final || 0) - Number(o.importe_pagado || 0)) * s
            const ts = orderTs(o) || 0
            return { o, saldo, dias: ts ? Math.floor((now - ts) / DAY) : 0 }
        })
        .filter(d => d.saldo > 0.01)
        .sort((a, b) => b.dias - a.dias)
})
const totalPendiente = computed(() => deudas.value.reduce((s, d) => s + d.saldo, 0))

/* El primer tramo abre por abajo sin límite: un pedido fechado en el futuro
 * da días negativos y, con `min: 0`, se caería de todos los tramos y el
 * desglose dejaría de sumar el total. */
const AGING = [
    { label: 'Menos de 15 d', min: -Infinity, max: 15, tone: 'text-emerald-600 dark:text-emerald-400' },
    { label: '15 – 30 d', min: 15, max: 30, tone: 'text-amber-600 dark:text-amber-400' },
    { label: '30 – 60 d', min: 30, max: 60, tone: 'text-orange-600 dark:text-orange-400' },
    { label: 'Más de 60 d', min: 60, max: Infinity, tone: 'text-red-600 dark:text-red-400' },
]
const aging = computed(() => AGING.map(b => {
    const rows = deudas.value.filter(d => d.dias >= b.min && d.dias < b.max)
    return { ...b, count: rows.length, amount: rows.reduce((s, d) => s + d.saldo, 0) }
}))

/* ── Sobrecostes que el beneficio_neto guardado no descuenta ───────────── */
const costeReimpresiones = computed(() => committed.value.reduce((s, o) => {
    const reps = Math.max(0, Math.floor(Number(o.repeticiones_error) || 0))
    return s + Number(o.coste_bruto || 0) * reps * orderShare(o)
}, 0))
const gastosExtra = computed(() =>
    committed.value.reduce((s, o) => s + Number(o.gasto_misc || 0) * orderShare(o), 0)
)

/* ── KPIs derivados ────────────────────────────────────────────────────── */
const margen = (m) => (m.facturado > 0 ? (m.beneficio / m.facturado) * 100 : 0)
const margenActual = computed(() => margen(cur.value))
const margenPrevio = computed(() => margen(prev.value))

const tickets = computed(() => committed.value.map(o => money(o).facturado).filter(v => v > 0))
const ticketMedio = computed(() => (tickets.value.length ? cur.value.facturado / tickets.value.length : 0))
const ticketMediana = computed(() => median(tickets.value))

/** Presupuestos emitidos en el rango y qué fue de ellos. */
const embudo = computed(() => {
    const descartados = inRange.value.filter(o => normalizeEstado(o.estado) === ORDER_DISCARDED)
    const emitidos = inRange.value.length
    const aceptados = committed.value.length
    const resueltos = aceptados + descartados.length
    return {
        emitidos,
        aceptados,
        descartados: descartados.length,
        abiertos: emitidos - aceptados - descartados.length,
        conversion: resueltos > 0 ? (aceptados / resueltos) * 100 : 0,
        perdido: descartados.reduce((s, o) => s + Number(o.precio_final || 0) * orderShare(o), 0),
    }
})

/** Días desde el pedido hasta el último cobro. Mediana: la media la revientan los morosos. */
const diasCobro = computed(() => {
    const lags = []
    for (const o of committed.value) {
        const ts = orderTs(o)
        const ev = orderCashEvents(o).filter(e => e.amount > 0 && e.ts)
        if (!ts || !ev.length) continue
        lags.push(Math.max(0, (Math.max(...ev.map(e => e.ts)) - ts) / DAY))
    }
    return median(lags)
})

/* ── Clientes ──────────────────────────────────────────────────────────── */
const clientes = computed(() => {
    const map = new Map()
    for (const o of committed.value) {
        const key = String(o.cliente || '').trim().toLowerCase()
        if (!key) continue
        const acc = map.get(key) || { nombre: String(o.cliente).trim(), pedidos: 0, facturado: 0 }
        acc.pedidos += 1
        acc.facturado += money(o).facturado
        map.set(key, acc)
    }
    return [...map.values()].sort((a, b) => b.facturado - a.facturado)
})
const recurrentes = computed(() => clientes.value.filter(c => c.pedidos > 1))
const pctRecurrente = computed(() => {
    const total = clientes.value.reduce((s, c) => s + c.facturado, 0)
    if (total <= 0) return 0
    return (recurrentes.value.reduce((s, c) => s + c.facturado, 0) / total) * 100
})

/* ── Producción: sólo lo que se imprime de verdad ──────────────────────── */
const pesoTotal = computed(() => committed.value.reduce((s, o) => s + Number(o.peso_g || 0) * orderShare(o), 0))
const horasTotal = computed(() => committed.value.reduce((s, o) => s + Number(o.horas || 0) * orderShare(o), 0))
const piezasTotal = computed(() => committed.value.reduce((s, o) => s + Math.max(1, Number(o.cantidad) || 1), 0))
const eurPorHora = computed(() => (horasTotal.value > 0 ? cur.value.beneficio / horasTotal.value : 0))
const eurPorKg = computed(() => (pesoTotal.value > 0 ? cur.value.facturado / (pesoTotal.value / 1000) : 0))

const topBy = (list, keyFn) => {
    const c = {}
    for (const o of list) {
        const k = keyFn(o) || '—'
        c[k] = (c[k] || 0) + 1
    }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || '—'
}
const topMaterial = computed(() => topBy(committed.value, o => o.filamento))
const topPrinter = computed(() => topBy(committed.value, o => o.impresora))

const findPrinterForOrder = (order) => {
    const printers = store.appData.printers || []
    if (!printers.length) return null
    const target = String(order.impresora || '').trim().toLowerCase()
    if (!target) return null
    return printers.find(p => String(p.name || '').toLowerCase() === target)
        || printers.find(p => target.includes(String(p.name || '').toLowerCase()))
        || printers.find(p => String(p.name || '').toLowerCase().includes(target))
        || null
}
/** La luz ya está dentro del coste: esto sólo la aísla para saber cuánto pesa. */
const totalElectricidad = computed(() => {
    const rate = Number(store.appData.global_config?.energy_cost_kwh || 0)
    if (!rate) return 0
    return committed.value.reduce((sum, order) => {
        const printer = findPrinterForOrder(order)
        if (!printer) return sum
        const hours = Number(order.horas || 0)
        const consumption = Number(printer.energy_consumption_kwh || 0)
        return (hours && consumption) ? sum + hours * consumption * rate * orderShare(order) : sum
    }, 0)
})

/* ── Gramos por material, del desglose multimaterial cuando lo hay ─────── */
const gramosPorMaterial = computed(() => {
    const c = {}
    for (const o of committed.value) {
        const s = orderShare(o)
        const bd = Array.isArray(o.material_breakdown) ? o.material_breakdown : []
        if (bd.length) {
            for (const m of bd) {
                const k = String(m.material || 'Otro')
                c[k] = (c[k] || 0) + Number(m.grams || 0) * s
            }
        } else {
            const k = String(o.filamento || 'Otro')
            c[k] = (c[k] || 0) + Number(o.peso_g || 0) * s
        }
    }
    return Object.entries(c).filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1])
})

/* ── Paleta y gráficos ─────────────────────────────────────────────────── */
const PALETTE = { facturado: '#60a5fa', coste: '#f87171', caja: '#34d399', material: '#a78bfa' }
/* Gris azulado con poca opacidad: legible tanto en claro como en oscuro. */
const axis = { tick: '#94a3b8', grid: 'rgba(148,163,184,0.18)' }

const METHOD_COLORS = {
    'Efectivo': '#22c55e',
    'Bizum': '#3b82f6',
    'Transferencia': '#a855f7',
    'Stripe': '#fb923c',
    'Otro': '#6b7280',
    'Sin registrar': '#94a3b8',
}
const EXTRA_COLORS = ['#f472b6', '#22d3ee', '#facc15', '#84cc16']
const colorForMethod = (m, i) => METHOD_COLORS[m] || EXTRA_COLORS[i % EXTRA_COLORS.length]

const serieMensual = computed(() => {
    const buckets = {}
    const touch = (k) => (buckets[k] ||= { facturado: 0, coste: 0, caja: 0 })
    for (const o of committed.value) {
        const ts = orderTs(o)
        if (!ts) continue
        const m = money(o)
        const b = touch(monthKey(ts))
        b.facturado += m.facturado
        b.coste += m.coste
    }
    for (const e of cashInRange.value) touch(monthKey(e.ts)).caja += e.amount
    return Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))
})

const chartFacturacion = computed(() => {
    const s = serieMensual.value
    return {
        labels: s.map(([k]) => monthName(k)),
        datasets: [
            {
                type: 'bar', label: 'Facturado', data: s.map(([, v]) => v.facturado),
                backgroundColor: 'rgba(96,165,250,0.7)', borderColor: PALETTE.facturado,
                borderWidth: 1, borderRadius: 6, barPercentage: 0.8, order: 2,
            },
            {
                type: 'bar', label: 'Coste real', data: s.map(([, v]) => v.coste),
                backgroundColor: 'rgba(248,113,113,0.7)', borderColor: PALETTE.coste,
                borderWidth: 1, borderRadius: 6, barPercentage: 0.8, order: 3,
            },
            {
                type: 'line', label: 'Caja cobrada', data: s.map(([, v]) => v.caja),
                borderColor: PALETTE.caja, backgroundColor: PALETTE.caja,
                borderWidth: 2.5, tension: 0.3, pointRadius: 3, pointHoverRadius: 5, order: 1,
            },
        ],
    }
})

const chartMetodos = computed(() => {
    const months = {}
    const methods = new Set()
    for (const e of cashInRange.value) {
        const k = monthKey(e.ts)
        months[k] ||= {}
        months[k][e.method] = (months[k][e.method] || 0) + e.amount
        methods.add(e.method)
    }
    const keys = Object.keys(months).sort()
    const list = [...methods].sort()
    return {
        labels: keys.map(monthName),
        datasets: list.map((m, i) => ({
            label: m,
            data: keys.map(k => months[k][m] || 0),
            backgroundColor: colorForMethod(m, i),
            borderRadius: 4,
            barPercentage: 0.85,
        })),
    }
})

const cobrosPorMetodo = computed(() => {
    const c = {}
    for (const e of cashInRange.value) c[e.method] = (c[e.method] || 0) + e.amount
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([name, amount]) => ({
        name,
        amount,
        color: METHOD_COLORS[name] || '#94a3b8',
        pct: cobrado.value > 0 ? (amount / cobrado.value) * 100 : 0,
    }))
})

const ESTADO_COLORS = {
    'Entregado': '#34d399',
    'Listo para entregar': '#22d3ee',
    'Post-procesado': '#a78bfa',
    'En producción': '#60a5fa',
    'Aceptado': '#fbbf24',
    'Presupuesto enviado': '#fb923c',
    'Nuevo': '#f472b6',
    [ORDER_DISCARDED]: '#94a3b8',
}
const chartEstados = computed(() => {
    const counts = {}
    for (const o of inRange.value) {
        const s = normalizeEstado(o.estado)
        counts[s] = (counts[s] || 0) + 1
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    return {
        labels: sorted.map(([l]) => l),
        datasets: [{
            data: sorted.map(([, v]) => v),
            backgroundColor: sorted.map(([l], i) => ESTADO_COLORS[l] || EXTRA_COLORS[i % EXTRA_COLORS.length]),
            borderWidth: 0,
            hoverOffset: 8,
        }],
    }
})

const chartClientes = computed(() => {
    const top = clientes.value.slice(0, 8)
    return {
        labels: top.map(c => c.nombre),
        datasets: [{
            label: 'Facturado',
            data: top.map(c => c.facturado),
            backgroundColor: 'rgba(96,165,250,0.75)',
            borderColor: PALETTE.facturado,
            borderWidth: 1,
            borderRadius: 5,
        }],
    }
})

const chartMateriales = computed(() => {
    const top = gramosPorMaterial.value.slice(0, 8)
    return {
        labels: top.map(([m]) => m),
        datasets: [{
            label: 'Gramos',
            data: top.map(([, g]) => g),
            backgroundColor: 'rgba(167,139,250,0.75)',
            borderColor: PALETTE.material,
            borderWidth: 1,
            borderRadius: 5,
        }],
    }
})

/* ── Opciones de gráfico ───────────────────────────────────────────────── */
const legendLabels = { color: axis.tick, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 12, font: { size: 11 } }
const moneyTooltip = { callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed?.y ?? c.parsed?.x ?? c.raw ?? 0)}` } }

const optsFacturacion = {
    plugins: { legend: { labels: legendLabels }, tooltip: moneyTooltip },
    interaction: { mode: 'index', intersect: false },
    scales: {
        x: { ticks: { color: axis.tick, font: { size: 11 } }, grid: { color: axis.grid }, offset: true },
        y: { beginAtZero: true, grace: '12%', ticks: { color: axis.tick, callback: fmtShort }, grid: { color: axis.grid } },
    },
}
const optsStacked = {
    plugins: { legend: { labels: legendLabels }, tooltip: moneyTooltip },
    interaction: { mode: 'index', intersect: false },
    scales: {
        x: { stacked: true, ticks: { color: axis.tick, font: { size: 11 } }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: axis.tick, callback: fmtShort }, grid: { color: axis.grid } },
    },
}
const optsHBar = {
    indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: moneyTooltip },
    scales: {
        x: { beginAtZero: true, ticks: { color: axis.tick, callback: fmtShort }, grid: { color: axis.grid } },
        y: { ticks: { color: axis.tick, font: { size: 11 } }, grid: { display: false } },
    },
}
const optsHBarGrams = {
    ...optsHBar,
    plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${nf.format((c.parsed?.x ?? 0) / 1000)} kg` } },
    },
}
const optsDoughnut = {
    cutout: '58%',
    plugins: {
        legend: { position: 'bottom', labels: legendLabels },
        tooltip: {
            callbacks: {
                label: (c) => {
                    const t = (c.dataset?.data || []).reduce((s, v) => s + Number(v || 0), 0)
                    return `${c.label}: ${c.raw} (${t > 0 ? ((c.raw / t) * 100).toFixed(0) : 0}%)`
                },
            },
        },
    },
}

/* ── Presets de periodo ────────────────────────────────────────────────── */
const setDays = (n) => {
    const now = new Date()
    const d = new Date(now)
    d.setDate(d.getDate() - (n - 1))
    rangeFrom.value = d
    rangeTo.value = now
}
const setThisMonth = () => {
    const now = new Date()
    rangeFrom.value = new Date(now.getFullYear(), now.getMonth(), 1)
    rangeTo.value = new Date(now.getFullYear(), now.getMonth() + 1, 0)
}
const setThisYear = () => {
    const now = new Date()
    rangeFrom.value = new Date(now.getFullYear(), 0, 1)
    rangeTo.value = new Date(now.getFullYear(), 11, 31)
}
const clearRange = () => { rangeFrom.value = null; rangeTo.value = null }

const selectedMonth = ref(null)
const monthOptions = computed(() => {
    const map = new Map()
    for (const o of orders.value) {
        const d = parseDate(o.fecha)
        if (!d) continue
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        if (map.has(key)) continue
        const name = d.toLocaleString('es-ES', { month: 'long' })
        map.set(key, {
            label: `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d.getFullYear()}`,
            date: new Date(d.getFullYear(), d.getMonth(), 1),
            key,
        })
    }
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key))
})
const applyMonth = () => {
    if (!selectedMonth.value) return
    const d = selectedMonth.value.date
    rangeFrom.value = new Date(d.getFullYear(), d.getMonth(), 1)
    rangeTo.value = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    // Se limpia la selección para poder volver a elegir el mismo mes más tarde.
    setTimeout(() => { selectedMonth.value = null }, 100)
}

const rangeLabel = computed(() => {
    const fmt = (ts) => new Date(ts).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' })
    return `${fmt(effFrom.value)} → ${fmt(effTo.value)}`
})

/* ── Variación contra el periodo anterior ──────────────────────────────── */
const delta = (now, before) => {
    if (!hasPrev.value || !before) return null
    return ((now - before) / Math.abs(before)) * 100
}
const deltaClass = (d) => (d === null ? '' : d >= 0 ? 'text-emerald-500' : 'text-red-500')
const deltaText = (d) => (d === null ? '' : `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%`)

/* ── Exportación ───────────────────────────────────────────────────────── */
const exportCSV = () => {
    if (!inRange.value.length) return
    const headers = ['ID', 'Fecha', 'Cliente', 'Estado', 'Material', 'Cantidad', 'Facturado', 'Coste real', 'Beneficio real', 'Cobrado', 'Pendiente', 'Metodos de cobro']
    const rows = inRange.value.map(o => {
        const m = money(o)
        const metodos = [...new Set(orderCashEvents(o).map(e => e.method))].join(' + ')
        return [
            o.id,
            o.fecha,
            `"${String(o.cliente || '').replace(/"/g, '""')}"`,
            normalizeEstado(o.estado),
            o.filamento || '',
            Math.max(1, Number(o.cantidad) || 1),
            m.facturado.toFixed(2),
            m.coste.toFixed(2),
            m.beneficio.toFixed(2),
            m.pagado.toFixed(2),
            Math.max(0, m.facturado - m.pagado).toFixed(2),
            `"${metodos}"`,
        ]
    })
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.setAttribute('download', `estadisticas_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- ═══ Periodo ═══ -->
        <div class="flex flex-wrap items-center justify-between gap-3 p-3 card rounded-2xl">
            <div class="flex flex-wrap items-center gap-2">
                <span class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider mr-1">Período</span>
                <DatePicker v-model="rangeFrom" dateFormat="dd/mm/yy" showIcon iconDisplay="input" placeholder="Desde" class="w-36" showButtonBar />
                <span class="text-surface-400 text-sm">→</span>
                <DatePicker v-model="rangeTo" dateFormat="dd/mm/yy" showIcon iconDisplay="input" placeholder="Hasta" class="w-36" showButtonBar />

                <div class="flex flex-wrap gap-1 ml-1">
                    <button @click="setDays(30)" class="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">30D</button>
                    <button @click="setDays(90)" class="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">90D</button>
                    <button @click="setThisMonth" class="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">Mes</button>
                    <button @click="setThisYear" class="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">Año</button>
                    <Select v-model="selectedMonth" :options="monthOptions" optionLabel="label" placeholder="Mes…" @change="applyMonth" class="w-32 !text-xs !py-0 flex items-center ml-1 h-[32px]" />
                </div>

                <button v-if="rangeFrom || rangeTo" @click="clearRange"
                    class="px-2.5 py-0.5 ml-1 rounded-full text-[11px] font-medium border border-surface-300 dark:border-surface-600 text-surface-500 hover:border-red-400 hover:text-red-400 transition-colors cursor-pointer">
                    Todo
                </button>
            </div>

            <div class="flex items-center gap-3">
                <div class="text-right leading-tight">
                    <div class="text-[11px] text-surface-500">{{ rangeLabel }}</div>
                    <div class="text-[10px] text-surface-400">{{ committed.length }} aceptados · {{ inRange.length }} presupuestos</div>
                </div>
                <button @click="exportCSV" :disabled="!inRange.length" title="Exportar a CSV"
                    class="w-8 h-8 rounded-full flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 text-surface-500 cursor-pointer">
                    <i class="pi pi-download text-sm"></i>
                </button>
            </div>
        </div>

        <!-- ═══ Dinero ═══ -->
        <div>
            <div class="flex items-baseline justify-between mb-2 px-1 gap-3">
                <div class="text-[10px] text-surface-400 uppercase tracking-widest font-semibold">Dinero · pedidos aceptados</div>
                <div v-if="hasPrev" class="text-[10px] text-surface-400 shrink-0">vs. periodo anterior ({{ committedPrev.length }} pedidos)</div>
            </div>
            <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-blue-500 font-semibold uppercase tracking-wider">Facturado</div>
                    <div class="text-xl font-bold text-blue-700 dark:text-blue-300 mt-0.5 tabular-nums">{{ fmtMoney(cur.facturado) }}</div>
                    <div class="text-[10px] mt-1 flex items-center gap-1.5">
                        <span :class="deltaClass(delta(cur.facturado, prev.facturado))">{{ deltaText(delta(cur.facturado, prev.facturado)) }}</span>
                        <span class="text-surface-400">{{ committed.length }} pedidos</span>
                    </div>
                </div>

                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-green-500 font-semibold uppercase tracking-wider">Caja cobrada</div>
                    <div class="text-xl font-bold text-green-700 dark:text-green-300 mt-0.5 tabular-nums">{{ fmtMoney(cobrado) }}</div>
                    <div class="text-[10px] mt-1 flex items-center gap-1.5">
                        <span :class="deltaClass(delta(cobrado, cobradoPrev))">{{ deltaText(delta(cobrado, cobradoPrev)) }}</span>
                        <span class="text-surface-400">por fecha de cobro</span>
                    </div>
                </div>

                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-emerald-500 font-semibold uppercase tracking-wider">Beneficio real</div>
                    <div class="text-xl font-bold text-emerald-700 dark:text-emerald-300 mt-0.5 tabular-nums">{{ fmtMoney(cur.beneficio) }}</div>
                    <div class="text-[10px] mt-1 flex items-center gap-1.5">
                        <span :class="deltaClass(delta(cur.beneficio, prev.beneficio))">{{ deltaText(delta(cur.beneficio, prev.beneficio)) }}</span>
                        <span class="text-surface-400">margen {{ margenActual.toFixed(1) }}%</span>
                    </div>
                </div>

                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-red-500 font-semibold uppercase tracking-wider">Coste real</div>
                    <div class="text-xl font-bold text-red-700 dark:text-red-300 mt-0.5 tabular-nums">{{ fmtMoney(cur.coste) }}</div>
                    <div class="text-[10px] text-surface-400 mt-1">
                        + {{ fmtMoney(costeReimpresiones) }} reimpresión · {{ fmtMoney(gastosExtra) }} extras
                    </div>
                </div>

                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-amber-500 font-semibold uppercase tracking-wider">Pendiente de cobro</div>
                    <div class="text-xl font-bold text-amber-700 dark:text-amber-300 mt-0.5 tabular-nums">{{ fmtMoney(totalPendiente) }}</div>
                    <div class="text-[10px] text-surface-400 mt-1">
                        {{ deudas.length }} pedido{{ deudas.length === 1 ? '' : 's' }} · a día de hoy
                    </div>
                </div>

                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-purple-500 font-semibold uppercase tracking-wider">Margen real</div>
                    <div class="text-xl font-bold text-purple-700 dark:text-purple-300 mt-0.5 tabular-nums">{{ margenActual.toFixed(1) }}%</div>
                    <div class="text-[10px] mt-1 flex items-center gap-1.5">
                        <span v-if="hasPrev" :class="deltaClass(margenActual - margenPrevio)">
                            {{ (margenActual - margenPrevio) >= 0 ? '▲' : '▼' }} {{ Math.abs(margenActual - margenPrevio).toFixed(1) }} pp
                        </span>
                        <span class="text-surface-400">tras reimpresiones</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- ═══ Comercial ═══ -->
        <div>
            <div class="text-[10px] text-surface-400 uppercase tracking-widest font-semibold mb-2 px-1">Comercial</div>
            <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Conversión</div>
                    <div class="text-xl font-bold mt-0.5 tabular-nums">{{ embudo.conversion.toFixed(0) }}%</div>
                    <div class="text-[10px] text-surface-400 mt-1">{{ embudo.aceptados }} sí · {{ embudo.descartados }} no · {{ embudo.abiertos }} abiertos</div>
                </div>
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Perdido</div>
                    <div class="text-xl font-bold mt-0.5 tabular-nums text-surface-500">{{ fmtMoney(embudo.perdido) }}</div>
                    <div class="text-[10px] text-surface-400 mt-1">presupuestos descartados</div>
                </div>
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Ticket medio</div>
                    <div class="text-xl font-bold mt-0.5 tabular-nums">{{ fmtMoney(ticketMedio) }}</div>
                    <div class="text-[10px] text-surface-400 mt-1">mediana {{ fmtMoney(ticketMediana) }}</div>
                </div>
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Días hasta cobro</div>
                    <div class="text-xl font-bold mt-0.5 tabular-nums">{{ diasCobro.toFixed(1) }} d</div>
                    <div class="text-[10px] text-surface-400 mt-1">mediana pedido → último cobro</div>
                </div>
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Clientes</div>
                    <div class="text-xl font-bold mt-0.5 tabular-nums">{{ clientes.length }}</div>
                    <div class="text-[10px] text-surface-400 mt-1">{{ recurrentes.length }} repiten</div>
                </div>
                <div class="card rounded-2xl p-4">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Ingreso recurrente</div>
                    <div class="text-xl font-bold mt-0.5 tabular-nums">{{ pctRecurrente.toFixed(0) }}%</div>
                    <div class="text-[10px] text-surface-400 mt-1">de clientes que repiten</div>
                </div>
            </div>
        </div>

        <!-- ═══ Facturación vs caja ═══ -->
        <ChartCard title="Facturado, coste y caja por mes" type="bar" :data="chartFacturacion" :options="optsFacturacion" height="330px" />

        <!-- ═══ Cobros ═══ -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div class="lg:col-span-2">
                <ChartCard title="Cobros por método y mes" type="bar" :data="chartMetodos" :options="optsStacked" height="300px" />
            </div>
            <div class="rounded-2xl card overflow-hidden flex flex-col">
                <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
                    <div class="text-sm font-semibold">Cobros del período</div>
                    <div class="text-[10px] text-surface-400 mt-0.5">{{ fmtMoney(cobrado) }} en {{ cashInRange.length }} movimientos</div>
                </div>
                <div class="divide-y divide-black/[0.04] dark:divide-white/[0.06] flex-1">
                    <div v-if="!cobrosPorMetodo.length" class="px-4 py-6 text-center text-sm text-surface-400">Sin cobros en el rango</div>
                    <div v-for="m in cobrosPorMetodo" :key="m.name" class="px-4 py-2.5">
                        <div class="flex justify-between items-center">
                            <span class="text-sm font-medium flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full" :style="{ background: m.color }"></span>
                                {{ m.name }}
                            </span>
                            <span class="text-sm font-semibold tabular-nums">{{ fmtMoney(m.amount) }}</span>
                        </div>
                        <div class="h-1 mt-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] overflow-hidden">
                            <div class="h-full rounded-full" :style="{ width: m.pct + '%', background: m.color }"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- ═══ Pendiente de cobro ═══ -->
        <div class="rounded-2xl card overflow-hidden">
            <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06] flex items-baseline justify-between gap-3">
                <div>
                    <div class="text-sm font-semibold">Pendiente de cobro</div>
                    <div class="text-[10px] text-surface-400 mt-0.5">Saldo vivo a día de hoy — no depende del período elegido</div>
                </div>
                <div class="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums shrink-0">{{ fmtMoney(totalPendiente) }}</div>
            </div>

            <div v-if="!deudas.length" class="px-4 py-8 text-center text-sm text-surface-400">
                <i class="pi pi-check-circle mr-1.5 text-emerald-500"></i> Todo cobrado
            </div>

            <template v-else>
                <div class="grid grid-cols-2 md:grid-cols-4 border-b border-black/[0.04] dark:border-white/[0.06]">
                    <div v-for="b in aging" :key="b.label" class="px-4 py-3 border-r last:border-r-0 border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">{{ b.label }}</div>
                        <div class="text-base font-bold mt-0.5 tabular-nums" :class="b.amount > 0 ? b.tone : 'text-surface-400'">{{ fmtMoney(b.amount) }}</div>
                        <div class="text-[10px] text-surface-400">{{ b.count }} pedido{{ b.count === 1 ? '' : 's' }}</div>
                    </div>
                </div>

                <div class="divide-y divide-black/[0.04] dark:divide-white/[0.06] max-h-72 overflow-y-auto">
                    <div v-for="d in deudas" :key="d.o.id" class="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                        <div class="min-w-0">
                            <div class="text-sm font-medium truncate">{{ d.o.cliente || 'Sin cliente' }}</div>
                            <div class="text-[11px] text-surface-400 truncate">{{ d.o.descripcion || '—' }} · {{ d.o.fecha }}</div>
                        </div>
                        <div class="flex items-center gap-3 shrink-0">
                            <span class="text-[11px] tabular-nums" :class="d.dias >= 60 ? 'text-red-500' : d.dias >= 30 ? 'text-orange-500' : 'text-surface-400'">{{ d.dias }} d</span>
                            <span class="text-sm font-semibold tabular-nums w-20 text-right">{{ fmtMoney(d.saldo) }}</span>
                        </div>
                    </div>
                </div>
            </template>
        </div>

        <!-- ═══ Clientes y estados ═══ -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Top clientes por facturación" type="bar" :data="chartClientes" :options="optsHBar" height="300px" />
            <ChartCard title="Estado de los presupuestos" type="doughnut" :data="chartEstados" :options="optsDoughnut" height="300px" />
        </div>

        <!-- ═══ Producción ═══ -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Material consumido por tipo" type="bar" :data="chartMateriales" :options="optsHBarGrams" height="280px" />

            <div class="rounded-2xl card overflow-hidden">
                <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
                    <div class="text-sm font-semibold">Producción</div>
                    <div class="text-[10px] text-surface-400 mt-0.5">Sólo pedidos aceptados — los descartados no se imprimieron</div>
                </div>
                <div class="grid grid-cols-2">
                    <div class="px-4 py-3 border-r border-b border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Beneficio / hora</div>
                        <div class="text-base font-bold mt-0.5 tabular-nums text-emerald-600 dark:text-emerald-400">{{ fmtMoney(eurPorHora) }}</div>
                    </div>
                    <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Facturado / kg</div>
                        <div class="text-base font-bold mt-0.5 tabular-nums">{{ fmtMoney(eurPorKg) }}</div>
                    </div>
                    <div class="px-4 py-3 border-r border-b border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Horas de máquina</div>
                        <div class="text-base font-bold mt-0.5 tabular-nums">{{ horasTotal.toFixed(1) }} h</div>
                    </div>
                    <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Material</div>
                        <div class="text-base font-bold mt-0.5 tabular-nums">{{ (pesoTotal / 1000).toFixed(2) }} kg</div>
                    </div>
                    <div class="px-4 py-3 border-r border-black/[0.04] dark:border-white/[0.06]">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Piezas</div>
                        <div class="text-base font-bold mt-0.5 tabular-nums">{{ piezasTotal }}</div>
                    </div>
                    <div class="px-4 py-3">
                        <div class="text-[10px] text-surface-400 uppercase tracking-wider font-semibold">Luz <span class="normal-case font-normal">(ya en el coste)</span></div>
                        <div class="text-base font-bold mt-0.5 tabular-nums text-orange-500">{{ fmtMoney(totalElectricidad) }}</div>
                    </div>
                </div>
                <div class="px-4 py-2.5 border-t border-black/[0.04] dark:border-white/[0.06] flex justify-between gap-3 text-[11px]">
                    <span class="text-surface-400 truncate">Impresora top <span class="text-surface-700 dark:text-surface-200 font-medium">{{ topPrinter }}</span></span>
                    <span class="text-surface-400 truncate">Material top <span class="text-surface-700 dark:text-surface-200 font-medium">{{ topMaterial }}</span></span>
                </div>
            </div>
        </div>
    </div>
</template>
