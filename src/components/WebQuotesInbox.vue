<script setup>
import { ref, onMounted, computed } from 'vue'
import { store } from '../store'
import { loadWebQuotes, rejectWebQuote, notifyWebQuote, quoteFileUrl } from '../supabaseService'
import { api, isMobile } from '../platform'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'

const toast = useToast()
const confirm = useConfirm()
const quotes = ref([])
const loading = ref(false)
const errorMsg = ref('')
const collapsed = ref(false)
const expandedId = ref(null)
const rejecting = ref(null)

const ESTADO_META = {
  nuevo: { label: 'Nuevo', severity: 'info' },
  revisado: { label: 'Revisado', severity: 'secondary' },
  aceptado: { label: 'Aceptado por cliente', severity: 'success' },
}

async function refresh() {
  loading.value = true
  errorMsg.value = ''
  try {
    quotes.value = await loadWebQuotes()
    store.webQuotesCount = quotes.value.length
  } catch (e) {
    errorMsg.value = e.message || 'No se pudieron cargar los presupuestos web.'
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

const fmtMoney = (v) => `${Number(v || 0).toFixed(2)} €`
const fmtFecha = (iso) => {
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
}
const fmtBytes = (b) => {
  const n = Number(b || 0)
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function diasRestantes(q) {
  const t = new Date(q.valido_hasta).getTime()
  if (isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

function archivos(q) {
  return Array.isArray(q.archivos) ? q.archivos.filter((f) => f && f.path) : []
}

function piezas(q) {
  const files = archivos(q)
  if (!files.length) return Math.max(1, Number(q.cantidad || 1))
  return files.reduce((acc, f) => acc + Math.max(1, Number(f?.cantidad || 1)), 0)
}

function precioRef(q) {
  return q.precio_final != null ? Number(q.precio_final) : Number(q.precio_total || 0)
}

function direccion(q) {
  const d = q.direccion || {}
  return [d.calle, d.cp, d.ciudad, d.provincia].filter(Boolean).join(', ')
}

/* ── Acciones de archivo ── */
const abrirDescarga = (f) => api.openUrl(quoteFileUrl(f, { download: true }))
const abrirEnOrca = (f) => api.openUrl(`orcaslicer://open?file=${encodeURIComponent(quoteFileUrl(f))}`)
const abrirEnBambu = (f) => api.openUrl(`bambustudio://open?file=${encodeURIComponent(quoteFileUrl(f))}`)

/* ── Usar en calculadora ── */
function buildPrefill(q) {
  const files = archivos(q)
  let peso = 0
  let tiempo = 0
  for (const f of files) {
    const cant = Math.max(1, Number(f?.cantidad || 1))
    peso += Number(f?.metricas?.peso_g || 0) * cant
    tiempo += Number(f?.metricas?.tiempo_h || 0) * cant
  }
  if (!peso) peso = Number(q?.metricas?.peso_g || 0) * Math.max(1, Number(q.cantidad || 1))
  if (!tiempo) tiempo = Number(q?.metricas?.tiempo_h || 0) * Math.max(1, Number(q.cantidad || 1))

  const nombres = files.map((f) => String(f?.nombre || '').trim()).filter(Boolean)
  return {
    cliente: String(q.nombre || '').trim(),
    cliente_email: String(q.email || '').trim(),
    descripcion: `${q.codigo}${nombres.length ? ' · ' + nombres.join(', ') : ' · presupuesto web'}`,
    filamento_tipo: String(q.material || '').trim(),
    filamento_color: String(q.colores?.[0]?.nombre || '').trim(),
    peso_g: Math.round(peso) || null,
    tiempo_h: tiempo ? Math.round(tiempo * 10) / 10 : null,
    precio_web: precioRef(q),
  }
}

function usarEnCalculadora(q) {
  store.pendingWebQuote = { id: q.id, codigo: q.codigo, prefill: buildPrefill(q) }
  toast.add({
    severity: 'info',
    summary: `${q.codigo} → Calculadora`,
    detail: 'Datos precargados. Recalcula con tus costes reales y guarda el pedido para enlazarlo.',
    life: 6000,
  })
}

/* ── Rechazar ── */
function rechazar(q) {
  confirm.require({
    header: `Rechazar ${q.codigo}`,
    message: `Se marcará como rechazada y se avisará a ${q.nombre} por email con la plantilla de la web. ¿Continuar?`,
    acceptLabel: 'Rechazar y avisar',
    rejectLabel: 'Cancelar',
    acceptProps: { severity: 'danger' },
    accept: async () => {
      rejecting.value = q.id
      try {
        const res = await rejectWebQuote(q.id)
        if (!res.ok) throw new Error('La solicitud ya no está activa (¿aceptada o caducada?).')
        const mail = await notifyWebQuote(q.id)
        toast.add({
          severity: mail.ok ? 'success' : 'warn',
          summary: `${q.codigo} rechazado`,
          detail: mail.ok ? 'Cliente avisado por email.' : `Rechazado, pero el email falló: ${mail.error}`,
          life: 6000,
        })
        await refresh()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 6000 })
      } finally {
        rejecting.value = null
      }
    },
  })
}

const titulo = computed(() => `Presupuestos web${quotes.value.length ? ` (${quotes.value.length})` : ''}`)
const mobile = isMobile()
</script>

<template>
  <div class="rounded-2xl border border-sky-300/60 dark:border-sky-700/50 bg-sky-50 dark:bg-sky-950/30 p-3 flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <i class="pi pi-globe text-sky-600 dark:text-sky-300" />
      <span class="text-sm font-semibold text-sky-700 dark:text-sky-300">{{ titulo }}</span>
      <span class="text-[10px] text-surface-400 dark:text-white/30 hidden sm:inline">solicitudes del tasador de impresion3dcc.com sin pedido</span>
      <div class="ml-auto flex items-center gap-1">
        <Button :icon="loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'" text rounded severity="secondary"
          class="!w-11 !h-11 lg:!w-8 lg:!h-8" aria-label="Actualizar solicitudes web"
          @click="refresh" v-tooltip.bottom="'Actualizar'" :disabled="loading" />
        <Button :icon="collapsed ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" text rounded severity="secondary"
          class="!w-11 !h-11 lg:!w-8 lg:!h-8" :aria-label="collapsed ? 'Desplegar solicitudes web' : 'Plegar solicitudes web'"
          @click="collapsed = !collapsed" />
      </div>
    </div>

    <div v-if="!collapsed" class="flex flex-col gap-1.5">
      <div v-if="errorMsg" class="text-xs text-red-500 px-1">{{ errorMsg }}</div>
      <div v-else-if="!loading && !quotes.length" class="text-xs text-surface-400 dark:text-white/30 px-1">
        No hay solicitudes web pendientes.
      </div>

      <div v-for="q in quotes" :key="q.id" class="rounded-xl bg-white/70 dark:bg-black/20 overflow-hidden">
        <!-- Fila principal -->
        <div class="flex flex-wrap items-center gap-2 px-3 py-2 cursor-pointer" @click="expandedId = expandedId === q.id ? null : q.id">
          <i :class="expandedId === q.id ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="text-[10px] text-surface-400" />
          <span class="font-mono text-xs font-bold text-sky-600 dark:text-sky-300">{{ q.codigo }}</span>
          <Tag :value="ESTADO_META[q.estado]?.label || q.estado" :severity="ESTADO_META[q.estado]?.severity || 'secondary'" class="text-[9px] px-1.5 py-0" />
          <span class="text-sm font-medium">{{ q.nombre }}</span>
          <span class="text-xs text-surface-500">{{ q.material }} · {{ piezas(q) }} pza{{ piezas(q) !== 1 ? 's' : '' }}</span>
          <span v-if="q.entrega === 'envio'" class="text-[10px] text-surface-400"><i class="pi pi-truck text-[9px]" /> envío</span>
          <Tag v-if="diasRestantes(q) !== null && diasRestantes(q) <= 3" :value="diasRestantes(q) <= 0 ? 'Caducado' : `Caduca en ${diasRestantes(q)} d`" severity="danger" class="text-[9px] px-1.5 py-0" />
          <span class="text-[10px] text-surface-400 ml-auto">{{ fmtFecha(q.created_at) }}</span>
          <span class="text-sm font-semibold whitespace-nowrap">{{ fmtMoney(precioRef(q)) }}</span>
          <Button label="Usar en calculadora" icon="pi pi-calculator" outlined
            class="!h-11 lg:!h-8 w-full sm:w-auto shrink-0" @click.stop="usarEnCalculadora(q)" />
        </div>

        <!-- Detalle expandido -->
        <div v-if="expandedId === q.id" class="px-4 pb-3 pt-1 flex flex-col gap-2 border-t border-black/[0.05] dark:border-white/[0.06]">
          <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-surface-600 dark:text-white/60">
            <span><i class="pi pi-envelope text-[10px] mr-1" />{{ q.email }}</span>
            <span v-if="q.telefono"><i class="pi pi-phone text-[10px] mr-1" />{{ q.telefono }}</span>
            <span v-if="q.entrega === 'envio' && direccion(q)"><i class="pi pi-truck text-[10px] mr-1" />{{ direccion(q) }}</span>
            <span v-if="q.entrega === 'recogida'"><i class="pi pi-map-marker text-[10px] mr-1" />Recogida en Salamanca</span>
            <span v-if="diasRestantes(q) !== null"><i class="pi pi-clock text-[10px] mr-1" />Válido hasta {{ fmtFecha(q.valido_hasta) }}</span>
          </div>
          <p v-if="q.mensaje" class="text-xs text-surface-500 dark:text-white/50 italic m-0">“{{ q.mensaje }}”</p>

          <!-- Archivos -->
          <div v-if="archivos(q).length" class="flex flex-col gap-1">
            <div v-for="(f, i) in archivos(q)" :key="i" class="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04]">
              <i class="pi pi-box text-xs text-surface-400" />
              <span class="text-xs font-medium truncate max-w-[16rem]" :title="f.nombre">{{ f.nombre }}</span>
              <span class="text-[10px] text-surface-400">{{ fmtBytes(f.tamano_original || f.tamano) }}<template v-if="f.cantidad > 1"> · ×{{ f.cantidad }}</template></span>
              <span v-if="f.metricas?.peso_g" class="text-[10px] text-surface-400">{{ Math.round(f.metricas.peso_g) }} g/ud</span>
              <div class="flex gap-1 ml-auto">
                <Button icon="pi pi-download" size="small" text rounded severity="secondary" class="!w-7 !h-7" v-tooltip.top="'Descargar'" @click="abrirDescarga(f)" />
                <Button v-if="!mobile" label="Orca" size="small" text severity="info" class="!py-0.5 !px-2 text-[11px]" v-tooltip.top="'Abrir en OrcaSlicer'" @click="abrirEnOrca(f)" />
                <Button v-if="!mobile" label="Bambu" size="small" text severity="success" class="!py-0.5 !px-2 text-[11px]" v-tooltip.top="'Abrir en Bambu Studio'" @click="abrirEnBambu(f)" />
              </div>
            </div>
          </div>
          <div v-else class="text-[11px] text-surface-400">Sin archivos adjuntos.</div>

          <div class="flex justify-end">
            <Button label="Rechazar" icon="pi pi-times" size="small" text severity="danger" :loading="rejecting === q.id" @click="rechazar(q)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
