<script setup>
import { onMounted, onUnmounted, computed, ref } from 'vue'
import { store } from './store'
import { api } from './platform'
import { useToast } from 'primevue/usetoast'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import ProgressSpinner from 'primevue/progressspinner'
import Toast from 'primevue/toast'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import Calculator from './components/Calculator.vue'
import Orders from './components/Orders.vue'
import Inventory from './components/Inventory.vue'
import Statistics from './components/Statistics.vue'
import Configuration from './components/Configuration.vue'
import Login from './components/Login.vue'

const toast = useToast()

const darkMode = ref(localStorage.getItem('darkMode') !== 'false')
const ghostLoading = ref(false)

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

const pendingOrdersCount = computed(() => {
    if (!store.isLoaded) return 0
    return store.appData.orders.filter(o =>
        !o.archived && ['Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'].includes(o.estado) &&
        Number(o.importe_pagado || 0) < Number(o.precio_final || 0)
    ).length
})
const lowStockCount = computed(() => {
    if (!store.isLoaded) return 0
    return store.appData.filament_stock.filter(s =>
        Number(s.remaining_g || 0) <= Number(s.buy_threshold_g || 0)
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

    <!-- Loading spinner -->
    <div v-if="showSpinner" class="flex items-center justify-center h-screen bg-[#f5f5f7] dark:bg-[#0d0d0d]">
        <ProgressSpinner />
    </div>

    <!-- Login screen -->
    <Login v-else-if="showLogin" @login-success="onLoginSuccess" />

    <!-- Main app -->
    <div v-else-if="showApp" class="flex flex-col h-screen bg-[#f5f5f7] dark:bg-[#0d0d0d] text-surface-900 dark:text-surface-0">
        <Tabs value="0" class="flex flex-col flex-1 overflow-hidden" :pt="{ root: { class: 'px-1' } }">
            <TabList class="shrink-0 backdrop-blur-xl bg-white/70 dark:bg-white/[0.04] border-b border-black/[0.06] dark:border-white/[0.07]">
                <Tab value="0">
                    <i class="pi pi-calculator mr-2" />Calculadora
                </Tab>
                <Tab value="1">
                    <i class="pi pi-list mr-2" />Pedidos
                    <span v-if="pendingOrdersCount" class="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white leading-none">{{ pendingOrdersCount }}</span>
                </Tab>
                <Tab value="2">
                    <i class="pi pi-box mr-2" />Inventario
                    <span v-if="lowStockCount" class="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-500 text-white leading-none">{{ lowStockCount }}</span>
                </Tab>
                <Tab value="3">
                    <i class="pi pi-chart-bar mr-2" />Estadísticas
                </Tab>
                <Tab value="4">
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
                <TabPanel value="0"><Calculator /></TabPanel>
                <TabPanel value="1"><Orders /></TabPanel>
                <TabPanel value="2"><Inventory /></TabPanel>
                <TabPanel value="3"><Statistics /></TabPanel>
                <TabPanel value="4"><Configuration /></TabPanel>
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
