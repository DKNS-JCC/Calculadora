<script setup>
/* Campo de duración. Entiende lo que se escribe o se copia del laminador
 * ("2,5", "2.5", "2:30", "2h 30m", "150 min"…), enseña debajo la
 * equivalencia mientras se escribe y al salir se reescribe como "2 h 30 min".
 * El modelo sigue siendo horas decimales. */
import { ref, computed, watch } from 'vue'
import InputText from 'primevue/inputtext'
import { parseHoras, formatHoras } from '../shared/formatos.mjs'

const props = defineProps({
    modelValue: { type: [Number, String], default: null },
    min: { type: Number, default: 0 },
    disabled: Boolean,
    invalid: Boolean,
    placeholder: { type: String, default: '2h 30m · 2:30 · 2,5' },
    size: String,
    inputId: String,
})
const emit = defineEmits(['update:modelValue'])

const aNumero = (v) => (v == null || v === '' ? null : Number(v))

const texto = ref(formatHoras(props.modelValue))
const enfocado = ref(false)
const editado = ref(false)

watch(() => props.modelValue, (v) => {
    if (!enfocado.value) texto.value = formatHoras(v)
})

const leido = computed(() => {
    const h = parseHoras(texto.value)
    return h == null || Number.isNaN(h) ? h : Math.max(props.min, h)
})

const pista = computed(() => {
    if (!enfocado.value || !editado.value || leido.value == null) return null
    if (Number.isNaN(leido.value)) return { error: true, texto: 'No reconocido. Prueba 2h 30m, 2:30 o 2,5' }
    return { error: false, texto: `= ${formatHoras(leido.value)}` }
})

const onTexto = (valor) => {
    texto.value = String(valor ?? '')
    editado.value = true
    const h = leido.value
    if (h === null) emit('update:modelValue', null)
    else if (!Number.isNaN(h)) emit('update:modelValue', h)
}

// Si el texto no se entiende, se vuelve al último valor válido
const confirmar = () => {
    const h = editado.value ? leido.value : aNumero(props.modelValue)
    texto.value = formatHoras(Number.isNaN(h) ? props.modelValue : h)
    editado.value = false
}

// Igual que en CampoNumero: seleccionar todo y anular el mouseup del clic
let soltarTrasFoco = false
const onFocus = (e) => {
    enfocado.value = true
    e.target.select()
    soltarTrasFoco = true
}
const onMouseup = (e) => {
    if (soltarTrasFoco) e.preventDefault()
    soltarTrasFoco = false
}
const onBlur = () => {
    enfocado.value = false
    confirmar()
}
</script>

<template>
    <div class="flex flex-col gap-1 min-w-0">
        <InputText :modelValue="texto" @update:modelValue="onTexto"
            :id="inputId" :disabled="disabled" :invalid="invalid || !!pista?.error" :placeholder="placeholder" :size="size"
            autocomplete="off" class="w-full min-w-0"
            @focus="onFocus" @mouseup="onMouseup" @blur="onBlur" @keydown.enter="confirmar" />
        <small v-if="pista" class="text-xs" :class="pista.error ? 'text-red-500' : 'text-surface-400'">{{ pista.texto }}</small>
    </div>
</template>
