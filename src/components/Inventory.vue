<script setup>
import { computed, ref } from 'vue'
import { store } from '../store'
import { filamentUsageByColor, filamentSpendG, filamentSpendEur } from '../shared/backend.mjs'
import { useIsHandheld } from '../composables/useMediaQuery'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ColorPicker from 'primevue/colorpicker'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'

/* El inventario ya no lleva stock restante: es el catálogo de colores que se
 * eligen en los pedidos, más cuánto se ha gastado de cada uno. El gasto se
 * calcula sumando los pedidos ya aceptados —archivados incluidos— y encima se
 * le puede añadir un ajuste manual para lo que no sale de ningún pedido. */

const toast = useToast()
const confirmDlg = useConfirm()
const isHandheld = useIsHandheld()

const unit = computed(() => store.appData.global_config?.money_unit || '€')
const fmtMoney = (v) => `${Number(v || 0).toFixed(2)} ${unit.value}`
const fmtGramos = (v) => {
    const g = Number(v || 0)
    return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(0)} g`
}

const filamentTypes = computed(() => store.appData.filament_types || [])
const materialOptions = computed(() => filamentTypes.value.map(f => f.name))

// El gasto sale del historial de pedidos, así que los archivados cuentan solos.
const usage = computed(() => filamentUsageByColor(store.appData))

const stock = computed(() => {
    const tipos = filamentTypes.value
    const u = usage.value
    const catalogo = (store.appData.filament_stock || []).map((s, i) => ({
        ...s,
        _idx: i,
        _historial: u.get(`${s.material}|${String(s.color || '').toLowerCase()}`) || 0,
        _g: filamentSpendG(s, u),
        _eur: filamentSpendEur(s, tipos, u),
    }))

    // Colores que aparecen en pedidos pero ya no están en el catálogo: si no se
    // listaran, su gasto desaparecería del total sin avisar.
    const enCatalogo = new Set(catalogo.map(s => `${s.material}|${String(s.color || '').toLowerCase()}`))
    const sueltos = []
    for (const [clave, gramos] of u) {
        if (enCatalogo.has(clave)) continue
        const [material, color] = clave.split('|')
        const item = { material, color, ajuste_g: 0 }
        sueltos.push({
            ...item, _idx: -1, _fueraDeCatalogo: true,
            _historial: gramos, _g: gramos,
            _eur: filamentSpendEur({ ...item }, tipos, u),
        })
    }
    return [...catalogo, ...sueltos]
})

/** Mete en el catálogo un color que solo existía en pedidos antiguos. */
const adoptarColor = async (item) => {
    store.appData.filament_stock = [
        ...(store.appData.filament_stock || []),
        { material: item.material, color: item.color, color_hex: colorHex(item), ajuste_g: 0 },
    ]
    await store.saveApp()
    toast.add({ severity: 'success', summary: `${item.color} añadido al catálogo`, life: 2500 })
}

const totales = computed(() => ({
    gramos: stock.value.reduce((acc, s) => acc + s._g, 0),
    euros: stock.value.reduce((acc, s) => acc + s._eur, 0),
    usados: stock.value.filter(s => s._g > 0).length,
}))

/* Colores conocidos por nombre, para no obligar a elegir el hex a mano. */
const HEX_COLOR_MAP = {
    Negro: '#111827', Blanco: '#F9FAFB', Gris: '#6B7280', Rojo: '#EF4444',
    Azul: '#3B82F6', Verde: '#10B981', Amarillo: '#FACC15', Naranja: '#F97316',
    Morado: '#8B5CF6', Rosa: '#EC4899', Transparente: '#D1D5DB',
}
const normalizeHex = (value) => {
    const raw = String(value || '').trim().replace('#', '')
    return raw ? `#${raw}` : '#94A3B8'
}
const colorHex = (item) => {
    if (item?.color_hex) return normalizeHex(item.color_hex)
    return HEX_COLOR_MAP[item?.color] || '#94A3B8'
}

const dialogVisible = ref(false)
const isNew = ref(false)
const editingItem = ref({})

const openNew = () => {
    editingItem.value = { material: materialOptions.value[0] || 'PLA', color: '', color_hex: '111827', ajuste_g: 0, _historial: 0 }
    isNew.value = true
    dialogVisible.value = true
}

const editItem = (item) => {
    editingItem.value = { ...item, color_hex: colorHex(item).replace('#', ''), _historial: item._historial }
    isNew.value = false
    dialogVisible.value = true
}

const saveItem = async () => {
    const color = String(editingItem.value.color || '').trim()
    if (!editingItem.value.material) {
        toast.add({ severity: 'warn', summary: 'Falta el material', life: 3000 })
        return
    }
    if (!color) {
        toast.add({ severity: 'warn', summary: 'Falta el nombre del color', life: 3000 })
        return
    }
    const list = [...(store.appData.filament_stock || [])]
    const obj = {
        material: editingItem.value.material,
        color,
        color_hex: normalizeHex(editingItem.value.color_hex),
        ajuste_g: Math.max(0, Number(editingItem.value.ajuste_g || 0)),
    }
    if (isNew.value) {
        list.push(obj)
    } else {
        const idx = editingItem.value._idx
        if (idx >= 0 && idx < list.length) list[idx] = obj
    }
    store.appData.filament_stock = list
    await store.saveApp()
    dialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Guardado', life: 2000 })
}

const deleteItem = (item) => {
    confirmDlg.require({
        header: 'Quitar color',
        message: `¿Quitar ${item.material} · ${item.color} del catálogo? Dejará de poder elegirse en pedidos nuevos; el gasto de los pedidos ya hechos no se toca.`,
        acceptLabel: 'Quitar',
        rejectLabel: 'Cancelar',
        acceptProps: { severity: 'danger' },
        accept: async () => {
            const list = [...(store.appData.filament_stock || [])]
            list.splice(item._idx, 1)
            store.appData.filament_stock = list
            await store.saveApp()
            toast.add({ severity: 'success', summary: 'Color quitado', life: 2000 })
        },
    })
}
</script>

<template>
    <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
                <i class="pi pi-box text-surface-400" aria-hidden="true" />
                <h1 class="text-xl font-bold">Colores</h1>
            </div>
            <Button label="Nuevo color" icon="pi pi-plus" class="!h-11 lg:!h-9" @click="openNew" />
        </div>

        <!-- Resumen de gasto -->
        <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <div class="card rounded-2xl px-3 py-3">
                <div class="text-[10px] text-surface-500 dark:text-white/40 font-medium uppercase tracking-widest">Material gastado</div>
                <div class="text-2xl font-semibold mt-0.5 tracking-tight">{{ fmtGramos(totales.gramos) }}</div>
            </div>
            <div class="card rounded-2xl px-3 py-3">
                <div class="text-[10px] text-violet-500 font-medium uppercase tracking-widest">Equivale a</div>
                <div class="text-2xl font-semibold text-violet-600 dark:text-violet-400 mt-0.5 tracking-tight">{{ fmtMoney(totales.euros) }}</div>
            </div>
            <div class="card rounded-2xl px-3 py-3 col-span-2 lg:col-span-1">
                <div class="text-[10px] text-surface-500 dark:text-white/40 font-medium uppercase tracking-widest">Catálogo</div>
                <div class="text-2xl font-semibold mt-0.5 tracking-tight">{{ stock.length }}</div>
                <div class="text-[10px] text-surface-400 dark:text-white/30 mt-0.5">{{ totales.usados }} con gasto apuntado</div>
            </div>
        </div>

        <!-- Lista de tarjetas (móvil / tablet vertical) -->
        <div v-if="isHandheld" class="flex flex-col gap-2">
            <div v-for="item in stock" :key="item._idx" class="card rounded-2xl p-4 flex items-center gap-3">
                <span class="w-9 h-9 rounded-full border border-black/10 dark:border-white/15 shrink-0"
                    :style="{ backgroundColor: colorHex(item) }" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                    <div class="font-semibold truncate">{{ item.color }}</div>
                    <div class="text-xs text-surface-500 dark:text-surface-400 truncate">
                        {{ item.material }}<span v-if="item._fueraDeCatalogo" class="text-amber-600 dark:text-amber-400"> · solo en pedidos antiguos</span>
                    </div>
                </div>
                <div class="text-right shrink-0">
                    <div class="font-semibold tracking-tight">{{ fmtGramos(item._g) }}</div>
                    <div class="text-[11px] text-violet-500">{{ fmtMoney(item._eur) }}</div>
                </div>
                <div class="flex flex-col gap-1 shrink-0">
                    <template v-if="item._fueraDeCatalogo">
                        <Button icon="pi pi-plus" text rounded severity="info" class="!w-11 !h-11"
                            :aria-label="`Añadir ${item.color} al catálogo`" @click="adoptarColor(item)" />
                    </template>
                    <template v-else>
                        <Button icon="pi pi-pencil" text rounded severity="secondary" class="!w-11 !h-11"
                            :aria-label="`Editar ${item.color}`" @click="editItem(item)" />
                        <Button icon="pi pi-trash" text rounded severity="danger" class="!w-11 !h-11"
                            :aria-label="`Quitar ${item.color}`" @click="deleteItem(item)" />
                    </template>
                </div>
            </div>
            <div v-if="!stock.length" class="flex flex-col items-center justify-center py-14 gap-3 text-center">
                <div class="w-16 h-16 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
                    <i class="pi pi-box text-3xl text-surface-400" aria-hidden="true" />
                </div>
                <p class="font-semibold text-surface-600 dark:text-surface-300">Aún no hay colores</p>
                <p class="text-sm text-surface-400 px-8">Añade los que uses para poder elegirlos al crear un pedido.</p>
            </div>
        </div>

        <!-- Tabla (escritorio) -->
        <DataTable v-else :value="stock" dataKey="_idx" class="rounded-2xl overflow-hidden card" stripedRows>
            <template #empty>
                <div class="p-10 text-center text-surface-400">Aún no hay colores en el catálogo</div>
            </template>
            <Column header="Color" style="min-width: 12rem">
                <template #body="{ data }">
                    <div class="flex items-center gap-2">
                        <span class="w-4 h-4 rounded-full border border-black/10 dark:border-white/15 shrink-0"
                            :style="{ backgroundColor: colorHex(data) }" aria-hidden="true" />
                        <span class="font-medium">{{ data.color }}</span>
                        <span v-if="data._fueraDeCatalogo" class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">solo en pedidos antiguos</span>
                    </div>
                </template>
            </Column>
            <Column field="material" header="Material" sortable style="width: 12rem" />
            <Column field="_g" header="Gastado" sortable style="width: 11rem">
                <template #body="{ data }">
                    <span>{{ fmtGramos(data._g) }}</span>
                    <span v-if="data.ajuste_g > 0" class="text-[10px] text-surface-400 ml-1">(+{{ fmtGramos(data.ajuste_g) }} ajuste)</span>
                </template>
            </Column>
            <Column field="_eur" header="Equivale a" sortable style="width: 9rem">
                <template #body="{ data }">
                    <span class="text-violet-600 dark:text-violet-400 font-medium">{{ fmtMoney(data._eur) }}</span>
                </template>
            </Column>
            <Column header="" style="width: 7rem">
                <template #body="{ data }">
                    <div class="flex gap-1">
                        <Button v-if="data._fueraDeCatalogo" icon="pi pi-plus" text rounded severity="info"
                            :aria-label="`Añadir ${data.color} al catálogo`" v-tooltip.top="'Añadir al catálogo'" @click="adoptarColor(data)" />
                        <template v-else>
                            <Button icon="pi pi-pencil" text rounded severity="secondary" :aria-label="`Editar ${data.color}`" @click="editItem(data)" />
                            <Button icon="pi pi-trash" text rounded severity="danger" :aria-label="`Quitar ${data.color}`" @click="deleteItem(data)" />
                        </template>
                    </div>
                </template>
            </Column>
        </DataTable>

        <!-- Alta / edición -->
        <Dialog v-model:visible="dialogVisible" modal :header="isNew ? 'Nuevo color' : 'Editar color'"
            :style="isHandheld ? { width: '100vw', maxWidth: '100vw' } : { width: 'min(95vw, 26rem)' }">
            <div class="flex flex-col gap-4 py-2">
                <div class="flex flex-col gap-1">
                    <label for="inv-material" class="text-sm text-surface-400">Material</label>
                    <Select id="inv-material" v-model="editingItem.material" :options="materialOptions" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label for="inv-color" class="text-sm text-surface-400">Nombre del color</label>
                    <InputText id="inv-color" v-model="editingItem.color" class="w-full" placeholder="Negro, Azul cielo…" />
                </div>
                <div class="flex flex-col gap-1">
                    <span class="text-sm text-surface-400">Muestra</span>
                    <div class="flex items-center gap-3">
                        <ColorPicker v-model="editingItem.color_hex" />
                        <span class="text-xs text-surface-400">Se usa para reconocerlo en los desplegables de pedidos.</span>
                    </div>
                </div>
                <div class="flex flex-col gap-1">
                    <div class="flex items-baseline justify-between gap-2">
                        <span class="text-sm text-surface-400">Gastado en pedidos</span>
                        <span class="font-mono text-sm">{{ fmtGramos(editingItem._historial || 0) }}</span>
                    </div>
                    <small class="text-surface-400 mb-2">Se calcula solo sumando los pedidos aceptados, incluidos los archivados.</small>

                    <label for="inv-ajuste" class="text-sm text-surface-400">Ajuste manual</label>
                    <InputNumber id="inv-ajuste" v-model="editingItem.ajuste_g" :min="0" suffix=" g" class="w-full" />
                    <small class="text-surface-400">Gramos que no salen de ningún pedido: purgas, fallos, bobina estropeada.</small>
                </div>
            </div>
            <template #footer>
                <div class="flex items-center gap-2 w-full">
                    <Button label="Cancelar" severity="secondary" outlined class="flex-1 !h-11 lg:!h-9" @click="dialogVisible = false" />
                    <Button label="Guardar" icon="pi pi-check" class="flex-1 !h-11 lg:!h-9" @click="saveItem" />
                </div>
            </template>
        </Dialog>
    </div>
</template>
