/**
 * Lectura y formato de números escritos a mano en los formularios.
 *
 * Coma y punto valen los dos como separador decimal ("12,5" = "12.5"), así
 * que no se admiten separadores de miles: "1.250" es 1,25, no 1250. Por eso
 * los números se muestran siempre sin agrupar.
 *
 * Módulo puro: lo usan los componentes, los tickets de backend.mjs y los PDF
 * del proceso main de Electron.
 */

const NUMERO = /^-?(\d+([.,]\d*)?|[.,]\d+)$/

/** "12,5" / "12.5" → 12.5 · vacío → null · no numérico → NaN */
export function parseNumero(texto) {
  const t = String(texto ?? '').replace(/\s+/g, '')
  if (!t) return null
  if (!NUMERO.test(t)) return NaN
  return Number(t.replace(',', '.'))
}

export function formatNumero(valor, { minDecimales = 0, maxDecimales = 2 } = {}) {
  if (valor == null || valor === '') return ''
  const n = Number(valor)
  if (!Number.isFinite(n)) return ''
  return new Intl.NumberFormat('es-ES', {
    useGrouping: false,
    minimumFractionDigits: minDecimales,
    maximumFractionDigits: Math.max(minDecimales, maxDecimales),
  }).format(n)
}

const UNIDAD_TIEMPO = {
  d: 24, dia: 24, dias: 24, día: 24, días: 24, day: 24, days: 24,
  h: 1, hr: 1, hrs: 1, hora: 1, horas: 1, hour: 1, hours: 1,
  m: 1 / 60, min: 1 / 60, mins: 1 / 60, minuto: 1 / 60, minutos: 1 / 60, minute: 1 / 60, minutes: 1 / 60,
  s: 1 / 3600, seg: 1 / 3600, segundo: 1 / 3600, segundos: 1 / 3600, sec: 1 / 3600, secs: 1 / 3600, second: 1 / 3600, seconds: 1 / 3600,
}

/**
 * Duración en horas decimales a partir de lo que se escribe o se copia del
 * laminador: "2,5" · "2.5" · "2:30" · "2:30:15" · "2h 30m" · "2h30" ·
 * "1d 2h 30m" · "150 min". Vacío → null · no reconocido → NaN.
 */
export function parseHoras(texto) {
  const t = String(texto ?? '').trim().toLowerCase()
  if (!t) return null

  const numero = parseNumero(t)
  if (!Number.isNaN(numero)) return numero

  const reloj = t.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/)
  if (reloj) return Number(reloj[1]) + Number(reloj[2]) / 60 + Number(reloj[3] || 0) / 3600

  const token = /\s*(\d+(?:[.,]\d+)?)\s*([a-záéíóú]*)\s*/y
  let total = 0
  let unidadAnterior = null
  let pos = 0
  while (pos < t.length) {
    token.lastIndex = pos
    const m = token.exec(t)
    if (!m) return NaN
    pos = token.lastIndex
    const n = Number(m[1].replace(',', '.'))
    let factor = UNIDAD_TIEMPO[m[2]]
    // "2h30": un número suelto al final detrás de las horas son minutos
    if (!m[2] && unidadAnterior === 1 && pos >= t.length) factor = 1 / 60
    if (factor == null) return NaN
    total += n * factor
    unidadAnterior = factor
  }
  return total
}

/** 2.5 → "2 h 30 min" · 0.75 → "45 min" · 3 → "3 h" (redondeado al minuto) */
export function formatHoras(horas) {
  if (horas == null || horas === '') return ''
  const n = Number(horas)
  if (!Number.isFinite(n)) return ''
  const totalMin = Math.round(n * 60)
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  if (!min) return `${h} h`
  return h ? `${h} h ${min} min` : `${min} min`
}
