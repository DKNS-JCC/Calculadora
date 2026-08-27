<script setup>
import { computed, ref } from 'vue'
import { store } from '../store'
import { orderShare as _orderShare } from '../utils/orderShare'
import { useStaleOrders } from '../composables/useStaleOrders'
import { filamentUsageByColor, filamentSpendG, filamentSpendEur } from '../shared/backend.mjs'
import Chart from 'primevue/chart'
import Button from 'primevue/button'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'

const toast = useToast()
const confirmDlg = useConfirm()

const orders = computed(() => store.appData.orders || [])
const unit = computed(() => store.appData.global_config.money_unit)
const orderShare = (o) => _orderShare(o, store.empresa)

const parseDate = (str) => {
    if (!str) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, d] = str.split('-').map(Number)
        return new Date(y, m - 1, d)
    }
    const d = new Date(str)
    return isNaN(d.getTime()) ? null : d
}

const fmtMoney = (v) => `${Number(v || 0).toFixed(2)} ${unit.value}`

// Base filters
const accepted = computed(() => orders.value.filter(o => ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'].includes(o.estado)))
const pending = computed(() => orders.value.filter(o => !o.archived && ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'].includes(o.estado) && Number(o.importe_pagado || 0) < Number(o.precio_final || 0)))

// Monthly Revenue
const thisMonthRevenue = computed(() => {
    const now = new Date()
    return accepted.value
        .filter(o => {
            const d = parseDate(o.fecha)
            return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        })
        .reduce((s, o) => s + Number(o.precio_final || 0) * orderShare(o), 0)
})

const lastMonthRevenue = computed(() => {
    const now = new Date()
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return accepted.value
        .filter(o => {
            const d = parseDate(o.fecha)
            return d && d.getFullYear() === last.getFullYear() && d.getMonth() === last.getMonth()
        })
        .reduce((s, o) => s + Number(o.precio_final || 0) * orderShare(o), 0)
})

const revenueGrowth = computed(() => {
    if (lastMonthRevenue.value === 0) return 0
    return ((thisMonthRevenue.value - lastMonthRevenue.value) / lastMonthRevenue.value) * 100
})

// Pending Payments
const pendingAmount = computed(() => pending.value.reduce((s, o) => s + (Number(o.precio_final || 0) - Number(o.importe_pagado || 0)) * orderShare(o), 0))

// Profit Margin
const avgMargin = computed(() => {
    const totalRev = accepted.value.reduce((s, o) => s + Number(o.precio_final || 0) * orderShare(o), 0)
    const totalProfit = accepted.value.reduce((s, o) => s + Number(o.beneficio_neto || 0) * orderShare(o), 0)
    return totalRev > 0 ? (totalProfit / totalRev) * 100 : 0
})

// Inventory Status
const materialGastado = computed(() => {
    const stock = store.appData.filament_stock || []
    const tipos = store.appData.filament_types || []
    const usage = filamentUsageByColor(store.appData)
    return {
        gramos: stock.reduce((acc, s) => acc + filamentSpendG(s, usage), 0),
        euros: stock.reduce((acc, s) => acc + filamentSpendEur(s, tipos, usage), 0),
        colores: stock.filter(s => filamentSpendG(s, usage) > 0).length,
    }
})

// Avisos: pedidos estancados (sin actualización en 7+ días)
const { staleOrders, staleDays, snoozeStale, rejectStale, finishStale } = useStaleOrders()

const staleReject = (o) => {
    confirmDlg.require({
        message: `¿Marcar el pedido #${o.id} de ${o.cliente} como rechazado? Se archivará y dejará de generar avisos.`,
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
        toast.add({ severity: 'info', summary: 'Aviso pospuesto', detail: `#${o.id}: volverá a avisar en 7 días si no hay cambios`, life: 3200 })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

const staleFinish = async (o) => {
    try {
        await finishStale(o)
        toast.add({ severity: 'success', summary: 'Pedido finalizado', detail: `#${o.id} entregado y archivado (sin notificar al cliente)`, life: 3200 })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 3500 })
    }
}

// Chart: Order Status Distribution
const statusChartData = computed(() => {
    const counts = {}
    orders.value.forEach(o => { const s = o.estado || 'Desconocido'; counts[s] = (counts[s] || 0) + 1 })
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    const palette = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#9ca3af']
    return {
        labels: sorted.map(([l]) => l),
        datasets: [{ data: sorted.map(([, v]) => v), backgroundColor: palette, borderColor: 'transparent' }]
    }
})

const statusChartOptions = {
    cutout: '70%',
    plugins: {
        legend: { position: 'right', labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'circle', boxWidth: 8, font: { size: 11 } } },
        tooltip: { enabled: true }
    },
    responsive: true,
    maintainAspectRatio: false
}

</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
            <h1 class="text-2xl font-bold text-surface-900 dark:text-surface-0">Resumen de Negocio</h1>
            <div class="text-sm text-surface-500">{{ new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) }}</div>
        </div>

        <!-- KPI Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="card p-5 rounded-2xl border-0 bg-white/50 dark:bg-white/[0.03] backdrop-blur-md relative overflow-hidden group">
                <div class="flex justify-between items-start mb-4">
                    <div class="p-2.5 rounded-xl bg-[var(--p-primary-color)]/10 text-[var(--p-primary-color)]">
                        <i class="pi pi-chart-line text-xl" />
                    </div>
                    <div :class="revenueGrowth >= 0 ? 'text-emerald-500' : 'text-red-500'" class="text-xs font-bold flex items-center gap-1">
                        <i :class="revenueGrowth >= 0 ? 'pi pi-arrow-up-right' : 'pi pi-arrow-down-right'" class="text-[10px]" />
                        {{ Math.abs(revenueGrowth).toFixed(1) }}%
                    </div>
                </div>
                <div class="text-sm text-surface-500 mb-1">Ingresos este mes</div>
                <div class="text-2xl font-black text-surface-900 dark:text-surface-0">{{ fmtMoney(thisMonthRevenue) }}</div>
                <div class="text-[10px] text-surface-400 mt-3 flex items-center gap-1.5">
                    <span class="w-1 h-1 rounded-full bg-surface-300"></span>
                    vs {{ fmtMoney(lastMonthRevenue) }} mes anterior
                </div>
            </div>

            <div class="card p-5 rounded-2xl border-0 bg-white/50 dark:bg-white/[0.03] backdrop-blur-md">
                <div class="flex justify-between items-start mb-4">
                    <div class="p-2.5 rounded-xl bg-amber-500/10 text-amber-500">
                        <i class="pi pi-clock text-xl" />
                    </div>
                    <div class="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 text-[10px] font-bold">
                        {{ pending.length }} pedidos
                    </div>
                </div>
                <div class="text-sm text-surface-500 mb-1">Pendiente de cobro</div>
                <div class="text-2xl font-black text-amber-600 dark:text-amber-400">{{ fmtMoney(pendingAmount) }}</div>
                <div class="text-[10px] text-surface-400 mt-3 flex items-center gap-1.5">
                    <span class="w-1 h-1 rounded-full bg-amber-500/40"></span>
                    Envíos no facturados o parciales
                </div>
            </div>

            <div class="card p-5 rounded-2xl border-0 bg-white/50 dark:bg-white/[0.03] backdrop-blur-md">
                <div class="flex justify-between items-start mb-4">
                    <div class="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-500">
                        <i class="pi pi-percentage text-xl" />
                    </div>
                </div>
                <div class="text-sm text-surface-500 mb-1">Margen de beneficio medio</div>
                <div class="text-2xl font-black text-emerald-600 dark:text-emerald-400">{{ avgMargin.toFixed(1) }}%</div>
                <div class="text-[10px] text-surface-400 mt-3 flex items-center gap-1.5">
                    <span class="w-1 h-1 rounded-full bg-emerald-500/40"></span>
                    Sobre histórico de aceptados
                </div>
            </div>

            <div class="card p-5 rounded-2xl border-0 bg-white/50 dark:bg-white/[0.03] backdrop-blur-md">
                <div class="flex justify-between items-start mb-4">
                    <div class="p-2.5 rounded-xl bg-violet-500/10 text-violet-500">
                        <i class="pi pi-box text-xl" aria-hidden="true" />
                    </div>
                </div>
                <div class="text-sm text-surface-500 mb-1">Material gastado</div>
                <div class="text-2xl font-black text-violet-600 dark:text-violet-400">{{ (materialGastado.gramos / 1000).toFixed(2) }} <span class="text-sm font-normal text-surface-400">kg</span></div>
                <div class="text-[10px] text-surface-400 mt-3 flex items-center gap-1.5">
                    <span class="w-1 h-1 rounded-full bg-violet-500/40"></span>
                    {{ fmtMoney(materialGastado.euros) }} en {{ materialGastado.colores }} color{{ materialGastado.colores === 1 ? '' : 'es' }}
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <!-- Left: Avisos / pedidos estancados -->
            <div class="lg:col-span-2 flex flex-col gap-4">
                <div class="flex items-center justify-between px-1">
                    <h2 class="text-lg font-bold text-surface-900 dark:text-surface-0 flex items-center gap-2">
                        <i class="pi pi-bell" :class="staleOrders.length ? 'text-amber-500' : 'text-surface-400'" />
                        Avisos · Pedidos estancados
                    </h2>
                    <span v-if="staleOrders.length" class="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 text-[10px] font-bold">
                        {{ staleOrders.length }} sin actualizar +7 días
                    </span>
                </div>
                <div class="card rounded-2xl border-0 bg-white/50 dark:bg-white/[0.03] overflow-hidden">
                    <div class="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
                        <div v-for="order in staleOrders" :key="order.id" class="p-4 flex flex-wrap items-center gap-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                            <div class="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
                                <i class="pi pi-clock text-amber-500" />
                            </div>
                            <div class="flex-1 min-w-[10rem]">
                                <div class="flex items-center justify-between mb-0.5">
                                    <span class="font-bold text-sm truncate pr-2">{{ order.cliente }}</span>
                                    <span class="text-xs font-mono text-surface-400">#{{ order.id }}</span>
                                </div>
                                <div class="text-xs text-surface-500 truncate">{{ order.descripcion }}</div>
                                <div class="text-[10px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">
                                    {{ staleDays(order) }} días sin actualizar · {{ order.estado }}
                                </div>
                            </div>
                            <div class="flex gap-1.5 ml-auto">
                                <Button label="Rechazado" size="small" severity="danger" outlined @click="staleReject(order)" v-tooltip.bottom="'Archiva el pedido y deja de avisar'" />
                                <Button label="En producción" size="small" severity="info" outlined @click="staleInProduction(order)" v-tooltip.bottom="'Pospone este aviso 7 días'" />
                                <Button label="Finalizado" size="small" severity="success" outlined @click="staleFinish(order)" v-tooltip.bottom="'Marca Entregado y archiva (sin email)'" />
                            </div>
                        </div>
                        <div v-if="staleOrders.length === 0" class="p-10 text-center text-surface-400 flex flex-col items-center gap-3">
                            <i class="pi pi-check-circle text-4xl opacity-30 text-emerald-500" />
                            <p>Todo al día — ningún pedido lleva más de 7 días sin actualizarse</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Right: Stats Snapshot -->
            <div class="flex flex-col gap-4">
                <h2 class="text-lg font-bold text-surface-900 dark:text-surface-0 px-1">Estado General</h2>
                <div class="card p-5 rounded-2xl border-0 bg-white/50 dark:bg-white/[0.03] h-full flex flex-col">
                    <div class="flex-1 h-[240px]">
                        <Chart type="doughnut" :data="statusChartData" :options="statusChartOptions" class="h-full" />
                    </div>
                    <div class="mt-6 pt-6 border-t border-black/[0.05] dark:border-white/[0.05]">
                        <div class="flex items-center justify-between mb-3 text-xs">
                            <span class="text-surface-500">Pedidos totales</span>
                            <span class="font-bold">{{ orders.length }}</span>
                        </div>
                        <div class="flex items-center justify-between text-xs">
                            <span class="text-surface-500">Tasa de aceptación</span>
                            <span class="font-bold text-emerald-500">{{ orders.length > 0 ? ((accepted.length / orders.length) * 100).toFixed(0) : 0 }}%</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
