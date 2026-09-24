<script setup>
import { ref, reactive, computed, onMounted, watch, onUnmounted, nextTick } from 'vue'
import { z } from 'zod'
import { store } from '../store'
import { api } from '../platform'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Textarea from 'primevue/textarea'
import Chart from 'primevue/chart'
import Panel from 'primevue/panel'
import Slider from 'primevue/slider'
import DatePicker from 'primevue/datepicker'
import ChartCard from './ChartCard.vue'
import EmailNotifyDialog from './EmailNotifyDialog.vue'
import CampoNumero from './CampoNumero.vue'
import CampoTiempo from './CampoTiempo.vue'
import { useEmailConfirm } from '../composables/useEmailConfirm'
import { laborOptions, disenoCostH, DISENO_A_MEDIDA, MARKUP } from '../shared/backend.mjs'
import { formatNumero } from '../shared/formatos.mjs'
import { useIsHandheld } from '../composables/useMediaQuery'

const { state: emailConfirmState, ask: askEmailConfirm, answer: answerEmailConfirm } = useEmailConfirm()
const onEmailDialogSend = () => answerEmailConfirm('send')
const onEmailDialogSkip = () => answerEmailConfirm('skip')
const onEmailDialogCancel = () => answerEmailConfirm('cancel')

function errorRateToRepString(rate) {
    const r = Number(rate || 0)
    if (r <= 0) return ''
    if (r < 1) return ` — ≈ 1 de cada ${Math.round(1 / r)}`
    return ` — ≈ ${r} por pedido`
}

const OPTIONS = {
    probError: [
        { label: 'Baja (25%)', value: 'Baja (25%)' },
        { label: 'Media (50%)', value: 'Media (50%)' },
        { label: 'Alta (100% ≈ 1 fallo)', value: 'Alta (100%)' },
        { label: 'Muy Alta (150%)', value: 'Muy Alta (150%)' },
        { label: 'Crítica (200% ≈ 2 fallos)', value: 'Crítica (200%)' },
    ],
    urgencia: ['Normal', 'Urgente'],
    // Factores binarios del cuestionario de riesgo (0 = favorable, 1 = adverso)
    geometria: [
        { label: 'Base grande', value: 0 },
        { label: 'Base reducida', value: 1 },
    ],
    dificultadTecnica: [
        { label: 'Sencilla (PLA, PETG o similares)', value: 0 },
        { label: 'Compleja (resto de materiales)', value: 1 },
    ],
    duracionIndividual: [
        { label: 'Reducida (<5 horas)', value: 0 },
        { label: 'Elevada (>5 horas)', value: 1 },
    ],
    idOptimizacion: [
        { label: 'Modelo fiable', value: 0 },
        { label: 'Requiere optimización', value: 1 },
    ],
}

// Materiales considerados "sencillos" para la dificultad técnica
const MATERIALES_SENCILLOS = ['PLA', 'PETG', 'PLA SILK/MARBLE']

/* ── Zod Validation ── */
const calcSchema = z.object({
    cliente: z.string().min(1, 'Requerido'),
    cliente_email: z.string().email('Email no válido').or(z.literal('')).optional(),
    fecha: z.string().min(1, 'Requerido'),
    descripcion: z.string().min(1, 'Requerido'),
    impresora: z.string().min(1, 'Selecciona impresora'),
    filamento_tipo: z.string().min(1, 'Selecciona material'),
    peso_g: z.number({ error: 'Indica el peso' }).positive('Debe ser mayor que 0'),
    tiempo_h: z.number({ error: 'Indica el tiempo' }).positive('Debe ser mayor que 0'),
})

const toast = useToast()
const confirm = useConfirm()
const isHandheld = useIsHandheld()
const resultsAnchor = ref(null)
const errors = ref({})

/* ── Date picker helper ── */
// Fecha local: toISOString() da la de UTC y de 00:00 a 02:00 marcaba el día anterior
const fechaISO = (val) => `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}-${String(val.getDate()).padStart(2, '0')}`
const hoyISO = () => fechaISO(new Date())

const formFechaDate = computed({
    get: () => {
        if (!form.fecha) return null
        const [y, m, d] = form.fecha.split('-').map(Number)
        return new Date(y, m - 1, d)
    },
    set: (val) => {
        form.fecha = val ? fechaISO(val) : ''
    }
})


const findLastEmailForClient = (name) => {
    const target = String(name || '').trim().toLowerCase()
    if (!target) return ''
    const matches = (store.appData?.orders || []).filter(o =>
        String(o.cliente || '').trim().toLowerCase() === target
        && String(o.cliente_email || '').trim()
    )
    if (!matches.length) return ''
    matches.sort((a, b) => String(b.created_at || b.fecha || '').localeCompare(String(a.created_at || a.fecha || '')))
    return String(matches[0].cliente_email || '').trim()
}

let lastAutofilledEmail = ''
const onClientSelected = () => {
    const email = findLastEmailForClient(form.cliente)
    const current = String(form.cliente_email || '').trim()
    if (email && (!current || current === lastAutofilledEmail)) {
        form.cliente_email = email
        lastAutofilledEmail = email
    } else if (!email && current && current === lastAutofilledEmail) {
        form.cliente_email = ''
        lastAutofilledEmail = ''
    }
}

const form = reactive({
    empresa: store.empresa,
    cliente: '',
    cliente_email: '',
    fecha: hoyISO(),
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
    diseno_modelado: 'No necesario',
    diseno_horas: 1,
    postprocesado: 'Limpio',
    probabilidad_error: OPTIONS.probError[0].value,
    markup: Object.keys(MARKUP)[0],
    urgencia_nivel: OPTIONS.urgencia[0],
    gasto_misc: 0,
})
watch(() => form.cliente, onClientSelected)

// El error de un campo desaparece en cuanto se corrige, sin esperar a recalcular.
// Síncrono: si no, un cambio hecho justo antes de validar (Enter) borraría el error recién puesto.
watch(() => ({ ...form }), (nuevo, viejo) => {
    for (const campo of Object.keys(errors.value)) {
        if (nuevo[campo] !== viejo[campo]) delete errors.value[campo]
    }
}, { flush: 'sync' })

const HEX_COLOR_MAP = {
    Negro: '#111827',
    Blanco: '#F9FAFB',
    Gris: '#6B7280',
    Rojo: '#EF4444',
    Azul: '#3B82F6',
    Verde: '#10B981',
    Amarillo: '#FACC15',
    Naranja: '#F97316',
    Morado: '#8B5CF6',
    Rosa: '#EC4899',
    Transparente: '#D1D5DB'
}
const colorHex = (name) => HEX_COLOR_MAP[name] || '#94A3B8'
const normalizeHex = (value) => {
    const raw = String(value || '').trim().replace('#', '')
    if (!raw) return '#94A3B8'
    return `#${raw}`
}

const riskDialog = ref(false)
const indiceError = reactive({ geometria: 0, dificultad: 0, duracion: 0, id: 0 })

const openRiskDialog = () => {
    // Autorrellenar dificultad técnica desde el material y duración desde el tiempo
    const mat = String(form.filamento_tipo || '').toUpperCase().trim()
    indiceError.dificultad = MATERIALES_SENCILLOS.some(m => mat === m || mat.startsWith(m)) ? 0 : (mat ? 1 : 0)
    indiceError.duracion = Number(form.tiempo_h || 0) > 5 ? 1 : 0
    riskDialog.value = true
}

// Nº de factores adversos (0-4) → escalón de probabilidad (25-200%)
const NIVELES_ERROR = ['Baja (25%)', 'Media (50%)', 'Alta (100%)', 'Muy Alta (150%)', 'Crítica (200%)']
const indiceErrorSugerido = computed(() => {
    const adversos = (Number(indiceError.geometria) || 0)
        + (Number(indiceError.dificultad) || 0)
        + (Number(indiceError.duracion) || 0)
        + (Number(indiceError.id) || 0)
    return NIVELES_ERROR[Math.min(adversos, NIVELES_ERROR.length - 1)]
})
const applyIndiceError = () => {
    form.probabilidad_error = indiceErrorSugerido.value
    riskDialog.value = false
}

const getColorOptionsByMaterial = (material) => {
    if (!material) return []
    const ownStock = store.appData.filament_stock.filter(s => s.material === material)
    const partnerStockArr = (form.is_shared && store.partnerInventory?.filament_stock)
        ? store.partnerInventory.filament_stock.filter(s => s.material === material)
        : []
    const byName = new Map()
    ;[...ownStock, ...partnerStockArr].forEach((item) => {
        const name = String(item.color || '').trim()
        if (!name || byName.has(name)) return
        const hex = item.color_hex ? normalizeHex(item.color_hex) : colorHex(name)
        byName.set(name, { label: name, value: name, hex })
    })
    const colors = [...byName.values()]
    return colors.length ? colors : [{ label: 'Negro', value: 'Negro', hex: colorHex('Negro') }]
}

const colorOptions = computed(() => {
    return getColorOptionsByMaterial(form.filamento_tipo)
})

const onMixMaterialChange = (idx) => {
    const line = mixLines[idx]
    const validValues = getColorOptionsByMaterial(line.material).map(o => o.value)
    if (!validValues.includes(line.color)) {
        line.color = validValues[0] || ''
    }
}

const printerOptions = computed(() => {
    const options = store.appData.printers.map(p => ({ label: p.name, value: p.name }))
    // Impresoras compartidas: en pedidos compartidos se puede imprimir en las del socio
    if (form.is_shared && store.partnerInventory?.printers?.length) {
        const ownNames = new Set(store.appData.printers.map(p => p.name))
        const partnerName = store.partnerInventory.partner || 'Socio'
        for (const p of store.partnerInventory.printers) {
            if (p?.name && !ownNames.has(p.name)) options.push({ label: `${p.name} · ${partnerName}`, value: p.name })
        }
    }
    return options
})

const partnerPrintersPayload = () => form.is_shared
    ? JSON.parse(JSON.stringify(store.partnerInventory?.printers || []))
    : []
const filamentOptions = computed(() => store.appData.filament_types.map(f => f.name))

const mixLines = reactive([
    { material: '', color: '', grams: 0 },
    { material: '', color: '', grams: 0 },
])

const addMixLine = () => {
    mixLines.push({ material: form.filamento_tipo || '', color: '', grams: 0 })
}
const removeMixLine = (idx) => {
    if (mixLines.length > 2) mixLines.splice(idx, 1)
}
const mixLineCost = (line) => {
    const f = store.appData.filament_types.find(ft => ft.name === line.material)
    if (!f || !line.grams) return 0
    return (line.grams * Number(f.price_per_kg || 0)) / 1000
}
const mixTotalGrams = computed(() => mixLines.reduce((acc, l) => acc + Number(l.grams || 0), 0))
const mixTotalCost = computed(() => mixLines.reduce((acc, l) => acc + mixLineCost(l), 0))
const materialBreakdown = () => form.is_multimaterial
    ? mixLines.filter(l => l.material && l.color && l.grams > 0).map(l => ({ ...l }))
    : []

const result = ref(null)
const chartDataDonut = ref(null)
const chartDataBar = ref(null)

const ticketDialogVisible = ref(false)
const ticketTitle = ref('')
const ticketContent = ref('')
const ticketKind = ref('cliente')

const unit = computed(() => store.appData.global_config.money_unit)
const moneyFormatter = computed(() => new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
}))

const formatMoney = (value) => `${moneyFormatter.value.format(Number(value || 0))} ${unit.value}`
const formatPercent = (value) => `${moneyFormatter.value.format(Number(value || 0))}%`
const toRgba = (hex, alpha) => {
    const clean = hex.replace('#', '')
    const r = parseInt(clean.substring(0, 2), 16)
    const g = parseInt(clean.substring(2, 4), 16)
    const b = parseInt(clean.substring(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const filamentPrice = computed(() => {
    const f = store.appData.filament_types.find(ft => ft.name === form.filamento_tipo)
    return f ? `${f.price_per_kg} ${unit.value}/kg` : ''
})

/* ── Tarifas de mano de obra ──
 * Los tramos y sus importes salen de backend.mjs valorados al coste/hora
 * vigente, así que un cambio de tarifa se refleja aquí sin tocar la vista. */
const tarifas = computed(() => laborOptions(store.appData.global_config))
const disenoOptions = computed(() => tarifas.value.diseno)
const postprocOptions = computed(() => tarifas.value.postproc)
const esDisenoAMedida = computed(() => form.diseno_modelado === DISENO_A_MEDIDA)

const laborCostH = computed(() => disenoCostH(store.appData.global_config))
const markupOptions = computed(() => Object.keys(MARKUP))
const cantidadUds = computed(() => Math.max(1, Math.floor(Number(form.cantidad) || 1)))

const disenoTarifa = computed(() => esDisenoAMedida.value
    ? Math.max(0, Number(form.diseno_horas) || 0) * laborCostH.value
    : (disenoOptions.value.find(o => o.value === form.diseno_modelado)?.eur || 0))
// El post-procesado es trabajo pieza a pieza: escala con la cantidad.
const postprocTarifaUd = computed(() => postprocOptions.value.find(o => o.value === form.postprocesado)?.eur || 0)
const postprocTarifa = computed(() => postprocTarifaUd.value * cantidadUds.value)
const manoObraTotal = computed(() => disenoTarifa.value + postprocTarifa.value)
const llevaPintura = computed(() => form.postprocesado === 'Avanzado (+ pintura)')


const detailedBreakdown = computed(() => {
    if (!result.value) return null

    const info = result.value.info || {}
    const rawBreakdown = result.value.breakdownDict || {}
    const allRows = Object.entries(rawBreakdown).map(([label, value]) => ({
        label,
        value: Number(value || 0)
    }))

    // Section 1 — Bruto: raw material + energy costs + depreciation
    const isBrutoRaw = (label) => label === 'Filamento' || label === 'Electricidad' || label === 'Deterioro imp.'
    const brutoRows = allRows.filter((row) => isBrutoRaw(row.label))
    const brutoTotal = brutoRows.reduce((acc, row) => acc + row.value, 0)

    // Section 2 — Complementos: labor costs + extras
    const isComplemento = (label) => !isBrutoRaw(label)
    const complementosRows = allRows.filter((row) => isComplemento(row.label))
    const complementosTotal = complementosRows.reduce((acc, row) => acc + row.value, 0)

    // Section 3 — Beneficio: markup + error supplements + urgency
    // coste_bruto_impresion = filamento + electricidad + deterioro (used in formula)
    const costeBrutoFormula = Number(info.coste_bruto_impresion || 0)
    const markup = Number(info.markup || 2.3)
    const errorRate = Number(info.error_rate || 0)
    const markupSupplement = Math.max(0, costeBrutoFormula * (markup - 1))
    const errorSupplement = Math.max(0, costeBrutoFormula * errorRate)
    const recargoUrgencia = Number(info.recargo_urgencia || 0)
    const beneficioTotal = markupSupplement + errorSupplement + recargoUrgencia

    return {
        brutoRows,
        brutoTotal,
        complementosRows,
        complementosTotal,
        markupSupplement,
        errorSupplement,
        recargoUrgencia,
        gastoMisc: Number(info.gasto_misc || 0),
        beneficioTotal,
        markup,
        errorRate,
        tasaErrorLabel: info.prob_error || form.probabilidad_error,
    }
})

const errorRepString = computed(() => {
    const rate = detailedBreakdown.value?.errorRate ?? 0
    return errorRateToRepString(rate)
})

const summaryMetrics = computed(() => {
    if (!result.value) {
        return { precioUnitario: 0, precioFinal: 0, costeBruto: 0, beneficioNeto: 0, cantidad: 1 }
    }
    const precioFinal = Number(result.value.info?.precio_final || 0)
    const cant = Math.max(1, Number(result.value.info?.cantidad || 1))
    const precioUnitario = precioFinal / cant
    const costeBruto = Number(result.value.info?.coste_bruto_impresion || 0)
    const beneficioNeto = precioFinal - costeBruto
    return { precioUnitario, precioFinal, costeBruto, beneficioNeto, cantidad: cant }
})

onMounted(() => {
    const cs = store.appData.calc_state || {}
    Object.assign(form, {
        empresa: store.empresa,
        cliente: cs.cliente || '',
        cliente_email: cs.cliente_email || '',
        fecha: cs.fecha || hoyISO(),
        descripcion: cs.descripcion || '',
        impresora: cs.impresora || (store.appData.printers[0]?.name || ''),
        filamento_tipo: cs.filamento_tipo || (store.appData.filament_types[0]?.name || ''),
        filamento_color: cs.filamento_color || '',
        peso_g: Number(cs.peso_g) || 50,
        tiempo_h: Number(cs.tiempo_h) || 1,
        cantidad: Number(cs.cantidad) || 1,
        is_multimaterial: !!cs.is_multimaterial,
        is_shared: !!cs.is_shared,
        shared_percent_3dcc: Number(cs.shared_percent_3dcc ?? 50),
        shared_percent_silab3d: Number(cs.shared_percent_silab3d ?? 50),
        diseno_modelado: cs.diseno_modelado || 'No necesario',
        diseno_horas: Number(cs.diseno_horas) || 1,
        postprocesado: cs.postprocesado || 'Limpio',
        probabilidad_error: cs.probabilidad_error || OPTIONS.probError[0].value,
        markup: cs.markup || Object.keys(MARKUP)[0],
        urgencia_nivel: cs.urgencia_nivel || OPTIONS.urgencia[0],
        gasto_misc: Number(cs.gasto_misc || 0),
    })
    if (cs.material_breakdown && Array.isArray(cs.material_breakdown)) {
        // Reset reactive array to match saved breakdown
        mixLines.splice(0, mixLines.length)
        cs.material_breakdown.forEach((line) => {
            mixLines.push({ material: line.material, color: line.color, grams: line.grams })
        })
        // Ensure at least 2 lines
        while (mixLines.length < 2) mixLines.push({ material: '', color: '', grams: 0 })
    }
    if (form.is_shared) store.loadPartnerInventory()
})

watch(() => form.is_shared, (val) => {
    if (val && !store.partnerInventory) store.loadPartnerInventory()
})

/* ── Precarga desde la bandeja de presupuestos web (fase 2) ── */
function applyWebQuotePrefill(pending) {
    const p = pending?.prefill
    if (!p) return
    if (p.cliente) form.cliente = p.cliente
    if (p.cliente_email) { form.cliente_email = p.cliente_email; lastAutofilledEmail = p.cliente_email }
    if (p.descripcion) form.descripcion = p.descripcion
    if (p.filamento_tipo && filamentOptions.value.includes(p.filamento_tipo)) form.filamento_tipo = p.filamento_tipo
    if (p.filamento_color) form.filamento_color = p.filamento_color
    if (Number(p.peso_g) > 0) form.peso_g = Number(p.peso_g)
    if (Number(p.tiempo_h) > 0) form.tiempo_h = Number(p.tiempo_h)
    form.cantidad = 1
    form.fecha = hoyISO()
}

onMounted(() => {
    if (store.pendingWebQuote) applyWebQuotePrefill(store.pendingWebQuote)
})
watch(() => store.pendingWebQuote, (v) => {
    if (v) applyWebQuotePrefill(v)
})

const descartarWebQuote = () => { store.pendingWebQuote = null }

let _saveTimer = null
watch(form, () => {
    clearTimeout(_saveTimer)
    _saveTimer = setTimeout(() => {
        store.saveCalcState(structuredClone({
            ...form,
            material_breakdown: materialBreakdown(),
            deterioro_impresora: 'Autofinanciación'
        }))
    }, 600)
}, { deep: true })
onUnmounted(() => clearTimeout(_saveTimer))

// Sync mix breakdown whenever mix lines change
watch(mixLines, () => {
    if (!form.is_multimaterial) return
    form.peso_g = mixTotalGrams.value
}, { deep: true })

watch(() => form.is_multimaterial, (val) => {
    if (val) {
        // Initialise first two lines with the currently-selected material
        if (!mixLines[0].material) mixLines[0].material = form.filamento_tipo
        if (!mixLines[1].material) mixLines[1].material = form.filamento_tipo
    }
})

const calculate = async () => {
    errors.value = {}
    const validation = calcSchema.safeParse({ ...form })
    if (!validation.success) {
        const fieldErrors = {}
        for (const issue of validation.error.issues) {
            const field = issue.path[0]
            if (field && !fieldErrors[field]) fieldErrors[field] = issue.message
        }
        errors.value = fieldErrors
        toast.add({ severity: 'warn', summary: 'Validación', detail: 'Revisa los campos marcados en rojo', life: 4000 })
        return
    }
    try {
        const payload = structuredClone({
            ...form,
            material_breakdown: materialBreakdown(),
            partner_printers: partnerPrintersPayload(),
            deterioro_impresora: 'Autofinanciación'
        })
        const res = await store.calculate(payload)
        result.value = res
        updateCharts(res)
        if (isHandheld.value) {
            await nextTick()
            resultsAnchor.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error de cálculo', detail: e.message, life: 5000 })
    }
}

// Enter en cualquier campo de texto del formulario lanza el cálculo
const onEnterCalcular = (e) => {
    const el = e.target
    if (e.isComposing || el.tagName !== 'INPUT' || el.readOnly || el.type === 'checkbox') return
    calculate()
}

const COLORS = ['#60A5FA', '#34D399', '#A78BFA', '#FBBF24', '#F472B6', '#22D3EE', '#FB923C', '#9CA3AF']

const updateCharts = (res) => {
    const rows = Object.entries(res.breakdownDict || {})
        .map(([label, value]) => [label, Number(value || 0)])
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1])

    const labels = rows.map(([label]) => label)
    const values = rows.map(([, value]) => value)
    const barColors = labels.map((_, index) => toRgba(COLORS[index % COLORS.length], 0.75))

    chartDataDonut.value = {
        labels,
        datasets: [{
            data: values,
            backgroundColor: labels.map((_, index) => COLORS[index % COLORS.length]),
            borderColor: '#0f172a',
            borderWidth: 2,
            hoverOffset: 10,
            spacing: 2
        }]
    }
    chartDataBar.value = {
        labels,
        datasets: [{
            label: 'Coste',
            data: values,
            backgroundColor: barColors,
            borderColor: labels.map((_, index) => COLORS[index % COLORS.length]),
            borderWidth: 1,
            borderRadius: 8,
            borderSkipped: false,
            barThickness: 18
        }]
    }
}

const pieOpts = {
    cutout: '0%',
    plugins: {
        legend: {
            position: 'right',
            labels: {
                color: '#94a3b8',
                usePointStyle: true,
                pointStyle: 'circle',
                boxWidth: 10,
                padding: 14,
                font: { size: 11 }
            }
        },
        tooltip: {
            callbacks: {
                label: (context) => {
                    const dataset = context.dataset?.data || []
                    const total = dataset.reduce((acc, value) => acc + Number(value || 0), 0)
                    const current = Number(context.raw || 0)
                    const percent = formatNumero(total > 0 ? (current / total) * 100 : 0, { minDecimales: 1, maxDecimales: 1 })
                    return `${context.label}: ${formatMoney(current)} (${percent}%)`
                }
            }
        }
    },
    responsive: true,
    maintainAspectRatio: false
}

const barOpts = {
    ...pieOpts,
    indexAxis: 'y',
    plugins: {
        legend: { display: false },
        tooltip: {
            callbacks: {
                label: (context) => {
                    const dataset = context.dataset?.data || []
                    const total = dataset.reduce((acc, value) => acc + Number(value || 0), 0)
                    const current = Number(context.raw || 0)
                    const percent = formatNumero(total > 0 ? (current / total) * 100 : 0, { minDecimales: 1, maxDecimales: 1 })
                    return `${formatMoney(current)} (${percent}%)`
                }
            }
        }
    },
    scales: {
        x: {
            beginAtZero: true,
            ticks: {
                color: '#94a3b8',
                callback: (value) => formatMoney(value)
            },
            grid: { color: '#1e293b' }
        },
        y: { ticks: { color: '#94a3b8' }, grid: { display: false } }
    }
}

const _decideEmailForNew = async () => {
    const email = String(form.cliente_email || '').trim()
    const emailEnabled = store.puedeAvisar()
    if (!email || !emailEnabled) return { proceed: true, options: {} }
    const fakeOrder = {
        id: '——',
        cliente: form.cliente,
        cliente_email: email,
        descripcion: form.descripcion,
        estado: 'Presupuesto enviado',
    }
    const choice = await askEmailConfirm({
        order: fakeOrder,
        oldStatus: '',
        newStatus: 'Presupuesto enviado',
        recipientEmail: email,
        title: 'Notificar nuevo presupuesto',
    })
    if (choice === 'cancel') return { proceed: false, options: {} }
    // sync any edited recipient back to the form
    if (emailConfirmState.recipientEmail && emailConfirmState.recipientEmail !== email) {
        form.cliente_email = emailConfirmState.recipientEmail
        if (result.value?.info) result.value.info.cliente_email = form.cliente_email
    }
    if (choice === 'skip') return { proceed: true, options: { skipNotification: true } }
    return { proceed: true, options: {} }
}

const _payloadActual = () => JSON.parse(JSON.stringify({
    ...form,
    material_breakdown: materialBreakdown(),
    partner_printers: partnerPrintersPayload(),
    deterioro_impresora: 'Autofinanciación',
}))

/* Solicitud web precargada: su pedido ya existe (lo creó Supabase al llegar),
 * así que se recalcula ese mismo y pasa a 'Presupuesto enviado'. */
const presupuestarSolicitud = async () => {
    const pending = store.pendingWebQuote
    const decision = await _decideEmailForNew()
    if (!decision.proceed) {
        toast.add({ severity: 'secondary', summary: 'Guardado cancelado', life: 2200 })
        return
    }
    try {
        const res = await store.presupuestarSolicitud({ orderId: pending.orderId, payload: _payloadActual() }, decision.options)
        const aviso = decision.options.skipNotification || !form.cliente_email
            ? '(sin notificación)'
            : '· avisando al cliente con el PDF…'
        toast.add({
            severity: 'success',
            summary: `${pending.codigo || pending.orderId} presupuestado`,
            detail: `${formatMoney(res.newPrice)} ${aviso}`,
            life: 4000,
        })
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 5000 })
    }
}

const saveOrder = async () => {
    if (!result.value) return
    if (store.pendingWebQuote?.orderId && store.appData.orders.some((o) => o.id === store.pendingWebQuote.orderId)) {
        return presupuestarSolicitud()
    }
    const info = result.value.info || {}
    const clienteNorm = String(info.cliente || '').trim().toLowerCase()
    const descNorm = String(info.descripcion || '').trim().toLowerCase()
    const existing = store.appData.orders.find(
        (o) => !o.archived
            && String(o.cliente || '').trim().toLowerCase() === clienteNorm
            && String(o.descripcion || '').trim().toLowerCase() === descNorm
    )
    if (existing) {
        confirm.require({
            message: `Ya existe el pedido #${existing.id} de "${existing.cliente}" — "${existing.descripcion}".\n¿Quieres actualizarlo con los nuevos valores o crear uno nuevo?`,
            header: 'Pedido existente',
            icon: 'pi pi-exclamation-triangle',
            rejectLabel: 'Crear nuevo',
            acceptLabel: 'Actualizar',
            rejectProps: { severity: 'secondary' },
            acceptProps: { severity: 'warn' },
            accept: async () => {
                try {
                    const payload = JSON.parse(JSON.stringify({ ...form, material_breakdown: materialBreakdown(), partner_printers: partnerPrintersPayload(), deterioro_impresora: 'Autofinanciación' }))
                    const res = await store.recalculateOrder({ orderId: existing.id, payload })
                    toast.add({ severity: 'success', summary: 'Pedido actualizado', detail: `#${existing.id} — nuevo precio: ${formatMoney(res.newPrice)}`, life: 4000 })
                } catch (e) {
                    toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
                }
            },
            reject: async () => {
                const decision = await _decideEmailForNew()
                if (!decision.proceed) {
                    toast.add({ severity: 'secondary', summary: 'Guardado cancelado', life: 2200 })
                    return
                }
                const res = await store.saveOrderFromResult(result.value, decision.options)
                if (decision.options.skipNotification) {
                    toast.add({ severity: 'info', summary: 'Guardado', detail: `Pedido #${res.order.id} (sin notificación).`, life: 3000 })
                } else if (form.cliente_email && store.puedeAvisar()) {
                    toast.add({ severity: 'success', summary: 'Guardado', detail: `Pedido #${res.order.id} · Enviando email + PDF…`, life: 3500 })
                } else {
                    toast.add({ severity: 'success', summary: 'Guardado', detail: `Pedido #${res.order.id}`, life: 3000 })
                }
            },
        })
    } else {
        const decision = await _decideEmailForNew()
        if (!decision.proceed) {
            toast.add({ severity: 'secondary', summary: 'Guardado cancelado', life: 2200 })
            return
        }
        const res = await store.saveOrderFromResult(result.value, decision.options)
        if (decision.options.skipNotification) {
            toast.add({ severity: 'info', summary: 'Guardado', detail: `Pedido #${res.order.id} (sin notificación).`, life: 3000 })
        } else if (form.cliente_email && store.puedeAvisar()) {
            toast.add({ severity: 'success', summary: 'Guardado', detail: `Pedido #${res.order.id} · Enviando email + PDF…`, life: 3500 })
        } else {
            toast.add({ severity: 'success', summary: 'Guardado', detail: `Pedido #${res.order.id}`, life: 3000 })
        }
    }
}

const getTicket = async (type) => {
    if (!result.value) return
    const resultPlain = JSON.parse(JSON.stringify(result.value))
    const tickets = await api.getTickets({ info: resultPlain.info || {}, breakdown: resultPlain.breakdown, breakdownDict: resultPlain.breakdownDict || {} })
    ticketKind.value = type
    ticketTitle.value = type === 'cliente' ? 'Ticket Cliente' : 'Ticket Empresa'
    ticketContent.value = type === 'cliente' ? tickets.cliente : tickets.empresa
    ticketDialogVisible.value = true
}

const copyTicket = () => {
    api.copyText(ticketContent.value)
    toast.add({ severity: 'info', summary: 'Copiado', detail: 'Texto copiado al portapapeles', life: 2000 })
}

const pdfTicket = async () => {
    try {
        const resultPlain = result.value ? JSON.parse(JSON.stringify(result.value)) : null
        const summary = resultPlain
            ? { kind: ticketKind.value, info: resultPlain.info || {}, breakdownDict: resultPlain.breakdownDict || {} }
            : null

        const res = await api.saveTicketPdf({
            title: ticketTitle.value,
            content: ticketContent.value,
            summary,
        })
        if (!res.canceled) {
            toast.add({
                severity: 'success',
                summary: 'PDF guardado',
                detail: 'Pulsa aquí para abrir la carpeta',
                life: 6000,
                data: { folderPath: res.filePath },
            })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'PDF', detail: e.message || 'No se pudo generar el PDF', life: 4000 })
    }
}

const exportBothPdfs = async () => {
    if (!result.value) return
    try {
        const resultPlain = JSON.parse(JSON.stringify(result.value))
        const summary = { info: resultPlain.info || {}, breakdownDict: resultPlain.breakdownDict || {} }
        const res = await api.saveBothPdfs({ summary })
        if (!res.canceled && res.files?.length) {
            toast.add({
                severity: 'success',
                summary: 'PDFs guardados',
                detail: `${res.files.length} archivos exportados. Pulsa para abrir carpeta.`,
                life: 6000,
                data: { folderPath: res.files[0] },
            })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'PDF', detail: e.message || 'No se pudieron generar los PDFs', life: 4000 })
    }
}
</script>

<template>
    <div class="flex flex-col gap-4" :class="isHandheld ? 'pb-24' : ''">
        <!-- ═══ Aviso: presupuesto web pendiente de enlazar ═══ -->
        <div v-if="store.pendingWebQuote" class="rounded-2xl border border-sky-300/60 dark:border-sky-700/50 bg-sky-50 dark:bg-sky-950/30 px-3 py-2 flex flex-wrap items-center gap-2">
            <i class="pi pi-globe text-sky-600 dark:text-sky-300 text-sm" />
            <span class="text-sm text-sky-700 dark:text-sky-300">
                <strong class="font-mono">{{ store.pendingWebQuote.codigo }}</strong> precargado
                <template v-if="store.pendingWebQuote.prefill?.precio_web != null">
                    · precio estimado en la web: <strong>{{ formatMoney(store.pendingWebQuote.prefill.precio_web) }}</strong>
                </template>
            </span>
            <span class="text-xs text-surface-400 dark:text-white/30">al guardar se actualiza su pedido y pasa a «Presupuesto enviado»</span>
            <Button label="Descartar" icon="pi pi-times" size="small" text severity="secondary" class="ml-auto" @click="descartarWebQuote" />
        </div>

        <div class="flex flex-col 2xl:flex-row gap-6">
            <!-- LEFT: Form -->
            <div class="w-full 2xl:w-[420px] 2xl:shrink-0 flex flex-col gap-4 min-w-0" @keydown.enter="onEnterCalcular">
                <Panel header="Información del proyecto" toggleable :pt="{ root: { class: 'card rounded-2xl border-0 overflow-hidden' }, header: { class: '!bg-transparent border-b border-black/[0.05] dark:border-white/[0.06] px-4 py-3' }, content: { class: '!bg-transparent p-4' } }">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Empresa</label>
                            <InputText :modelValue="store.empresa" class="w-full" disabled />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Cliente</label>
                            <InputText v-model="form.cliente" class="w-full" placeholder="Nombre del cliente" autocomplete="off" :invalid="!!errors.cliente" />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Fecha</label>
                            <DatePicker v-model="formFechaDate" dateFormat="dd/mm/yy" showIcon iconDisplay="input" class="w-full" :invalid="!!errors.fecha" />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Descripción</label>
                            <InputText v-model="form.descripcion" class="w-full" :invalid="!!errors.descripcion" />
                        </div>
                        <div class="flex flex-col gap-1 sm:col-span-2 min-w-0">
                            <label class="text-sm text-surface-400 flex items-center gap-1.5">
                                <i class="pi pi-envelope text-xs" />
                                Email del cliente
                                <span class="text-xs text-surface-300 dark:text-white/30">— opcional, para notificaciones automáticas</span>
                            </label>
                            <InputText v-model="form.cliente_email" type="email" placeholder="cliente@ejemplo.com" class="w-full" :invalid="!!errors.cliente_email" />
                            <small v-if="errors.cliente_email" class="text-red-500">{{ errors.cliente_email }}</small>
                        </div>
                    </div>
                    <div class="flex items-center gap-3 mt-3 p-3 bg-surface-100 dark:bg-surface-800 rounded-lg">
                        <Checkbox v-model="form.is_shared" binary inputId="shared" />
                        <label for="shared" class="text-sm cursor-pointer font-medium">Pedido compartido (3DCC + SILAB3D)</label>
                    </div>
                    <div v-if="form.is_shared" class="mt-3 p-3 border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg">
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-sm font-semibold text-indigo-600 dark:text-indigo-400">Reparto de retribución</span>
                            <span class="text-xs text-surface-500">Total: {{ form.shared_percent_3dcc + form.shared_percent_silab3d }}%</span>
                        </div>
                        <div class="flex items-center gap-4">
                            <div class="flex flex-col items-center gap-1 min-w-[80px]">
                                <span class="text-xs font-semibold text-blue-500">3DCC</span>
                                <span class="text-lg font-bold text-blue-600 dark:text-blue-400">{{ form.shared_percent_3dcc }}%</span>
                            </div>
                            <Slider v-model="form.shared_percent_3dcc" :min="0" :max="100" :step="5" class="flex-1"
                                @update:modelValue="(v) => { form.shared_percent_silab3d = 100 - v }" />
                            <div class="flex flex-col items-center gap-1 min-w-[80px]">
                                <span class="text-xs font-semibold text-purple-500">SILAB3D</span>
                                <span class="text-lg font-bold text-purple-600 dark:text-purple-400">{{ form.shared_percent_silab3d }}%</span>
                            </div>
                        </div>
                    </div>
                </Panel>

                <Panel header="Parámetros básicos" toggleable :pt="{ root: { class: 'card rounded-2xl border-0 overflow-hidden' }, header: { class: '!bg-transparent border-b border-black/[0.05] dark:border-white/[0.06] px-4 py-3' }, content: { class: '!bg-transparent p-4' } }">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-hidden">
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Impresora</label>
                            <Select v-model="form.impresora" :options="printerOptions" optionLabel="label" optionValue="value" class="w-full" :invalid="!!errors.impresora" />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Material</label>
                            <Select v-model="form.filamento_tipo" :options="filamentOptions" class="w-full" :invalid="!!errors.filamento_tipo" />
                        </div>
                        <div class="flex flex-col gap-1 min-w-0 overflow-hidden">
                            <label class="text-sm text-surface-400">Color</label>
                            <Select v-model="form.filamento_color" :options="colorOptions" optionLabel="label" optionValue="value" :disabled="form.is_multimaterial" class="w-full">
                                <template #option="slotProps">
                                    <div class="flex items-center gap-2">
                                        <span class="inline-block w-3 h-3 rounded-full border border-surface-300 dark:border-surface-600" :style="{ backgroundColor: slotProps.option.hex || colorHex(slotProps.option.value) }" />
                                        <span>{{ slotProps.option.label }}</span>
                                    </div>
                                </template>
                            </Select>
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label for="calc-peso" class="text-sm text-surface-400">Peso</label>
                            <CampoNumero v-model="form.peso_g" input-id="calc-peso" :max-decimales="2" unidad="g" :disabled="form.is_multimaterial" :invalid="!!errors.peso_g" />
                            <small v-if="errors.peso_g" class="text-red-500">{{ errors.peso_g }}</small>
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label for="calc-tiempo" class="text-sm text-surface-400">Tiempo</label>
                            <CampoTiempo v-model="form.tiempo_h" input-id="calc-tiempo" :invalid="!!errors.tiempo_h" />
                            <small v-if="errors.tiempo_h" class="text-red-500">{{ errors.tiempo_h }}</small>
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label for="calc-cantidad" class="text-sm text-surface-400">Cantidad</label>
                            <CampoNumero v-model="form.cantidad" input-id="calc-cantidad" :min="1" unidad="ud." />
                        </div>
                    </div>
                    <small class="text-surface-400 mt-2 block">
                        <i class="pi pi-info-circle mr-1" />Peso y tiempo son <strong>totales del pedido</strong>, de todas las piezas juntas. La cantidad reparte el precio por unidad y multiplica el post-procesado.
                    </small>
                    <div class="flex items-center gap-3 mt-3 p-2 bg-surface-100 dark:bg-surface-800 rounded-lg">
                        <Checkbox v-model="form.is_multimaterial" binary inputId="multi" />
                        <label for="multi" class="text-sm cursor-pointer">Multicolor / Multimaterial</label>
                    </div>
                    <!-- Inline multicolor rows -->
                    <div v-if="form.is_multimaterial" class="mt-3 flex flex-col gap-2 p-3 border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 rounded-lg">
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Mezcla de colores</span>
                            <Button icon="pi pi-plus" size="small" text severity="success" @click="addMixLine" v-tooltip.top="'Añadir color'" />
                        </div>
                        <div v-for="(line, idx) in mixLines" :key="idx"
                            class="grid gap-2 items-end overflow-hidden"
                            :class="isHandheld ? 'grid-cols-2 p-2.5 rounded-xl bg-white/60 dark:bg-white/[0.04]' : ''"
                            :style="isHandheld ? null : { gridTemplateColumns: mixLines.length > 2 ? '6rem 1fr 4.5rem 3.5rem 2rem' : '6rem 1fr 4.5rem 3.5rem' }">
                            <div class="flex flex-col gap-1 overflow-hidden">
                                <label v-if="idx === 0 || isHandheld" class="text-[11px] text-surface-400">Material</label>
                                <Select v-model="line.material" :options="filamentOptions" placeholder="Material" class="w-full" @update:modelValue="onMixMaterialChange(idx)" />
                            </div>
                            <div class="flex flex-col gap-1 overflow-hidden">
                                <label v-if="idx === 0 || isHandheld" class="text-[11px] text-surface-400">Color</label>
                                <Select v-model="line.color" :options="getColorOptionsByMaterial(line.material)" optionLabel="label" optionValue="value" placeholder="Color" class="w-full">
                                    <template #option="slotProps">
                                        <div class="flex items-center gap-2">
                                            <span class="inline-block w-3 h-3 rounded-full border border-surface-300 dark:border-surface-600" :style="{ backgroundColor: slotProps.option.hex || colorHex(slotProps.option.value) }" />
                                            <span>{{ slotProps.option.label }}</span>
                                        </div>
                                    </template>
                                </Select>
                            </div>
                            <div class="flex flex-col gap-1 overflow-hidden">
                                <label v-if="idx === 0 || isHandheld" class="text-[11px] text-surface-400">Peso (g)</label>
                                <CampoNumero v-model="line.grams" :max-decimales="2" placeholder="g" />
                            </div>
                            <div class="flex flex-col gap-1 min-w-0">
                                <label v-if="idx === 0 || isHandheld" class="text-[11px] text-surface-400">Gasto</label>
                                <span class="text-xs font-mono font-semibold text-amber-600 dark:text-amber-400 py-2 text-right whitespace-nowrap">{{ formatMoney(mixLineCost(line)) }}</span>
                            </div>
                            <Button v-if="mixLines.length > 2" icon="pi pi-times" text severity="danger"
                                :class="isHandheld ? 'col-span-2 !h-11' : 'mb-0.5 self-end'"
                                :label="isHandheld ? 'Quitar color' : null"
                                aria-label="Quitar color" @click="removeMixLine(idx)" v-tooltip.top="'Quitar'" />
                        </div>
                        <div class="flex items-center justify-between mt-2 pt-2 border-t border-amber-200 dark:border-amber-700">
                            <span class="text-xs text-surface-500">Total: <strong>{{ formatNumero(mixTotalGrams) }} g</strong></span>
                            <span class="text-sm font-mono font-bold text-amber-600 dark:text-amber-400">{{ formatMoney(mixTotalCost) }}</span>
                        </div>
                    </div>
                    <small v-if="filamentPrice" class="text-surface-400 mt-1 block">
                        <i class="pi pi-info-circle mr-1" />{{ filamentPrice }}
                    </small>
                </Panel>

                <Panel header="Parámetros complementarios" toggleable :pt="{ root: { class: 'card rounded-2xl border-0 overflow-hidden' }, header: { class: '!bg-transparent border-b border-black/[0.05] dark:border-white/[0.06] px-4 py-3' }, content: { class: '!bg-transparent p-4' } }">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-sm text-surface-400 flex items-center justify-between gap-2">
                                <span>Diseño</span>
                                <span class="font-mono text-xs" :class="disenoTarifa > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">{{ formatMoney(disenoTarifa) }}</span>
                            </label>
                            <Select v-model="form.diseno_modelado" :options="disenoOptions" optionLabel="label" optionValue="value" class="w-full">
                                <template #option="{ option }">
                                    <div class="flex items-baseline justify-between gap-3 w-full min-w-0">
                                        <div class="min-w-0">
                                            <div class="font-medium">{{ option.label }}</div>
                                            <div class="text-xs text-surface-400 leading-snug whitespace-normal">{{ option.desc }}</div>
                                        </div>
                                        <span class="font-mono text-xs shrink-0" :class="option.eur > 0 || option.custom ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">
                                            {{ option.custom ? formatMoney(laborCostH) + '/h' : formatMoney(option.eur) }}
                                        </span>
                                    </div>
                                </template>
                            </Select>
                            <div v-if="esDisenoAMedida" class="flex items-start gap-2 mt-1">
                                <CampoTiempo v-model="form.diseno_horas" class="w-40 shrink-0" />
                                <span class="text-xs text-surface-400 pt-2.5">× {{ formatMoney(laborCostH) }}/h = <strong class="text-amber-600 dark:text-amber-400">{{ formatMoney(disenoTarifa) }}</strong></span>
                            </div>
                            <small class="text-surface-400">Se cobra una sola vez por pedido, sean 1 o 50 piezas.</small>
                        </div>

                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-sm text-surface-400 flex items-center justify-between gap-2">
                                <span>Post-procesado <span class="text-xs">(incluye soportes)</span></span>
                                <span class="font-mono text-xs" :class="postprocTarifa > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">{{ formatMoney(postprocTarifa) }}</span>
                            </label>
                            <Select v-model="form.postprocesado" :options="postprocOptions" optionLabel="label" optionValue="value" class="w-full">
                                <template #option="{ option }">
                                    <div class="flex items-baseline justify-between gap-3 w-full min-w-0">
                                        <div class="min-w-0">
                                            <div class="font-medium">{{ option.label }}</div>
                                            <div class="text-xs text-surface-400 leading-snug whitespace-normal">{{ option.desc }}</div>
                                        </div>
                                        <span class="font-mono text-xs shrink-0" :class="option.eur > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">
                                            {{ formatMoney(option.eur) }}<span v-if="cantidadUds > 1" class="text-surface-400">/ud.</span>
                                        </span>
                                    </div>
                                </template>
                            </Select>
                            <small v-if="cantidadUds > 1 && postprocTarifaUd > 0" class="text-surface-400">
                                {{ formatMoney(postprocTarifaUd) }}/ud. × {{ cantidadUds }} uds. = <strong class="text-amber-600 dark:text-amber-400">{{ formatMoney(postprocTarifa) }}</strong> — el acabado es manual y se repite en cada pieza.
                            </small>
                            <small v-else class="text-surface-400">Los soportes ya van dentro del tramo; se multiplica por cada pieza.</small>
                            <div v-if="llevaPintura" class="flex items-start gap-2 mt-1 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                                <i class="pi pi-info-circle text-amber-500 text-xs mt-0.5" />
                                <span class="text-xs text-amber-700 dark:text-amber-300">La tarifa cubre la mano de obra. Añade imprimación, pinturas y barniz en <strong>Extras / Misceláneos</strong>.</span>
                            </div>
                        </div>

                        <div v-if="manoObraTotal > 0" class="col-span-full flex items-center justify-between px-3 py-2 rounded-lg card-inset">
                            <span class="text-xs font-semibold uppercase tracking-wide text-surface-500">Mano de obra</span>
                            <span class="font-mono font-bold text-amber-600 dark:text-amber-400">{{ formatMoney(manoObraTotal) }}</span>
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Prob. Error</label>
                            <div class="flex gap-1">
                                <InputText :modelValue="form.probabilidad_error" readonly class="flex-1 min-w-0 !cursor-pointer"
                                    @click="openRiskDialog" v-tooltip.top="'Pulsa para calcular el riesgo con el cuestionario'" />
                                <Button icon="pi pi-question-circle" @click="openRiskDialog" severity="secondary" v-tooltip.top="'Calcular riesgo mediante cuestionario'" />
                            </div>
                        </div>
                        <div class="flex flex-col gap-1 min-w-0">
                            <label class="text-sm text-surface-400">Markup</label>
                            <Select v-if="markupOptions.length > 1" v-model="form.markup" :options="markupOptions" class="w-full" />
                            <div v-else class="flex items-center gap-2 px-3 py-2.5 rounded-lg card-inset text-sm text-surface-500">
                                <span>{{ form.markup }}</span>
                                <i class="pi pi-lock text-[10px] ml-auto" v-tooltip.top="'Margen fijo de la casa: se aplica sobre filamento, luz y desgaste.'" />
                            </div>
                        </div>
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-sm text-surface-400">Urgencia</label>
                            <Select v-model="form.urgencia_nivel" :options="OPTIONS.urgencia" class="w-full" />
                        </div>
                        <div class="flex flex-col gap-1 col-span-full min-w-0">
                            <label class="text-sm text-surface-400 flex items-center gap-1">
                                <i class="pi pi-tag text-xs" /> Extras / Misceláneos
                            </label>
                            <CampoNumero v-model="form.gasto_misc" :min-decimales="2" :max-decimales="2" :unidad="unit" />
                            <small class="text-surface-400">Anillas, llaveros, embalaje… Importe directo añadido al precio final (sin markup)</small>
                        </div>
                    </div>
                </Panel>

                <Button v-if="!isHandheld" label="Calcular Presupuesto" icon="pi pi-bolt" @click="calculate" class="w-full" severity="info" size="large" />
            </div>

            <!-- RIGHT: Results -->
            <div ref="resultsAnchor" class="flex-1 min-w-0 scroll-mt-4">
                <div v-if="result" class="flex flex-col gap-4">
                    <!-- Precios del proyecto -->
                    <div class="flex flex-col gap-2">
                        <div class="text-xs font-semibold uppercase tracking-wider text-surface-500 px-1">Precios del proyecto</div>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div class="bg-primary-50 dark:bg-primary-950/30 border border-primary-200 dark:border-primary-800 rounded-xl p-4 text-center">
                                <div class="text-xs text-primary-600 dark:text-primary-400 font-semibold uppercase tracking-wide">Precio Total</div>
                                <div class="text-2xl font-bold text-primary-700 dark:text-primary-300 mt-1">{{ formatMoney(summaryMetrics.precioFinal) }}</div>
                                <div v-if="summaryMetrics.cantidad > 1" class="text-xs text-primary-500 mt-1">{{ summaryMetrics.cantidad }} ud. × {{ formatMoney(summaryMetrics.precioUnitario) }}/ud.</div>
                            </div>
                            <div class="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-xl p-4 text-center">
                                <div class="text-xs text-green-600 dark:text-green-400 font-semibold uppercase tracking-wide">Beneficio</div>
                                <div class="text-2xl font-bold text-green-700 dark:text-green-300 mt-1">{{ formatMoney(summaryMetrics.beneficioNeto) }}</div>
                            </div>
                            <div class="card-inset rounded-xl p-4 text-center">
                                <div class="text-xs text-surface-500 font-semibold uppercase tracking-wide">Coste Bruto</div>
                                <div class="text-2xl font-bold mt-1">{{ formatMoney(summaryMetrics.costeBruto) }}</div>
                            </div>
                        </div>
                    </div>

                    <!-- Shared Split Info -->
                    <div v-if="result.info.is_shared && result.info.shared_split" class="p-4 border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 rounded-xl">
                        <div class="flex items-center gap-2 mb-3">
                            <i class="pi pi-users text-indigo-500" />
                            <span class="font-semibold text-indigo-600 dark:text-indigo-400">Pedido Compartido — Reparto</span>
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div class="text-center p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
                                <div class="text-xs font-semibold text-blue-500 uppercase">3DCC ({{ result.info.shared_split['3DCC'] }}%)</div>
                                <div class="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1">{{ formatMoney(result.info.precio_final * result.info.shared_split['3DCC'] / 100) }}</div>
                            </div>
                            <div class="text-center p-3 bg-purple-50 dark:bg-purple-950/30 rounded-lg border border-purple-200 dark:border-purple-800">
                                <div class="text-xs font-semibold text-purple-500 uppercase">SILAB3D ({{ result.info.shared_split['SILAB3D'] }}%)</div>
                                <div class="text-xl font-bold text-purple-600 dark:text-purple-400 mt-1">{{ formatMoney(result.info.precio_final * result.info.shared_split['SILAB3D'] / 100) }}</div>
                            </div>
                        </div>
                    </div>

                    <!-- Breakdown -->
                    <Panel header="Desglose de Costes" :pt="{ root: { class: 'card rounded-2xl border-0 overflow-hidden' }, header: { class: '!bg-transparent border-b border-black/[0.05] dark:border-white/[0.06] px-4 py-3' }, content: { class: '!bg-transparent p-4' } }">
                        <div class="flex flex-col gap-3">
                            <!-- Sección 1: Bruto -->
                            <div class="rounded-xl card-inset">
                                <div class="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-surface-500 border-b border-black/[0.04] dark:border-white/[0.06]">
                                    Parámetros básicos <span class="font-normal normal-case">(filamento + electricidad + maquinaria)</span>
                                </div>
                                <div class="px-3 py-1">
                                    <div v-for="row in detailedBreakdown?.brutoRows || []" :key="`bruto-${row.label}`"
                                        class="flex justify-between items-center py-2 border-b border-black/[0.04] dark:border-white/[0.06] last:border-0">
                                        <span class="text-surface-600 dark:text-surface-300">{{ row.label }}</span>
                                        <span class="font-mono font-semibold text-primary-600 dark:text-primary-400">{{ formatMoney(row.value) }}</span>
                                    </div>
                                    <div class="flex justify-between items-center py-2">
                                        <span class="font-semibold text-surface-700 dark:text-surface-200">Subtotal bruto</span>
                                        <span class="font-mono font-bold text-primary-600 dark:text-primary-400">{{ formatMoney(detailedBreakdown?.brutoTotal || 0) }}</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Sección 2: Complementos -->
                            <div class="rounded-xl card-inset">
                                <div class="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-surface-500 border-b border-black/[0.04] dark:border-white/[0.06]">
                                    Parámetros complementarios <span class="font-normal normal-case">(mano de obra + extras)</span>
                                </div>
                                <div class="px-3 py-1">
                                    <div v-for="row in detailedBreakdown?.complementosRows || []" :key="`comp-${row.label}`"
                                        class="flex justify-between items-center py-2 border-b border-black/[0.04] dark:border-white/[0.06] last:border-0">
                                        <span class="text-surface-600 dark:text-surface-300">{{ row.label }}</span>
                                        <span class="font-mono font-semibold text-primary-600 dark:text-primary-400">{{ formatMoney(row.value) }}</span>
                                    </div>
                                    <div class="flex justify-between items-center py-2">
                                        <span class="font-semibold text-surface-700 dark:text-surface-200">Subtotal complementos</span>
                                        <span class="font-mono font-bold text-primary-600 dark:text-primary-400">{{ formatMoney(detailedBreakdown?.complementosTotal || 0) }}</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Sección 3: Beneficio -->
                            <div class="rounded-xl card-inset">
                                <div class="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-surface-500 border-b border-black/[0.04] dark:border-white/[0.06]">
                                    Beneficio <span class="font-normal normal-case">(markup + error)</span>
                                </div>
                                <div class="px-3 py-1">
                                    <div class="flex justify-between items-center py-2 border-b border-black/[0.04] dark:border-white/[0.06]">
                                        <span class="text-surface-600 dark:text-surface-300">Suplemento markup (×{{ moneyFormatter.format(detailedBreakdown?.markup || 2.3) }})</span>
                                        <span class="font-mono font-semibold text-green-600 dark:text-green-400">+{{ formatMoney(detailedBreakdown?.markupSupplement || 0) }}</span>
                                    </div>
                                    <div class="flex justify-between items-center py-2 border-b border-black/[0.04] dark:border-white/[0.06]">
                                        <span class="text-surface-600 dark:text-surface-300">
                                            Suplemento error ({{ detailedBreakdown?.tasaErrorLabel }}{{ errorRepString }})
                                        </span>
                                        <span class="font-mono font-semibold text-amber-500">+{{ formatMoney(detailedBreakdown?.errorSupplement || 0) }}</span>
                                    </div>
                                    <div v-if="(detailedBreakdown?.recargoUrgencia || 0) > 0" class="flex justify-between items-center py-2 border-b border-black/[0.04] dark:border-white/[0.06]">
                                        <span class="text-surface-600 dark:text-surface-300">Recargo urgencia</span>
                                        <span class="font-mono font-semibold text-orange-500">+{{ formatMoney(detailedBreakdown?.recargoUrgencia || 0) }}</span>
                                    </div>
                                    <div class="flex justify-between items-center py-2">
                                        <span class="font-semibold text-surface-700 dark:text-surface-200">Subtotal beneficio</span>
                                        <span class="font-mono font-bold text-green-600 dark:text-green-400">{{ formatMoney(detailedBreakdown?.beneficioTotal || 0) }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </Panel>

                    <!-- Actions -->
                    <div class="flex flex-wrap gap-2">
                        <Button label="Ticket Cliente" icon="pi pi-file" severity="secondary" outlined @click="getTicket('cliente')" />
                        <Button label="Ticket Empresa" icon="pi pi-briefcase" severity="secondary" outlined @click="getTicket('empresa')" />
                        <Button label="Exportar Ambos PDFs" icon="pi pi-file-pdf" severity="help" @click="exportBothPdfs" />
                        <Button label="Recalcular" icon="pi pi-refresh" severity="warning" outlined @click="calculate" />
                        <Button label="Guardar Pedido" icon="pi pi-save" severity="success" @click="saveOrder" class="ml-auto" />
                    </div>

                    <!-- Charts -->
                    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        <ChartCard title="Distribución de Costes" type="pie" :data="chartDataDonut" :options="pieOpts" height="360px" />
                        <ChartCard title="Desglose por Concepto" type="bar" :data="chartDataBar" :options="barOpts" height="360px" />
                    </div>
                </div>

                <!-- Empty State -->
                <div v-else class="flex flex-col items-center justify-center h-full text-surface-400 gap-4 py-20">
                    <i class="pi pi-calculator text-6xl text-surface-300" />
                    <p class="text-lg">Configura los parámetros y calcula un presupuesto</p>
                </div>
            </div>
        </div>

        <!-- Risk Assessment Dialog -->
        <Dialog v-model:visible="riskDialog" modal header="Cuestionario de Riesgo" :style="{ width: '32rem' }">
            <div class="flex flex-col gap-4 py-2">
                <p class="text-sm text-surface-500 mb-2">Responde estas 4 preguntas para calcular la probabilidad de error (25% – 200%). Cada factor adverso sube un nivel.</p>

                <div class="flex flex-col gap-1 min-w-0">
                    <label class="text-sm font-semibold">1. Geometría y estabilidad</label>
                    <Select v-model="indiceError.geometria" :options="OPTIONS.geometria" optionLabel="label" optionValue="value" class="w-full" />
                </div>

                <div class="flex flex-col gap-1 min-w-0">
                    <label class="text-sm font-semibold">2. Dificultad técnica</label>
                    <Select v-model="indiceError.dificultad" :options="OPTIONS.dificultadTecnica" optionLabel="label" optionValue="value" class="w-full" />
                </div>

                <div class="flex flex-col gap-1 min-w-0">
                    <label class="text-sm font-semibold">3. Duración individual</label>
                    <Select v-model="indiceError.duracion" :options="OPTIONS.duracionIndividual" optionLabel="label" optionValue="value" class="w-full" />
                </div>

                <div class="flex flex-col gap-1 min-w-0">
                    <label class="text-sm font-semibold">4. I+D</label>
                    <Select v-model="indiceError.id" :options="OPTIONS.idOptimizacion" optionLabel="label" optionValue="value" class="w-full" />
                </div>

                <div class="flex items-center justify-between p-4 rounded-2xl mt-2 bg-surface-100 dark:bg-surface-800/50 border border-black/[0.05] dark:border-white/[0.05]">
                    <div>
                        <div class="text-[10px] uppercase font-bold text-surface-500 tracking-wider">Probabilidad Sugerida</div>
                        <div class="text-xl font-black text-primary-600 dark:text-primary-400">
                            {{ indiceErrorSugerido }}
                        </div>
                    </div>
                    <Button label="Aplicar" icon="pi pi-check" @click="applyIndiceError" />
                </div>
            </div>
        </Dialog>

        <!-- Ticket Dialog -->
        <Dialog v-model:visible="ticketDialogVisible" modal :header="ticketTitle" :style="{ width: 'min(95vw, 45rem)' }">
            <div class="flex flex-col gap-3">
                <Textarea v-model="ticketContent" rows="18" class="w-full font-mono text-sm" readonly autoResize />
            </div>
            <template #footer>
                <Button label="Copiar" icon="pi pi-copy" severity="secondary" text @click="copyTicket" />
                <Button label="Guardar PDF" icon="pi pi-file-pdf" severity="help" @click="pdfTicket" />
            </template>
        </Dialog>

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

        <!-- ═══ Barra de acción móvil ═══
             Anclada abajo (zona del pulgar) y con el precio ya visible, para
             no tener que buscar el resultado a ciegas después de calcular. -->
        <div v-if="isHandheld"
            class="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-black/[0.06] dark:border-white/[0.08] backdrop-blur-xl bg-white/85 dark:bg-[#141414]/90">
            <div v-if="result" class="min-w-0 flex-1">
                <div class="text-[10px] uppercase tracking-widest text-surface-400 leading-none">Precio total</div>
                <div class="text-xl font-semibold tracking-tight truncate">{{ formatMoney(summaryMetrics.precioFinal) }}</div>
            </div>
            <div v-else class="min-w-0 flex-1">
                <div class="text-[11px] text-surface-400 leading-snug">Mano de obra {{ formatMoney(manoObraTotal) }}</div>
            </div>
            <Button label="Calcular" icon="pi pi-bolt" severity="info" class="!h-12 shrink-0 px-5" @click="calculate" />
        </div>
    </div>
</template>
