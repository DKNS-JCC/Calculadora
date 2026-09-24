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
import CampoNumero from './CampoNumero.vue'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import ToggleSwitch from 'primevue/toggleswitch'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import { laborOptions, disenoCostH, postprocCostH } from '../shared/backend.mjs'
import { checkForUpdate, describeCheck, isAndroid as isAndroidApp } from '../utils/androidUpdater'
import PurgeMatrix from './PurgeMatrix.vue'

const emit = defineEmits(['install-update'])

const config = computed(() => store.appData.global_config)
const printers = computed(() => store.appData.printers)
const materials = computed(() => store.appData.filament_types)

const saved = ref(false)
const toast = useToast()

/* ── Comprobación manual de actualizaciones ──────────────────────────────
 * La del arranque se traga los errores para no molestar sin cobertura, con
 * el efecto de que un canal roto se ve igual que "estás al día". Ésta dice
 * exactamente lo que ha pasado. */
const updateChecking = ref(false)
const updateMessage = ref('')
const updateSeverity = ref('info')
const updateFound = ref(null)

async function manualUpdateCheck() {
    updateChecking.value = true
    updateFound.value = null
    try {
        const result = await checkForUpdate({ force: true })
        updateMessage.value = describeCheck(result)
        updateSeverity.value = result.status === 'error' || result.status === 'no-asset'
            ? 'error'
            : result.status === 'available' ? 'warn' : 'success'
        if (result.available) updateFound.value = result
    } catch (e) {
        updateMessage.value = `No se pudo comprobar: ${e.message}`
        updateSeverity.value = 'error'
    } finally {
        updateChecking.value = false
    }
}

/* Tarifario de mano de obra: se deriva del coste/hora, así que se muestra
 * aquí en vivo para ver qué importes produce el valor que se está editando. */
const tarifaUnit = (v) => `${Number(v || 0).toFixed(2)} ${config.value?.money_unit || '€'}`
const tarifario = computed(() => {
    const gc = {
        labor_cost_h: Number(config.value?.labor_cost_h || 0),
        postproc_cost_h: Number(config.value?.postproc_cost_h || 0),
    }
    const opts = laborOptions(gc)
    return [
        { titulo: 'Diseño', filas: opts.diseno, costeH: disenoCostH(gc), nota: 'Se cobra una vez por pedido.' },
        { titulo: 'Post-procesado', filas: opts.postproc, costeH: postprocCostH(gc), nota: 'Incluye soportes. Se multiplica por cada pieza.' },
    ]
})
const emailTesting = ref(false)
const emailTestTo = ref('')

/* 3DCC manda los correos desde Supabase (notify-quote / recibo-emitir): mismas
 * plantillas y remitente que la web, en escritorio y en móvil, y la contraseña
 * de Gmail vive solo en el servidor. SILAB3D sigue con su propio Gmail. */
const correoServidor = computed(() => store.empresa === '3DCC')

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

const PDF_BRAND_PRESETS = {
    '3DCC': { primary: '#2563eb', headerStyle: 'dark', tagline: 'Impresión 3D profesional' },
    'SILAB3D': { primary: '#0f766e', headerStyle: 'light', tagline: 'Fabricación digital y prototipado' },
}

const pdfLogoPreview = ref('')

const ensurePdfBrandingDefaults = () => {
    const c = config.value
    const preset = PDF_BRAND_PRESETS[String(store.empresa || '').toUpperCase()] || { primary: '#2563eb', headerStyle: 'dark', tagline: '' }
    if (c.pdf_show_logo === undefined) c.pdf_show_logo = true
    if (!c.pdf_primary_color) c.pdf_primary_color = preset.primary
    if (!c.pdf_header_style) c.pdf_header_style = preset.headerStyle
    if (!c.pdf_tagline) c.pdf_tagline = preset.tagline
    ;['pdf_logo_path', 'pdf_company_legal', 'pdf_contact_email', 'pdf_contact_phone', 'pdf_contact_web', 'pdf_contact_address', 'pdf_conditions', 'pdf_footer_note'].forEach((k) => {
        if (c[k] === undefined) c[k] = ''
    })
}
ensurePdfBrandingDefaults()

const loadPdfLogoPreview = async () => {
    const p = String(config.value.pdf_logo_path || '').trim()
    if (!p || !api.readImageAsBase64) { pdfLogoPreview.value = ''; return }
    try {
        const r = await api.readImageAsBase64(p)
        pdfLogoPreview.value = r?.ok ? `data:${r.mimeType};base64,${r.data}` : ''
    } catch { pdfLogoPreview.value = '' }
}
loadPdfLogoPreview()

const selectPdfLogo = async () => {
    if (!api.openImageFilePicker) return
    const res = await api.openImageFilePicker()
    if (res && !res.canceled && res.filePath) {
        config.value.pdf_logo_path = res.filePath
        await loadPdfLogoPreview()
    }
}

const clearPdfLogo = () => {
    config.value.pdf_logo_path = ''
    pdfLogoPreview.value = ''
}

const pdfHeaderPreviewStyle = computed(() => (
    config.value.pdf_header_style === 'light' ? { background: '#ffffff', border: '1px solid #e2e8f0' } : { background: '#0f172a' }
))
const pdfHeaderTextColor = computed(() => (config.value.pdf_header_style === 'light' ? '#0f172a' : '#ffffff'))
const defaultConditionsPlaceholder = [
    'El coste indicado es el precio final del proyecto, incluyendo todos los gastos necesarios.',
    'El tiempo de entrega depende de la complejidad del proyecto y la cola de trabajo en curso.',
    'Se requiere el abono del 50% del presupuesto como anticipo para iniciar la producción.',
].join('\n')


const handleLogout = async () => {
    try {
        await store.logout()
    } catch (e) {
        console.error('Logout error', e)
    }
}

const saveConfig = async () => {
    try {
        // La contraseña de Gmail ya no hace falta en 3DCC: que no viaje en la
        // config (la lee también la empresa socia).
        if (correoServidor.value && config.value.email_app_password) config.value.email_app_password = ''
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
            <Tab value="6"><i class="pi pi-id-card mr-2" />Marca / PDF</Tab>
        </TabList>
        <TabPanels>
            <!-- General Settings -->
            <TabPanel value="0">
                <div class="max-w-xl flex flex-col gap-4 pt-2">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Electricidad (€/kWh)</label>
                            <CampoNumero v-model="config.energy_cost_kwh" :min-decimales="2" :max-decimales="4" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Diseño (€/h)</label>
                            <CampoNumero v-model="config.labor_cost_h" :min-decimales="2" :max-decimales="2" />
                            <small class="text-surface-400">Modelado, slicer y búsqueda de modelos.</small>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Post-procesado (€/h)</label>
                            <CampoNumero v-model="config.postproc_cost_h" :min-decimales="2" :max-decimales="2" />
                            <small class="text-surface-400">Soportes, lijado, ensamblado y pintura.</small>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Moneda</label>
                            <InputText v-model="config.money_unit" class="w-full" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Precio Mínimo</label>
                            <CampoNumero v-model="config.precio_minimo" :min-decimales="2" :max-decimales="2" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Color de Marca (Botones y acentos)</label>
                            <div class="flex items-center gap-2">
                                <input type="color" v-model="config.brand_color" class="w-10 h-10 p-0 border-0 bg-transparent cursor-pointer rounded overflow-hidden" />
                                <InputText v-model="config.brand_color" class="flex-1" placeholder="#3b82f6" />
                            </div>
                        </div>
                    </div>

                    <!-- Tarifario derivado del coste/hora -->
                    <div class="rounded-xl border border-black/[0.06] dark:border-white/[0.08] overflow-hidden">
                        <div class="px-4 py-2.5 border-b border-black/[0.06] dark:border-white/[0.08] flex items-baseline justify-between gap-2">
                            <span class="text-sm font-medium">Tarifario de mano de obra</span>
                            <span class="text-xs text-surface-400">cada bloque a su propio coste/hora</span>
                        </div>
                        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                            <div v-for="grupo in tarifario" :key="grupo.titulo" class="flex flex-col gap-1.5">
                                <div class="flex items-baseline justify-between gap-2">
                                    <span class="text-[11px] uppercase font-semibold tracking-wide text-surface-400">{{ grupo.titulo }}</span>
                                    <span class="text-[11px] font-mono text-surface-400">{{ tarifaUnit(grupo.costeH) }}/h</span>
                                </div>
                                <div v-for="t in grupo.filas" :key="t.value" class="flex items-baseline justify-between gap-3 text-sm">
                                    <span class="truncate text-surface-600 dark:text-surface-300">{{ t.label }}</span>
                                    <span class="font-mono shrink-0" :class="t.eur > 0 || t.custom ? 'text-amber-600 dark:text-amber-400' : 'text-surface-400'">
                                        {{ t.custom ? tarifaUnit(grupo.costeH) + '/h' : tarifaUnit(t.eur) }}
                                    </span>
                                </div>
                                <div class="text-[11px] text-surface-400 mt-0.5">{{ grupo.nota }}</div>
                            </div>
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

                    <!-- Actualizaciones: la comprobación del arranque calla sus
                         errores, así que ésta es la única forma de distinguir
                         "no hay novedades" de "el canal está roto". -->
                    <div v-if="isAndroidApp()" class="rounded-xl card-inset p-4 flex flex-col gap-2">
                        <div class="flex items-center justify-between gap-3">
                            <div>
                                <div class="text-sm font-medium">Actualizaciones</div>
                                <div class="text-[11px] text-surface-400">Instalación por sideload desde GitHub Releases</div>
                            </div>
                            <Button label="Buscar" icon="pi pi-refresh" size="small" outlined
                                :loading="updateChecking" @click="manualUpdateCheck" />
                        </div>
                        <Message v-if="updateMessage" :severity="updateSeverity" :closable="false" class="!text-sm">
                            {{ updateMessage }}
                        </Message>
                        <Button v-if="updateFound" :label="`Descargar e instalar ${updateFound.version}`"
                            icon="pi pi-download" size="small" @click="$emit('install-update', updateFound)" />
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
                        <ToggleSwitch v-if="!correoServidor" v-model="config.email_enabled" />
                    </div>

                    <Message v-if="correoServidor" severity="success" :closable="false">
                        Los correos de <strong>3DCC</strong> salen del servidor (Supabase), con las mismas plantillas y el mismo
                        remitente que la web, también desde el móvil. Aquí no hace falta ninguna contraseña: al guardar se borra
                        la que hubiera. Al cambiar el estado de un pedido se te preguntará si avisar al cliente; al enviar un
                        presupuesto desde el escritorio se adjunta el PDF.
                    </Message>

                    <template v-if="!correoServidor">
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

                    </template>

                    <div class="flex items-center gap-3 flex-wrap">
                        <Button label="Guardar" icon="pi pi-save" @click="saveConfig" />
                        <Message v-if="saved" severity="success" :closable="false">Guardado correctamente</Message>
                    </div>

                    <template v-if="!correoServidor">
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
                    </template>
                </div>
            </TabPanel>

            <!-- PDF / Marca -->
            <TabPanel value="6">
                <div class="max-w-3xl flex flex-col gap-5 pt-2">
                    <Message severity="info" :closable="false">
                        Personaliza el PDF de presupuesto que reciben tus clientes. Cada empresa guarda su propia marca,
                        de modo que <strong>{{ store.empresa }}</strong> genera un documento distinto al de la otra marca.
                    </Message>

                    <!-- Live preview of the PDF header -->
                    <div class="rounded-2xl overflow-hidden border border-black/[0.05] dark:border-white/[0.06]">
                        <div class="px-5 py-4 flex items-center gap-3" :style="pdfHeaderPreviewStyle">
                            <img v-if="config.pdf_show_logo && pdfLogoPreview" :src="pdfLogoPreview" class="w-14 h-14 object-contain rounded" />
                            <div v-else-if="config.pdf_show_logo" class="w-14 h-14 rounded bg-black/10 dark:bg-white/10 flex items-center justify-center text-[10px] uppercase tracking-wider" :style="{ color: pdfHeaderTextColor }">Logo</div>
                            <div class="min-w-0 flex-1">
                                <div class="font-bold text-xl leading-tight truncate" :style="{ color: pdfHeaderTextColor }">{{ config.pdf_company_legal || store.empresa }}</div>
                                <div v-if="config.pdf_tagline" class="text-[11px] font-bold uppercase tracking-wide truncate mt-0.5" :style="{ color: config.pdf_primary_color }">{{ config.pdf_tagline }}</div>
                            </div>
                            <div class="text-right text-[10px] leading-snug shrink-0" :style="{ color: pdfHeaderTextColor, opacity: 0.7 }">
                                <div v-if="config.pdf_contact_email">{{ config.pdf_contact_email }}</div>
                                <div v-if="config.pdf_contact_phone">{{ config.pdf_contact_phone }}</div>
                                <div v-if="config.pdf_contact_web">{{ config.pdf_contact_web }}</div>
                            </div>
                        </div>
                        <div class="h-1.5" :style="{ background: config.pdf_primary_color }" />
                        <div class="px-4 py-2 text-[11px] text-surface-400 bg-surface-50 dark:bg-surface-800">Vista previa de la cabecera del presupuesto</div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Nombre en el documento</label>
                            <InputText v-model="config.pdf_company_legal" class="w-full" :placeholder="store.empresa" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Eslogan / subtítulo</label>
                            <InputText v-model="config.pdf_tagline" class="w-full" placeholder="Ej: Impresión 3D profesional" />
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Color principal</label>
                            <div class="flex items-center gap-2">
                                <input type="color" v-model="config.pdf_primary_color" class="w-10 h-10 p-0 border-0 bg-transparent cursor-pointer rounded overflow-hidden" />
                                <InputText v-model="config.pdf_primary_color" class="flex-1" placeholder="#2563eb" />
                            </div>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Estilo de cabecera</label>
                            <select v-model="config.pdf_header_style" class="w-full h-10 px-3 rounded-md border border-surface-300 dark:border-surface-600 bg-surface-0 dark:bg-surface-900 text-sm">
                                <option value="dark">Oscura (fondo oscuro)</option>
                                <option value="light">Clara (fondo blanco)</option>
                            </select>
                        </div>
                    </div>

                    <!-- Logo -->
                    <div class="rounded-2xl card-inset p-4 flex flex-col gap-3 border border-black/[0.05] dark:border-white/[0.06]">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2">
                                <i class="pi pi-image text-primary-500" />
                                <span class="font-semibold">Logo</span>
                            </div>
                            <ToggleSwitch v-model="config.pdf_show_logo" />
                        </div>
                        <div v-if="isElectron()" class="flex gap-2 items-center">
                            <InputText v-model="config.pdf_logo_path" class="flex-1" placeholder="Logo por defecto de la empresa" :disabled="!config.pdf_show_logo" />
                            <Button icon="pi pi-folder-open" severity="secondary" outlined @click="selectPdfLogo" :disabled="!config.pdf_show_logo" />
                            <Button icon="pi pi-times" severity="secondary" text @click="clearPdfLogo" :disabled="!config.pdf_show_logo || !config.pdf_logo_path" v-tooltip.bottom="'Usar logo por defecto'" />
                        </div>
                        <small class="text-surface-400">Si lo dejas vacío se usa el logo por defecto de {{ store.empresa }}. Formato PNG o JPG.</small>
                    </div>

                    <!-- Contact block -->
                    <div class="rounded-2xl card-inset p-4 flex flex-col gap-3 border border-black/[0.05] dark:border-white/[0.06]">
                        <div class="flex items-center gap-2">
                            <i class="pi pi-address-book text-violet-500" />
                            <span class="font-semibold">Datos de contacto en el PDF</span>
                        </div>
                        <p class="text-sm text-surface-500 dark:text-surface-400 -mt-1">Aparecen en la cabecera y el pie del documento. Sólo se muestran los que rellenes.</p>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-medium">Email</label>
                                <InputText v-model="config.pdf_contact_email" class="w-full" :placeholder="config.email_from || 'contacto@tuempresa.com'" />
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-medium">Teléfono / WhatsApp</label>
                                <InputText v-model="config.pdf_contact_phone" class="w-full" :placeholder="config.email_whatsapp || '+34 600 123 456'" />
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-medium">Web</label>
                                <InputText v-model="config.pdf_contact_web" class="w-full" :placeholder="config.email_website || 'https://tuempresa.com'" />
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-medium">Dirección</label>
                                <InputText v-model="config.pdf_contact_address" class="w-full" placeholder="C/ Mayor, 12 — Ciudad" />
                            </div>
                        </div>
                    </div>

                    <!-- Conditions + footer -->
                    <div class="grid grid-cols-1 gap-3">
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Condiciones del presupuesto</label>
                            <Textarea v-model="config.pdf_conditions" rows="5" autoResize class="w-full text-sm" :placeholder="defaultConditionsPlaceholder" />
                            <small class="text-surface-400">Una condición por línea. Si lo dejas vacío se usan las condiciones estándar.</small>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-sm font-medium">Nota de pie de página</label>
                            <InputText v-model="config.pdf_footer_note" class="w-full" :placeholder="config.email_footer_note || 'Gracias por confiar en nosotros'" />
                        </div>
                    </div>

                    <div class="flex items-center gap-3">
                        <Button label="Guardar marca" icon="pi pi-save" @click="saveConfig" />
                        <Message v-if="saved" severity="success" :closable="false">Guardado correctamente</Message>
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
                    <CampoNumero v-model="editingPrinter.price_eur" :max-decimales="2" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Consumo (kWh)</label>
                    <CampoNumero v-model="editingPrinter.energy_consumption_kwh" :min-decimales="3" :max-decimales="3" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Vida útil (h)</label>
                    <CampoNumero v-model="editingPrinter.depreciation_time_h" :max-decimales="2" />
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-sm font-medium">Costes servicio (€)</label>
                    <CampoNumero v-model="editingPrinter.service_costs_life_eur" :max-decimales="2" />
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
                <CampoNumero v-model="editingMaterial.price_per_kg" :min-decimales="2" :max-decimales="2" />
            </div>
        </div>
        <template #footer>
            <Button label="Cancelar" severity="secondary" text @click="materialDialog = false" />
            <Button label="Guardar" icon="pi pi-check" @click="saveMaterial" />
        </template>
    </Dialog>
</template>
