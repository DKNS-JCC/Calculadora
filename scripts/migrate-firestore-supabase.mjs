/**
 * Migración de datos Firestore → Supabase (fase 1 del plan de unificación).
 *
 * Lee empresas/{slug}/data/* y empresas/{slug}/orders/* de Firestore y los
 * vuelca en empresa_docs / orders de Supabase. Idempotente (upsert): se puede
 * ejecutar tantas veces como haga falta.
 *
 * Uso:
 *   node scripts/migrate-firestore-supabase.mjs --dry-run   # solo informe
 *   node scripts/migrate-firestore-supabase.mjs             # migra y verifica
 *
 * Variables de entorno necesarias:
 *   GOOGLE_APPLICATION_CREDENTIALS  ruta al JSON de service account de Firebase
 *                                   (Consola Firebase → Configuración → Cuentas
 *                                   de servicio → Generar nueva clave privada)
 *   SUPABASE_URL                    https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY       Dashboard → Settings → API → service_role
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createClient } from '@supabase/supabase-js'
import { normalizeData } from '../src/shared/backend.mjs'

const DRY_RUN = process.argv.includes('--dry-run')
const EMPRESAS = [
  { slug: '3dcc', nombre: '3DCC' },
  { slug: 'silab3d', nombre: 'SILAB3D' },
]
const DOCS = ['config', 'inventory', 'clients', 'calc_state']

function fail(msg) {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fail('Falta GOOGLE_APPLICATION_CREDENTIALS (ruta al JSON de service account de Firebase).')
}
if (!DRY_RUN && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  fail('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY.')
}

initializeApp({ credential: applicationDefault() })
const fs = getFirestore()
const supabase = DRY_RUN
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

const money = (v) => Math.round(Number(v || 0) * 100) / 100
const sum = (orders, field) => money(orders.reduce((a, o) => a + Number(o[field] || 0), 0))

/* ── Lectura Firestore ──────────────────────────────────────────────────── */

async function readEmpresa(slug) {
  const base = fs.collection('empresas').doc(slug)
  const docs = {}
  for (const d of DOCS) {
    const snap = await base.collection('data').doc(d).get()
    docs[d] = snap.exists ? snap.data() : null
  }
  const ordSnap = await base.collection('orders').get()
  const orders = []
  ordSnap.forEach((d) => orders.push({ id: d.id, ...d.data() }))
  return { docs, orders }
}

/* ── Transformación ─────────────────────────────────────────────────────── */

function transform(slug, { docs, orders }) {
  const cfg = docs.config || {}
  // normalizeData sanea pedidos (normalizeOrder) y rellena huecos igual que
  // hace la app al cargar. Mantiene los secretos de global_config tal cual:
  // el email/Stripe de escritorio siguen funcionando hasta la fase 3.
  const normalized = normalizeData({
    printers: cfg.printers,
    filament_types: cfg.filament_types,
    global_config: cfg.global_config,
    purge_config: cfg.purge_config,
    filament_stock: (docs.inventory || {}).filament_stock,
    calc_state: docs.calc_state,
    orders,
  })

  const cleanOrders = normalized.orders.map((o) => {
    const data = JSON.parse(JSON.stringify(o))
    delete data._fromPartner
    delete data._empresaOwner
    return data
  })

  return {
    docRows: [
      { empresa: slug, doc: 'config', data: {
        printers: normalized.printers,
        filament_types: normalized.filament_types,
        global_config: normalized.global_config,
        purge_config: normalized.purge_config,
      } },
      { empresa: slug, doc: 'inventory', data: { filament_stock: normalized.filament_stock } },
      { empresa: slug, doc: 'clients', data: { clients: (docs.clients || {}).clients || [] } },
      { empresa: slug, doc: 'calc_state', data: normalized.calc_state || {} },
    ],
    orderRows: cleanOrders.map((o) => ({ empresa: slug, id: String(o.id), data: o })),
    stats: {
      pedidos: cleanOrders.length,
      clientes: ((docs.clients || {}).clients || []).length,
      stock: (normalized.filament_stock || []).length,
      sum_precio_final: sum(cleanOrders, 'precio_final'),
      sum_importe_pagado: sum(cleanOrders, 'importe_pagado'),
    },
  }
}

/* ── Escritura Supabase ─────────────────────────────────────────────────── */

async function writeEmpresa({ docRows, orderRows }) {
  {
    const { error } = await supabase.from('empresa_docs').upsert(docRows, { onConflict: 'empresa,doc' })
    if (error) fail(`upsert empresa_docs: ${error.message}`)
  }
  for (let i = 0; i < orderRows.length; i += 500) {
    const chunk = orderRows.slice(i, i + 500)
    const { error } = await supabase.from('orders').upsert(chunk, { onConflict: 'empresa,id' })
    if (error) fail(`upsert orders (bloque ${i / 500 + 1}): ${error.message}`)
  }
}

/* ── Verificación ───────────────────────────────────────────────────────── */

async function verifyEmpresa(slug, stats) {
  const back = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('orders').select('id, data').eq('empresa', slug).range(from, from + 999)
    if (error) fail(`releyendo orders de ${slug}: ${error.message}`)
    back.push(...data.map((r) => r.data))
    if (data.length < 1000) break
  }
  const { data: docsBack, error: docsErr } = await supabase
    .from('empresa_docs').select('doc').eq('empresa', slug)
  if (docsErr) fail(`releyendo docs de ${slug}: ${docsErr.message}`)

  const checks = [
    ['docs presentes', docsBack.length, 4],
    ['nº pedidos', back.length, stats.pedidos],
    ['Σ precio_final', sum(back, 'precio_final'), stats.sum_precio_final],
    ['Σ importe_pagado', sum(back, 'importe_pagado'), stats.sum_importe_pagado],
  ]
  let ok = true
  for (const [name, got, want] of checks) {
    const match = got === want
    ok = ok && match
    console.log(`   ${match ? '✔' : '✖'} ${name}: ${got}${match ? '' : ` (esperado ${want})`}`)
  }
  return ok
}

/* ── Main ───────────────────────────────────────────────────────────────── */

console.log(`Migración Firestore → Supabase ${DRY_RUN ? '(DRY RUN — no se escribe nada)' : ''}\n`)
let allOk = true

for (const { slug, nombre } of EMPRESAS) {
  console.log(`── ${nombre} (${slug}) ──────────────────────────────`)
  const raw = await readEmpresa(slug)
  const t = transform(slug, raw)
  console.log(`   Firestore: ${t.stats.pedidos} pedidos, ${t.stats.clientes} clientes, ${t.stats.stock} bobinas en stock`)
  console.log(`   Σ precio_final = ${t.stats.sum_precio_final} € · Σ importe_pagado = ${t.stats.sum_importe_pagado} €`)

  if (!DRY_RUN) {
    await writeEmpresa(t)
    console.log('   Escrito en Supabase. Verificando…')
    allOk = (await verifyEmpresa(slug, t.stats)) && allOk
  }
  console.log('')
}

if (DRY_RUN) {
  console.log('DRY RUN completado. Ejecuta sin --dry-run para migrar.')
} else if (allOk) {
  console.log('✔ Migración completada y verificada: los totales coinciden al céntimo.')
} else {
  fail('La verificación ha detectado diferencias. NO publiques la app; revisa antes.')
}
process.exit(allOk ? 0 : 1)
