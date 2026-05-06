<script setup>
import { computed, ref } from 'vue'
import { store } from '../store'
import { api, isElectron } from '../platform'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Toolbar from 'primevue/toolbar'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import ToggleSwitch from 'primevue/toggleswitch'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import PurgeMatrix from './PurgeMatrix.vue'

const config = computed(() => store.appData.global_config)
const printers = computed(() => store.appData.printers)
const materials = computed(() => store.appData.filament_types)

const saved = ref(false)
const toast = useToast()
const emailTesting = ref(false)
const emailTestTo = ref('')

const ensureEmailDefaults = () => {
    const c = config.value
    if (c.email_enabled === undefined) c.email_enabled = false
    if (c.email_from === undefined) c.email_from = ''
    if (c.email_app_password === undefined) c.email_app_password = ''
    if (c.email_sender_name === undefined) c.email_sender_name = store.empresa || ''
    if (c.email_reply_to === undefined) c.email_reply_to = ''
    if (c.email_whatsapp === undefined) c.email_whatsapp = ''
    if (c.email_instagram === undefined) c.email_instagram = ''
    if (c.email_website === undefined) c.email_website = ''
    if (c.email_footer_note === undefined) c.email_footer_note = ''
}
ensureEmailDefaults()

const sendTestEmail = async () => {
    ensureEmailDefaults()
    const target = String(emailTestTo.value || config.value.email_from || '').trim()
    if (!target) {
        toast.add({ severity: 'warn', summary: 'Indica un destinatario', detail: 'Escribe un correo o guarda primero el remitente.', life: 4000 })
        return
    }
    emailTesting.value = true
    try {
        await store.saveApp()
        const res = await api.sendTestEmail({
            config: JSON.parse(JSON.stringify(config.value)),
            empresa: store.empresa,
            to: target,
        })
        if (res?.ok) {
            toast.add({ severity: 'success', summary: 'Correo de prueba enviado', detail: `Revisa la bandeja de ${target}.`, life: 5000 })
        } else {
            toast.add({ severity: 'error', summary: 'No se pudo enviar', detail: res?.error || 'Error desconocido', life: 6000 })
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message || 'Error enviando correo', life: 6000 })
    } finally {
        emailTesting.value = false
    }
}

const handleLogout = async () => {
    try {
        await store.logout()
    } catch (e) {
        console.error('Logout error', e)
    }
}

const saveConfig = async () => {
    try {
        await store.saveApp()
        saved.value = true
        setTimeout(() => saved.value = false, 2000)
    } catch (e) {
        alert('Error al guardar: ' + e.message)
    }
}

/* ── Printers ── */
const printerDialog = ref(false)
const editingPrinter = ref({})
const isNewPrinter = ref(false)
const editingPrinterIdx = ref(-1)

const openNewPrinter = () => {
    editingPrinter.value = {
        name: '', material_diameter_mm: 1.75, price_eur: 300,
        depreciation_time_h: 2000, service_costs_life_eur: 100,
        energy_consumption_kwh: 0.15
    }
    isNewPrinter.value = true
    editingPrinterIdx.value = -1
    printerDialog.value = true
}

const editPrinter = (p) => {
    editingPrinter.value = { ...p }
    isNewPrinter.value = false
    editingPrinterIdx.value = store.appData.printers.findIndex(x => x.name === p.name)
    printerDialog.value = true
}

const savePrinter = async () => {
    if (!editingPrinter.value.name?.trim()) return alert('Nombre requerido')
    const list = [...store.appData.printers]
    const data = { ...editingPrinter.value }
    if (isNewPrinter.value) {
        list.push(data)
    } else if (editingPrinterIdx.value >= 0) {
        list[editingPrinterIdx.value] = data
    }
    store.appData.printers = list
    printerDialog.value = false
    await saveConfig()
}

const deletePrinter = (p) => {
    if (!confirm('¿Eliminar impresora ' + p.name + '?')) return
    const idx = store.appData.printers.findIndex(x => x.name === p.name)
    if (idx >= 0) {
        const list = [...store.appData.printers]
        list.splice(idx, 1)
        store.appData.printers = list
        saveConfig()
    }
}

/* ── Materials ── */
const materialDialog = ref(false)
const editingMaterial = ref({})
const isNewMaterial = ref(false)
const editingMaterialIdx = ref(-1)

const openNewMaterial = () => {
    editingMaterial.value = { name: '', price_per_kg: 20 }
    isNewMaterial.value = true
    editingMaterialIdx.value = -1
    materialDialog.value = true
}

const editMaterial = (m) => {
    editingMaterial.value = { ...m }
    isNewMaterial.value = false
    editingMaterialIdx.value = store.appData.filament_types.findIndex(x => x.name === m.name)
    materialDialog.value = true
}

const saveMaterial = async () => {
    if (!editingMaterial.value.name?.trim()) return alert('Nombre requerido')
    const list = [...store.appData.filament_types]
    const data = { ...editingMaterial.value }
    if (isNewMaterial.value) {
        list.push(data)
    } else if (editingMaterialIdx.value >= 0) {
        list[editingMaterialIdx.value] = data
    }
    store.appData.filament_types = list
    materialDialog.value = false
    await saveConfig()
}

const deleteMaterial = (m) => {
    if (!confirm('¿Eliminar material ' + m.name + '?')) return
    const idx = store.appData.filament_types.findIndex(x => x.name === m.name)
    if (idx >= 0) {
        const list = [...store.appData.filament_types]
        list.splice(idx, 1)
        store.appData.filament_types = list
        saveConfig()
    }
}

const selectPdfFolder = async () => {
    try {
        const res = await api.selectFolder()
        if (!res.canceled && res.path) {
            config.value.pdf_default_path = res.path
        }
    } catch (e) { /* user cancelled */ }
}
</script>

<template>
    <!-- Session bar -->
    <div class="flex items-center justify-between mb-4 p-3 rounded-xl card">
        <div class="flex items-center gap-3 text-sm text-surface-500 dark:text-surface-300">
            <i class="pi pi-building text-primary-500 dark:text-primary-400" />
            <span class="font-semibold text-surface-900 dark:text-surface-0">{{ store.empresa }}</span>
            <span class="text-surface-300 dark:text-surface-500">|</span>
            <i class="pi pi-user" />
            <span>{{ store.user?.email }}</span>
        </div>
        <Button label="Cerrar Sesión" icon="pi pi-sign-out" severity="danger" text size="small" @click="handleLogout" />
    </div>

    <Tabs value="0">
        <TabList>
            <Tab value="0"><i class="pi pi-sliders-h mr-2" />General</Tab>
            <Tab value="1"><i class="pi pi-print mr-2" />Impresoras</Tab>
            <Tab value="2"><i class="pi pi-palette mr-2" />Materiales</Tab>
            <Tab value="3"><i class="pi pi-sync mr-2" />Purgas</Tab>
            <Tab value="4"><i class="pi pi-credit-card mr-2" />Stripe</Tab>
            <Tab value="5"><i class="pi pi-envelope mr-2" />Notificaciones</Tab>
        </TabList>
        <TabPanels>
            <!-- General Settings -->
            <TabPanel value="0">
                <div class="max-w-xl flex flex-col gap-4 pt-2">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Electricidad (€/kWh)</label>
                            <InputNumber v-model="config.energy_cost_kwh" :minFractionDigits="2" :maxFractionDigits="4" class="w-full" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Mano de Obra (€/h)</label>
                            <InputNumber v-model="config.labor_cost_h" :minFractionDigits="2" class="w-full" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Moneda</label>
                            <InputText v-model="config.money_unit" class="w-full" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Precio Mínimo</label>
                            <InputNumber v-model="config.precio_minimo" :minFractionDigits="2" class="w-full" />
                        </div>
                    </div>
                    <div v-if="isElectron()" class="flex flex-col gap-1">
                        <label class="text-sm font-medium">Carpeta predeterminada para PDFs</label>
                        <div class="flex gap-2">
                            <InputText v-model="config.pdf_default_path" class="flex-1" placeholder="Sin definir — se pedirá cada vez" />
                            <Button icon="pi pi-folder-open" severity="secondary" outlined @click="selectPdfFolder" />
                        </div>
                        <small class="text-surface-400">Si se configura, los PDFs se guardan directamente aquí sin preguntar.</small>
                    </div>
                    <div class="flex items-center gap-3">
                        <Button label="Guardar Configuración" icon="pi pi-save" @click="saveConfig" />
                        <Message v-if="saved" severity="success" :closable="false">Guardado correctamente</Message>
                    </div>
                </div>
            </TabPanel>

            <!-- Printers -->
            <TabPanel value="1">
                <Toolbar class="mb-3">
                    <template #start>
                        <span class="font-semibold">Mis Impresoras</span>
                    </template>
                    <template #end>
                        <Button label="Nueva Impresora" icon="pi pi-plus" size="small" @click="openNewPrinter" />
                    </template>
                </Toolbar>
                <DataTable :value="printers" stripedRows size="small">
                    <Column field="name" header="Nombre" />
                    <Column field="price_eur" header="Precio (€)" style="width: 8rem" />
                    <Column field="energy_consumption_kwh" header="Consumo (kWh)" style="width: 10rem" />
                    <Column field="depreciation_time_h" header="Vida útil (h)" style="width: 8rem" />
                    <Column header="" style="width: 7rem">
                        <template #body="{ data }">
                            <div class="flex gap-1">
                                <Button icon="pi pi-pencil" text rounded size="small" @click="editPrinter(data)" />
                                <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deletePrinter(data)" />
                            </div>
                        </template>
                    </Column>
                </DataTable>
            </TabPanel>

            <!-- Materials -->
            <TabPanel value="2">
                <Toolbar class="mb-3">
                    <template #start>
                        <span class="font-semibold">Tipos de Material</span>
                    </template>
                    <template #end>
                        <Button label="Nuevo Material" icon="pi pi-plus" size="small" @click="openNewMaterial" />
                    </template>
                </Toolbar>
                <DataTable :value="materials" stripedRows size="small">
                    <Column field="name" header="Nombre" />
                    <Column field="price_per_kg" header="Precio/Kg (€)" style="width: 10rem" />
                    <Column header="" style="width: 7rem">
                        <template #body="{ data }">
                            <div class="flex gap-1">
                                <Button icon="pi pi-pencil" text rounded size="small" @click="editMaterial(data)" />
                                <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deleteMaterial(data)" />
                            </div>
                        </template>
                    </Column>
                </DataTable>
            </TabPanel>

            <!-- Purge Matrix -->
            <TabPanel value="3">
                <PurgeMatrix />
            </TabPanel>

            <!-- Stripe -->
            <TabPanel value="4">
                <div class="max-w-xl flex flex-col gap-4 pt-2">
                    <Message severity="info" :closable="false">
                        Configura tu clave API de Stripe para generar enlaces de pago.
                    </Message>
                    <div class="flex flex-col gap-1">
                        <label class="text-sm font-medium">Secret Key</label>
                        <InputText v-model="config.stripe_secret_key" class="w-full" type="password" />
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-sm font-medium">URL Éxito</label>
                        <InputText v-model="config.stripe_success_url" class="w-full" />
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-sm font-medium">URL Cancelación</label>
                        <InputText v-model="config.stripe_cancel_url" class="w-full" />
                    </div>
                    <Button label="Guardar" icon="pi pi-save" @click="saveConfig" class="w-fit" />
                </div>
            </TabPanel>

            <!-- Email notifications -->
            <TabPanel value="5">
                <div class="max-w-2xl flex flex-col gap-5 pt-2">
                    <div class="flex items-start gap-4 p-4 rounded-2xl card-inset border border-black/[0.05] dark:border-white/[0.06]">
                        <div class="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 text-white shrink-0">
                            <i class="pi pi-envelope text-xl" />
                        </div>
                        <div class="flex-1">
                            <div class="font-semibold text-surface-900 dark:text-surface-0">Notificaciones automáticas por email</div>
                            <p class="text-sm text-surface-500 dark:text-surface-300 mt-1 leading-relaxed">
                                Cuando un pedido tiene un correo asociado, el cliente recibirá un email estético cada vez que cambies su estado
                                (presupuesto enviado, aceptado, en producción, post-procesado, listo para entregar, entregado).
                            </p>
                        </div>
                        <ToggleSwitch v-model="config.email_enabled" />
                    </div>

                    <Message severity="info" :closable="false">
                        Para usar Gmail necesitas una <strong>App Password</strong> de Google. Activa la verificación en 2 pasos en tu cuenta y
                        genera una contraseña de aplicación en
                        <a href="https://myaccount.google.com/apppasswords" target="_blank" class="underline">myaccount.google.com/apppasswords</a>.
                        No uses tu contraseña normal de Gmail.
                    </Message>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Cuenta Gmail (remitente)</label>
                            <InputText v-model="config.email_from" class="w-full" placeholder="pedidos@tudominio.com" :disabled="!config.email_enabled" />
                            <small class="text-surface-400">Cuenta desde la que se mandarán los correos.</small>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">App Password</label>
                            <InputText v-model="config.email_app_password" class="w-full" type="password" placeholder="xxxx xxxx xxxx xxxx" :disabled="!config.email_enabled" />
                            <small class="text-surface-400">16 caracteres generados en Google.</small>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Nombre del remitente</label>
                            <InputText v-model="config.email_sender_name" class="w-full" :placeholder="store.empresa" :disabled="!config.email_enabled" />
                            <small class="text-surface-400">Aparecerá en el campo "De:" del correo.</small>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Responder a (opcional)</label>
                            <InputText v-model="config.email_reply_to" class="w-full" placeholder="contacto@tudominio.com" :disabled="!config.email_enabled" />
                            <small class="text-surface-400">Si los clientes responden, llegará aquí.</small>
                        </div>
                    </div>

                    <!-- Contact buttons in email -->
                    <div class="rounded-2xl card-inset p-4 flex flex-col gap-3 border border-black/[0.05] dark:border-white/[0.06]">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2">
                                <i class="pi pi-link text-violet-500" />
                                <span class="font-semibold">Botones de contacto en el email</span>
                            </div>
                            <span class="text-[10px] text-surface-400 uppercase tracking-wider">Opcional</span>
                        </div>
                        <p class="text-sm text-surface-500 dark:text-surface-400 -mt-1">
                            Aparecen al final de cada correo. Sólo se muestran los que rellenes.
                        </p>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-medium flex items-center gap-1.5">
                                    <i class="pi pi-whatsapp text-green-500 text-xs" />
                                    WhatsApp
                                </label>
                                <InputText v-model="config.email_whatsapp" class="w-full" placeholder="+34 600 123 456" :disabled="!config.email_enabled" />
                                <small class="text-surface-400">Con prefijo internacional. Lleva al chat directo.</small>
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-medium flex items-center gap-1.5">
                                    <i class="pi pi-instagram text-pink-500 text-xs" />
                                    Instagram
                                </label>
                                <InputText v-model="config.email_instagram" class="w-full" placeholder="@tu_usuario  o  https://instagram.com/..." :disabled="!config.email_enabled" />
                            </div>
                            <div class="flex flex-col gap-1 md:col-span-2">
                                <label class="text-xs font-medium flex items-center gap-1.5">
                                    <i class="pi pi-globe text-blue-500 text-xs" />
                                    Página web
                                </label>
                                <InputText v-model="config.email_website" class="w-full" placeholder="https://impresion3dcc.com" :disabled="!config.email_enabled" />
                            </div>
                            <div class="flex flex-col gap-1 md:col-span-2">
                                <label class="text-xs font-medium flex items-center gap-1.5">
                                    <i class="pi pi-pencil text-surface-500 text-xs" />
                                    Mensaje de pie (opcional)
                                </label>
                                <Textarea v-model="config.email_footer_note" rows="2" autoResize class="w-full text-sm" placeholder="Ej: Recogida en C/ Mayor, 12 — Lun a Vie 10-14h y 17-20h" :disabled="!config.email_enabled" />
                                <small class="text-surface-400">Se incluye en cursiva al pie de cada email. Útil para horario, dirección, etc.</small>
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center gap-3 flex-wrap">
                        <Button label="Guardar" icon="pi pi-save" @click="saveConfig" />
                        <Message v-if="saved" severity="success" :closable="false">Guardado correctamente</Message>
                    </div>

                    <div class="rounded-2xl card-inset p-4 flex flex-col gap-3 border border-black/[0.05] dark:border-white/[0.06]">
                        <div class="flex items-center gap-2">
                            <i class="pi pi-send text-blue-500" />
                            <span class="font-semibold">Probar configuración</span>
                        </div>
                        <p class="text-sm text-surface-500 dark:text-surface-400">
                            Mandamos un correo de prueba con la plantilla y el logo de tu empresa para que veas cómo lo reciben tus clientes.
                        </p>
                        <div class="flex flex-col sm:flex-row gap-2">
                            <InputText v-model="emailTestTo" class="flex-1" :placeholder="config.email_from || 'destinatario@ejemplo.com'" />
                            <Button label="Enviar prueba" icon="pi pi-paper-plane" severity="info" :loading="emailTesting"
                                @click="sendTestEmail" :disabled="!config.email_enabled || !config.email_from || !config.email_app_password" />
                        </div>
                    </div>
                </div>
            </TabPanel>
        </TabPanels>
    </Tabs>

    <!-- Printer Dialog -->
    <Dialog v-model:visible="printerDialog" modal :header="isNewPrinter ? 'Nueva Impresora' : 'Editar Impresora'" :style="{ width: '30rem' }">
        <div class="flex flex-col gap-4 pt-2">
            <div class="flex flex-col gap-1">
                <label class="text-sm font-medium">Nombre</label>
                <InputText v-model="editingPrinter.name" class="w-full" />
            </div>
            <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Precio (€)</label>
                    <InputNumber v-model="editingPrinter.price_eur" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Consumo (kWh)</label>
                    <InputNumber v-model="editingPrinter.energy_consumption_kwh" :minFractionDigits="3" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Vida útil (h)</label>
                    <InputNumber v-model="editingPrinter.depreciation_time_h" class="w-full" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Costes servicio (€)</label>
                    <InputNumber v-model="editingPrinter.service_costs_life_eur" class="w-full" />
                </div>
            </div>
        </div>
        <template #footer>
            <Button label="Cancelar" severity="secondary" text @click="printerDialog = false" />
            <Button label="Guardar" icon="pi pi-check" @click="savePrinter" />
        </template>
    </Dialog>

    <!-- Material Dialog -->
    <Dialog v-model:visible="materialDialog" modal :header="isNewMaterial ? 'Nuevo Material' : 'Editar Material'" :style="{ width: '24rem' }">
        <div class="flex flex-col gap-4 pt-2">
            <div class="flex flex-col gap-1">
                <label class="text-sm font-medium">Nombre (ej: PETG)</label>
                <InputText v-model="editingMaterial.name" class="w-full" />
            </div>
            <div class="flex flex-col gap-1">
                <label class="text-sm font-medium">Precio por Kg (€)</label>
                <InputNumber v-model="editingMaterial.price_per_kg" :minFractionDigits="2" class="w-full" />
            </div>
        </div>
        <template #footer>
            <Button label="Cancelar" severity="secondary" text @click="materialDialog = false" />
            <Button label="Guardar" icon="pi pi-check" @click="saveMaterial" />
        </template>
    </Dialog>
</template>
