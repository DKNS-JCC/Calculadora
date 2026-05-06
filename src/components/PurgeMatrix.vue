<script setup>
import { ref, computed } from 'vue'
import { store } from '../store'
import Select from 'primevue/select'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'

// ── Color resolution ──────────────────────────────────────────────────────────
const HEX_COLOR_MAP = {
  Negro:'#111827', Blanco:'#F9FAFB', Gris:'#6B7280', Rojo:'#EF4444',
  Azul:'#3B82F6', Verde:'#10B981', Amarillo:'#FACC15', Naranja:'#F97316',
  Morado:'#8B5CF6', Rosa:'#EC4899', Transparente:'#D1D5DB', Cian:'#06B6D4',
  Marrón:'#92400E', Dorado:'#D97706', Plateado:'#9CA3AF', Turquesa:'#14B8A6',
  Magenta:'#D946EF', Lima:'#84CC16', Beige:'#D4B896', Crema:'#F5F0DC',
}
function colorHex(name) {
  const item = store.appData.filament_stock.find(s => s.color === name)
  if (item?.color_hex) return `#${String(item.color_hex).replace('#', '')}`
  return HEX_COLOR_MAP[name] || '#8B5CF6'
}
function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16)
  return (r*299 + g*587 + b*114)/1000 > 145 ? '#1a1a1a' : '#ffffff'
}

// ── Printer selector ──────────────────────────────────────────────────────────
const printers = computed(() => store.appData.printers.map(p => p.name))
const selectedPrinter = ref(printers.value[0] || '')

// ── Config helpers ────────────────────────────────────────────────────────────
function ensurePurgeConfig() {
  if (!store.appData.purge_config) store.appData.purge_config = { colors:[], values:[], active_by_printer:{} }
  if (!Array.isArray(store.appData.purge_config.colors)) store.appData.purge_config.colors = []
  if (!Array.isArray(store.appData.purge_config.values)) store.appData.purge_config.values = []
  if (!store.appData.purge_config.active_by_printer) store.appData.purge_config.active_by_printer = {}
}

// ── All colors ────────────────────────────────────────────────────────────────
const stockColors = computed(() =>
  store.appData.filament_stock.map(s => s.color).filter(c => c && c !== 'Multicolor')
)
const allColors = computed(() => {
  ensurePurgeConfig()
  return [...new Set([...stockColors.value, ...(store.appData.purge_config.colors||[])])].filter(Boolean).sort()
})
function isStockColor(c) { return stockColors.value.includes(c) }

// ── Active colors (filter for matrix) ────────────────────────────────────────
const activeColors = computed(() => {
  ensurePurgeConfig()
  const saved = store.appData.purge_config.active_by_printer?.[selectedPrinter.value]
  return Array.isArray(saved) ? saved.filter(c => allColors.value.includes(c)) : []
})
const matrixColors = computed(() => allColors.value.filter(c => activeColors.value.includes(c)))
function isActive(c) { return activeColors.value.includes(c) }

async function toggleColor(color) {
  ensurePurgeConfig()
  const map = store.appData.purge_config.active_by_printer
  const cur = Array.isArray(map[selectedPrinter.value]) ? [...map[selectedPrinter.value]] : []
  const idx = cur.indexOf(color)
  idx >= 0 ? cur.splice(idx, 1) : cur.push(color)
  map[selectedPrinter.value] = cur
  await persistChange()
}

// ── Values ────────────────────────────────────────────────────────────────────
function getValue(from, to) {
  return store.appData.purge_config?.values?.find(
    e => e.printer === selectedPrinter.value && e.from === from && e.to === to
  )?.grams ?? null
}

// ── Debounced save ────────────────────────────────────────────────────────────
const savedFlash = ref(false)
const saving = ref(false)
let saveTimer = null

function schedulesSave() {
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
  const idx = values.findIndex(e => e.printer === selectedPrinter.value && e.from === from && e.to === to)
  const str = String(rawValue ?? '').trim()
  if (str === '' || str === null) {
    if (idx >= 0) values.splice(idx, 1)
  } else {
    const g = parseFloat(str)
    if (isNaN(g)) return
    if (idx >= 0) values[idx].grams = g
    else values.push({ printer: selectedPrinter.value, from, to, grams: g })
  }
}

function handleBlur(from, to, event) {
  setValueImmediate(from, to, event.target.value)
  schedulesSave()
}

// ── Enter → next editable cell ────────────────────────────────────────────────
function handleEnter(from, to, event) {
  setValueImmediate(from, to, event.target.value)
  schedulesSave()
  focusNext(from, to)
}

function focusNext(fromColor, toColor) {
  const cols = matrixColors.value
  // Build ordered list of editable pairs (left→right, top→bottom, skip diagonal)
  const pairs = []
  for (const r of cols) for (const c of cols) if (r !== c) pairs.push(`${r}__${c}`)
  const cur = pairs.indexOf(`${fromColor}__${toColor}`)
  const nextPair = pairs[(cur + 1) % pairs.length]
  const el = document.querySelector(`[data-cell="${nextPair}"]`)
  if (el) { el.focus(); el.select() }
}

// ── Add / remove extra colors ─────────────────────────────────────────────────
const newColorName = ref('')

async function addColor() {
  const name = newColorName.value.trim()
  if (!name) return
  ensurePurgeConfig()
  if (!store.appData.purge_config.colors.includes(name)) store.appData.purge_config.colors.push(name)
  const map = store.appData.purge_config.active_by_printer
  const cur = Array.isArray(map[selectedPrinter.value]) ? map[selectedPrinter.value] : []
  if (!cur.includes(name)) cur.push(name)
  map[selectedPrinter.value] = cur
  await persistChange()
  newColorName.value = ''
}

async function removeExtraColor(color) {
  if (isStockColor(color)) return
  ensurePurgeConfig()
  const idx = store.appData.purge_config.colors.indexOf(color)
  if (idx >= 0) store.appData.purge_config.colors.splice(idx, 1)
  for (const p in store.appData.purge_config.active_by_printer) {
    const arr = store.appData.purge_config.active_by_printer[p]
    const i = arr.indexOf(color); if (i >= 0) arr.splice(i, 1)
  }
  store.appData.purge_config.values = store.appData.purge_config.values.filter(v => v.from !== color && v.to !== color)
  await persistChange()
}

async function persistChange() {
  await store.saveApp()
  savedFlash.value = true
  setTimeout(() => { savedFlash.value = false }, 1200)
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const configuredCount = computed(() => {
  if (!store.appData.purge_config?.values) return 0
  const active = matrixColors.value
  return store.appData.purge_config.values.filter(
    v => v.printer === selectedPrinter.value && active.includes(v.from) && active.includes(v.to)
  ).length
})
const totalPossible = computed(() => { const n = matrixColors.value.length; return n*(n-1) })
</script>

<template>
  <div class="flex flex-col gap-4">

    <!-- Printer + status row -->
    <div class="flex items-center gap-4 flex-wrap">
      <div class="flex items-center gap-2">
        <label class="text-sm font-semibold text-surface-600 dark:text-surface-300">Impresora</label>
        <Select v-model="selectedPrinter" :options="printers" class="w-52" placeholder="Seleccionar impresora" />
      </div>
      <div class="flex items-center gap-2 ml-auto">
        <Transition name="flash">
          <span v-if="savedFlash" class="flex items-center gap-1 text-xs text-green-500 font-medium">
            <i class="pi pi-check-circle" /> Guardado
          </span>
        </Transition>
        <Transition name="flash">
          <span v-if="saving && !savedFlash" class="flex items-center gap-1 text-xs text-surface-400">
            <i class="pi pi-spin pi-spinner text-[10px]" /> Guardando...
          </span>
        </Transition>
        <span v-if="totalPossible > 0" class="text-xs text-surface-400">
          {{ configuredCount }}/{{ totalPossible }} configuradas
        </span>
      </div>
    </div>

    <!-- Color filter panel -->
    <div class="p-3 rounded-xl card flex flex-col gap-2.5">
      <div class="text-xs font-semibold text-surface-500 dark:text-surface-400 flex items-center gap-1.5">
        <i class="pi pi-filter text-primary-500" />
        Selecciona los colores que usas en esta impresora
        <span class="font-normal text-surface-400 ml-1">— haz clic para activarlos en la matriz</span>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <button
          v-for="color in allColors" :key="color"
          class="color-chip"
          :class="isActive(color) ? 'chip-active' : 'chip-inactive'"
          :style="isActive(color) ? {
            backgroundColor: colorHex(color),
            color: contrastColor(colorHex(color)),
            borderColor: colorHex(color),
            boxShadow: `0 0 0 2px ${colorHex(color)}55, 0 1px 4px rgba(0,0,0,0.2)`
          } : { borderColor: colorHex(color) + '80' }"
          @click="toggleColor(color)"
        >
          <span class="w-2.5 h-2.5 rounded-full shrink-0 border border-black/10" :style="{ backgroundColor: colorHex(color) }" />
          <span class="text-xs font-semibold leading-none">{{ color }}</span>
          <span
            v-if="!isStockColor(color)"
            class="remove-btn"
            :style="isActive(color) ? { color: contrastColor(colorHex(color)) } : {}"
            title="Eliminar color"
            @click.stop="removeExtraColor(color)"
          >×</span>
        </button>
        <div class="flex items-center gap-1 ml-1">
          <InputText v-model="newColorName" placeholder="Nuevo color..." class="!text-xs !py-1 !px-2 h-7 w-28" @keyup.enter="addColor" />
          <Button icon="pi pi-plus" size="small" text rounded severity="secondary" v-tooltip.top="'Añadir color'" @click="addColor" />
        </div>
      </div>
      <p class="text-[11px] text-surface-400 -mt-0.5">
        {{ activeColors.length === 0
          ? 'Ningún color activo — haz clic en los colores para activarlos.'
          : `${activeColors.length} color${activeColors.length !== 1 ? 'es' : ''} activo${activeColors.length !== 1 ? 's' : ''}. Tab o Enter para navegar entre celdas.` }}
      </p>
    </div>

    <!-- Matrix -->
    <div v-if="matrixColors.length >= 2">
      <div class="text-xs text-surface-400 mb-2 flex items-center gap-1.5">
        <i class="pi pi-info-circle" />
        Valores en <strong class="text-surface-500 dark:text-surface-300">mm³</strong> ·
        <strong class="text-surface-500 dark:text-surface-300">Columna (A) = destino · Fila (DE) = origen</strong> ·
        Tab / Enter para avanzar celdas
      </div>
      <div class="overflow-auto rounded-xl card p-3">
        <table class="purge-matrix">
          <thead>
            <tr>
              <th class="corner-th">
                <div class="corner-box">
                  <span class="corner-de">DE</span>
                  <span class="corner-a">A</span>
                </div>
              </th>
              <th v-for="col in matrixColors" :key="'ch-'+col" class="col-th">
                <div class="flex flex-col items-center gap-1.5 px-1 py-1">
                  <div class="w-4 h-4 rounded-full border border-black/15 shadow-sm" :style="{ backgroundColor: colorHex(col) }" />
                  <span class="text-[11px] font-semibold leading-none whitespace-nowrap">{{ col }}</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in matrixColors" :key="'row-'+row">
              <td class="row-th">
                <div class="flex flex-col items-center gap-1.5 px-1">
                  <div class="w-4 h-4 rounded-full border border-black/15 shadow-sm" :style="{ backgroundColor: colorHex(row) }" />
                  <span class="text-[11px] font-semibold leading-none whitespace-nowrap">{{ row }}</span>
                </div>
              </td>
              <td
                v-for="col in matrixColors" :key="'c-'+col"
                :class="['matrix-cell', row === col ? 'cell-diag' : 'cell-val']"
              >
                <span v-if="row === col" class="text-surface-200 dark:text-surface-700 text-base font-light select-none">—</span>
                <div v-else class="cell-inner">
                  <input
                    type="number"
                    class="purge-input"
                    :data-cell="`${row}__${col}`"
                    :value="getValue(row, col) ?? ''"
                    min="0" max="99999" step="1"
                    placeholder="—"
                    @blur="handleBlur(row, col, $event)"
                    @keydown.enter.prevent="handleEnter(row, col, $event)"
                  />
                  <span class="unit-label">mm³</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Message v-else-if="allColors.length > 0" severity="secondary" :closable="false">
      Selecciona al menos 2 colores arriba para ver la matriz.
    </Message>
    <Message v-else severity="secondary" :closable="false">
      Añade colores de filamento en el inventario o usa el botón "Nuevo color".
    </Message>

  </div>
</template>

<style scoped>
/* ── Color chips ───────────────────────────────────────────────────── */
.color-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px 4px 6px; border-radius: 999px; border: 1.5px solid;
  font-size: 12px; cursor: pointer;
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
}
.chip-inactive { background: transparent; color: var(--p-text-muted-color); opacity: 0.55; }
.chip-inactive:hover { opacity: 0.85; transform: scale(1.04); }
.chip-active:hover { filter: brightness(1.1); transform: scale(1.04); }
.remove-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%;
  font-size: 13px; line-height: 1; opacity: 0.5; margin-left: 1px;
  transition: opacity 0.1s, background 0.1s;
}
.remove-btn:hover { opacity: 1; background: rgba(0,0,0,0.15); }

/* ── Matrix table ──────────────────────────────────────────────────── */
.purge-matrix { border-collapse: separate; border-spacing: 3px; min-width: max-content; }
.corner-th { width: 76px; min-width: 76px; padding: 4px; vertical-align: middle; }
.corner-box { position: relative; width: 72px; height: 60px; border-radius: 8px; background: rgba(0,0,0,0.04); overflow: hidden; }
:global(.dark) .corner-box { background: rgba(255,255,255,0.04); }
.corner-box::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(to bottom right, transparent calc(50% - 0.5px), rgba(0,0,0,0.15) 50%, transparent calc(50% + 0.5px));
}
:global(.dark) .corner-box::before {
  background: linear-gradient(to bottom right, transparent calc(50% - 0.5px), rgba(255,255,255,0.15) 50%, transparent calc(50% + 0.5px));
}
.corner-de { position: absolute; bottom: 6px; left: 8px; font-size: 10px; font-weight: 700; opacity: 0.4; letter-spacing: 0.04em; }
.corner-a  { position: absolute; top: 6px; right: 8px; font-size: 10px; font-weight: 700; opacity: 0.4; letter-spacing: 0.04em; }
.col-th { text-align: center; vertical-align: bottom; min-width: 90px; padding-bottom: 4px; }
.row-th { text-align: center; vertical-align: middle; padding: 4px; min-width: 76px; }

.matrix-cell {
  text-align: center; vertical-align: middle;
  width: 90px; min-width: 90px; height: 52px;
  border-radius: 9px; padding: 4px;
}
.cell-diag { background: rgba(0,0,0,0.03); }
:global(.dark) .cell-diag { background: rgba(255,255,255,0.03); }
.cell-val {
  background: rgba(99,102,241,0.05);
  border: 1.5px solid transparent;
  transition: background 0.12s, border-color 0.12s;
}
.cell-val:focus-within {
  background: rgba(99,102,241,0.10);
  border-color: rgba(99,102,241,0.45);
}
:global(.dark) .cell-val { background: rgba(99,102,241,0.08); }
:global(.dark) .cell-val:focus-within { background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.45); }

/* ── Input inside cell ─────────────────────────────────────────────── */
.cell-inner {
  display: flex; align-items: center; justify-content: center; gap: 2px;
  width: 100%; height: 100%;
}
.purge-input {
  width: 52px;
  background: transparent;
  border: none;
  outline: none;
  text-align: right;
  font-size: 0.82rem;
  font-weight: 600;
  color: #6366f1;
  padding: 0;
  font-family: inherit;
}
:global(.dark) .purge-input { color: #a5b4fc; }
.purge-input::-webkit-outer-spin-button,
.purge-input::-webkit-inner-spin-button { -webkit-appearance: none; }
.purge-input[type=number] { -moz-appearance: textfield; }
.purge-input::placeholder { color: rgba(150,150,150,0.4); font-weight: 400; font-size: 0.9rem; }

.unit-label {
  font-size: 0.65rem;
  opacity: 0.55;
  white-space: nowrap;
  color: #6366f1;
  font-weight: 500;
  flex-shrink: 0;
}
:global(.dark) .unit-label { color: #a5b4fc; }

/* ── Flash transition ──────────────────────────────────────────────── */
.flash-enter-active, .flash-leave-active { transition: opacity 0.3s }
.flash-enter-from, .flash-leave-to { opacity: 0 }
</style>
