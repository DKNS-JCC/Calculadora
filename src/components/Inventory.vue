<script setup>
import { computed, ref, onMounted } from 'vue'
import { store } from '../store'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Toolbar from 'primevue/toolbar'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ColorPicker from 'primevue/colorpicker'
import Tag from 'primevue/tag'
import ProgressBar from 'primevue/progressbar'
import Checkbox from 'primevue/checkbox'

const showPartner = ref(false)
const partnerStock = ref([])
const partnerLoaded = ref(false)

onMounted(async () => {
    const pi = await store.loadPartnerInventory()
    if (pi?.filament_stock?.length) {
        partnerStock.value = pi.filament_stock
        partnerLoaded.value = true
    }
})

const stock = computed(() =>
    store.appData.filament_stock.map((s, i) => ({ ...s, _idx: i, _owner: store.empresa }))
)

const partnerItems = computed(() =>
    partnerStock.value.map((s, i) => ({
        ...s,
        _idx: `p_${i}`,
        _owner: store.partnerInventory?.partner || 'Partner',
        _isPartner: true,
    }))
)

const combinedStock = computed(() => {
    if (!showPartner.value) return stock.value
    return [...stock.value, ...partnerItems.value]
})

const dialogVisible = ref(false)
const editingItem = ref({})
const isNew = ref(false)
const selectedItem = ref(null)

const materialOptions = computed(() => store.appData.filament_types.map(f => f.name))
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
const normalizeHex = (value) => {
    const raw = String(value || '').trim().replace('#', '')
    if (!raw) return '#94A3B8'
    return `#${raw}`
}
const colorHex = (itemOrName) => {
    if (typeof itemOrName === 'object' && itemOrName) {
        if (itemOrName.color_hex) return normalizeHex(itemOrName.color_hex)
        return HEX_COLOR_MAP[itemOrName.color] || '#94A3B8'
    }
    return HEX_COLOR_MAP[itemOrName] || '#94A3B8'
}

const openNew = () => {
    editingItem.value = { material: 'PLA', color: '', color_hex: '111827', remaining_g: 1000, buy_threshold_g: 200 }
    isNew.value = true
    dialogVisible.value = true
}

const editItem = (item) => {
    editingItem.value = { ...item, color_hex: colorHex(item).replace('#', '') }
    isNew.value = false
    dialogVisible.value = true
}

const saveItem = async () => {
    const color = String(editingItem.value.color || '').trim()
    if (!editingItem.value.material) return alert('El material es obligatorio')
    if (!color) return alert('El nombre del color es obligatorio')
    const list = [...store.appData.filament_stock]
    const obj = {
        material: editingItem.value.material,
        color,
        color_hex: normalizeHex(editingItem.value.color_hex),
        remaining_g: Math.max(0, Number(editingItem.value.remaining_g || 0)),
        buy_threshold_g: Math.max(0, Number(editingItem.value.buy_threshold_g || 0)),
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
    selectedItem.value = null
}

const deleteItem = async () => {
    if (!selectedItem.value) return
    if (!confirm('¿Eliminar este rollo del inventario?')) return
    const idx = selectedItem.value._idx
    const list = [...store.appData.filament_stock]
    list.splice(idx, 1)
    store.appData.filament_stock = list
    await store.saveApp()
    selectedItem.value = null
}

const getSeverity = (item) => {
    if (item.remaining_g <= 0) return 'danger'
    if (item.remaining_g <= item.buy_threshold_g) return 'warn'
    return 'success'
}

const getLabel = (item) => {
    if (item.remaining_g <= 0) return 'Agotado'
    if (item.remaining_g <= item.buy_threshold_g) return 'Bajo'
    return 'OK'
}

const getPercent = (item) => Math.min(100, Math.round((item.remaining_g / 1000) * 100))
</script>

<template>
    <div class="flex flex-col gap-4">
        <Toolbar>
            <template #start>
                <div class="flex items-center gap-3">
                    <span class="text-lg font-semibold">Inventario de Filamentos</span>
                    <div v-if="partnerLoaded" class="flex items-center gap-2 ml-4 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 rounded-lg">
                        <Checkbox v-model="showPartner" binary inputId="showPartner" />
                        <label for="showPartner" class="text-sm cursor-pointer text-indigo-600 dark:text-indigo-400 font-medium">
                            Mostrar inventario compartido
                        </label>
                    </div>
                </div>
            </template>
            <template #end>
                <div class="flex gap-2">
                    <Button label="Nuevo Rollo" icon="pi pi-plus" size="small" @click="openNew" />
                    <Button label="Eliminar" icon="pi pi-trash" severity="danger" size="small" outlined @click="deleteItem" :disabled="!selectedItem || selectedItem._isPartner" />
                </div>
            </template>
        </Toolbar>

        <DataTable
            v-model:selection="selectedItem"
            :value="combinedStock"
            selectionMode="single"
            dataKey="_idx"
            :paginator="true"
            :rows="18"
            :rowsPerPageOptions="[18, 50, 100]"
            stripedRows
            size="small"
        >
            <Column v-if="showPartner" header="Empresa" sortable style="width: 8rem">
                <template #body="{ data }">
                    <Tag :value="data._owner" :severity="data._isPartner ? 'info' : 'success'" />
                </template>
            </Column>
            <Column field="material" header="Material" sortable style="width: 10rem" />
            <Column field="color" header="Color" sortable style="width: 10rem">
                <template #body="{ data }">
                    <div class="flex items-center gap-2">
                        <span class="inline-block w-3 h-3 rounded-full border border-surface-300 dark:border-surface-600" :style="{ backgroundColor: colorHex(data) }" />
                        <span>{{ data.color }}</span>
                    </div>
                </template>
            </Column>
            <Column field="remaining_g" header="Restante" sortable style="width: 10rem">
                <template #body="{ data }">
                    <div class="flex items-center gap-2">
                        <span class="font-semibold">{{ data.remaining_g }} g</span>
                        <Tag :value="getLabel(data)" :severity="getSeverity(data)" />
                    </div>
                </template>
            </Column>
            <Column header="Nivel" style="width: 12rem">
                <template #body="{ data }">
                    <ProgressBar :value="getPercent(data)" :showValue="false" style="height: 8px" />
                </template>
            </Column>
            <Column field="buy_threshold_g" header="Umbral (g)" style="width: 8rem" />
            <Column header="" style="width: 4rem">
                <template #body="{ data }">
                    <Button v-if="!data._isPartner" icon="pi pi-pencil" text rounded size="small" @click="editItem(data)" />
                </template>
            </Column>
        </DataTable>

        <Dialog v-model:visible="dialogVisible" modal :header="isNew ? 'Nuevo Rollo' : 'Editar Rollo'" :style="{ width: '28rem' }">
            <div class="flex flex-col gap-4 pt-2">
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Material</label>
                    <Select v-model="editingItem.material" :options="materialOptions" editable class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Nombre del color</label>
                    <InputText v-model="editingItem.color" placeholder="Ej: Azul Noche" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Color visual</label>
                    <div class="flex items-center gap-3">
                        <ColorPicker v-model="editingItem.color_hex" format="hex" />
                        <span class="inline-block w-5 h-5 rounded-full border border-surface-300 dark:border-surface-600" :style="{ backgroundColor: normalizeHex(editingItem.color_hex) }" />
                        <span class="text-sm text-surface-500">{{ normalizeHex(editingItem.color_hex) }}</span>
                    </div>
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Cantidad Restante (g)</label>
                    <InputNumber v-model="editingItem.remaining_g" suffix=" g" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Umbral de Alerta (g)</label>
                    <InputNumber v-model="editingItem.buy_threshold_g" suffix=" g" class="w-full" />
                </div>
            </div>
            <template #footer>
                <Button label="Cancelar" severity="secondary" text @click="dialogVisible = false" />
                <Button label="Guardar" icon="pi pi-check" @click="saveItem" />
            </template>
        </Dialog>
    </div>
</template>
