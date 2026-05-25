<script setup>
import { computed, reactive, ref } from 'vue'
import { store } from '../store'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Dialog from 'primevue/dialog'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'

const toast = useToast()
const confirm = useConfirm()

const clients = computed(() => {
    const rawClients = store.appData.clients || []
    const allOrders = store.appData.orders || []
    
    return rawClients.map(client => {
        const clientOrders = allOrders.filter(o => o.cliente === client.name)
        const totalSpent = clientOrders.reduce((sum, o) => sum + Number(o.precio_final || 0), 0)
        return {
            ...client,
            _orderCount: clientOrders.length,
            _totalSpent: totalSpent
        }
    })
})
const globalFilter = ref('')
const clientDialog = ref(false)
const historyDialog = ref(false)
const selectedClient = ref(null)

const clientForm = reactive({
    id: '',
    name: '',
    email: '',
    phone: '',
    tax_id: '',
    address: '',
    default_discount: 0,
    notes: ''
})

const openNew = () => {
    Object.assign(clientForm, {
        id: '',
        name: '',
        email: '',
        phone: '',
        tax_id: '',
        address: '',
        default_discount: 0,
        notes: ''
    })
    clientDialog.value = true
}

const editClient = (client) => {
    Object.assign(clientForm, { ...client })
    clientDialog.value = true
}

const saveClient = async () => {
    if (!clientForm.name) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'El nombre es obligatorio', life: 3000 })
        return
    }

    try {
        if (clientForm.id) {
            await store.updateClient({ clientId: clientForm.id, updates: { ...clientForm } })
            toast.add({ severity: 'success', summary: 'Éxito', detail: 'Cliente actualizado', life: 3000 })
        } else {
            await store.addClient({ ...clientForm })
            toast.add({ severity: 'success', summary: 'Éxito', detail: 'Cliente creado', life: 3000 })
        }
        clientDialog.value = false
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    }
}

const deleteClient = (client) => {
    confirm.require({
        message: `¿Estás seguro de eliminar a ${client.name}? Sus pedidos no se borrarán, pero dejará de aparecer en la lista de clientes.`,
        header: 'Confirmar eliminación',
        icon: 'pi pi-exclamation-triangle',
        acceptProps: { severity: 'danger' },
        accept: async () => {
            try {
                await store.removeClient(client.id)
                toast.add({ severity: 'info', summary: 'Eliminado', detail: 'Cliente eliminado correctamente', life: 3000 })
            } catch (e) {
                toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
            }
        }
    })
}

const getClientOrders = (clientName) => {
    return (store.appData.orders || []).filter(o => o.cliente === clientName)
}

const showHistory = (client) => {
    selectedClient.value = client
    historyDialog.value = true
}

const fmtMoney = (v) => `${Number(v || 0).toFixed(2)} ${store.appData.global_config.money_unit}`
const fmtDate = (v) => v ? new Date(v).toLocaleDateString() : '-'

</script>

<template>
    <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between p-1.5 rounded-2xl card">
            <div class="flex items-center gap-2 pl-2">
                <i class="pi pi-users text-surface-400" />
                <h1 class="text-xl font-bold">Gestión de Clientes</h1>
            </div>
            <div class="flex items-center gap-2">
                <InputText v-model="globalFilter" placeholder="Buscar cliente..." class="text-sm" size="small" />
                <Button label="Nuevo Cliente" icon="pi pi-plus" size="small" @click="openNew" />
            </div>
        </div>

        <DataTable :value="clients" :paginator="true" :rows="10" dataKey="id" 
            :filters="{ global: { value: globalFilter, matchMode: 'contains' } }"
            :globalFilterFields="['name', 'email', 'tax_id', 'phone']"
            class="rounded-2xl overflow-hidden card" responsiveLayout="scroll">
            <template #empty>
                <div class="p-10 text-center text-surface-400">No hay clientes registrados</div>
            </template>
            <Column field="name" header="Nombre" sortable>
                <template #body="{ data }">
                    <div class="flex flex-col">
                        <span class="font-bold">{{ data.name }}</span>
                        <span class="text-xs text-surface-500">{{ data.email || 'Sin email' }}</span>
                    </div>
                </template>
            </Column>
            <Column field="tax_id" header="DNI/CIF" sortable></Column>
            <Column field="phone" header="Teléfono"></Column>
            <Column field="_orderCount" header="Pedidos" sortable class="text-center">
                <template #body="{ data }">
                    <Button :label="String(data._orderCount)" text size="small" @click="showHistory(data)" />
                </template>
            </Column>
            <Column field="_totalSpent" header="Total Invertido" sortable>
                <template #body="{ data }">
                    <span class="font-semibold">{{ fmtMoney(data._totalSpent) }}</span>
                </template>
            </Column>
            <Column header="Acciones" class="w-32">
                <template #body="{ data }">
                    <div class="flex gap-1">
                        <Button icon="pi pi-pencil" severity="secondary" text rounded size="small" @click="editClient(data)" />
                        <Button icon="pi pi-history" severity="info" text rounded size="small" @click="showHistory(data)" v-tooltip.top="'Ver historial'" />
                        <Button icon="pi pi-trash" severity="danger" text rounded size="small" @click="deleteClient(data)" />
                    </div>
                </template>
            </Column>
        </DataTable>

        <!-- Client Form Dialog -->
        <Dialog v-model:visible="clientDialog" :header="clientForm.id ? 'Editar Cliente' : 'Nuevo Cliente'" modal :style="{ width: '30rem' }">
            <div class="flex flex-col gap-4 py-2">
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-semibold">Nombre Completo</label>
                    <InputText v-model="clientForm.name" class="w-full" placeholder="Ej: Juan Pérez" />
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="flex flex-col gap-1">
                        <label class="text-sm font-semibold">DNI / CIF</label>
                        <InputText v-model="clientForm.tax_id" class="w-full" />
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-sm font-semibold">Teléfono</label>
                        <InputText v-model="clientForm.phone" class="w-full" />
                    </div>
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-semibold">Email</label>
                    <InputText v-model="clientForm.email" class="w-full" type="email" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-semibold">Dirección</label>
                    <InputText v-model="clientForm.address" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-semibold">Descuento predeterminado (%)</label>
                    <InputNumber v-model="clientForm.default_discount" :min="0" :max="100" suffix="%" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-semibold">Notas</label>
                    <Textarea v-model="clientForm.notes" rows="3" autoResize class="w-full" />
                </div>
            </div>
            <template #footer>
                <Button label="Cancelar" severity="secondary" text @click="clientDialog = false" />
                <Button label="Guardar" icon="pi pi-check" @click="saveClient" />
            </template>
        </Dialog>

        <!-- History Dialog -->
        <Dialog v-model:visible="historyDialog" :header="'Historial: ' + selectedClient?.name" modal :style="{ width: '50rem' }">
            <div v-if="selectedClient" class="flex flex-col gap-4">
                <div class="grid grid-cols-3 gap-3">
                    <div class="card p-3 text-center bg-surface-50 dark:bg-surface-800">
                        <div class="text-[10px] uppercase font-bold text-surface-500">Total Pedidos</div>
                        <div class="text-xl font-bold">{{ selectedClient._orderCount }}</div>
                    </div>
                    <div class="card p-3 text-center bg-surface-50 dark:bg-surface-800">
                        <div class="text-[10px] uppercase font-bold text-surface-500">Total Invertido</div>
                        <div class="text-xl font-bold text-emerald-500">{{ fmtMoney(selectedClient._totalSpent) }}</div>
                    </div>
                    <div v-if="selectedClient.default_discount" class="card p-3 text-center bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                        <div class="text-[10px] uppercase font-bold text-amber-600">Descuento Fijo</div>
                        <div class="text-xl font-bold text-amber-600">{{ selectedClient.default_discount }}%</div>
                    </div>
                </div>

                <DataTable :value="getClientOrders(selectedClient.name)" :rows="5" :paginator="true" class="text-sm">
                    <Column field="fecha" header="Fecha" sortable>
                        <template #body="{ data }">{{ fmtDate(data.fecha) }}</template>
                    </Column>
                    <Column field="descripcion" header="Descripción"></Column>
                    <Column field="precio_final" header="Total">
                        <template #body="{ data }">{{ fmtMoney(data.precio_final) }}</template>
                    </Column>
                    <Column field="estado" header="Estado">
                        <template #body="{ data }">
                            <span class="text-xs font-bold">{{ data.estado }}</span>
                        </template>
                    </Column>
                </DataTable>
            </div>
        </Dialog>
    </div>
</template>
