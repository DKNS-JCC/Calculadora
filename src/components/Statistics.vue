<script setup>
import { computed, ref } from 'vue'
import { store } from '../store'
import { orderShare as _orderShare } from '../utils/orderShare'
import Chart from 'primevue/chart'
import ChartCard from './ChartCard.vue'
import DatePicker from 'primevue/datepicker'
import Select from 'primevue/select'

/* ── Base data ── */
const orders = computed(() => store.appData.orders || [])
const unit = computed(() => store.appData.global_config.money_unit)

const orderShare = (o) => _orderShare(o, store.empresa)

/* ── Date helpers ── */
const parseDate = (str) => {
    if (!str) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, d] = str.split('-').map(Number)
        return new Date(y, m - 1, d)
    }
    const parts = str.split('/')
    if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0])
    const d = new Date(str)
    return isNaN(d.getTime()) ? null : d
}
const monthLabel = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const fmtMoney = (v) => `${Number(v || 0).toFixed(2)} ${unit.value}`

/* ── Accepted orders = the only ones that count financially ── */
const accepted = computed(() => orders.value.filter(o => ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'].includes(o.estado)))

/* ── Date range filter ── */
const statsFrom = ref(null)
const statsTo = ref(null)

const inRange = (o) => {
    const d = parseDate(o.fecha)
    if (!d) return true
    if (statsFrom.value && d < statsFrom.value) return false
    if (statsTo.value && d > statsTo.value) return false
    return true
}

const acceptedFiltered = computed(() => accepted.value.filter(inRange))
const ordersFiltered = computed(() => orders.value.filter(inRange))

/* ── KPIs (all based on accepted only) ── */
const totalFacturado = computed(() =>
    acceptedFiltered.value.reduce((s, o) => s + Number(o.precio_final || 0) * orderShare(o), 0)
)
const totalCobrado = computed(() =>
    acceptedFiltered.value.reduce((s, o) => s + Number(o.importe_pagado || 0) * orderShare(o), 0)
)
const totalPendiente = computed(() =>
    acceptedFiltered.value.reduce((s, o) => {
        const diff = (Number(o.precio_final || 0) - Number(o.importe_pagado || 0)) * orderShare(o)
        return s + (diff > 0 ? diff : 0)
    }, 0)
)
const totalPropinas = computed(() =>
    acceptedFiltered.value.reduce((s, o) => {
        const diff = (Number(o.importe_pagado || 0) - Number(o.precio_final || 0)) * orderShare(o)
        return s + (diff > 0 ? diff : 0)
    }, 0)
)
const totalBeneficio = computed(() =>
    acceptedFiltered.value.reduce((s, o) => s + Number(o.beneficio_neto || 0) * orderShare(o), 0)
)
const totalCoste = computed(() =>
    acceptedFiltered.value.reduce((s, o) => s + Number(o.coste_bruto || 0) * orderShare(o), 0)
)
const margenMedio = computed(() =>
    totalFacturado.value > 0 ? (totalBeneficio.value / totalFacturado.value) * 100 : 0
)
const pedidoMedio = computed(() =>
    acceptedFiltered.value.length > 0 ? totalFacturado.value / acceptedFiltered.value.length : 0
)

/* ── Printer electricity cost ── */
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
const totalElectricityCost = computed(() => {
    const rate = Number(store.appData.global_config?.energy_cost_kwh || 0)
    if (!rate) return 0
    return acceptedFiltered.value.reduce((sum, order) => {
        const printer = findPrinterForOrder(order)
        if (!printer) return sum
        const hours = Number(order.horas || 0)
        const consumption = Number(printer.energy_consumption_kwh || 0)
        return (hours && consumption) ? sum + hours * consumption * rate * orderShare(order) : sum
    }, 0)
})

/* ── Production metrics (all orders, not just accepted) ── */
const topMaterial = computed(() => {
    const c = {}
    ordersFiltered.value.forEach(o => { const m = o.filamento || 'Otro'; c[m] = (c[m] || 0) + 1 })
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || '-'
})
const topPrinter = computed(() => {
    const c = {}
    ordersFiltered.value.forEach(o => { const p = o.impresora || '?'; c[p] = (c[p] || 0) + 1 })
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || '-'
})
const pesoTotal = computed(() => ordersFiltered.value.reduce((s, o) => s + Number(o.peso_g || 0), 0))
const horasTotal = computed(() => ordersFiltered.value.reduce((s, o) => s + Number(o.horas || 0), 0))

/* ── Current month snapshot (accepted only) ── */
const currentMonthValues = computed(() => {
    const now = new Date()
    const thisMonth = monthLabel(now)
    const mo = acceptedFiltered.value.filter(o => { const d = parseDate(o.fecha); return d && monthLabel(d) === thisMonth })
    return {
        facturado: mo.reduce((s, o) => s + Number(o.precio_final || 0) * orderShare(o), 0),
        coste: mo.reduce((s, o) => s + Number(o.coste_bruto || 0) * orderShare(o), 0),
        beneficio: mo.reduce((s, o) => s + Number(o.beneficio_neto || 0) * orderShare(o), 0),
        count: mo.length
    }
})

/* ── Chart data: Monthly evolution (accepted only) ── */
const comparativeChartData = computed(() => {
    const buckets = {}
    acceptedFiltered.value.forEach(o => {
        const d = parseDate(o.fecha)
        if (!d) return
        const key = monthLabel(d)
        const share = orderShare(o)
        if (!buckets[key]) buckets[key] = { facturado: 0, coste: 0, beneficio: 0 }
        buckets[key].facturado += Number(o.precio_final || 0) * share
        buckets[key].coste += Number(o.coste_bruto || 0) * share
        buckets[key].beneficio += Number(o.beneficio_neto || 0) * share
    })
    const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))
    return {
        labels: sorted.map(([key]) => key),
        datasets: [
            { label: 'Facturado', data: sorted.map(([, v]) => v.facturado), backgroundColor: 'rgba(96,165,250,0.75)', borderColor: '#60a5fa', borderWidth: 2, borderRadius: 6, barPercentage: 0.7 },
            { label: 'Coste', data: sorted.map(([, v]) => v.coste), backgroundColor: 'rgba(248,113,113,0.72)', borderColor: '#f87171', borderWidth: 2, borderRadius: 6, barPercentage: 0.7 },
            { label: 'Beneficio', data: sorted.map(([, v]) => v.beneficio), backgroundColor: 'rgba(52,211,153,0.75)', borderColor: '#34d399', borderWidth: 2, borderRadius: 6, barPercentage: 0.7 }
        ]
    }
})

/* ── Chart data: Order status distribution (all orders) ── */
const statusData = computed(() => {
    const counts = {}
    ordersFiltered.value.forEach(o => { const s = o.estado || 'Desconocido'; counts[s] = (counts[s] || 0) + 1 })
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    const palette = ['#34d399', '#fbbf24', '#60a5fa', '#a78bfa', '#9ca3af', '#fb7185', '#22d3ee']
    return {
        labels: sorted.map(([l]) => l),
        datasets: [{ data: sorted.map(([, v]) => v), backgroundColor: sorted.map((_, i) => palette[i % palette.length]), borderColor: '#0f172a', borderWidth: 2, hoverOffset: 8 }]
    }
})

/* ── Chart data: Material usage (all orders) ── */
const materialData = computed(() => {
    const counts = {}
    ordersFiltered.value.forEach(o => { const m = o.filamento || 'Otro'; counts[m] = (counts[m] || 0) + 1 })
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 6)
    const rest = sorted.slice(6).reduce((s, [, c]) => s + c, 0)
    if (rest > 0) top.push(['Otros', rest])
    const palette = ['#60a5fa', '#f472b6', '#a78bfa', '#fbbf24', '#34d399', '#fb923c', '#22d3ee']
    return {
        labels: top.map(([l]) => l),
        datasets: [{ data: top.map(([, v]) => v), backgroundColor: top.map((_, i) => palette[i % palette.length]), borderColor: '#0f172a', borderWidth: 2 }]
    }
})

/* ── Payment methods statistics ── */
const paymentMethodsByMonth = computed(() => {
    const buckets = {}
    acceptedFiltered.value.forEach(o => {
        const d = parseDate(o.fecha)
        if (!d) return
        const monthKey = monthLabel(d)
        const method = o.payment_method || 'Otro'
        const key = `${monthKey}|${method}`
        
        if (!buckets[key]) buckets[key] = { month: monthKey, method, amount: 0 }
        buckets[key].amount += Number(o.importe_pagado || 0) * orderShare(o)
    })
    return Object.values(buckets).sort((a, b) => a.month.localeCompare(b.month) || a.method.localeCompare(b.method))
})

const currentMonthPaymentMethods = computed(() => {
    const now = new Date()
    const thisMonth = monthLabel(now)
    const methods = {}
    acceptedFiltered.value.forEach(o => {
        const d = parseDate(o.fecha)
        if (!d || monthLabel(d) !== thisMonth) return
        const method = o.payment_method || 'Otro'
        if (!methods[method]) methods[method] = 0
        methods[method] += Number(o.importe_pagado || 0) * orderShare(o)
    })
    return Object.entries(methods).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount)
})

const paymentMethodChartData = computed(() => {
    const methodsList = ['Efectivo', 'Bizum', 'Transferencia', 'Stripe', 'Otro']
    const months = {}
    
    acceptedFiltered.value.forEach(o => {
        const d = parseDate(o.fecha)
        if (!d) return
        const monthKey = monthLabel(d)
        const method = o.payment_method || 'Otro'
        
        if (!months[monthKey]) {
            months[monthKey] = {}
            methodsList.forEach(m => { months[monthKey][m] = 0 })
        }
        months[monthKey][method] = (months[monthKey][method] || 0) + Number(o.importe_pagado || 0) * orderShare(o)
    })
    
    const sortedMonths = Object.keys(months).sort()
    const colors = {
        'Efectivo': 'rgba(34,197,94,0.75)',
        'Bizum': 'rgba(59,130,246,0.75)',
        'Transferencia': 'rgba(168,85,247,0.75)',
        'Stripe': 'rgba(251,146,60,0.75)',
        'Otro': 'rgba(107,114,128,0.75)'
    }
    const borderColors = {
        'Efectivo': '#22c55e',
        'Bizum': '#3b82f6',
        'Transferencia': '#a855f7',
        'Stripe': '#fb923c',
        'Otro': '#6b7280'
    }
    
    return {
        labels: sortedMonths,
        datasets: methodsList.map(method => ({
            label: method,
            data: sortedMonths.map(month => months[month][method] || 0),
            backgroundColor: colors[method],
            borderColor: borderColors[method],
            borderWidth: 2,
            borderRadius: 6,
            barPercentage: 0.8
        }))
    }
})

/* ── Chart options ── */
const axisColors = { tick: '#94a3b8', grid: '#1e293b' }

const comparativeOpts = {
    layout: { padding: { top: 6, right: 10 } },
    plugins: {
        legend: { labels: { color: axisColors.tick } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed?.y ?? c.raw ?? 0)}` } }
    },
    interaction: { mode: 'index', intersect: false },
    scales: {
        x: { ticks: { color: axisColors.tick }, grid: { color: axisColors.grid }, offset: true },
        y: { beginAtZero: true, grace: '20%', ticks: { color: axisColors.tick, callback: v => Number(v).toFixed(0) }, grid: { color: axisColors.grid } }
    },
    responsive: true, maintainAspectRatio: false
}

const doughnutOpts = {
    cutout: '55%',
    plugins: {
        legend: { position: 'bottom', labels: { color: axisColors.tick, usePointStyle: true, pointStyle: 'circle', boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => { const t = (c.dataset?.data || []).reduce((s, v) => s + Number(v || 0), 0); return `${c.label}: ${c.raw} (${t > 0 ? ((c.raw / t) * 100).toFixed(1) : 0}%)` } } }
    },
    responsive: true, maintainAspectRatio: false
}

const polarOpts = {
    plugins: {
        legend: { position: 'bottom', labels: { color: axisColors.tick, usePointStyle: true, pointStyle: 'circle', boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => { const t = (c.dataset?.data || []).reduce((s, v) => s + Number(v || 0), 0); return `${c.label}: ${c.raw} (${t > 0 ? ((c.raw / t) * 100).toFixed(1) : 0}%)` } } }
    },
    scales: { r: { ticks: { color: axisColors.tick, backdropColor: 'transparent' }, grid: { color: axisColors.grid }, pointLabels: { display: false } } },
    responsive: true, maintainAspectRatio: false
}

/* ── Quality of Life ── */
const setPreset = (preset) => {
    const now = new Date()
    if (preset === '7days') {
        const d = new Date(now)
        d.setDate(d.getDate() - 6)
        statsFrom.value = d
        statsTo.value = now
    } else if (preset === 'thisYear') {
        statsFrom.value = new Date(now.getFullYear(), 0, 1)
        statsTo.value = new Date(now.getFullYear(), 11, 31)
    }
}

const selectedMonthPreset = ref(null)
const monthPresets = computed(() => {
    if (!orders.value || orders.value.length === 0) return []
    
    const uniqueMap = new Map()
    orders.value.forEach(o => {
        const d = parseDate(o.fecha)
        if (!d) return
        
        const y = d.getFullYear()
        const m = d.getMonth()
        const key = `${y}-${String(m + 1).padStart(2, '0')}`
        
        if (!uniqueMap.has(key)) {
            const monthName = d.toLocaleString('es-ES', { month: 'long' })
            const capitalized = monthName.charAt(0).toUpperCase() + monthName.slice(1)
            uniqueMap.set(key, {
                label: `${capitalized} ${y}`,
                date: new Date(y, m, 1),
                sortKey: key
            })
        }
    })
    
    return Array.from(uniqueMap.values()).sort((a, b) => b.sortKey.localeCompare(a.sortKey))
})

const applyMonthPreset = () => {
    if (!selectedMonthPreset.value) return
    const d = selectedMonthPreset.value.date
    statsFrom.value = new Date(d.getFullYear(), d.getMonth(), 1)
    statsTo.value = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    // Clear selection after applying so user can re-select the same month later if they alter dates manually
    setTimeout(() => { selectedMonthPreset.value = null }, 100)
}

const exportCSV = () => {
    if (ordersFiltered.value.length === 0) return
    const headers = ['ID', 'Fecha', 'Cliente', 'Estado', 'Filamento', 'Facturado', 'Coste', 'Beneficio']
    const rows = ordersFiltered.value.map(o => {
        const share = orderShare(o)
        return [
            o.id,
            o.fecha,
            `"${(o.cliente || '').replace(/"/g, '""')}"`,
            o.estado,
            o.filamento || '',
            (Number(o.precio_final || 0) * share).toFixed(2),
            (Number(o.coste_bruto || 0) * share).toFixed(2),
            (Number(o.beneficio_neto || 0) * share).toFixed(2)
        ]
    })
    const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\n')
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.setAttribute('download', `estadisticas_${monthLabel(new Date())}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- ═══ Date range filter ═══ -->
        <div class="flex flex-wrap items-center justify-between gap-3 p-3 card rounded-2xl">
            <div class="flex flex-wrap items-center gap-3">
                <span class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Período:</span>
                <DatePicker v-model="statsFrom" dateFormat="dd/mm/yy" showIcon iconDisplay="input" placeholder="Desde" class="w-36" showButtonBar />
                <span class="text-surface-400 text-sm">→</span>
                <DatePicker v-model="statsTo" dateFormat="dd/mm/yy" showIcon iconDisplay="input" placeholder="Hasta" class="w-36" showButtonBar />
                
                <div class="flex gap-1 ml-2">
                    <button @click="setPreset('7days')" class="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">7D</button>
                    <button @click="setPreset('thisYear')" class="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">Año</button>
                    <Select v-model="selectedMonthPreset" :options="monthPresets" optionLabel="label" placeholder="Mes..." @change="applyMonthPreset" class="w-32 !text-xs !py-0 flex items-center ml-1 h-[32px]" />
                </div>
                
                <button v-if="statsFrom || statsTo" @click="statsFrom = null; statsTo = null"
                    class="px-2.5 py-0.5 ml-2 rounded-full text-[11px] font-medium border border-surface-300 dark:border-surface-600 text-surface-500 hover:border-red-400 hover:text-red-400 transition-colors cursor-pointer">
                    Limpiar
                </button>
            </div>
            
            <div class="flex items-center gap-3">
                <span class="text-[11px] text-surface-400">{{ acceptedFiltered.length }} pedidos aceptados en rango</span>
                <button @click="exportCSV" :disabled="ordersFiltered.length === 0" 
                    title="Exportar resumen a CSV"
                    class="w-8 h-8 rounded-full flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 text-surface-500 cursor-pointer">
                    <i class="pi pi-download text-sm"></i>
                </button>
            </div>
        </div>

        <!-- ═══════════ Financial KPIs (accepted orders only) ═══════════ -->
        <div>
            <div class="text-[10px] text-surface-400 uppercase tracking-widest font-semibold mb-2 px-1">Resumen financiero · Solo pedidos aceptados</div>
            <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-surface-500 font-semibold uppercase tracking-wider">Pedidos</div>
                    <div class="text-xl font-bold mt-0.5">{{ acceptedFiltered.length }} <span class="text-xs text-surface-400 font-normal">/ {{ ordersFiltered.length }}</span></div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-blue-500 font-semibold uppercase tracking-wider">Facturado</div>
                    <div class="text-xl font-bold text-blue-700 dark:text-blue-300 mt-0.5">{{ fmtMoney(totalFacturado) }}</div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-green-500 font-semibold uppercase tracking-wider">Cobrado</div>
                    <div class="text-xl font-bold text-green-700 dark:text-green-300 mt-0.5">{{ fmtMoney(totalCobrado) }}</div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-amber-500 font-semibold uppercase tracking-wider">Pendiente</div>
                    <div class="text-xl font-bold text-amber-700 dark:text-amber-300 mt-0.5">{{ fmtMoney(totalPendiente) }}</div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-pink-500 font-semibold uppercase tracking-wider">Propinas</div>
                    <div class="text-xl font-bold text-pink-700 dark:text-pink-300 mt-0.5">{{ fmtMoney(totalPropinas) }}</div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-red-500 font-semibold uppercase tracking-wider">Coste</div>
                    <div class="text-xl font-bold text-red-700 dark:text-red-300 mt-0.5">{{ fmtMoney(totalCoste) }}</div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-emerald-500 font-semibold uppercase tracking-wider">Beneficio</div>
                    <div class="text-xl font-bold text-emerald-700 dark:text-emerald-300 mt-0.5">{{ fmtMoney(totalBeneficio) }}</div>
                </div>
                <div class="card rounded-2xl p-4 text-center">
                    <div class="text-[10px] text-purple-500 font-semibold uppercase tracking-wider">Margen</div>
                    <div class="text-xl font-bold text-purple-700 dark:text-purple-300 mt-0.5">{{ margenMedio.toFixed(1) }}%</div>
                </div>
            </div>
        </div>

        <!-- ═══════════ Monthly evolution chart ═══════════ -->
        <ChartCard title="Evolución Mensual" type="bar" :data="comparativeChartData" :options="comparativeOpts" height="320px" />

        <!-- ═══════════ Middle row: Status + Materials ═══════════ -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Estado de Pedidos" type="doughnut" :data="statusData" :options="doughnutOpts" height="300px" />
            <ChartCard title="Materiales Utilizados" type="polarArea" :data="materialData" :options="polarOpts" height="300px" />
        </div>

        <!-- ═══════════ Payment methods chart ═══════════ -->
        <ChartCard title="Ingresos por Método de Pago (Mensual)" type="bar" :data="paymentMethodChartData" :options="comparativeOpts" height="320px" />

        <!-- ═══════════ Bottom row: Month snapshot + Production summary ═══════════ -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <!-- Current month payment methods -->
            <div class="rounded-2xl card overflow-hidden">
                <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
                    <div class="text-sm font-semibold">Métodos de Pago - Mes Actual</div>
                    <div class="text-[10px] text-surface-400 mt-0.5">Dinero recibido por cada método</div>
                </div>
                <div class="divide-y divide-black/[0.04] dark:divide-white/[0.06]">
                    <div v-if="currentMonthPaymentMethods.length === 0" class="px-4 py-3 text-center text-sm text-surface-400">
                        Sin ingresos registrados
                    </div>
                    <div v-for="method in currentMonthPaymentMethods" :key="method.name" class="flex justify-between items-center px-4 py-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                        <span class="text-sm font-medium">{{ method.name }}</span>
                        <span class="text-sm font-semibold text-green-600 dark:text-green-400">{{ fmtMoney(method.amount) }}</span>
                    </div>
                </div>
            </div>

            <!-- Production summary -->
            <div class="rounded-2xl card overflow-hidden">
                <div class="px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
                    <div class="text-sm font-semibold">Producción</div>
                    <div class="text-[10px] text-surface-400 mt-0.5">Todos los pedidos</div>
                </div>
                <div class="divide-y divide-black/[0.04] dark:divide-white/[0.06]">
                    <div class="flex justify-between items-center px-4 py-2.5">
                        <span class="text-sm text-surface-500">Pedido medio</span>
                        <span class="text-sm font-semibold">{{ fmtMoney(pedidoMedio) }}</span>
                    </div>
                    <div class="flex justify-between items-center px-4 py-2.5">
                        <span class="text-sm text-surface-500">Electricidad</span>
                        <span class="text-sm font-semibold text-orange-500">{{ fmtMoney(totalElectricityCost) }}</span>
                    </div>
                    <div class="flex justify-between items-center px-4 py-2.5">
                        <span class="text-sm text-surface-500">Material top</span>
                        <span class="text-sm font-semibold">{{ topMaterial }}</span>
                    </div>
                    <div class="flex justify-between items-center px-4 py-2.5">
                        <span class="text-sm text-surface-500">Impresora top</span>
                        <span class="text-sm font-semibold">{{ topPrinter }}</span>
                    </div>
                    <div class="flex justify-between items-center px-4 py-2.5">
                        <span class="text-sm text-surface-500">Material usado</span>
                        <span class="text-sm font-semibold">{{ (pesoTotal / 1000).toFixed(2) }} kg</span>
                    </div>
                    <div class="flex justify-between items-center px-4 py-2.5">
                        <span class="text-sm text-surface-500">Tiempo total</span>
                        <span class="text-sm font-semibold">{{ horasTotal.toFixed(1) }} h</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
