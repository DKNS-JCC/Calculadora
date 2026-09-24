<script setup>
/* Campo numérico que acepta coma y punto como decimal.
 * Sustituye a InputNumber de PrimeVue, que en español ignora el punto, sin
 * maxFractionDigits no deja escribir decimales y en el móvil abre el teclado
 * sin separador. Mientras se escribe se emite el valor; al salir del campo
 * (o con Enter) se ajusta a min/max y se le da formato. */
import { ref, computed, watch, nextTick } from 'vue'
import InputText from 'primevue/inputtext'
import { parseNumero, formatNumero } from '../shared/formatos.mjs'

const props = defineProps({
    modelValue: { type: [Number, String], default: null },
    min: { type: Number, default: 0 },
    max: { type: Number, default: null },
    minDecimales: { type: Number, default: 0 },
    maxDecimales: { type: Number, default: 0 },
    unidad: { type: String, default: '' },
    disabled: Boolean,
    invalid: Boolean,
    placeholder: String,
    size: String,
    inputId: String,
    inputClass: [String, Object, Array],
})
const emit = defineEmits(['update:modelValue'])

const aNumero = (v) => (v == null || v === '' ? null : Number(v))
const formatear = (v) => formatNumero(aNumero(v), { minDecimales: props.minDecimales, maxDecimales: props.maxDecimales })

const texto = ref(formatear(props.modelValue))
const enfocado = ref(false)

watch(() => props.modelValue, (v) => {
    if (!enfocado.value) texto.value = formatear(v)
})

// Lo que se deja escribir: dígitos, un separador y como mucho maxDecimales
const patron = computed(() => {
    const signo = props.min != null && props.min < 0 ? '-?' : ''
    const decimales = props.maxDecimales > 0 ? `([.,]\\d{0,${props.maxDecimales}})?` : ''
    return new RegExp(`^${signo}\\d*${decimales}$`)
})
const esValido = (t) => patron.value.test(t.replace(/\s+/g, ''))

const ajustar = (n) => {
    let v = n
    if (props.min != null) v = Math.max(props.min, v)
    if (props.max != null) v = Math.min(props.max, v)
    return Number(v.toFixed(props.maxDecimales))
}

const onBeforeInput = (e) => {
    if (!e.inputType?.startsWith('insert') || e.inputType === 'insertFromPaste' || e.data == null) return
    const el = e.target
    const nuevo = el.value.slice(0, el.selectionStart) + e.data + el.value.slice(el.selectionEnd)
    if (!esValido(nuevo)) e.preventDefault()
}

// Pegar "12,5 g" o "Peso: 12.5": se queda solo con el número
const onPaste = (e) => {
    e.preventDefault()
    const pegado = (e.clipboardData?.getData('text') || '').replace(/[^\d.,-]/g, '')
    const n = parseNumero(pegado)
    if (n == null || Number.isNaN(n)) return
    const v = ajustar(n)
    texto.value = formatear(v)
    emit('update:modelValue', v)
}

const onTexto = async (valor) => {
    const t = String(valor ?? '')
    if (!esValido(t)) {
        // Red de seguridad para teclados que no respetan beforeinput
        const anterior = texto.value
        texto.value = t
        await nextTick()
        texto.value = anterior
        return
    }
    texto.value = t
    const n = parseNumero(t)
    if (n === null) emit('update:modelValue', null)
    else if (!Number.isNaN(n)) emit('update:modelValue', n)
}

const confirmar = () => {
    const n = parseNumero(texto.value)
    const v = n == null || Number.isNaN(n) ? null : ajustar(n)
    texto.value = formatear(v)
    if (v !== aNumero(props.modelValue)) emit('update:modelValue', v)
}

// Al entrar se selecciona todo para escribir encima. Chrome deshace la
// selección al soltar el clic que dio el foco, así que ese mouseup se anula.
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
    <div class="relative min-w-0">
        <InputText :modelValue="texto" @update:modelValue="onTexto"
            :id="inputId" :disabled="disabled" :invalid="invalid" :placeholder="placeholder" :size="size"
            :inputmode="maxDecimales > 0 ? 'decimal' : 'numeric'" autocomplete="off"
            class="w-full min-w-0" :class="inputClass"
            :style="unidad ? { paddingRight: `calc(1.25rem + ${unidad.length}ch)` } : null"
            @beforeinput="onBeforeInput" @paste="onPaste" @focus="onFocus" @mouseup="onMouseup" @blur="onBlur"
            @keydown.enter="confirmar" />
        <span v-if="unidad"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-surface-400 pointer-events-none select-none">{{ unidad }}</span>
    </div>
</template>
