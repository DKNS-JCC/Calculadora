<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Chart from 'primevue/chart'
import Panel from 'primevue/panel'

const props = defineProps({
    title: { type: String, default: '' },
    type: { type: String, default: 'bar' },
    data: { type: Object, default: null },
    options: { type: Object, default: () => ({}) },
    height: { type: String, default: '320px' },
    toggleable: { type: Boolean, default: true }
})

const wrapper = ref(null)
const chartComp = ref(null)
let observer = null

const mergedOptions = computed(() => ({
    ...props.options,
    responsive: true,
    maintainAspectRatio: false
}))

const refresh = () => {
    const instance = chartComp.value?.chart
    if (instance) instance.resize()
}

onMounted(() => {
    if (wrapper.value) {
        observer = new ResizeObserver(() => refresh())
        observer.observe(wrapper.value)
    }
})

onUnmounted(() => {
    observer?.disconnect()
})
</script>

<template>
    <Panel :header="title" :toggleable="toggleable" class="h-full"
        :pt="{ root: { class: 'card rounded-2xl border-0 overflow-hidden' }, header: { class: '!bg-transparent border-b border-black/[0.05] dark:border-white/[0.06] px-4 py-3' }, content: { class: '!bg-transparent p-4' } }">
        <div ref="wrapper" class="relative w-full overflow-hidden" :style="{ height }">
            <Chart
                v-if="data && data.labels?.length"
                ref="chartComp"
                :type="type"
                :data="data"
                :options="mergedOptions"
            />
            <div v-else class="flex items-center justify-center h-full text-surface-400 text-sm">
                <i class="pi pi-chart-bar mr-2 text-lg" />
                <span>Sin datos disponibles</span>
            </div>
        </div>
    </Panel>
</template>

<style scoped>
:deep(.p-chart) {
    width: 100% !important;
    height: 100% !important;
}
</style>
