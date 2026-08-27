import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Reactivo a una media query. Se usa para *no montar* la variante que no toca
 * (tabla de escritorio vs. lista de tarjetas), en vez de esconderla con CSS:
 * en móvil la DataTable de Pedidos son 10 columnas de DOM que no se ven.
 */
export function useMediaQuery(query) {
    const matches = ref(false)
    let mql = null
    const update = () => { matches.value = !!mql?.matches }

    onMounted(() => {
        if (!window.matchMedia) return
        mql = window.matchMedia(query)
        update()
        mql.addEventListener('change', update)
    })
    onUnmounted(() => mql?.removeEventListener('change', update))

    return matches
}

/** Por debajo de `lg` (1024px): móvil y tablet en vertical.
 *  La tabla de Pedidos necesita 50rem, así que por debajo de eso no cabe
 *  sin scroll lateral y se sirve la lista de tarjetas. */
export function useIsHandheld() {
    return useMediaQuery('(max-width: 1023px)')
}
