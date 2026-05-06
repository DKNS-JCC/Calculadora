const crypto = require('crypto');
const Stripe = require('stripe');

const DISENO_MODELADO = {
  'No necesario': 0,
  'Chorrada - En Slicer': 0.15,
  "Fácil - Fusión 30'": 1/3,
  "Medio - Fusión 60'": 2/3,
  'Avanzado - AI + Remesh': 1,
};

const BUSQUEDA_MODELOS = {
  No: 0,
  'Sí': 0.25,
};

const ELIMINACION_SOPORTES = {
  No: 0,
  'Pocos / Baja dificultad': 15,
  'Muchos / Elevada dificultad': 25,
};

const POSTPROCESADO = {
  No: 0,
  'Sencillo (Lijado ligero)': 15,
  'Medio (Lijado + Ensamblado)': 40,
  'Complejo (Lijado + Pintura)': 75,
};

const PROBABILIDAD_ERROR = {
  Baja: 0.25,
  Media: 1,
  Alta: 2,
};

const MARKUP = {
  'Normal (230%)': 2.3,
};

const URGENCIA = {
  Normal: 0,
  Urgente: 0.5,
};

const ORDER_LIFECYCLE = [
  'Presupuesto enviado',
  'Aceptado',
  'En producción',
  'Post-procesado',
  'Listo para entregar',
  'Entregado',
];

function normalizeEstado(value) {
  const v = String(value || '').trim();
  if (!v) return 'Presupuesto enviado';
  if (v === 'Enviado') return 'Presupuesto enviado';
  if (ORDER_LIFECYCLE.includes(v)) return v;
  return v;
}

function createDefaultData() {
  return {
    printers: [
      {
        name: 'Creality K1SE Combo',
        material_diameter_mm: 1.75,
        price_eur: 738,
        depreciation_time_h: 3000,
        service_costs_life_eur: 100,
        energy_consumption_kwh: 0.15,
      },
    ],
    filament_types: [
      { name: 'PLA', price_per_kg: 20 },
      { name: 'PETG', price_per_kg: 18 },
      { name: 'PLA SILK/MARBLE', price_per_kg: 23 },
      { name: 'ASA', price_per_kg: 24 },
      { name: 'TPU', price_per_kg: 21 },
    ],
    filament_stock: [
      { material: 'PLA', color: 'Negro', remaining_g: 1000, buy_threshold_g: 150 },
      { material: 'PLA', color: 'Blanco', remaining_g: 1000, buy_threshold_g: 150 },
      { material: 'PETG', color: 'Transparente', remaining_g: 1000, buy_threshold_g: 150 },
    ],
    global_config: {
      energy_cost_kwh: 0.24,
      labor_cost_h: 15,
      money_unit: '€',
      precio_minimo: 3,
      stripe_secret_key: '',
      stripe_success_url: 'https://example.com/pago-exitoso',
      stripe_cancel_url: 'https://example.com/pago-cancelado',
      pdf_default_path: '',
      email_enabled: false,
      email_from: '',
      email_app_password: '',
      email_sender_name: '',
      email_reply_to: '',
      email_whatsapp: '',
      email_instagram: '',
      email_website: '',
      email_footer_note: '',
    },
    calc_state: {
      empresa: '3DCC',
      cliente: '',
      descripcion: '',
      impresora: 'Creality K1SE Combo',
      filamento_tipo: 'PLA',
      filamento_color: 'Negro',
      is_multimaterial: false,
      material_breakdown: [],
      peso_g: '50',
      tiempo_h: '1',
      diseno_modelado: 'No necesario',
      busqueda_modelos: 'No',
      eliminacion_soportes: 'No',
      deterioro_impresora: 'Autofinanciación',
      postprocesado: 'No',
      probabilidad_error: 'Baja',
      markup: 'Normal (230%)',
      urgencia_nivel: 'Normal',
      gasto_misc: 0,
    },
    orders: [],
    purge_config: { colors: [], values: [], active_by_printer: {} },
  };
}

function normalizeData(raw) {
  const defaults = createDefaultData();
  const data = {
    ...defaults,
    ...(raw || {}),
  };

  if (!Array.isArray(data.printers) || data.printers.length === 0) data.printers = defaults.printers;
  if (!Array.isArray(data.filament_types) || data.filament_types.length === 0) data.filament_types = defaults.filament_types;
  if (!Array.isArray(data.filament_stock) || data.filament_stock.length === 0) data.filament_stock = defaults.filament_stock;
  if (!Array.isArray(data.orders)) data.orders = [];
  data.orders = data.orders.map((order) => normalizeOrder(order));

  data.global_config = { ...defaults.global_config, ...(data.global_config || {}) };
  data.calc_state = { ...defaults.calc_state, ...(data.calc_state || {}) };

  if (!data.purge_config || typeof data.purge_config !== 'object') data.purge_config = { colors: [], values: [], active_by_printer: {} };
  if (!Array.isArray(data.purge_config.colors)) data.purge_config.colors = [];
  if (!Array.isArray(data.purge_config.values)) data.purge_config.values = [];
  if (!data.purge_config.active_by_printer || typeof data.purge_config.active_by_printer !== 'object') data.purge_config.active_by_printer = {};

  if (data.calc_state.fecha) data.calc_state.fecha = normalizeDate(data.calc_state.fecha);
  data.calc_state.empresa = data.calc_state.empresa || '3DCC';
  data.calc_state.markup = MARKUP[data.calc_state.markup] ? data.calc_state.markup : 'Normal (230%)';
  const probErrorKey = String(data.calc_state.probabilidad_error ?? '');
  data.calc_state.probabilidad_error = Object.prototype.hasOwnProperty.call(PROBABILIDAD_ERROR, probErrorKey)
    ? probErrorKey
    : 'Baja';
  data.calc_state.urgencia_nivel = URGENCIA[data.calc_state.urgencia_nivel] !== undefined
    ? data.calc_state.urgencia_nivel
    : 'Normal';

  return data;
}

function normalizeDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parts = str.split('/');
  if (parts.length === 3) {
    const [d, m, y] = parts.map(Number);
    if (y > 1000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return str;
}

function paymentStatusFromOrder(order) {
  const total = roundMoney(order.precio_final || 0);
  const paid = roundMoney(order.importe_pagado || 0);
  if (paid <= 0) return 'Pendiente';
  if (paid >= total) return 'Pagado';
  return 'Parcial';
}

function refreshOrderPaymentFields(order) {
  order.precio_final = roundMoney(order.precio_final || 0);
  order.importe_pagado = roundMoney(order.importe_pagado || 0);
  order.importe_pendiente = roundMoney(Math.max(0, order.precio_final - order.importe_pagado));
  order.payment_status = paymentStatusFromOrder(order);
  return order;
}

function normalizeOrder(input) {
  const order = {
    ...input,
    id: String(input?.id || crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()),
    fecha: normalizeDate(String(input?.fecha || '')),
    empresa: String(input?.empresa || '3DCC'),
    cliente: String(input?.cliente || ''),
    descripcion: String(input?.descripcion || ''),
    impresora: String(input?.impresora || ''),
    filamento: String(input?.filamento || ''),
    filamento_color: String(input?.filamento_color || ''),
    peso_g: String(input?.peso_g ?? '0'),
    horas: String(input?.horas ?? '0'),
    cantidad: Math.max(1, Math.floor(Number(input?.cantidad) || 1)),
    precio_final: roundMoney(input?.precio_final || 0),
    coste_bruto: roundMoney(input?.coste_bruto || 0),
    beneficio_neto: roundMoney(input?.beneficio_neto || 0),
    markup: Number(input?.markup || 2.3),
    error_rate: Number(input?.error_rate || 0.5),
    urgencia_nivel: String(input?.urgencia_nivel || 'Normal'),
    urgencia_rate: Number(input?.urgencia_rate || 0),
    recargo_urgencia: roundMoney(input?.recargo_urgencia || 0),
    stripe_payment_url: String(input?.stripe_payment_url || ''),
    stripe_session_id: String(input?.stripe_session_id || ''),
    importe_pagado: roundMoney(input?.importe_pagado || 0),
    estado: normalizeEstado(input?.estado),
    cliente_email: String(input?.cliente_email || '').trim(),
    notif_history: Array.isArray(input?.notif_history) ? input.notif_history : [],
    is_multimaterial: !!input?.is_multimaterial,
    material_breakdown: Array.isArray(input?.material_breakdown) ? input.material_breakdown : [],
    material_contabilizado: !!input?.material_contabilizado,
    gasto_misc: roundMoney(input?.gasto_misc || 0),
    diseno_modelado: String(input?.diseno_modelado || 'No necesario'),
    busqueda_modelos: String(input?.busqueda_modelos || 'No'),
    eliminacion_soportes: String(input?.eliminacion_soportes || 'No'),
    postprocesado_label: String(input?.postprocesado_label || 'No'),
    probabilidad_error_label: String(input?.probabilidad_error_label || 'Baja'),
    markup_label: String(input?.markup_label || 'Normal (230%)'),
    is_shared: !!input?.is_shared,
    shared_split: (input?.is_shared && input?.shared_split && typeof input.shared_split === 'object')
      ? (() => { const a = Math.max(0, Math.min(100, Number(input.shared_split['3DCC'] ?? 50))); return { '3DCC': a, 'SILAB3D': 100 - a } })()
      : null,
    payment_method: String(input?.payment_method || ''),
    notes: String(input?.notes || ''),
    repeticiones_error: Math.max(0, Math.floor(Number(input?.repeticiones_error) || 0)),
    imagen_path: String(input?.imagen_path || ''),
    archived: !!input?.archived,
    payment_history: Array.isArray(input?.payment_history)
      ? input.payment_history.map((p) => ({
        id: String(p?.id || crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()),
        created_at: String(p?.created_at || new Date().toISOString()),
        method: String(p?.method || 'Manual'),
        amount: roundMoney(p?.amount || 0),
        note: String(p?.note || ''),
        source: String(p?.source || 'manual'),
      }))
      : [],
  };

  return refreshOrderPaymentFields(order);
}



function getDepreciationPerHour(printer) {
  const hours = Number(printer.depreciation_time_h || 0);
  if (hours <= 0) return 0;
  return (Number(printer.price_eur || 0) + Number(printer.service_costs_life_eur || 0)) / hours;
}

function calculateCost({
  peso_g,
  horas,
  filament_price_per_kg,
  printer,
  gconfig,
  diseno_str,
  busqueda_str,
  soportes_str,
  postproc_str,
}) {
  const filamento = (peso_g * filament_price_per_kg) / 1000;
  const electricidad = horas * Number(printer.energy_consumption_kwh || 0) * Number(gconfig.energy_cost_kwh || 0);
  const diseno = (DISENO_MODELADO[diseno_str] || 0) * Number(gconfig.labor_cost_h || 0);
  const busqueda = (BUSQUEDA_MODELOS[busqueda_str] || 0) * Number(gconfig.labor_cost_h || 0);
  const soportes = ((ELIMINACION_SOPORTES[soportes_str] || 0) / 60) * Number(gconfig.labor_cost_h || 0);
  const deterioro = horas * getDepreciationPerHour(printer);
  const postproc = ((POSTPROCESADO[postproc_str] || 0) / 60) * Number(gconfig.labor_cost_h || 0);

  return {
    filamento: round4(filamento),
    electricidad: round4(electricidad),
    diseno_modelado: round4(diseno),
    busqueda_modelos: round4(busqueda),
    eliminacion_soportes: round4(soportes),
    deterioro_impresora: round4(deterioro),
    postprocesado: round4(postproc),
  };
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function roundUpToNickel(value) {
  const amount = Math.max(0, Number(value || 0));
  return Math.ceil((amount + Number.EPSILON) / 0.05) * 0.05;
}

function subtotalAfectableError(bd) {
  return bd.filamento + bd.electricidad + bd.deterioro_impresora;
}

function subtotalNoAfectableError(bd) {
  return bd.diseno_modelado + bd.busqueda_modelos + bd.eliminacion_soportes + bd.postprocesado;
}

function subtotal(bd) {
  return subtotalAfectableError(bd) + subtotalNoAfectableError(bd);
}

function conError(bd, errorRate) {
  const bruto = subtotalAfectableError(bd);
  const resto = subtotalNoAfectableError(bd);
  return bruto * (1 + errorRate) + resto;
}

function subtotalTrasMarkup(bd, errorRate, markup) {
  const bruto = subtotalAfectableError(bd);
  const resto = subtotalNoAfectableError(bd);
  return (bruto * markup) + (bruto * errorRate) + resto;
}

function precioFinal(bd, errorRate, markup, precioMinimo = 3) {
  const precio = subtotalTrasMarkup(bd, errorRate, markup);
  return roundUpToNickel(Math.max(precio, precioMinimo));
}

function recargoUrgencia(bd, errorRate, markup, urgenciaRate, precioMinimo = 3) {
  const baseAntesUrgencia = subtotalTrasMarkup(bd, errorRate, markup);
  return baseAntesUrgencia * urgenciaRate;
}

function precioFinalConUrgencia(bd, errorRate, markup, urgenciaRate, precioMinimo = 3) {
  const baseAntesUrgencia = subtotalTrasMarkup(bd, errorRate, markup);
  const precio = baseAntesUrgencia * (1 + urgenciaRate);
  return roundUpToNickel(Math.max(precio, precioMinimo));
}

function costAsDict(bd) {
  return {
    Filamento: bd.filamento,
    Electricidad: bd.electricidad,
    'Diseño & Modelado': bd.diseno_modelado,
    'Búsqueda modelos': bd.busqueda_modelos,
    'Elim. soportes': bd.eliminacion_soportes,
    'Deterioro imp.': bd.deterioro_impresora,
    Postprocesado: bd.postprocesado,
    ...(bd.gasto_misc > 0 ? { 'Extras / Misc.': bd.gasto_misc } : {}),
  };
}

function updateCalcState(payload, info) {
  const source = payload || {};
  const state = {
    empresa: source.empresa || '3DCC',
    cliente: source.cliente || '',
    cliente_email: String(source.cliente_email || '').trim(),
    descripcion: source.descripcion || '',
    impresora: source.impresora || '',
    filamento_tipo: source.filamento_tipo || '',
    filamento_color: source.filamento_color || '',
    is_multimaterial: !!source.is_multimaterial,
    material_breakdown: Array.isArray(source.material_breakdown) ? source.material_breakdown : [],
    peso_g: String(source.peso_g ?? ''),
    tiempo_h: String(source.tiempo_h ?? ''),
    cantidad: Math.max(1, Math.floor(Number(source.cantidad) || 1)),
    diseno_modelado: source.diseno_modelado || 'No necesario',
    busqueda_modelos: source.busqueda_modelos || 'No',
    eliminacion_soportes: source.eliminacion_soportes || 'No',
    deterioro_impresora: source.deterioro_impresora || 'Autofinanciación',
    postprocesado: source.postprocesado || 'No',
    probabilidad_error: source.probabilidad_error || 'Baja',
    markup: source.markup || 'Normal (230%)',
    urgencia_nivel: source.urgencia_nivel || 'Normal',
    is_shared: !!source.is_shared,
    shared_percent_3dcc: Number(source.shared_percent_3dcc ?? 50),
    shared_percent_silab3d: Number(source.shared_percent_silab3d ?? 50),
    gasto_misc: Math.max(0, Number(source.gasto_misc || 0)),
  };

  if (info) {
    state.peso_g = String(info.peso ?? state.peso_g);
    state.filamento_tipo = String(info.filamento || state.filamento_tipo);
    state.filamento_color = String(info.filamento_color || state.filamento_color || 'Negro');
  }

  return state;
}

function calculateBudget(data, payload) {
  const gconfig = data.global_config;

  const pesoInput = Number(payload.peso_g);
  const horas = Number(payload.tiempo_h);
  if (!Number.isFinite(pesoInput) || !Number.isFinite(horas)) {
    throw new Error('Peso y horas deben ser numéricos.');
  }

  const printer = data.printers.find((p) => p.name === payload.impresora);
  if (!printer) {
    throw new Error('Selecciona una impresora.');
  }

  const isMulti = !!payload.is_multimaterial;
  let breakdown = Array.isArray(payload.material_breakdown) ? payload.material_breakdown : [];
  let peso = pesoInput;
  let filamentCostOverride = null;
  let filamentDisplayName = payload.filamento_tipo;
  let filamentDisplayColor = payload.filamento_color || 'Negro';
  let effectivePricePerKg = 0;

  if (isMulti) {
    if (breakdown.length < 2) {
      throw new Error('En modo multicolor/multimaterial debes configurar al menos 2 líneas de mezcla.');
    }

    let totalWeight = 0;
    let totalCost = 0;
    const materialsUsed = [];

    for (let i = 0; i < breakdown.length; i += 1) {
      const item = breakdown[i];
      const material = String(item.material || '').trim();
      const grams = Number(item.grams);
      if (!material) throw new Error(`Línea ${i + 1}: material vacío en la mezcla.`);
      if (!Number.isFinite(grams) || grams <= 0) throw new Error(`Línea ${i + 1}: gramos inválidos en la mezcla.`);

      const filament = data.filament_types.find((f) => f.name === material);
      if (!filament) throw new Error(`Línea ${i + 1}: el material '${material}' no existe en Tipos de Material.`);

      totalWeight += grams;
      totalCost += grams * Number(filament.price_per_kg || 0) / 1000;
      if (!materialsUsed.includes(material)) materialsUsed.push(material);
    }

    if (totalWeight <= 0) throw new Error('La mezcla multicolor no tiene peso válido.');

    peso = Math.round(totalWeight * 100) / 100;
    filamentCostOverride = round4(totalCost);
    effectivePricePerKg = (totalCost * 1000) / totalWeight;
    filamentDisplayName = materialsUsed.join(' + ');
    filamentDisplayColor = 'Multicolor';
  } else {
    const filament = data.filament_types.find((f) => f.name === payload.filamento_tipo);
    if (!filament) throw new Error('Selecciona un tipo de filamento.');
    effectivePricePerKg = Number(filament.price_per_kg || 0);
    filamentDisplayName = filament.name;
    filamentDisplayColor = payload.filamento_color || 'Negro';
    breakdown = [];
  }

  const markup = MARKUP[payload.markup] ?? 2.3;
  const payloadProbError = payload.probabilidad_error;
  const payloadProbErrorKey = String(payloadProbError ?? '');
  const payloadProbErrorNum = Number(payloadProbError);
  const errorRate = Object.prototype.hasOwnProperty.call(PROBABILIDAD_ERROR, payloadProbErrorKey)
    ? Number(PROBABILIDAD_ERROR[payloadProbErrorKey])
    : (Number.isFinite(payloadProbErrorNum) ? payloadProbErrorNum : Number(PROBABILIDAD_ERROR.Baja));
  const urgenciaRate = URGENCIA[payload.urgencia_nivel] ?? 0;

  const bd = calculateCost({
    peso_g: peso,
    horas,
    filament_price_per_kg: effectivePricePerKg,
    printer,
    gconfig,
    diseno_str: payload.diseno_modelado,
    busqueda_str: payload.busqueda_modelos,
    soportes_str: payload.eliminacion_soportes,
    postproc_str: payload.postprocesado,
  });

  if (filamentCostOverride !== null) bd.filamento = filamentCostOverride;

  const gastoMisc = round4(Math.max(0, Number(payload.gasto_misc || 0)));
  bd.gasto_misc = gastoMisc;

  const precioCalculado = subtotalTrasMarkup(bd, errorRate, markup);
  const precioCalculadoConUrgencia = precioCalculado * (1 + urgenciaRate);
  const precioBase = precioFinal(bd, errorRate, markup, Number(gconfig.precio_minimo || 3));
  const recargo = recargoUrgencia(bd, errorRate, markup, urgenciaRate, Number(gconfig.precio_minimo || 3));
  const precioSinMisc = precioFinalConUrgencia(bd, errorRate, markup, urgenciaRate, Number(gconfig.precio_minimo || 3));
  const precio = roundUpToNickel(precioSinMisc + gastoMisc);
  const precioMinAplicado = precioSinMisc > precioCalculadoConUrgencia;

  const info = {
    empresa: payload.empresa,
    cliente: payload.cliente,
    cliente_email: String(payload.cliente_email || '').trim(),
    fecha: payload.fecha,
    descripcion: payload.descripcion,
    impresora: printer.name,
    filamento: filamentDisplayName,
    filamento_color: filamentDisplayColor,
    is_multimaterial: isMulti,
    material_breakdown: breakdown,
    precio_kg: effectivePricePerKg,
    peso: String(peso),
    horas: String(horas),
    unit: gconfig.money_unit,
    error_rate: errorRate,
    markup,
    urgencia_nivel: payload.urgencia_nivel,
    urgencia_rate: urgenciaRate,
    recargo_urgencia: recargo,
    gasto_misc: gastoMisc,
    con_error: conError(bd, errorRate),
    precio_base: precioBase,
    precio_final: precio,
    precio_minimo: Number(gconfig.precio_minimo || 3),
    precio_minimo_aplicado: precioMinAplicado,
    diseno: payload.diseno_modelado,
    busqueda: payload.busqueda_modelos,
    soportes: payload.eliminacion_soportes,
    deterioro: payload.deterioro_impresora,
    postproc: payload.postprocesado,
    prob_error: payload.probabilidad_error,
    markup_label: payload.markup || 'Normal (230%)',
    coste_bruto_impresion: subtotalAfectableError(bd),
    beneficio_neto: precio - subtotalAfectableError(bd),
    stripe_payment_url: '',
    stripe_session_id: '',
    importe_pagado: 0,
    cantidad: Math.max(1, Math.floor(Number(payload.cantidad) || 1)),
    precio_unitario: roundMoney(precio / Math.max(1, Math.floor(Number(payload.cantidad) || 1))),
    is_shared: !!payload.is_shared,
    shared_split: payload.is_shared ? {
      '3DCC': Number(payload.shared_percent_3dcc ?? 50),
      'SILAB3D': Number(payload.shared_percent_silab3d ?? 50),
    } : null,
  };

  return {
    breakdown: bd,
    breakdownDict: costAsDict(bd),
    subtotal: subtotal(bd),
    info,
  };
}

function saveOrderFromResult(data, resultInfo) {
  const info = resultInfo.info;
  const order = normalizeOrder({
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
    fecha: info.fecha,
    empresa: info.empresa,
    cliente: info.cliente,
    descripcion: info.descripcion,
    impresora: info.impresora,
    filamento: info.filamento,
    filamento_color: info.filamento_color || '',
    peso_g: String(info.peso),
    horas: String(info.horas),
    cantidad: Number(info.cantidad || 1),
    precio_final: Number(info.precio_final || 0),
    coste_bruto: Number(info.coste_bruto_impresion || 0),
    beneficio_neto: Number(info.beneficio_neto || 0),
    markup: Number(info.markup || 2.3),
    error_rate: Number(info.error_rate || 0.5),
    urgencia_nivel: info.urgencia_nivel || 'Normal',
    urgencia_rate: Number(info.urgencia_rate || 0),
    recargo_urgencia: Number(info.recargo_urgencia || 0),
    stripe_payment_url: info.stripe_payment_url || '',
    stripe_session_id: info.stripe_session_id || '',
    importe_pagado: roundMoney(info.importe_pagado || 0),
    estado: 'Presupuesto enviado',
    cliente_email: String(info.cliente_email || '').trim(),
    is_multimaterial: !!info.is_multimaterial,
    material_breakdown: Array.isArray(info.material_breakdown) ? info.material_breakdown : [],
    material_contabilizado: false,
    diseno_modelado: info.diseno || 'No necesario',
    busqueda_modelos: info.busqueda || 'No',
    eliminacion_soportes: info.soportes || 'No',
    postprocesado_label: info.postproc || 'No',
    probabilidad_error_label: info.prob_error || 'Baja',
    markup_label: info.markup_label || 'Normal (230%)',
    is_shared: !!info.is_shared,
    shared_split: info.shared_split || null,
    gasto_misc: roundMoney(info.gasto_misc || 0),
    payment_method: '',
    notes: '',
    payment_history: [],
  });

  data.orders.push(order);
  return order;
}

function roundMoney(value) {
  return Math.round(Math.max(0, Number(value || 0)) * 100) / 100;
}

function findOrder(data, orderId) {
  const idx = data.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) throw new Error('Pedido no encontrado.');
  return { idx, order: data.orders[idx] };
}

/* ── Order recalculation (post-calc modification) ──────────────────────── */

function recalculateOrder(data, params) {
  const { order } = findOrder(data, params.orderId);
  const payload = params.payload;

  const result = calculateBudget(data, payload);
  const info = result.info;

  const oldPrice = roundMoney(order.precio_final);

  order.cliente = String(payload.cliente || order.cliente);
  if (payload.cliente_email !== undefined) order.cliente_email = String(payload.cliente_email || '').trim();
  order.descripcion = String(payload.descripcion || order.descripcion);
  order.fecha = String(payload.fecha || order.fecha);

  order.impresora = info.impresora;
  order.filamento = info.filamento;
  order.filamento_color = info.filamento_color || '';
  order.peso_g = String(info.peso);
  order.horas = String(info.horas);
  order.is_multimaterial = !!info.is_multimaterial;
  order.material_breakdown = Array.isArray(info.material_breakdown) ? info.material_breakdown : [];
  order.cantidad = Number(info.cantidad || 1);

  order.precio_final = roundMoney(info.precio_final);
  order.coste_bruto = roundMoney(info.coste_bruto_impresion);
  order.beneficio_neto = roundMoney(info.beneficio_neto);
  order.markup = Number(info.markup || 2.3);
  order.error_rate = Number(info.error_rate || 0.5);
  order.urgencia_nivel = info.urgencia_nivel || 'Normal';
  order.urgencia_rate = Number(info.urgencia_rate || 0);
  order.recargo_urgencia = roundMoney(info.recargo_urgencia || 0);

  order.diseno_modelado = payload.diseno_modelado || 'No necesario';
  order.busqueda_modelos = payload.busqueda_modelos || 'No';
  order.eliminacion_soportes = payload.eliminacion_soportes || 'No';
  order.postprocesado_label = payload.postprocesado || 'No';
  order.probabilidad_error_label = payload.probabilidad_error || 'Baja';
  order.markup_label = payload.markup || 'Normal (230%)';

  order.is_shared = !!payload.is_shared;
  order.shared_split = payload.is_shared ? {
    '3DCC': Number(payload.shared_percent_3dcc ?? 50),
    'SILAB3D': Number(payload.shared_percent_silab3d ?? 50),
  } : null;
  order.gasto_misc = roundMoney(info.gasto_misc || 0);

  const newPrice = order.precio_final;
  const delta = roundMoney(newPrice - oldPrice);
  if (delta !== 0) {
    const sign = delta > 0 ? '+' : '';
    if (!Array.isArray(order.payment_history)) order.payment_history = [];
    order.payment_history.push({
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
      created_at: new Date().toISOString(),
      method: 'Modificación',
      amount: 0,
      note: `Precio modificado: ${oldPrice.toFixed(2)} → ${newPrice.toFixed(2)} (${sign}${delta.toFixed(2)})`,
      source: 'recalculation',
    });
  }

  refreshOrderPaymentFields(order);

  return { ok: true, order, result, oldPrice, newPrice, delta };
}

function consumeOrderMaterial(data, order, partnerStock) {
  const lines = [];

  if (order.is_multimaterial) {
    if (!Array.isArray(order.material_breakdown) || order.material_breakdown.length < 2) {
      throw new Error('Este pedido está marcado como multimaterial, pero no tiene desglose válido.');
    }

    for (const item of order.material_breakdown) {
      const material = String(item.material || '').trim();
      const color = String(item.color || '').trim() || 'Negro';
      const grams = Math.max(0, Number(item.grams || 0));
      if (material && grams > 0) lines.push({ material, color, grams });
    }

    if (lines.length < 2) throw new Error('La mezcla debe contener al menos 2 líneas válidas con gramos > 0.');
  } else {
    const material = String(order.filamento || '').trim();
    const color = String(order.filamento_color || '').trim() || 'Negro';
    const grams = Math.max(0, Number(order.peso_g || 0));
    if (!material) throw new Error('El pedido no tiene material asignado.');
    lines.push({ material, color, grams });
  }

  // For shared orders, combine own + partner pools for deduction
  const useSharedPool = !!order.is_shared && Array.isArray(partnerStock);

  const lowStock = [];
  for (const line of lines) {
    let remaining = line.grams;

    // Try own stock first
    let ownItem = data.filament_stock.find(
      (s) => s.material === line.material && String(s.color || '').toLowerCase() === line.color.toLowerCase(),
    );
    if (!ownItem) {
      ownItem = { material: line.material, color: line.color, remaining_g: 0, buy_threshold_g: 150 };
      data.filament_stock.push(ownItem);
    }

    const ownAvailable = Math.max(0, Number(ownItem.remaining_g || 0));

    if (useSharedPool && ownAvailable < remaining) {
      // Deduct as much as possible from own stock, rest from partner
      const fromOwn = Math.min(ownAvailable, remaining);
      ownItem.remaining_g = Math.round((ownAvailable - fromOwn) * 100) / 100;
      remaining -= fromOwn;

      // Now try partner stock
      let partnerItem = partnerStock.find(
        (s) => s.material === line.material && String(s.color || '').toLowerCase() === line.color.toLowerCase(),
      );
      if (!partnerItem) {
        partnerItem = { material: line.material, color: line.color, remaining_g: 0, buy_threshold_g: 150 };
        partnerStock.push(partnerItem);
      }
      partnerItem.remaining_g = Math.round((Number(partnerItem.remaining_g || 0) - remaining) * 100) / 100;
      remaining = 0;

      if (Number(partnerItem.remaining_g || 0) <= Number(partnerItem.buy_threshold_g || 0)) {
        lowStock.push(`[Partner] ${partnerItem.material} (${partnerItem.color}): ${Number(partnerItem.remaining_g || 0).toFixed(2)} g`);
      }
    } else {
      // All from own stock
      ownItem.remaining_g = Math.round((Number(ownItem.remaining_g || 0) - remaining) * 100) / 100;
    }

    if (Number(ownItem.remaining_g || 0) <= Number(ownItem.buy_threshold_g || 0)) {
      lowStock.push(`${ownItem.material} (${ownItem.color}): ${Number(ownItem.remaining_g || 0).toFixed(2)} g`);
    }
  }

  order.material_contabilizado = true;
  return lowStock;
}

function setOrderAccepted(data, orderId, partnerStock) {
  const { order } = findOrder(data, orderId);

  if (!(order.estado === 'Aceptado' && order.material_contabilizado)) {
    const lowStock = order.material_contabilizado
      ? []
      : consumeOrderMaterial(data, order, partnerStock);
    order.estado = 'Aceptado';
    const result = { ok: true, lowStock };
    // If shared and partner stock was used, signal back so it can be persisted
    if (order.is_shared && Array.isArray(partnerStock)) {
      result.partnerStockUsed = true;
      result.partnerStock = partnerStock;
    }
    return result;
  }

  return { ok: true, lowStock: [] };
}

function setOrderSent(data, orderId) {
  const { order } = findOrder(data, orderId);
  order.estado = 'Presupuesto enviado';
}

function deleteOrder(data, orderId) {
  const { idx } = findOrder(data, orderId);
  data.orders.splice(idx, 1);
}

function currencyFromUnit(unit) {
  const map = {
    '€': 'eur',
    EUR: 'eur',
    '$': 'usd',
    USD: 'usd',
    '£': 'gbp',
    GBP: 'gbp',
  };
  return map[String(unit || '').trim()] || 'eur';
}

async function generateStripePaymentLink(data, params) {
  const { order } = findOrder(data, params.orderId);
  const gc = data.global_config;

  if (!gc.stripe_secret_key || !gc.stripe_success_url || !gc.stripe_cancel_url) {
    throw new Error('Configura Stripe Secret Key + Success URL + Cancel URL en Configuración.');
  }

  const pending = roundMoney(Math.max(0, order.precio_final - order.importe_pagado));

  const amount = roundMoney(params.amountToCharge);
  if (!amount || amount <= 0) {
    throw new Error('Importe inválido. Debe ser mayor que 0.');
  }

  const isPartial = pending > 0 && amount < pending;
  const stripe = new Stripe(gc.stripe_secret_key.trim());

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: gc.stripe_success_url.trim(),
    cancel_url: gc.stripe_cancel_url.trim(),
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: currencyFromUnit(gc.money_unit),
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: order.cliente ? String(order.cliente).slice(0, 120) : 'Pieza 3D',
            description: `${order.descripcion || 'Resumen del pedido'} · ${isPartial ? 'Adelanto' : 'Pago pendiente'}`.slice(0, 240),
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      customer_name: order.cliente ? String(order.cliente).slice(0, 120) : '',
      order_id: order.id,
    },
  });

  if (!session.url) {
    throw new Error('Stripe no devolvió URL de checkout.');
  }

  order.stripe_payment_url = session.url;
  order.stripe_session_id = session.id;
  refreshOrderPaymentFields(order);

  return {
    ok: true,
    url: session.url,
    sessionId: session.id,
    amount,
    pendingAfter: order.importe_pendiente,
  };
}

function updateOrder(data, params) {
  const { order } = findOrder(data, params.orderId);
  const updates = params.updates || {};

  if (updates.fecha !== undefined) order.fecha = String(updates.fecha || '').trim();
  if (updates.cliente !== undefined) order.cliente = String(updates.cliente || '').trim();
  if (updates.cliente_email !== undefined) order.cliente_email = String(updates.cliente_email || '').trim();
  if (updates.descripcion !== undefined) order.descripcion = String(updates.descripcion || '').trim();
  if (updates.estado !== undefined) order.estado = normalizeEstado(updates.estado);
  if (updates.notes !== undefined) order.notes = String(updates.notes || '').trim();
  if (updates.payment_method !== undefined) order.payment_method = String(updates.payment_method || '').trim();
  if (updates.repeticiones_error !== undefined) order.repeticiones_error = Math.max(0, Math.floor(Number(updates.repeticiones_error) || 0));
  if (updates.imagen_path !== undefined) order.imagen_path = String(updates.imagen_path || '');
  if (updates.archived !== undefined) order.archived = !!updates.archived;

  if (updates.is_shared !== undefined) {
    order.is_shared = !!updates.is_shared;
    if (order.is_shared && updates.shared_split && typeof updates.shared_split === 'object') {
      const _a = Math.max(0, Math.min(100, Number(updates.shared_split['3DCC'] ?? 50)));
      order.shared_split = { '3DCC': _a, 'SILAB3D': 100 - _a };
    } else if (!order.is_shared) {
      order.shared_split = null;
    }
  }

  if (updates.importe_pagado !== undefined) {
    const oldPaid = roundMoney(order.importe_pagado || 0);
    const newPaid = roundMoney(updates.importe_pagado || 0);
    order.importe_pagado = newPaid;

    const delta = roundMoney(newPaid - oldPaid);
    if (delta !== 0) {
      if (!Array.isArray(order.payment_history)) order.payment_history = [];
      order.payment_history.push({
        id: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
        created_at: new Date().toISOString(),
        method: order.payment_method || 'Ajuste manual',
        amount: delta,
        note: String(params.adjustmentNote || 'Ajuste manual de cobro'),
        source: 'manual-adjustment',
      });
    }
  }

  refreshOrderPaymentFields(order);
  return { ok: true, order };
}

function duplicateOrder(data, orderId) {
  const { order } = findOrder(data, orderId)
  const newOrder = normalizeOrder({
    ...order,
    id: undefined,
    fecha: new Date().toISOString().slice(0, 10),
    estado: 'Presupuesto enviado',
    importe_pagado: 0,
    payment_history: [],
    notif_history: [],
    stripe_payment_url: null,
    stripe_session_id: null,
    archived: false,
  })
  data.orders.push(newOrder)
  return { ok: true, order: newOrder }
}

function addManualOrderPayment(data, params) {
  const { order } = findOrder(data, params.orderId);

  const amount = roundMoney(params.amount || 0);
  if (!amount || amount <= 0) throw new Error('El importe manual debe ser mayor que 0.');

  const method = String(params.method || '').trim();
  if (!method) throw new Error('Debes indicar un método de cobro (Efectivo, Bizum, etc.).');

  if (!Array.isArray(order.payment_history)) order.payment_history = [];
  order.payment_history.push({
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
    created_at: new Date().toISOString(),
    method,
    amount,
    note: String(params.note || ''),
    source: 'manual-payment',
  });

  order.importe_pagado = roundMoney(order.importe_pagado + amount);
  order.payment_method = method;
  refreshOrderPaymentFields(order);

  return {
    ok: true,
    amount,
    pendingAfter: order.importe_pendiente,
    order,
  };
}

function removeOrderPaymentRecord(data, params) {
  const { order } = findOrder(data, params.orderId);
  const paymentId = String(params.paymentId || '').trim();
  if (!paymentId) throw new Error('Debes indicar el ID del movimiento a eliminar.');

  if (!Array.isArray(order.payment_history) || order.payment_history.length === 0) {
    throw new Error('Este pedido no tiene historial de cobros.');
  }

  const idx = order.payment_history.findIndex((p) => String(p?.id || '') === paymentId);
  if (idx < 0) throw new Error('No se encontró el movimiento en el historial.');

  const [removed] = order.payment_history.splice(idx, 1);
  order.importe_pagado = roundMoney(Math.max(0, Number(order.importe_pagado || 0) - Number(removed.amount || 0)));
  refreshOrderPaymentFields(order);

  return {
    ok: true,
    removed,
    pendingAfter: order.importe_pendiente,
    order,
  };
}

function getTickets(resultInfo) {
  const info = resultInfo.info;
  const bd = resultInfo.breakdown;
  const breakdownDict = resultInfo.breakdownDict || costAsDict(bd);
  const entries = Object.entries(breakdownDict).map(([name, val]) => ({ name, value: Number(val || 0) }));
  const subtotalVal = entries.reduce((acc, item) => acc + item.value, 0);
  const isBruto = (label) => ['Filamento', 'Electricidad', 'Deterioro imp.', 'Desgaste impresora'].includes(String(label || '').trim());
  const costeBruto = entries.filter((item) => isBruto(item.name)).reduce((acc, item) => acc + item.value, 0);
  const cantidad = Math.max(1, Math.floor(Number(info.cantidad) || 1));
  const precioTotal = Number(info.precio_final || 0);
  const precioUnitario = roundMoney(precioTotal / cantidad);
  const beneficioNeto = precioTotal - costeBruto;

  const clienteLines = [
    '══════════════════════════════════════════',
    `${info.empresa} · RESUMEN`,
    '══════════════════════════════════════════',
    `Cliente:      ${info.cliente}`,
    `Fecha:        ${info.fecha}`,
    `Descripción:  ${info.descripcion}`,
    '',
    `Material:     ${info.filamento} (${info.filamento_color || '-'})`,
    `Peso:         ${info.peso} g`,
    `Tiempo est.:  ${info.horas} h`,
    `Urgencia:     ${info.urgencia_nivel}`,
    '──────────────────────────────────────────',
    '',
    `Precio ud.:   ${precioUnitario.toFixed(2)} ${info.unit}`,
    `Cantidad:     ${cantidad}`,
    `TOTAL:        ${precioTotal.toFixed(2)} ${info.unit}`,
    '',
    '══════════════════════════════════════════',
  ];

  const empresaLines = [
    '══════════════════════════════════════════════',
    `${info.empresa} · DESGLOSE INTERNO`,
    '══════════════════════════════════════════════',
    `Cliente:      ${info.cliente}`,
    `Fecha:        ${info.fecha}`,
    `Descripción:  ${info.descripcion}`,
    `Impresora:    ${info.impresora}`,
    '──────────────────────────────────────────────',
    `Material:     ${info.filamento} (${info.filamento_color || '-'}) (${Number(info.precio_kg || 0).toFixed(2)} ${info.unit}/kg)`,
    `Peso:         ${info.peso} g`,
    `Tiempo:       ${info.horas} h`,
    `Cantidad:     ${cantidad}`,
    '──────────────────────────────────────────────',
    `Coste bruto (filamento + luz + desgaste): ${costeBruto.toFixed(2)} ${info.unit}`,
    '──────────────────────────────────────────────',
    'COSTES (por unidad):',
  ];

  entries.forEach((item) => {
    const pct = subtotalVal > 0 ? (item.value / subtotalVal) * 100 : 0;
    empresaLines.push(`  ${item.name}: ${item.value.toFixed(2)} ${info.unit} (${pct.toFixed(1)}%)`);
  });

  empresaLines.push(
    '──────────────────────────────────────────────',
    `Subtotal: ${subtotalVal.toFixed(2)} ${info.unit}`,
    `+ Error (${Math.round(Number(info.error_rate || 0) * 100)}%): ${Number(info.con_error || 0).toFixed(2)} ${info.unit}`,
    `Markup ×${Number(info.markup || 2.3).toFixed(2)}`,
  );

  if (Number(info.urgencia_rate || 0) > 0) {
    empresaLines.push(`+ Urgencia (${Math.round(Number(info.urgencia_rate) * 100)}%): +${Number(info.recargo_urgencia || 0).toFixed(2)} ${info.unit}`);
  }

  if (info.precio_minimo_aplicado) {
    empresaLines.push(`(Precio mínimo aplicado: ${Number(info.precio_minimo || 0).toFixed(2)} ${info.unit})`);
  }

  empresaLines.push(
    '──────────────────────────────────────────────',
    `PRECIO UNITARIO: ${precioUnitario.toFixed(2)} ${info.unit}`,
    `CANTIDAD: ${cantidad}`,
    `PRECIO TOTAL: ${precioTotal.toFixed(2)} ${info.unit}`,
    `BENEFICIO NETO: ${beneficioNeto.toFixed(2)} ${info.unit}`,
    '══════════════════════════════════════════════',
    `Parámetros: Diseño=${info.diseno}; Búsqueda=${info.busqueda}; Soportes=${info.soportes}; Deterioro=${info.deterioro}; Postproc=${info.postproc}; Error=${info.prob_error}; Urgencia=${info.urgencia_nivel}`,
    '══════════════════════════════════════════════',
  );

  return {
    cliente: clienteLines.join('\n'),
    empresa: empresaLines.join('\n'),
  };
}

module.exports = {
  DISENO_MODELADO,
  BUSQUEDA_MODELOS,
  ELIMINACION_SOPORTES,
  POSTPROCESADO,
  PROBABILIDAD_ERROR,
  MARKUP,
  URGENCIA,
  ORDER_LIFECYCLE,
  normalizeEstado,
  createDefaultData,
  normalizeData,
  calculateBudget,
  saveOrderFromResult,
  setOrderAccepted,
  setOrderSent,
  deleteOrder,
  updateOrder,
  duplicateOrder,
  recalculateOrder,
  addManualOrderPayment,
  removeOrderPaymentRecord,
  generateStripePaymentLink,
  updateCalcState,
  getTickets,
  costAsDict,
};
