<script setup>
import { ref, computed } from 'vue'
import { store } from '../store'

const props = defineProps({
  printer: { type: String, required: true },
  colors:  { type: Array,  required: true },
})

// ── Color resolution ──────────────────────────────────────────────────────────
const HEX_COLOR_MAP = {
  Negro:'#111827', Blanco:'#F9FAFB', Gris:'#6B7280', Rojo:'#EF4444',
  Azul:'#3B82F6', Verde:'#10B981', Amarillo:'#FACC15', Naranja:'#F97316',
  Morado:'#8B5CF6', Rosa:'#EC4899', Transparente:'#D1D5DB', Cian:'#06B6D4',
  Marrón:'#92400E', Dorado:'#D97706', Plateado:'#9CA3AF', Turquesa:'#14B8A6',
  Magenta:'#D946EF', Lima:'#84CC16',
}
function colorHex(name) {
  const item = store.appData.filament_stock.find(s => s.color === name)
  if (item?.color_hex) return `#${String(item.color_hex).replace('#','')}`
  return HEX_COLOR_MAP[name] || '#8B5CF6'
}
function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16)
  return (r*299+g*587+b*114)/1000 > 145 ? '#1a1a1a' : '#ffffff'
}

const matrixColors = computed(() => [...new Set(props.colors.filter(Boolean))])

// ── Config helpers ────────────────────────────────────────────────────────────
function ensurePurgeConfig() {
  if (!store.appData.purge_config) store.appData.purge_config = { colors:[], values:[], active_by_printer:{} }
  if (!Array.isArray(store.appData.purge_config.values)) store.appData.purge_config.values = []
}
function getValue(from, to) {
  return store.appData.purge_config?.values?.find(
    e => e.printer === props.printer && e.from === from && e.to === to
  )?.grams ?? null
}

// ── Debounced save ────────────────────────────────────────────────────────────
const savedFlash = ref(false)
const saving = ref(false)
let saveTimer = null

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saving.value = true
  saveTimer = setTimeout(async () => {
    await store.saveApp()
    saving.value = false
    savedFlash.value = true
    setTimeout(() => { savedFlash.value = false }, 1200)
  }, 400)
}

function setValueImmediate(from, to, rawValue) {
  ensurePurgeConfig()
  const values = store.appData.purge_config.values
  const idx = values.findIndex(e => e.printer === props.printer && e.from === from && e.to === to)
  const str = String(rawValue ?? '').trim()
  if (str === '') {
    if (idx >= 0) values.splice(idx, 1)
  } else {
    const g = parseFloat(str)
    if (isNaN(g)) return
    if (idx >= 0) values[idx].grams = g
    else values.push({ printer: props.printer, from, to, grams: g })
  }
}

function handleBlur(from, to, event) {
  setValueImmediate(from, to, event.target.value)
  scheduleSave()
}

function handleEnter(from, to, event) {
  setValueImmediate(from, to, event.target.value)
  scheduleSave()
  focusNext(from, to)
}

function focusNext(fromColor, toColor) {
  const cols = matrixColors.value
  const pairs = []
  for (const r of cols) for (const c of cols) if (r !== c) pairs.push(`${r}__${c}`)
  const cur = pairs.indexOf(`${fromColor}__${toColor}`)
  const nextPair = pairs[(cur + 1) % pairs.length]
  const el = document.querySelector(`[data-ocell="${nextPair}"]`)
  if (el) { el.focus(); el.select() }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const missingCount = computed(() => {
  const cols = matrixColors.value
  let m = 0
  for (const f of cols) for (const t of cols) if (f !== t && getValue(f,t) === null) m++
  return m
})
const totalPairs = computed(() => { const n = matrixColors.value.length; return n*(n-1) })
</script>

<template>
  <div class="flex flex-col gap-2.5">

    <!-- Header -->
    <div class="flex items-center gap-2 justify-between">
      <div class="flex items-center gap-1.5">
        <i class="pi pi-sync text-primary-500 text-sm" />
        <span class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Purgas de cambio de color</span>
        <span class="text-[10px] text-surface-400">· {{ printer }} · mm³</span>
      </div>
      <div class="flex items-center gap-2">
        <Transition name="pf">
          <span v-if="savedFlash" class="text-[10px] text-green-500 font-medium flex items-center gap-1">
            <i class="pi pi-check" /> Guardado
          </span>
        </Transition>
        <Transition name="pf">
          <span v-if="saving && !savedFlash" class="text-[10px] text-surface-400 flex items-center gap-1">
            <i class="pi pi-spin pi-spinner text-[9px]" /> Guardando...
          </span>
        </Transition>
        <span v-if="missingCount > 0" class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-semibold">
          {{ missingCount }} sin configurar
        </span>
        <span v-else-if="totalPairs > 0" class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 font-semibold">
          Completo
        </span>
      </div>
    </div>

    <!-- Color chips -->
    <div class="flex flex-wrap gap-1.5">
      <div
        v-for="color in matrixColors" :key="color"
        class="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
        :style="{ backgroundColor: colorHex(color), color: contrastColor(colorHex(color)), border: '1px solid rgba(0,0,0,0.12)' }"
      >{{ color }}</div>
    </div>

    <!-- Matrix -->
    <div v-if="matrixColors.length >= 2" class="overflow-auto">
      <table class="opt-matrix">
        <thead>
          <tr>
            <th class="opt-corner">
              <div class="opt-corner-box">
                <span class="opt-de">DE</span>
                <span class="opt-a">A</span>
              </div>
            </th>
            <th v-for="col in matrixColors" :key="'h'+col" class="opt-col-h">
              <div class="flex flex-col items-center gap-1 py-0.5 px-1">
                <div class="w-3 h-3 rounded-full border border-black/15" :style="{ backgroundColor: colorHex(col) }" />
                <span class="text-[10px] font-semibold whitespace-nowrap leading-none">{{ col }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in matrixColors" :key="'r'+row">
            <td class="opt-row-h">
              <div class="flex flex-col items-center gap-1 px-1">
                <div class="w-3 h-3 rounded-full border border-black/15" :style="{ backgroundColor: colorHex(row) }" />
                <span class="text-[10px] font-semibold whitespace-nowrap leading-none">{{ row }}</span>
              </div>
            </td>
            <td
              v-for="col in matrixColors" :key="'c'+col"
              :class="['opt-cell', row === col ? 'opt-diag' : 'opt-val']"
            >
              <span v-if="row === col" class="text-surface-200 dark:text-surface-700 select-none">—</span>
              <div v-else class="opt-inner">
                <input
                  type="number"
                  class="opt-input"
                  :data-ocell="`${row}__${col}`"
                  :value="getValue(row, col) ?? ''"
                  min="0" max="99999" step="1"
                  placeholder="—"
                  @blur="handleBlur(row, col, $event)"
                  @keydown.enter.prevent="handleEnter(row, col, $event)"
                />
                <span class="opt-unit">mm³</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="text-[10px] text-surface-400 flex items-center gap-1">
      <i class="pi pi-info-circle text-[9px]" />
      Tab / Enter para avanzar · Los cambios se guardan en la configuración global de purgas.
    </p>
  </div>
</template>

<style scoped>
.opt-matrix { border-collapse: separate; border-spacing: 2px; min-width: max-content; }
.opt-corner { width: 60px; min-width: 60px; padding: 2px; vertical-align: middle; }
.opt-corner-box { position: relative; width: 56px; height: 50px; border-radius: 6px; background: rgba(0,0,0,0.04); overflow: hidden; }
:global(.dark) .opt-corner-box { background: rgba(255,255,255,0.04); }
.opt-corner-box::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(to bottom right, transparent calc(50% - 0.5px), rgba(0,0,0,0.15) 50%, transparent calc(50% + 0.5px));
}
:global(.dark) .opt-corner-box::before {
  background: linear-gradient(to bottom right, transparent calc(50% - 0.5px), rgba(255,255,255,0.15) 50%, transparent calc(50% + 0.5px));
}
.opt-de { position: absolute; bottom: 5px; left: 6px; font-size: 9px; font-weight: 700; opacity: 0.4; }
.opt-a  { position: absolute; top: 5px; right: 6px; font-size: 9px; font-weight: 700; opacity: 0.4; }
.opt-col-h { text-align: center; vertical-align: bottom; min-width: 80px; padding-bottom: 2px; }
.opt-row-h { text-align: center; vertical-align: middle; padding: 2px; min-width: 60px; }

.opt-cell { text-align: center; vertical-align: middle; width: 80px; min-width: 80px; height: 44px; border-radius: 7px; padding: 3px; font-size: 13px; }
.opt-diag { background: rgba(0,0,0,0.03); }
:global(.dark) .opt-diag { background: rgba(255,255,255,0.03); }
.opt-val {
  background: rgba(99,102,241,0.05);
  border: 1.5px solid transparent;
  transition: background 0.12s, border-color 0.12s;
}
.opt-val:focus-within { background: rgba(99,102,241,0.10); border-color: rgba(99,102,241,0.45); }
:global(.dark) .opt-val { background: rgba(99,102,241,0.08); }
:global(.dark) .opt-val:focus-within { background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.45); }

.opt-inner { display: flex; align-items: center; justify-content: center; gap: 1px; width: 100%; height: 100%; }
.opt-input {
  width: 44px; background: transparent; border: none; outline: none;
  text-align: right; font-size: 0.78rem; font-weight: 600;
  color: #6366f1; padding: 0; font-family: inherit;
}
:global(.dark) .opt-input { color: #a5b4fc; }
.opt-input::-webkit-outer-spin-button, .opt-input::-webkit-inner-spin-button { -webkit-appearance: none; }
.opt-input[type=number] { -moz-appearance: textfield; }
.opt-input::placeholder { color: rgba(150,150,150,0.4); font-weight: 400; }
.opt-unit { font-size: 0.6rem; opacity: 0.5; white-space: nowrap; color: #6366f1; font-weight: 500; flex-shrink: 0; }
:global(.dark) .opt-unit { color: #a5b4fc; }

.pf-enter-active, .pf-leave-active { transition: opacity 0.3s }
.pf-enter-from, .pf-leave-to { opacity: 0 }
</style>
