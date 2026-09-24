<script setup>
import { onMounted, onUnmounted, computed, ref, defineAsyncComponent } from 'vue'
import { store } from './store'
import { api } from './platform'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import { checkForUpdate, downloadAndInstall, skipVersion } from './utils/androidUpdater'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import ProgressSpinner from 'primevue/progressspinner'
import Toast from 'primevue/toast'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import Login from './components/Login.vue'

/* Cada pestaña se descarga al abrirla. Login va estático porque es la
 * primera pantalla y no tiene sentido diferirlo. */
const Dashboard = defineAsyncComponent(() => import('./components/Dashboard.vue'))
const Calculator = defineAsyncComponent(() => import('./components/Calculator.vue'))
const Orders = defineAsyncComponent(() => import('./components/Orders.vue'))
const Inventory = defineAsyncComponent(() => import('./components/Inventory.vue'))
const Statistics = defineAsyncComponent(() => import('./components/Statistics.vue'))
const Configuration = defineAsyncComponent(() => import('./components/Configuration.vue'))

const toast = useToast()
const confirm = useConfirm()

const darkMode = ref(localStorage.getItem('darkMode') !== 'false')
const ghostLoading = ref(false)
const activeTab = ref('0')

/* Progreso de la descarga de la APK. Un toast de PrimeVue no vale: `toast.add`
 * no devuelve el mensaje, así que no hay forma de irle cambiando el porcentaje.
 * Con un ref y un aviso propio el número sí se mueve. */
const updateDownload = ref(null)   // { version, pct } | null

async function runAndroidUpdateFlow() {
    let result
    try {
        result = await checkForUpdate()
    } catch (e) {
        // El arranque calla los errores a propósito: sin cobertura o con
        // GitHub limitando peticiones, la app tiene que seguir funcionando.
        // La comprobación manual de Ajustes sí cuenta lo que pasa.
        console.warn('Update check failed', e)
        return
    }
    if (!result?.available) return

    confirm.require({
        header: 'Actualización disponible',
        message: `Versión ${result.version} (tienes la ${result.installed}).\n\n`
            + 'Se descarga y Android pedirá confirmación. Si sale un aviso de seguridad, '
            + 'pulsa «Instalar de todos modos»: va firmada con la misma clave y tus datos se mantienen.',
        acceptLabel: 'Actualizar',
        rejectLabel: 'Más tarde',
        accept: () => startUpdateDownload(result),
        reject: () => skipVersion(result.version),
    })
}

async function startUpdateDownload(result) {
    updateDownload.value = { version: result.version, pct: 0 }
    try {
        await downloadAndInstall(result.asset, (pct) => {
            if (updateDownload.value) updateDownload.value.pct = pct
        })
        updateDownload.value = null
        toast.add({
            severity: 'success',
            summary: 'Descarga lista',
            detail: 'Confirma la instalación en el diálogo del sistema.',
            life: 8000,
        })
    } catch (e) {
        updateDownload.value = null
        toast.add({
            severity: 'error',
            summary: 'No se pudo actualizar',
            detail: e.message || 'Falló la descarga de la APK.',
            life: 10000,
        })
    }
}

async function handleGhostToggle() {
    if (!store.isLoaded) return
    if (ghostLoading.value) return
    ghostLoading.value = true
    try {
        if (store.ghostMode) {
            await store.exitGhostMode()
        } else {
            await store.enterGhostMode()
        }
    } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: e.message, life: 4000 })
    } finally {
        ghostLoading.value = false
    }
}

function onKeyDown(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'G') {
        e.preventDefault()
        handleGhostToggle()
    }
}

const toggleDarkMode = () => {
    darkMode.value = !darkMode.value
    localStorage.setItem('darkMode', darkMode.value)
    document.documentElement.classList.toggle('dark', darkMode.value)
}

// Watch brand color and apply as CSS variable
import { watch } from 'vue'
// Al elegir "Usar en calculadora" en la bandeja web, saltar a la pestaña Calculadora
watch(() => store.pendingWebQuote, (v) => {
    if (v) activeTab.value = '1'
})

watch(() => store.appData?.global_config?.brand_color, (newColor) => {
    if (newColor) {
        document.documentElement.style.setProperty('--p-primary-color', newColor)
        // Also update the Tailwind primary if needed, but PrimeVue is priority
    }
}, { immediate: true })

const pendingOrdersCount = computed(() => {
    if (!store.isLoaded) return 0
    return store.appData.orders.filter(o =>
        !o.archived && ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'].includes(o.estado) &&
        Number(o.importe_pagado || 0) < Number(o.precio_final || 0)
    ).length
})
const showLogin = computed(() => store.authReady && !store.isAuthenticated)
const showApp = computed(() => store.authReady && store.isAuthenticated && store.isLoaded)
const showSpinner = computed(() => !store.authReady || (store.isAuthenticated && !store.isLoaded))

onMounted(async () => {
    window.addEventListener('keydown', onKeyDown)
    document.documentElement.classList.toggle('dark', darkMode.value)
    try {
        // Wait for Firebase Auth to resolve persisted session
        await store.initAuth()
        // If already authenticated (persisted session), load data
        if (store.isAuthenticated) {
            await store.loadApp()
        }
    } catch (e) {
        console.error('Failed to initialise app', e)
        await store.logout()
        toast.add({ severity: 'error', summary: 'Error de carga', detail: e.message, life: 8000 })
    }
    // Android sideload auto-update — no-op on Electron/web.
    runAndroidUpdateFlow()
})

function openFileFromToast(filePath) {
    if (filePath && api?.openFile) api.openFile(filePath)
}

function openFolderFromToast(filePath) {
    if (filePath && api?.showItemInFolder) api.showItemInFolder(filePath)
}

onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown)
})

async function onLoginSuccess({ uid, email, empresa }) {
    store.setSession(uid, email, empresa)
    try {
        await store.loadApp()
    } catch (e) {
        console.error('Failed to load app data after login', e)
        await store.logout()
        toast.add({ severity: 'error', summary: 'Error de carga', detail: e.message, life: 8000 })
    }
}
</script>

<template>
    <Toast>
        <template #message="{ message }">
            <div
                class="flex flex-col gap-1 w-full"
                :class="{ 'cursor-pointer': message.data?.filePath || message.data?.folderPath }"
                @click="message.data?.folderPath ? openFolderFromToast(message.data.folderPath) : (message.data?.filePath && openFileFromToast(message.data.filePath))"
            >
                <span class="font-semibold text-sm">{{ message.summary }}</span>
                <span class="text-xs opacity-80">{{ message.detail }}</span>
            </div>
        </template>
    </Toast>
    <ConfirmDialog />

    <!-- Descarga de la actualización de Android -->
    <div v-if="updateDownload"
        class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] w-[min(92vw,22rem)] rounded-2xl card px-4 py-3 shadow-lg">
        <div class="flex items-center justify-between text-xs font-medium">
            <span>Descargando {{ updateDownload.version }}…</span>
            <span class="tabular-nums text-surface-500">{{ Math.round(updateDownload.pct * 100) }}%</span>
        </div>
        <div class="h-1.5 mt-2 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
            <div class="h-full rounded-full bg-primary transition-[width] duration-200"
                :style="{ width: Math.max(2, updateDownload.pct * 100) + '%' }"></div>
        </div>
    </div>

    <!-- Loading spinner -->
    <div v-if="showSpinner" class="flex items-center justify-center h-screen bg-[#f5f5f7] dark:bg-[#0d0d0d]">
        <ProgressSpinner />
    </div>

    <!-- Login screen -->
    <Login v-else-if="showLogin" @login-success="onLoginSuccess" />

    <!-- Main app -->
    <div v-else-if="showApp" class="flex flex-col h-screen bg-[#f5f5f7] dark:bg-[#0d0d0d] text-surface-900 dark:text-surface-0">
        <Tabs v-model:value="activeTab" class="flex flex-col flex-1 overflow-hidden" :pt="{ root: { class: 'px-1' } }">
            <TabList class="shrink-0 backdrop-blur-xl bg-white/70 dark:bg-white/[0.04] border-b border-black/[0.06] dark:border-white/[0.07]">
                <Tab value="0">
                    <i class="pi pi-home mr-2" />Dashboard
                </Tab>
                <Tab value="1">
                    <i class="pi pi-calculator mr-2" />Calculadora
                </Tab>
                <Tab value="2">
                    <i class="pi pi-list mr-2" />Pedidos
                    <span v-if="pendingOrdersCount" class="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white leading-none">{{ pendingOrdersCount }}</span>
                    <span v-if="store.webQuotesCount && !store.ghostMode" class="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-500 text-white leading-none" v-tooltip.bottom="'Presupuestos web sin pedido'">{{ store.webQuotesCount }}</span>
                </Tab>
                <Tab value="3">
                    <i class="pi pi-box mr-2" />Inventario
                </Tab>
                <Tab value="4">
                    <i class="pi pi-chart-bar mr-2" />Estadísticas
                </Tab>
                <Tab value="5">
                    <i class="pi pi-cog mr-2" />Configuración
                </Tab>
                <div class="ml-auto self-center flex items-center gap-1 mr-1">
                    <Transition name="ghost-fade">
                        <div v-if="store.ghostMode || ghostLoading" class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/25 text-violet-500 dark:text-violet-400 text-[10px] font-medium select-none">
                            <i :class="ghostLoading ? 'pi pi-spin pi-spinner' : 'pi pi-eye'" class="text-[9px]" />
                            <span>{{ store.empresa }}</span>
                        </div>
                    </Transition>
                    <Button :icon="darkMode ? 'pi pi-sun' : 'pi pi-moon'" text size="small" rounded v-tooltip.bottom="darkMode ? 'Modo claro' : 'Modo oscuro'" @click="toggleDarkMode" class="mr-1" severity="secondary" />
                </div>
            </TabList>
            <TabPanels class="flex-1 overflow-auto p-4">
                <TabPanel value="0"><Dashboard /></TabPanel>
                <TabPanel value="1"><Calculator /></TabPanel>
                <TabPanel value="2"><Orders /></TabPanel>
                <TabPanel value="3"><Inventory /></TabPanel>
                <TabPanel value="4"><Statistics /></TabPanel>
                <TabPanel value="5"><Configuration @install-update="startUpdateDownload" /></TabPanel>
            </TabPanels>
        </Tabs>
    </div>
</template>

<style>
html, body, #app {
    height: 100%;
    margin: 0;
}

.ghost-fade-enter-active,
.ghost-fade-leave-active {
    transition: opacity 0.25s ease, transform 0.25s ease;
}
.ghost-fade-enter-from,
.ghost-fade-leave-to {
    opacity: 0;
    transform: scale(0.85);
}
</style>
