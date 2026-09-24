<script setup>
/**
 * Solicitudes del tasador web pendientes de presupuestar.
 *
 * Desde la migración 0027 cada solicitud llega YA como pedido en 'Nuevo'
 * (Supabase lo crea con los gramos, horas y coste estimados). Esta bandeja es
 * esa lista de pedidos filtrada, con los datos de la solicitud (archivos,
 * mensaje, entrega) que viven en su quote.
 */
import { ref, computed, watch } from 'vue'
import { store } from '../store'
import { loadQuotesByIds, notifyOrder, quoteFileUrl } from '../supabaseService'
import { api, isMobile } from '../platform'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'

const toast = useToast()
const confirm = useConfirm()
const quotesById = ref({})
const loading = ref(false)
const errorMsg = ref('')
const collapsed = ref(false)
const expandedId = ref(null)
const rejecting = ref(null)

/** Pedidos en 'Nuevo' que vienen de una solicitud web. */
const pedidos = computed(() =>
  (store.appData?.orders || [])
    .filter((o) => !o._fromPartner && !o.archived && o.quote_id && o.estado === 'Nuevo')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
)

async function cargarQuotes() {
  const ids = pedidos.value.map((o) => o.quote_id).filter((id) => !quotesById.value[id])
  if (!ids.length) return
  loading.value = true
  errorMsg.value = ''
  try {
    const rows = await loadQuotesByIds(ids)
    const next = { ...quotesById.value }
    for (const q of rows) next[q.id] = q
    quotesById.value = next
  } catch (e) {
    errorMsg.value = e.message || 'No se pudieron cargar las solicitudes web.'
  } finally {
    loading.value = false
  }
}

watch(() => pedidos.value.map((o) => o.quote_id).join(','), cargarQuotes, { immediate: true })

async function refresh() {
  loading.value = true
  try {
    await store.refresh()
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    loading.value = false
  }
}

const quoteDe = (o) => quotesById.value[o.quote_id] || null

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
  const t = new Date(q?.valido_hasta).getTime()
  if (isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

function archivos(q) {
  return Array.isArray(q?.archivos) ? q.archivos.filter((f) => f && f.path) : []
}

function direccion(q) {
  const d = q?.direccion || {}
  return [d.calle, d.cp, d.ciudad, d.provincia].filter(Boolean).join(', ')
}

/* ── Acciones de archivo ── */
const abrirDescarga = (f) => api.openUrl(quoteFileUrl(f, { download: true }))
const abrirEnOrca = (f) => api.openUrl(`orcaslicer://open?file=${encodeURIComponent(quoteFileUrl(f))}`)
const abrirEnBambu = (f) => api.openUrl(`bambustudio://open?file=${encodeURIComponent(quoteFileUrl(f))}`)

/* ── Presupuestar en la calculadora ── */
function buildPrefill(o) {
  return {
    cliente: String(o.cliente || '').trim(),
    cliente_email: String(o.cliente_email || '').trim(),
    descripcion: String(o.descripcion || '').trim(),
    filamento_tipo: String(o.filamento || '').trim(),
    filamento_color: String(o.filamento_color || '').trim(),
    peso_g: Math.round(Number(o.peso_g) || 0) || null,
    tiempo_h: Number(o.horas) ? Math.round(Number(o.horas) * 10) / 10 : null,
    precio_web: Number(o.precio_final || 0),
  }
}

function usarEnCalculadora(o) {
  store.pendingWebQuote = { id: o.quote_id, codigo: o._webCodigo || '', orderId: o.id, prefill: buildPrefill(o) }
  toast.add({
    severity: 'info',
    summary: `${o._webCodigo || o.id} → Calculadora`,
    detail: 'Datos precargados. Recalcula con tus costes reales y guarda: se actualiza este mismo pedido y pasa a «Presupuesto enviado».',
    life: 6000,
  })
}

/* ── Rechazar ── */
function rechazar(o) {
  confirm.require({
    header: `Rechazar ${o._webCodigo || o.id}`,
    message: `Pasará a «Descartado» (en la web, rechazada) y se avisará a ${o.cliente} por email con la plantilla de la web. ¿Continuar?`,
    acceptLabel: 'Rechazar y avisar',
    rejectLabel: 'Cancelar',
    acceptProps: { severity: 'danger' },
    accept: async () => {
      rejecting.value = o.id
      try {
        await store.updateOrder({ orderId: o.id, updates: { estado: 'Descartado' } }, { skipNotification: true })
        // Descartar no avisa por norma (limpieza interna); rechazar una
        // solicitud sí, a propósito.
        const mail = o.cliente_email ? await notifyOrder(store.empresa, o.id) : { ok: false, error: 'sin email' }
        toast.add({
          severity: mail.ok ? 'success' : 'warn',
          summary: `${o._webCodigo || o.id} rechazada`,
          detail: mail.ok ? 'Cliente avisado por email.' : `Rechazada, pero el email falló: ${mail.error}`,
          life: 6000,
        })
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 6000 })
      } finally {
        rejecting.value = null
      }
    },
  })
}

const titulo = computed(() => `Solicitudes web${pedidos.value.length ? ` (${pedidos.value.length})` : ''}`)
const mobile = isMobile()
</script>

<template>
  <div class="rounded-2xl border border-sky-300/60 dark:border-sky-700/50 bg-sky-50 dark:bg-sky-950/30 p-3 flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <i class="pi pi-globe text-sky-600 dark:text-sky-300" />
      <span class="text-sm font-semibold text-sky-700 dark:text-sky-300">{{ titulo }}</span>
      <span class="text-[10px] text-surface-400 dark:text-white/30 hidden sm:inline">pedidos del tasador de impresion3dcc.com en «Nuevo»</span>
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
      <div v-else-if="!pedidos.length" class="text-xs text-surface-400 dark:text-white/30 px-1">
        No hay solicitudes web pendientes.
      </div>

      <div v-for="o in pedidos" :key="o.id" class="rounded-xl bg-white/70 dark:bg-black/20 overflow-hidden">
        <!-- Fila principal -->
        <div class="flex flex-wrap items-center gap-2 px-3 py-2 cursor-pointer" @click="expandedId = expandedId === o.id ? null : o.id">
          <i :class="expandedId === o.id ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="text-[10px] text-surface-400" />
          <span class="font-mono text-xs font-bold text-sky-600 dark:text-sky-300">{{ o._webCodigo || o.id }}</span>
          <Tag value="Nuevo" severity="contrast" class="text-[9px] px-1.5 py-0" />
          <span class="text-sm font-medium">{{ o.cliente }}</span>
          <span class="text-xs text-surface-500">{{ o.filamento }} · {{ o.cantidad }} pza{{ Number(o.cantidad) !== 1 ? 's' : '' }}</span>
          <span v-if="quoteDe(o)?.entrega === 'envio'" class="text-[10px] text-surface-400"><i class="pi pi-truck text-[9px]" /> envío</span>
          <Tag v-if="diasRestantes(quoteDe(o)) !== null && diasRestantes(quoteDe(o)) <= 3"
            :value="diasRestantes(quoteDe(o)) <= 0 ? 'Caducado' : `Caduca en ${diasRestantes(quoteDe(o))} d`"
            severity="danger" class="text-[9px] px-1.5 py-0" />
          <span class="text-[10px] text-surface-400 ml-auto">{{ fmtFecha(o.created_at) }}</span>
          <span class="text-sm font-semibold whitespace-nowrap" v-tooltip.top="'Precio estimado en la web'">{{ fmtMoney(o.precio_final) }}</span>
          <Button label="Presupuestar" icon="pi pi-calculator" outlined
            class="!h-11 lg:!h-8 w-full sm:w-auto shrink-0" @click.stop="usarEnCalculadora(o)" />
        </div>

        <!-- Detalle expandido -->
        <div v-if="expandedId === o.id" class="px-4 pb-3 pt-1 flex flex-col gap-2 border-t border-black/[0.05] dark:border-white/[0.06]">
          <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-surface-600 dark:text-white/60">
            <span><i class="pi pi-envelope text-[10px] mr-1" />{{ o.cliente_email }}</span>
            <span v-if="quoteDe(o)?.telefono"><i class="pi pi-phone text-[10px] mr-1" />{{ quoteDe(o).telefono }}</span>
            <span v-if="quoteDe(o)?.entrega === 'envio' && direccion(quoteDe(o))"><i class="pi pi-truck text-[10px] mr-1" />{{ direccion(quoteDe(o)) }}</span>
            <span v-if="quoteDe(o)?.entrega === 'recogida'"><i class="pi pi-map-marker text-[10px] mr-1" />Recogida en Salamanca</span>
            <span v-if="diasRestantes(quoteDe(o)) !== null"><i class="pi pi-clock text-[10px] mr-1" />Válido hasta {{ fmtFecha(quoteDe(o).valido_hasta) }}</span>
            <span><i class="pi pi-box text-[10px] mr-1" />{{ o.peso_g }} g · {{ o.horas }} h estimados</span>
          </div>
          <p v-if="quoteDe(o)?.mensaje" class="text-xs text-surface-500 dark:text-white/50 italic m-0">“{{ quoteDe(o).mensaje }}”</p>

          <!-- Archivos -->
          <div v-if="archivos(quoteDe(o)).length" class="flex flex-col gap-1">
            <div v-for="(f, i) in archivos(quoteDe(o))" :key="i" class="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04]">
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
          <div v-else-if="quoteDe(o)" class="text-[11px] text-surface-400">Sin archivos adjuntos.</div>

          <div class="flex justify-end">
            <Button label="Rechazar" icon="pi pi-times" size="small" text severity="danger" :loading="rejecting === o.id" @click="rechazar(o)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
