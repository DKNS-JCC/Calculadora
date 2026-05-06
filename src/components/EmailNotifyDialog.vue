<script setup>
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import InputText from 'primevue/inputtext'

const props = defineProps({
    visible: { type: Boolean, default: false },
    order: { type: Object, default: null },
    oldStatus: { type: String, default: '' },
    newStatus: { type: String, default: '' },
    recipientEmail: { type: String, default: '' },
    title: { type: String, default: '' },
})

const emit = defineEmits(['update:visible', 'confirm', 'skip', 'cancel', 'update:recipientEmail'])

const emailModel = computed({
    get: () => props.recipientEmail,
    set: (v) => emit('update:recipientEmail', v),
})

const STATUS_BADGE = {
    'Presupuesto enviado': { sev: 'info', icon: 'pi-send', color: '#3b82f6' },
    'Aceptado': { sev: 'success', icon: 'pi-check-circle', color: '#10b981' },
    'En producción': { sev: 'warn', icon: 'pi-cog', color: '#f59e0b' },
    'Post-procesado': { sev: 'help', icon: 'pi-sparkles', color: '#8b5cf6' },
    'Listo para entregar': { sev: 'info', icon: 'pi-box', color: '#0ea5e9' },
    'Entregado': { sev: 'success', icon: 'pi-check', color: '#059669' },
}
const newBadge = computed(() => STATUS_BADGE[props.newStatus] || { sev: 'secondary', icon: 'pi-circle', color: '#6b7280' })
const oldBadge = computed(() => STATUS_BADGE[props.oldStatus] || { sev: 'secondary', icon: 'pi-circle', color: '#9ca3af' })

const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(emailModel.value || '').trim()))
const headerTitle = computed(() => props.title || 'Notificar al cliente por email')

const onCancel = () => emit('cancel')
const onSkip = () => emit('skip')
const onConfirm = () => { if (emailValid.value) emit('confirm') }

const close = () => emit('update:visible', false)
</script>

<template>
    <Dialog
        :visible="visible"
        @update:visible="(v) => $emit('update:visible', v)"
        modal
        :closable="false"
        :style="{ width: 'min(92vw, 30rem)' }"
        :pt="{ root: { class: 'rounded-2xl overflow-hidden' }, content: { class: '!p-0' }, header: { class: '!hidden' } }"
    >
        <!-- Header band -->
        <div class="px-6 pt-6 pb-4 bg-gradient-to-br from-blue-500/10 via-violet-500/10 to-pink-500/5 dark:from-blue-500/15 dark:via-violet-500/15 dark:to-pink-500/10 border-b border-black/[0.05] dark:border-white/[0.06]">
            <div class="flex items-start gap-3">
                <div class="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 text-white shrink-0 shadow-md shadow-blue-500/20">
                    <i class="pi pi-envelope text-base" />
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-bold text-surface-900 dark:text-surface-0 text-base">{{ headerTitle }}</div>
                    <div class="text-xs text-surface-500 dark:text-surface-300 mt-0.5">
                        Vamos a notificar al cliente del cambio de estado y adjuntaremos el PDF del presupuesto.
                    </div>
                </div>
            </div>
        </div>

        <!-- Body -->
        <div class="px-6 py-5 flex flex-col gap-4">
            <!-- Order summary -->
            <div v-if="order" class="rounded-xl bg-surface-50 dark:bg-surface-800/40 border border-black/[0.04] dark:border-white/[0.06] px-4 py-3 flex items-center justify-between text-sm">
                <div class="flex flex-col gap-0.5 min-w-0">
                    <span class="text-[10px] uppercase tracking-wider text-surface-400 font-semibold">Pedido</span>
                    <span class="font-mono font-bold text-surface-900 dark:text-surface-0">#{{ order.id }}</span>
                </div>
                <div class="flex flex-col gap-0.5 text-right min-w-0">
                    <span class="text-[10px] uppercase tracking-wider text-surface-400 font-semibold">Cliente</span>
                    <span class="font-semibold truncate max-w-[12rem]" :title="order.cliente">{{ order.cliente || '—' }}</span>
                </div>
            </div>

            <!-- Status transition -->
            <div class="flex items-center justify-center gap-2 py-1">
                <Tag v-if="oldStatus" :value="oldStatus" :severity="oldBadge.sev" class="text-[10px] !opacity-60" />
                <i v-if="oldStatus" class="pi pi-arrow-right text-surface-400 text-xs mx-1" />
                <Tag :value="newStatus" :severity="newBadge.sev" class="text-[11px] font-bold" :pt="{ root: { style: 'box-shadow:0 0 0 3px ' + newBadge.color + '20' } }" />
            </div>

            <!-- Recipient email -->
            <div class="flex flex-col gap-1.5">
                <label class="text-[10px] text-surface-500 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                    <i class="pi pi-at text-[10px]" />
                    Destinatario
                </label>
                <InputText v-model="emailModel" type="email" class="w-full" :invalid="!emailValid" />
                <small v-if="!emailValid && emailModel" class="text-red-500 flex items-center gap-1">
                    <i class="pi pi-exclamation-triangle text-[10px]" />
                    El email no parece válido
                </small>
                <small v-else-if="!emailValid" class="text-amber-500">Falta el email del cliente</small>
                <small v-else class="text-surface-400 flex items-center gap-1">
                    <i class="pi pi-paperclip text-[10px]" />
                    Se adjuntará el PDF del presupuesto cliente
                </small>
            </div>
        </div>

        <!-- Actions -->
        <div class="px-6 py-4 border-t border-black/[0.04] dark:border-white/[0.06] bg-surface-50 dark:bg-surface-800/40 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
            <Button
                label="Cancelar"
                icon="pi pi-times"
                severity="danger"
                text
                size="small"
                @click="onCancel"
                v-tooltip.top="'Aborta el guardado para que puedas corregir el destinatario'"
            />
            <div class="flex items-center gap-2">
                <Button
                    label="Saltar envío"
                    icon="pi pi-forward"
                    severity="secondary"
                    outlined
                    size="small"
                    @click="onSkip"
                    v-tooltip.top="'Guarda el cambio sin notificar al cliente'"
                />
                <Button
                    label="Enviar email"
                    icon="pi pi-send"
                    severity="info"
                    size="small"
                    :disabled="!emailValid"
                    @click="onConfirm"
                />
            </div>
        </div>
    </Dialog>
</template>
