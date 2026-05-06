const OPTIONS = {
  empresa: ['3DCC', 'SILAB3D'],
  diseno: ['No necesario', 'Chorrada - En Slicer', "Fácil - Fusión 30'", "Medio - Fusión 60'", 'Avanzado - AI + Remesh'],
  busqueda: ['No', 'Sí'],
  soportes: ['No', 'Pocos / Baja dificultad', 'Muchos / Elevada dificultad'],
  postproc: ['No', 'Sencillo (Lijado ligero)', 'Medio (Lijado + Ensamblado)', 'Complejo (Lijado + Pintura)'],
  probError: ['Baja', 'Media', 'Alta'],
  markup: ['Normal (230%)'],
  urgencia: ['Normal', 'Urgente'],
};

const COLORS = {
  Filamento: '#60A5FA',
  Electricidad: '#FBBF24',
  'Diseño & Modelado': '#34D399',
  'Búsqueda modelos': '#A78BFA',
  'Elim. soportes': '#F472B6',
  'Deterioro imp.': '#9CA3AF',
  Postprocesado: '#FB923C',
};

let appData = null;
let lastResult = null;
let calcMixBreakdown = [];
let selectedOrderId = null;
let selectedPrinterIndex = null;
let selectedFilamentIndex = null;
let selectedStockIndex = null;

let calcDonutChart = null;
let calcBarsChart = null;
let statsBarsChart = null;
let statsDonutChart = null;

const $ = (id) => document.getElementById(id);

function todayText() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function setOptions(selectEl, values, selected) {
  selectEl.innerHTML = '';
  values.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    selectEl.appendChild(opt);
  });
  if (selected && values.includes(selected)) selectEl.value = selected;
  else if (values.length) selectEl.value = values[0];
}

function showError(msg) {
  window.alert(msg);
}

function saveAll() {
  return window.api.saveApp(appData);
}

function getCalcPayload() {
  return {
    empresa: $('empresa').value,
    cliente: $('cliente').value,
    fecha: $('fecha').value,
    descripcion: $('descripcion').value,
    impresora: $('impresora').value,
    filamento_tipo: $('filamento').value,
    filamento_color: $('filamentoColor').value,
    is_multimaterial: $('isMultimaterial').checked,
    material_breakdown: calcMixBreakdown,
    peso_g: $('peso').value,
    tiempo_h: $('horas').value,
    diseno_modelado: $('diseno').value,
    busqueda_modelos: $('busqueda').value,
    eliminacion_soportes: $('soportes').value,
    deterioro_impresora: 'Autofinanciación',
    postprocesado: $('postproc').value,
    probabilidad_error: $('probError').value,
    markup: $('markup').value,
    urgencia_nivel: $('urgencia').value,
  };
}

async function persistCalcState() {
  await window.api.saveCalcState(getCalcPayload());
}

function updateFilamentColors() {
  const material = $('filamento').value;
  const colors = [...new Set(appData.filament_stock
    .filter((s) => s.material === material && String(s.color || '').trim())
    .map((s) => String(s.color).trim()))];
  const values = colors.length ? colors.sort((a, b) => a.localeCompare(b)) : ['Negro'];
  setOptions($('filamentoColor'), values, $('filamentoColor').value);
}

function updateFilamentPriceHint() {
  const ft = appData.filament_types.find((f) => f.name === $('filamento').value);
  $('filPrice').textContent = ft ? `${Number(ft.price_per_kg).toFixed(2)} ${appData.global_config.money_unit}/kg` : '';
}

function updateEnergyHint() {
  $('energyHint').textContent = `ℹ Tarifa eléctrica: ${Number(appData.global_config.energy_cost_kwh).toFixed(2)} €/kWh`;
}

function updateMultiUi() {
  const disabled = $('isMultimaterial').checked;
  $('filamento').disabled = disabled;
  $('filamentoColor').disabled = disabled;
  if (disabled) {
    const total = calcMixBreakdown.reduce((acc, item) => acc + Number(item.grams || 0), 0);
    if (total > 0) $('peso').value = total.toFixed(2);
  }
}

function renderBreakdown(result) {
  const rows = $('breakdownRows');
  rows.innerHTML = '';
  const entries = Object.entries(result.breakdownDict || {});
  const subtotal = Number(result.subtotal || 0);

  entries.forEach(([name, value]) => {
    const pct = subtotal > 0 ? (Number(value) / subtotal) * 100 : 0;
    const div = document.createElement('div');
    div.className = 'break-item';
    div.innerHTML = `
      <span class="break-name">${name}</span>
      <span class="break-val">${Number(value).toFixed(2)} ${result.info.unit}</span>
      <span class="break-pct">${pct.toFixed(0)}%</span>
    `;
    rows.appendChild(div);
  });

  const subtotalDiv = document.createElement('div');
  subtotalDiv.className = 'break-item';
  subtotalDiv.innerHTML = `<span class="break-name"><strong>Subtotal</strong></span><span class="break-val"><strong>${subtotal.toFixed(2)} ${result.info.unit}</strong></span><span></span>`;
  rows.appendChild(subtotalDiv);

  $('markupInfo').textContent = `Error: ${(result.info.error_rate * 100).toFixed(0)}% · Markup: ×${Number(result.info.markup).toFixed(2)}${
    result.info.urgencia_rate > 0 ? ` · Urgencia: +${(result.info.urgencia_rate * 100).toFixed(0)}%` : ''
  }${result.info.precio_minimo_aplicado ? ` · Mín: ${Number(result.info.precio_minimo).toFixed(2)}${result.info.unit}` : ''}`;
}

function renderCalcCharts(result) {
  const labels = Object.keys(result.breakdownDict);
  const values = Object.values(result.breakdownDict).map(Number);
  const colors = labels.map((l) => COLORS[l] || '#6b7280');

  if (calcDonutChart) calcDonutChart.destroy();
  if (calcBarsChart) calcBarsChart.destroy();

  calcDonutChart = new Chart($('calcDonut'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { labels: { color: '#f9fafb' } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw.toFixed(2)} ${result.info.unit}` } },
      },
    },
  });

  calcBarsChart = new Chart($('calcBars'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Coste', data: values, backgroundColor: colors }],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } },
        y: { ticks: { color: '#f9fafb' }, grid: { color: '#374151' } },
      },
    },
  });
}

function renderCalcResult(result) {
  $('kpiPrecio').textContent = `${Number(result.info.precio_final).toFixed(2)} ${result.info.unit}`;
  $('kpiBeneficio').textContent = `${Number(result.info.beneficio_neto).toFixed(2)} ${result.info.unit}`;
  $('kpiCoste').textContent = `${Number(result.info.coste_bruto_impresion).toFixed(2)} ${result.info.unit}`;
  renderBreakdown(result);
  renderCalcCharts(result);
}

function rowSelected(tableBody, row, className = 'selected') {
  [...tableBody.querySelectorAll('tr')].forEach((tr) => tr.classList.remove(className));
  row.classList.add(className);
}

function renderOrders() {
  const tbody = $('ordersTable').querySelector('tbody');
  tbody.innerHTML = '';
  const unit = appData.global_config.money_unit;

  appData.orders.forEach((o) => {
    const tr = document.createElement('tr');
    const estadoClass = o.estado === 'Aceptado' ? 'estado-aceptado' : o.estado === 'Pagado a medias' ? 'estado-pagado' : 'estado-enviado';
    tr.classList.add(estadoClass);
    tr.dataset.id = o.id;
    tr.innerHTML = `
      <td>${o.id}</td><td>${o.fecha}</td><td>${o.cliente}</td><td>${o.descripcion}</td>
      <td>${o.filamento}</td><td>${o.filamento_color || '-'}</td><td>${o.is_multimaterial ? '✓' : '-'}</td>
      <td>${o.peso_g}</td><td>${o.urgencia_nivel}</td><td>${Number(o.precio_final).toFixed(2)} ${unit}</td>
      <td>${Number(o.beneficio_neto).toFixed(2)} ${unit}</td><td>${o.estado}</td>
    `;
    tr.addEventListener('click', () => {
      selectedOrderId = o.id;
      rowSelected(tbody, tr);
    });
    tbody.appendChild(tr);
  });

  const total = appData.orders.length;
  const enviados = appData.orders.filter((o) => o.estado === 'Enviado' || o.estado === 'Pagado a medias').length;
  const aceptados = appData.orders.filter((o) => o.estado === 'Aceptado').length;
  const fact = appData.orders.filter((o) => o.estado === 'Aceptado').reduce((sum, o) => sum + Number(o.precio_final || 0), 0);

  $('ordersTotal').textContent = String(total);
  $('ordersEnviados').textContent = String(enviados);
  $('ordersAceptados').textContent = String(aceptados);
  $('ordersFacturacion').textContent = `${fact.toFixed(2)} ${unit}`;
}

function renderStats() {
  const unit = appData.global_config.money_unit;
  const accepted = appData.orders.filter((o) => o.estado === 'Aceptado');
  const ingresos = accepted.reduce((sum, o) => sum + Number(o.precio_final || 0), 0);
  const costes = accepted.reduce((sum, o) => sum + Number(o.coste_bruto || 0), 0);
  const beneficio = accepted.reduce((sum, o) => sum + Number(o.beneficio_neto || 0), 0);
  const margen = ingresos > 0 ? (beneficio / ingresos) * 100 : 0;
  const ticket = accepted.length ? ingresos / accepted.length : 0;

  $('stIngresos').textContent = `${ingresos.toFixed(2)} ${unit}`;
  $('stCostes').textContent = `${costes.toFixed(2)} ${unit}`;
  $('stBeneficio').textContent = `${beneficio.toFixed(2)} ${unit}`;
  $('stMargen').textContent = `${margen.toFixed(0)}%`;
  $('stTicket').textContent = `${ticket.toFixed(2)} ${unit}`;

  if (statsBarsChart) statsBarsChart.destroy();
  if (statsDonutChart) statsDonutChart.destroy();

  if (!accepted.length) {
    statsBarsChart = new Chart($('statsBars'), {
      type: 'bar',
      data: { labels: ['Sin pedidos aceptados'], datasets: [{ data: [0], backgroundColor: '#374151' }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#9ca3af' } }, y: { ticks: { color: '#9ca3af' } } } },
    });

    statsDonutChart = new Chart($('statsDonut'), {
      type: 'doughnut',
      data: { labels: ['Sin datos'], datasets: [{ data: [1], backgroundColor: ['#374151'] }] },
      options: { plugins: { legend: { labels: { color: '#9ca3af' } } } },
    });
    return;
  }

  const labels = accepted.map((o) => `#${o.id}`);
  statsBarsChart = new Chart($('statsBars'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Ingresos', data: accepted.map((o) => Number(o.precio_final || 0)), backgroundColor: '#06b6d4' },
        { label: 'Costes', data: accepted.map((o) => Number(o.coste_bruto || 0)), backgroundColor: '#ef4444' },
        { label: 'Beneficio', data: accepted.map((o) => Number(o.beneficio_neto || 0)), backgroundColor: '#10b981' },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: '#f9fafb' } } },
      scales: {
        x: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } },
        y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } },
      },
    },
  });

  const revenueByMaterial = {};
  accepted.forEach((o) => {
    revenueByMaterial[o.filamento] = (revenueByMaterial[o.filamento] || 0) + Number(o.precio_final || 0);
  });

  const matLabels = Object.keys(revenueByMaterial);
  const matValues = Object.values(revenueByMaterial);
  const matColors = matLabels.map((l, i) => COLORS[l] || ['#60A5FA', '#FBBF24', '#34D399', '#A78BFA', '#F472B6', '#FB923C'][i % 6]);

  statsDonutChart = new Chart($('statsDonut'), {
    type: 'doughnut',
    data: { labels: matLabels, datasets: [{ data: matValues, backgroundColor: matColors }] },
    options: { plugins: { legend: { labels: { color: '#f9fafb' } } } },
  });
}

function renderPrinters() {
  const tbody = $('printersTable').querySelector('tbody');
  tbody.innerHTML = '';

  appData.printers.forEach((p, idx) => {
    const depr = (Number(p.depreciation_time_h || 0) <= 0)
      ? 0
      : (Number(p.price_eur || 0) + Number(p.service_costs_life_eur || 0)) / Number(p.depreciation_time_h || 1);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.name}</td><td>${Number(p.material_diameter_mm).toFixed(2)}</td><td>${Number(p.price_eur).toFixed(0)}</td>
      <td>${Number(p.depreciation_time_h).toFixed(0)}</td><td>${Number(p.service_costs_life_eur).toFixed(0)}</td>
      <td>${Number(p.energy_consumption_kwh).toFixed(3)}</td><td>${depr.toFixed(4)}</td>
    `;
    tr.addEventListener('click', () => {
      selectedPrinterIndex = idx;
      rowSelected(tbody, tr);
    });
    tbody.appendChild(tr);
  });
}

function renderFilaments() {
  const tbody = $('filamentsTable').querySelector('tbody');
  tbody.innerHTML = '';
  appData.filament_types.forEach((f, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${f.name}</td><td>${Number(f.price_per_kg).toFixed(2)}</td>`;
    tr.addEventListener('click', () => {
      selectedFilamentIndex = idx;
      rowSelected(tbody, tr);
    });
    tbody.appendChild(tr);
  });
}

function renderStock() {
  const tbody = $('stockTable').querySelector('tbody');
  tbody.innerHTML = '';
  appData.filament_stock.forEach((s, idx) => {
    const needs = Number(s.remaining_g || 0) <= Number(s.buy_threshold_g || 0);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.material}</td><td>${s.color}</td><td>${Number(s.remaining_g).toFixed(2)}</td>
      <td>${Number(s.buy_threshold_g).toFixed(2)}</td><td>${needs ? 'Comprar' : 'OK'}</td>
    `;
    tr.classList.add(needs ? 'estado-enviado' : 'estado-aceptado');
    tr.addEventListener('click', () => {
      selectedStockIndex = idx;
      rowSelected(tbody, tr);
    });
    tbody.appendChild(tr);
  });
}

function renderConfig() {
  const gc = appData.global_config;
  $('cfgEnergy').value = gc.energy_cost_kwh;
  $('cfgLabor').value = gc.labor_cost_h;
  $('cfgMinPrice').value = gc.precio_minimo;
  $('cfgUnit').value = gc.money_unit;
  $('cfgStripeKey').value = gc.stripe_secret_key || '';
  $('cfgStripeSuccess').value = gc.stripe_success_url || '';
  $('cfgStripeCancel').value = gc.stripe_cancel_url || '';
}

function hydrateCalcForm() {
  const cs = appData.calc_state || {};

  setOptions($('empresa'), OPTIONS.empresa, cs.empresa || '3DCC');
  setOptions($('impresora'), appData.printers.map((p) => p.name), cs.impresora);
  setOptions($('filamento'), appData.filament_types.map((f) => f.name), cs.filamento_tipo);
  updateFilamentColors();

  $('filamentoColor').value = cs.filamento_color && [...$('filamentoColor').options].some((o) => o.value === cs.filamento_color)
    ? cs.filamento_color
    : $('filamentoColor').value;

  setOptions($('diseno'), OPTIONS.diseno, cs.diseno_modelado);
  setOptions($('busqueda'), OPTIONS.busqueda, cs.busqueda_modelos);
  setOptions($('soportes'), OPTIONS.soportes, cs.eliminacion_soportes);
  setOptions($('postproc'), OPTIONS.postproc, cs.postprocesado);
  setOptions($('probError'), OPTIONS.probError, cs.probabilidad_error);
  setOptions($('markup'), OPTIONS.markup, cs.markup);
  setOptions($('urgencia'), OPTIONS.urgencia, cs.urgencia_nivel);

  $('cliente').value = cs.cliente || '';
  $('fecha').value = cs.fecha || todayText();
  $('descripcion').value = cs.descripcion || '';
  $('peso').value = cs.peso_g || '50';
  $('horas').value = cs.tiempo_h || '1';

  $('isMultimaterial').checked = !!cs.is_multimaterial;
  calcMixBreakdown = Array.isArray(cs.material_breakdown) ? cs.material_breakdown : [];

  $('appTitle').textContent = `✨ ${$('empresa').value}`;
  updateFilamentPriceHint();
  updateEnergyHint();
  updateMultiUi();
}

function renderAll() {
  hydrateCalcForm();
  renderOrders();
  renderStats();
  renderPrinters();
  renderFilaments();
  renderStock();
  renderConfig();
}

function getSelectedOrder() {
  if (!selectedOrderId) return null;
  return appData.orders.find((o) => o.id === selectedOrderId) || null;
}

function openTicketDialog(title, content) {
  $('textDialogTitle').textContent = title;
  $('textDialogBody').value = content;
  $('textDialog').showModal();
}

function openMixDialog() {
  const dialog = $('mixDialog');
  const rowsWrap = $('mixRows');
  rowsWrap.innerHTML = '';
  const values = appData.filament_types.map((f) => f.name);
  const existing = calcMixBreakdown.length ? calcMixBreakdown : [
    { material: $('filamento').value, color: $('filamentoColor').value || 'Negro', grams: '' },
    { material: $('filamento').value, color: $('filamentoColor').value || 'Negro', grams: '' },
  ];

  $('mixCount').value = String(Math.min(4, Math.max(2, existing.length)));

  for (let i = 0; i < 4; i += 1) {
    const line = existing[i] || { material: $('filamento').value, color: 'Negro', grams: '' };
    const div = document.createElement('div');
    div.className = 'grid2 mt8';
    div.dataset.index = String(i);
    div.innerHTML = `
      <label>Material ${i + 1}<select class="mix-material"></select></label>
      <label>Color ${i + 1}<input class="mix-color" value="${line.color || ''}"/></label>
      <label>Gramos ${i + 1}<input class="mix-grams" value="${line.grams ?? ''}"/></label>
    `;

    const select = div.querySelector('.mix-material');
    setOptions(select, values, line.material);
    rowsWrap.appendChild(div);
  }

  const refreshVisibility = () => {
    const count = Number($('mixCount').value);
    [...rowsWrap.children].forEach((child, idx) => {
      child.style.display = idx < count ? 'grid' : 'none';
    });
  };

  $('mixCount').onchange = refreshVisibility;
  refreshVisibility();
  dialog.showModal();
}

function bindEvents() {
  $('tabsNav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const tab = btn.dataset.tab;

    [...document.querySelectorAll('.tab')].forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    [...document.querySelectorAll('.tab-pane')].forEach((p) => p.classList.remove('active'));
    $(`tab-${tab}`).classList.add('active');
  });

  $('empresa').addEventListener('change', async () => {
    $('appTitle').textContent = `✨ ${$('empresa').value}`;
    await persistCalcState();
  });

  ['cliente', 'fecha', 'descripcion', 'peso', 'horas'].forEach((id) => {
    $(id).addEventListener('change', persistCalcState);
  });

  $('impresora').addEventListener('change', persistCalcState);
  $('filamento').addEventListener('change', async () => {
    updateFilamentColors();
    updateFilamentPriceHint();
    await persistCalcState();
  });
  $('filamentoColor').addEventListener('change', persistCalcState);

  ['diseno', 'busqueda', 'soportes', 'postproc', 'probError', 'markup', 'urgencia'].forEach((id) => {
    $(id).addEventListener('change', persistCalcState);
  });

  $('isMultimaterial').addEventListener('change', async () => {
    if ($('isMultimaterial').checked && calcMixBreakdown.length < 2) {
      openMixDialog();
    }
    updateMultiUi();
    await persistCalcState();
  });

  $('btnEditMix').addEventListener('click', () => {
    openMixDialog();
  });

  $('btnMixCancel').addEventListener('click', () => $('mixDialog').close());

  $('btnMixSave').addEventListener('click', async () => {
    const count = Number($('mixCount').value);
    const rows = [...$('mixRows').children].slice(0, count);
    const result = [];

    for (let i = 0; i < rows.length; i += 1) {
      const material = rows[i].querySelector('.mix-material').value.trim();
      const color = rows[i].querySelector('.mix-color').value.trim();
      const grams = Number(rows[i].querySelector('.mix-grams').value);
      if (!material) return showError(`Línea ${i + 1}: selecciona material.`);
      if (!color) return showError(`Línea ${i + 1}: introduce color.`);
      if (!Number.isFinite(grams) || grams <= 0) return showError(`Línea ${i + 1}: gramos inválidos.`);
      result.push({ material, color, grams: Math.round(grams * 100) / 100 });
    }

    if (result.length < 2 || result.length > 4) return showError('La mezcla debe tener entre 2 y 4 líneas.');

    calcMixBreakdown = result;
    $('isMultimaterial').checked = true;
    updateMultiUi();
    $('mixDialog').close();
    await persistCalcState();
  });

  $('btnCalculate').addEventListener('click', async () => {
    try {
      const result = await window.api.calculate(getCalcPayload());
      lastResult = result;
      if ($('isMultimaterial').checked) {
        $('peso').value = Number(result.info.peso).toFixed(2);
      }
      renderCalcResult(result);
    } catch (err) {
      showError(err.message || String(err));
    }
  });

  $('btnSaveOrder').addEventListener('click', async () => {
    if (!lastResult) return showError('Primero calcula un presupuesto.');
    const response = await window.api.saveOrderFromResult(lastResult);
    appData = response.data;
    renderOrders();
    renderStats();
    renderStock();
    window.alert(`Pedido #${response.order.id} creado como 'Enviado'.`);
  });

  $('btnTicketCliente').addEventListener('click', async () => {
    if (!lastResult) return showError('Primero calcula un presupuesto.');
    const tickets = await window.api.getTickets(lastResult);
    openTicketDialog('Ticket Cliente', tickets.cliente);
  });

  $('btnTicketEmpresa').addEventListener('click', async () => {
    if (!lastResult) return showError('Primero calcula un presupuesto.');
    const tickets = await window.api.getTickets(lastResult);
    openTicketDialog('Ticket Empresa', tickets.empresa);
  });

  $('btnDialogClose').addEventListener('click', () => $('textDialog').close());
  $('btnDialogCopy').addEventListener('click', () => {
    window.api.copyText($('textDialogBody').value);
    window.alert('Copiado al portapapeles.');
  });
  $('btnDialogPdf').addEventListener('click', async () => {
    const title = $('textDialogTitle').textContent;
    const result = await window.api.saveTicketPdf({
      title,
      content: $('textDialogBody').value,
      defaultName: `ticket_${Date.now()}.pdf`,
    });
    if (!result.canceled) window.alert(`PDF guardado en:\n${result.filePath}`);
  });

  $('btnOrderAccepted').addEventListener('click', async () => {
    const order = getSelectedOrder();
    if (!order) return showError('Selecciona un pedido.');
    try {
      const response = await window.api.setOrderAccepted(order.id);
      appData = response.data;
      renderOrders();
      renderStats();
      renderStock();
      if (response.lowStock && response.lowStock.length) {
        window.alert(`Hay rollos por debajo del mínimo:\n\n${response.lowStock.join('\n')}`);
      }
    } catch (err) {
      showError(err.message || String(err));
    }
  });

  $('btnOrderSent').addEventListener('click', async () => {
    const order = getSelectedOrder();
    if (!order) return showError('Selecciona un pedido.');
    const response = await window.api.setOrderSent(order.id);
    appData = response.data;
    renderOrders();
    renderStats();
  });

  $('btnOrderDelete').addEventListener('click', async () => {
    const order = getSelectedOrder();
    if (!order) return showError('Selecciona un pedido.');
    if (!window.confirm(`¿Eliminar pedido #${order.id}?`)) return;
    const response = await window.api.deleteOrder(order.id);
    appData = response.data;
    selectedOrderId = null;
    renderOrders();
    renderStats();
  });

  $('btnOrderCopyLink').addEventListener('click', () => {
    const order = getSelectedOrder();
    if (!order) return showError('Selecciona un pedido.');
    if (!order.stripe_payment_url) return showError('Este pedido no tiene enlace Stripe guardado.');
    window.api.copyText(order.stripe_payment_url);
    window.alert('Enlace de pago copiado al portapapeles.');
  });

  $('btnOrderOpenLink').addEventListener('click', async () => {
    const order = getSelectedOrder();
    if (!order) return showError('Selecciona un pedido.');
    if (!order.stripe_payment_url) return showError('Este pedido no tiene enlace Stripe guardado.');
    await window.api.openUrl(order.stripe_payment_url);
  });

  $('btnOrderPayLink').addEventListener('click', async () => {
    const order = getSelectedOrder();
    if (!order) return showError('Selecciona un pedido.');

    const pending = Math.max(0, Number(order.precio_final || 0) - Number(order.importe_pagado || 0));
    if (pending <= 0) return showError('Este pedido ya no tiene importe pendiente.');

    let amount = pending;
    const full = window.confirm(`Pendiente: ${pending.toFixed(2)} ${appData.global_config.money_unit}\n\nAceptar = cobrar todo pendiente\nCancelar = introducir adelanto`);
    if (!full) {
      const raw = window.prompt(`Introduce importe a cobrar (máximo ${pending.toFixed(2)}):`, pending.toFixed(2));
      if (raw === null) return;
      amount = Number(raw);
    }

    try {
      const response = await window.api.generateOrderPaymentLink({ orderId: order.id, amountToCharge: amount });
      appData = response.data;
      renderOrders();
      window.api.copyText(response.url);
      const open = window.confirm(`Enlace copiado al portapapeles.\nImporte: ${response.amount.toFixed(2)} ${appData.global_config.money_unit}\nPendiente tras enlace: ${response.pendingAfter.toFixed(2)} ${appData.global_config.money_unit}\n\n¿Abrir en navegador?`);
      if (open) await window.api.openUrl(response.url);
    } catch (err) {
      showError(err.message || String(err));
    }
  });

  $('btnPrinterAdd').addEventListener('click', async () => {
    const p = {
      name: window.prompt('Nombre de impresora:', 'Nueva Impresora') || '',
      material_diameter_mm: Number(window.prompt('Diámetro material (mm):', '1.75')),
      price_eur: Number(window.prompt('Precio (€):', '300')),
      depreciation_time_h: Number(window.prompt('Vida útil (h):', '2000')),
      service_costs_life_eur: Number(window.prompt('Coste servicio vida (€):', '100')),
      energy_consumption_kwh: Number(window.prompt('Consumo energía (kWh/h):', '0.15')),
    };
    if (!p.name) return;
    appData.printers.push(p);
    await saveAll();
    renderPrinters();
    hydrateCalcForm();
  });

  $('btnPrinterEdit').addEventListener('click', async () => {
    if (selectedPrinterIndex === null) return showError('Selecciona una impresora.');
    const p = appData.printers[selectedPrinterIndex];
    const name = window.prompt('Nombre de impresora:', p.name);
    if (name === null || !name.trim()) return;
    p.name = name.trim();
    p.material_diameter_mm = Number(window.prompt('Diámetro material (mm):', p.material_diameter_mm));
    p.price_eur = Number(window.prompt('Precio (€):', p.price_eur));
    p.depreciation_time_h = Number(window.prompt('Vida útil (h):', p.depreciation_time_h));
    p.service_costs_life_eur = Number(window.prompt('Coste servicio vida (€):', p.service_costs_life_eur));
    p.energy_consumption_kwh = Number(window.prompt('Consumo energía (kWh/h):', p.energy_consumption_kwh));
    await saveAll();
    renderPrinters();
    hydrateCalcForm();
  });

  $('btnPrinterDelete').addEventListener('click', async () => {
    if (selectedPrinterIndex === null) return showError('Selecciona una impresora.');
    appData.printers.splice(selectedPrinterIndex, 1);
    selectedPrinterIndex = null;
    await saveAll();
    renderPrinters();
    hydrateCalcForm();
  });

  $('btnFilAdd').addEventListener('click', async () => {
    const name = window.prompt('Nombre del material:', 'PLA');
    if (!name) return;
    const price = Number(window.prompt('Precio (€/kg):', '20'));
    if (!Number.isFinite(price)) return showError('Precio inválido.');
    appData.filament_types.push({ name: name.trim(), price_per_kg: price });
    await saveAll();
    renderFilaments();
    hydrateCalcForm();
  });

  $('btnFilEdit').addEventListener('click', async () => {
    if (selectedFilamentIndex === null) return showError('Selecciona un material.');
    const f = appData.filament_types[selectedFilamentIndex];
    const oldName = f.name;
    const name = window.prompt('Nombre del material:', f.name);
    if (!name) return;
    const price = Number(window.prompt('Precio (€/kg):', f.price_per_kg));
    if (!Number.isFinite(price)) return showError('Precio inválido.');
    f.name = name.trim();
    f.price_per_kg = price;

    if (oldName !== f.name) {
      appData.filament_stock.forEach((s) => {
        if (s.material === oldName) s.material = f.name;
      });
    }

    await saveAll();
    renderFilaments();
    renderStock();
    hydrateCalcForm();
  });

  $('btnFilDelete').addEventListener('click', async () => {
    if (selectedFilamentIndex === null) return showError('Selecciona un material.');
    const removed = appData.filament_types.splice(selectedFilamentIndex, 1)[0];
    appData.filament_stock = appData.filament_stock.filter((s) => s.material !== removed.name);
    selectedFilamentIndex = null;
    await saveAll();
    renderFilaments();
    renderStock();
    hydrateCalcForm();
  });

  $('btnStockAdd').addEventListener('click', async () => {
    const material = window.prompt('Material:', appData.filament_types[0]?.name || 'PLA');
    if (!material) return;
    const color = window.prompt('Color:', 'Negro');
    if (!color) return;
    const remaining = Number(window.prompt('Restante (g):', '1000'));
    const threshold = Number(window.prompt('Mínimo compra (g):', '150'));
    if (!Number.isFinite(remaining) || !Number.isFinite(threshold)) return showError('Valores numéricos inválidos.');

    const dup = appData.filament_stock.find((s) => s.material === material && String(s.color).toLowerCase() === color.toLowerCase());
    if (dup) return showError('Ya existe un rollo para ese material y color.');

    appData.filament_stock.push({ material, color, remaining_g: remaining, buy_threshold_g: threshold });
    await saveAll();
    renderStock();
    hydrateCalcForm();
  });

  $('btnStockEdit').addEventListener('click', async () => {
    if (selectedStockIndex === null) return showError('Selecciona un rollo.');
    const s = appData.filament_stock[selectedStockIndex];
    const material = window.prompt('Material:', s.material);
    if (!material) return;
    const color = window.prompt('Color:', s.color);
    if (!color) return;
    const remaining = Number(window.prompt('Restante (g):', s.remaining_g));
    const threshold = Number(window.prompt('Mínimo compra (g):', s.buy_threshold_g));
    if (!Number.isFinite(remaining) || !Number.isFinite(threshold)) return showError('Valores numéricos inválidos.');

    const dup = appData.filament_stock.find((it, i) => i !== selectedStockIndex && it.material === material && String(it.color).toLowerCase() === color.toLowerCase());
    if (dup) return showError('Ya existe un rollo para ese material y color.');

    s.material = material;
    s.color = color;
    s.remaining_g = remaining;
    s.buy_threshold_g = threshold;
    await saveAll();
    renderStock();
    hydrateCalcForm();
  });

  $('btnStockDelete').addEventListener('click', async () => {
    if (selectedStockIndex === null) return showError('Selecciona un rollo.');
    appData.filament_stock.splice(selectedStockIndex, 1);
    selectedStockIndex = null;
    await saveAll();
    renderStock();
    hydrateCalcForm();
  });

  $('btnSaveConfig').addEventListener('click', async () => {
    const gc = appData.global_config;
    const energy = Number($('cfgEnergy').value);
    const labor = Number($('cfgLabor').value);
    const minPrice = Number($('cfgMinPrice').value);
    if (!Number.isFinite(energy) || !Number.isFinite(labor) || !Number.isFinite(minPrice)) {
      return showError('Valores numéricos inválidos.');
    }

    gc.energy_cost_kwh = energy;
    gc.labor_cost_h = labor;
    gc.precio_minimo = minPrice;
    gc.money_unit = $('cfgUnit').value || '€';
    gc.stripe_secret_key = $('cfgStripeKey').value.trim();
    gc.stripe_success_url = $('cfgStripeSuccess').value.trim();
    gc.stripe_cancel_url = $('cfgStripeCancel').value.trim();

    await saveAll();
    hydrateCalcForm();
    renderOrders();
    renderStats();
    window.alert('Configuración guardada correctamente.');
  });
}

async function bootstrap() {
  appData = await window.api.loadApp();
  renderAll();
  bindEvents();
}

bootstrap().catch((err) => {
  showError(err.message || String(err));
});
