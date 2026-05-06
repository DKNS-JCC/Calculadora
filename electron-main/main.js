const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const {
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
  createDefaultData,
} = require('./backend');
const { sendStatusEmail, sendTestEmail } = require('./mailer');

/* ── In-memory cache ──────────────────────────────────────────────────────── */
let cachedData = null;
let currentEmpresa = '3DCC';

/* ── Window ───────────────────────────────────────────────────────────────── */
let mainWindow = null;
const APP_ICON = path.join(app.getAppPath(), 'icon.ico');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1150,
    minHeight: 720,
    backgroundColor: '#111827',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function asText(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMoney(value, unit = '€') {
  const amount = toNumber(value, 0);
  return `${amount.toFixed(2)} ${unit}`;
}

function percentFromRate(rate) {
  return `${Math.round(toNumber(rate, 0) * 100)}%`;
}

function parseLegacyTicket(content, title = '') {
  const lines = String(content || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const kind = /empresa|interno/i.test(title) ? 'empresa' : 'cliente';

  const getField = (label) => {
    const row = lines.find((line) => line.toLowerCase().startsWith(`${label.toLowerCase()}:`));
    if (!row) return '';
    return row.split(':').slice(1).join(':').trim();
  };

  const priceRow = lines.find((line) => /precio\s*final|precio\s*:/i.test(line));
  const price = priceRow ? priceRow.replace(/.*?:\s*/, '').trim() : '';

  const info = {
    empresa: getField('Empresa') || (lines[1] ? lines[1].split('·')[0].trim() : ''),
    cliente: getField('Cliente'),
    fecha: getField('Fecha'),
    descripcion: getField('Descripción'),
    impresora: getField('Impresora'),
    filamento: getField('Material'),
    filamento_color: '',
    peso: getField('Peso')?.replace(/\s*g$/i, ''),
    horas: getField('Tiempo est.')?.replace(/\s*h$/i, '') || getField('Tiempo')?.replace(/\s*h$/i, ''),
    urgencia_nivel: getField('Urgencia') || 'Normal',
    unit: '€',
    precio_final: toNumber((price.match(/-?\d+(?:[.,]\d+)?/) || ['0'])[0].replace(',', '.')),
  };

  return {
    kind,
    info,
    breakdownDict: {},
    fallbackLines: lines,
  };
}

/* ── PDF Helper: colours ─────────────────────────────────────────────────── */
const COL = {
  dark: '#0f172a', brand: '#2563eb', brandDark: '#1d4ed8',
  accent: '#7c3aed', success: '#059669', warn: '#d97706',
  gray50: '#f8fafc', gray100: '#f1f5f9', gray200: '#e2e8f0',
  gray400: '#94a3b8', gray500: '#64748b', gray700: '#334155',
  white: '#ffffff',
};

function drawHeaderBand(doc, title, subtitle, accentColor = COL.brand) {
  const pw = doc.page.width;
  // Dark header band
  doc.save();
  doc.rect(0, 0, pw, 100).fill(COL.dark);
  // Accent strip
  doc.rect(0, 100, pw, 6).fill(accentColor);
  doc.restore();

  doc.fillColor(COL.white).fontSize(20).font('Helvetica-Bold')
    .text(title, 50, 32, { width: pw - 100 });
  doc.fillColor(COL.gray400).fontSize(10).font('Helvetica')
    .text(subtitle, 50, 62, { width: pw - 100 });
  return 126;
}

function drawSection(doc, text, y) {
  const pw = doc.page.width;
  doc.fillColor(COL.brand).fontSize(13).font('Helvetica-Bold').text(text, 50, y);
  doc.moveTo(50, y + 20).lineTo(pw - 50, y + 20).lineWidth(0.75).strokeColor(COL.gray200).stroke();
  doc.font('Helvetica');
  return y + 30;
}

function drawGrid(doc, rows, y, opts = {}) {
  const left = 50;
  const width = doc.page.width - 100;
  const cols = opts.cols || 2;
  const colGap = 14;
  const colWidth = (width - colGap * (cols - 1)) / cols;
  const rowHeight = 36;
  const totalRows = Math.ceil(rows.length / cols);
  const boxHeight = totalRows * rowHeight + 16;

  doc.roundedRect(left, y, width, boxHeight, 8).fillAndStroke(COL.gray50, COL.gray200);

  let idx = 0;
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < cols; c++) {
      if (idx >= rows.length) break;
      const item = rows[idx];
      const x = left + 14 + c * (colWidth + colGap);
      const baseY = y + 10 + r * rowHeight;
      doc.fillColor(COL.gray500).fontSize(8).font('Helvetica').text(item.label, x, baseY, { width: colWidth - 20 });
      doc.fillColor(COL.dark).fontSize(11).font('Helvetica-Bold').text(item.value, x, baseY + 12, { width: colWidth - 20 });
      doc.font('Helvetica');
      idx++;
    }
  }
  return y + boxHeight + 14;
}

function drawHighlightBox(doc, label, value, y, color = COL.brand) {
  const left = 50;
  const width = doc.page.width - 100;
  const height = 70;
  doc.roundedRect(left, y, width, height, 10).fill(COL.gray50);
  doc.roundedRect(left, y, 6, height, 3).fill(color);
  doc.fillColor(COL.gray500).fontSize(9).font('Helvetica').text(label, left + 22, y + 14);
  doc.fillColor(COL.dark).fontSize(26).font('Helvetica-Bold').text(value, left + 22, y + 30);
  doc.font('Helvetica');
  return y + height + 16;
}

function drawTable(doc, headers, rows, y, widths) {
  const left = 50;
  const tableWidth = doc.page.width - 100;
  const headerH = 28;
  const rowH = 26;
  const totalH = headerH + rows.length * rowH;

  doc.roundedRect(left, y, tableWidth, totalH, 6).strokeColor(COL.gray200).lineWidth(0.75).stroke();
  doc.rect(left, y, tableWidth, headerH).fill(COL.dark);

  let xOff = left;
  headers.forEach((h, i) => {
    const w = widths[i] * tableWidth;
    const align = i === 0 ? 'left' : 'right';
    doc.fillColor(COL.white).fontSize(9).font('Helvetica-Bold')
      .text(h, xOff + 10, y + 9, { width: w - 20, align });
    xOff += w;
  });
  doc.font('Helvetica');

  rows.forEach((row, ri) => {
    const ry = y + headerH + ri * rowH;
    doc.rect(left, ry, tableWidth, rowH).fill(ri % 2 === 0 ? COL.white : COL.gray50);
    let x = left;
    row.forEach((cell, ci) => {
      const w = widths[ci] * tableWidth;
      const align = ci === 0 ? 'left' : 'right';
      const color = ci === 0 ? COL.dark : COL.gray700;
      doc.fillColor(color).fontSize(10).text(String(cell), x + 10, ry + 8, { width: w - 20, align });
      x += w;
    });
  });

  // Vertical separators
  doc.strokeColor(COL.gray200).lineWidth(0.5);
  let sep = left;
  for (let i = 0; i < widths.length - 1; i++) {
    sep += widths[i] * tableWidth;
    doc.moveTo(sep, y).lineTo(sep, y + totalH).stroke();
  }

  return y + totalH + 16;
}

function drawFooter(doc, empresa) {
  const pw = doc.page.width;
  const ph = doc.page.height;
  doc.save();
  doc.rect(0, ph - 36, pw, 36).fill(COL.gray50);
  doc.fillColor(COL.gray400).fontSize(8).font('Helvetica')
    .text(`${asText(empresa)} · Documento generado automáticamente · ${new Date().toLocaleDateString('es-ES')}`, 50, ph - 24, { width: pw - 100, align: 'center' });
  doc.restore();
}

function ensureRoom(doc, y, requiredHeight, headerTitle, headerSub, accentColor) {
  const bottomLimit = doc.page.height - 60;
  if (y + requiredHeight <= bottomLimit) return y;
  doc.addPage();
  return drawHeaderBand(doc, headerTitle || 'Continuación', headerSub || '', accentColor);
}

/* ── Image helper ───────────────────────────────────────────────────────── */

function drawImageSection(doc, imagePath, y, empresa, accentColor) {
  if (!imagePath) return y;
  try {
    if (!fs.existsSync(imagePath)) return y;
    const pw = doc.page.width;
    const maxW = pw - 100;
    const maxH = 180;
    y = ensureRoom(doc, y, maxH + 50, empresa, '', accentColor);
    y = drawSection(doc, 'Imagen de referencia', y);
    doc.image(imagePath, 50, y, { fit: [maxW, maxH], align: 'center' });
    y += maxH + 14;
  } catch {
    // Skip image if it can't be read
  }
  return y;
}

/* ── Client PDF ─────────────────────────────────────────────────────────── */

function renderClientPdf(doc, summary) {
  const info = summary.info || {};
  const unit = asText(info.unit, '€');
  const empresa = asText(info.empresa, '3DCC');
  const cantidad = Math.max(1, Math.floor(Number(info.cantidad) || 1));
  const precioTotal = toNumber(info.precio_final, 0);
  const precioUnitario = Math.round(precioTotal / cantidad * 100) / 100;

  let y = drawHeaderBand(doc,
    `${empresa}`,
    `Resumen para ${asText(info.cliente)} · ${asText(info.fecha, new Date().toLocaleDateString('es-ES'))}`,
    COL.brand,
  );

  y = drawSection(doc, 'Datos del Proyecto', y);
  const gridItems = [
    { label: 'CLIENTE', value: asText(info.cliente) },
    { label: 'DESCRIPCIÓN', value: asText(info.descripcion) },
    { label: 'MATERIAL', value: `${asText(info.filamento)} (${asText(info.filamento_color)})` },
    { label: 'PESO ESTIMADO', value: `${asText(info.peso, '0')} g` },
    { label: 'TIEMPO DE IMPRESORA', value: `${asText(info.horas, '0')} h` },
    { label: 'ENTREGA', value: info.urgencia_nivel === 'Normal' ? 'Plazo estándar' : 'Urgente — Lo antes posible' },
  ];
  if (cantidad > 1) {
    gridItems.push({ label: 'CANTIDAD', value: `${cantidad} ud.` });
    gridItems.push({ label: 'PRECIO UNITARIO', value: formatMoney(precioUnitario, unit) });
  }
  y = drawGrid(doc, gridItems, y);

  y = ensureRoom(doc, y, 100, empresa, '', COL.brand);
  y = drawHighlightBox(doc, cantidad > 1 ? 'PRECIO TOTAL' : 'PRECIO FINAL', formatMoney(precioTotal, unit), y, COL.brand);

  // Reference image (optional)
  y = drawImageSection(doc, asText(info.imagen_path, ''), y, empresa, COL.brand);

  // Conditions
  const conditions = [
    'El coste indicado es el precio final del proyecto, incluyendo todos los gastos necesarios para llevarlo a cabo.',
    'Para plazos estándar, el tiempo de entrega dependerá de la complejidad del proyecto y la cola de trabajo en curso.',
    'Se requiere el abono del 50% del presupuesto como anticipo para iniciar la producción.',
    'Nuestros términos y condiciones generales están disponibles en nuestra web y se aplican a este presupuesto.',
  ];
  const conditionsHeight = 30 + conditions.length * 22 + 20;
  y = ensureRoom(doc, y, conditionsHeight, empresa, '', COL.brand);
  y = drawSection(doc, 'Condiciones', y);
  conditions.forEach((c) => {
    doc.fillColor(COL.gray500).fontSize(9).text(`•  ${c}`, 56, y, { width: doc.page.width - 112 });
    y += 22;
  });

  drawFooter(doc, empresa);
}

/* ── Company / Internal PDF ─────────────────────────────────────────────── */

function renderCompanyPdf(doc, summary) {
  const info = summary.info || {};
  const unit = asText(info.unit, '€');
  const empresa = asText(info.empresa, '3DCC');
  const breakdownDict = summary.breakdownDict || {};
  const entries = Object.entries(breakdownDict).map(([label, value]) => ({ label, value: toNumber(value, 0) }));
  const subtotalVal = entries.reduce((acc, item) => acc + item.value, 0);
  const isBruto = (label) => ['Filamento', 'Electricidad', 'Deterioro imp.', 'Desgaste impresora'].includes(String(label || '').trim());
  const costeBrutoVal = entries.filter((item) => isBruto(item.label)).reduce((acc, item) => acc + item.value, 0);
  const cantidad = Math.max(1, Math.floor(Number(info.cantidad) || 1));
  const precioTotal = toNumber(info.precio_final, 0);
  const precioUnitario = Math.round(precioTotal / cantidad * 100) / 100;
  const beneficioNetoVal = precioTotal - costeBrutoVal;

  let y = drawHeaderBand(doc,
    `${empresa} · Desglose Interno`,
    `${asText(info.fecha, new Date().toLocaleDateString('es-ES'))} · ${asText(info.cliente, 'Sin nombre')} · ${asText(info.descripcion)}`,
    COL.accent,
  );

  // Operative data
  y = drawSection(doc, 'Datos Operativos', y);
  y = drawGrid(doc, [
    { label: 'CLIENTE', value: asText(info.cliente) },
    { label: 'DESCRIPCIÓN', value: asText(info.descripcion) },
    { label: 'IMPRESORA', value: asText(info.impresora) },
    { label: 'MATERIAL', value: `${asText(info.filamento)} (${asText(info.filamento_color)})` },
    { label: 'PRECIO MATERIAL', value: formatMoney(info.precio_kg, `${unit}/kg`) },
    { label: 'PESO', value: `${asText(info.peso, '0')} g` },
    { label: 'TIEMPO', value: `${asText(info.horas, '0')} h` },
    { label: 'URGENCIA', value: asText(info.urgencia_nivel, 'Normal') },
    ...(cantidad > 1 ? [{ label: 'CANTIDAD', value: `${cantidad} ud.` }] : []),
  ], y);

  // Cost table
  y = ensureRoom(doc, y, 200, `${empresa} · Interno`, '', COL.accent);
  y = drawSection(doc, 'Desglose de Costes', y);
  const tableRows = entries.map((item) => [
    item.label,
    formatMoney(item.value, unit),
    `${subtotalVal > 0 ? ((item.value / subtotalVal) * 100).toFixed(1) : '0.0'}%`,
  ]);
  y = drawTable(doc, ['Concepto', 'Importe', '% Total'], tableRows, y, [0.50, 0.26, 0.24]);

  // Financial summary
  y = ensureRoom(doc, y, 220, `${empresa} · Interno`, '', COL.accent);
  y = drawSection(doc, 'Resumen Financiero', y);
  y = drawGrid(doc, [
    { label: 'SUBTOTAL COSTES', value: formatMoney(subtotalVal, unit) },
    { label: `CON ERROR (${percentFromRate(info.error_rate)})`, value: formatMoney(info.con_error, unit) },
    { label: 'MARKUP', value: `×${toNumber(info.markup, 2.3).toFixed(2)}` },
    { label: `URGENCIA (${percentFromRate(info.urgencia_rate)})`, value: formatMoney(info.recargo_urgencia, unit) },
    { label: 'COSTE BRUTO', value: formatMoney(costeBrutoVal, unit) },
    { label: 'BENEFICIO NETO', value: formatMoney(beneficioNetoVal, unit) },
    ...(cantidad > 1 ? [
      { label: 'CANTIDAD', value: `${cantidad} ud.` },
      { label: 'PRECIO UNITARIO', value: formatMoney(precioUnitario, unit) },
    ] : []),
  ], y);

  // Price + profit highlight
  y = ensureRoom(doc, y, 160, `${empresa} · Interno`, '', COL.accent);
  y = drawHighlightBox(doc, cantidad > 1 ? 'PRECIO TOTAL' : 'PRECIO FINAL', formatMoney(precioTotal, unit), y, COL.accent);

  // Reference image (optional)
  y = drawImageSection(doc, asText(info.imagen_path, ''), y, `${empresa} · Interno`, COL.accent);

  if (info.precio_minimo_aplicado) {
    doc.roundedRect(50, y, doc.page.width - 100, 34, 6).fillAndStroke('#fef3c7', '#fde68a');
    doc.fillColor('#92400e').fontSize(9).font('Helvetica-Bold')
      .text(`Se aplicó precio mínimo: ${formatMoney(info.precio_minimo, unit)}`, 64, y + 12, { width: doc.page.width - 128 });
    doc.font('Helvetica');
    y += 48;
  }

  // Parameters
  y = ensureRoom(doc, y, 80, `${empresa} · Interno`, '', COL.accent);
  y = drawSection(doc, 'Parámetros Utilizados', y);
  const params = [
    `Diseño: ${asText(info.diseno)}`, `Búsqueda: ${asText(info.busqueda)}`,
    `Soportes: ${asText(info.soportes)}`, `Postprocesado: ${asText(info.postproc)}`,
    `Prob. Error: ${asText(info.prob_error)}`, `Urgencia: ${asText(info.urgencia_nivel)}`,
  ];
  doc.fillColor(COL.gray500).fontSize(8).text(params.join('  |  '), 50, y, { width: doc.page.width - 100 });

  drawFooter(doc, empresa);
}

/* ── PDF generation helper ──────────────────────────────────────────────── */

function sanitizeFileName(name) {
  return String(name || 'documento').replace(/[<>:"/\\|?*]+/g, '_').replace(/_+/g, '_').trim().slice(0, 80);
}

function buildPdfFileName(info, kind) {
  const cliente = sanitizeFileName(info?.cliente || 'cliente');
  const descripcion = sanitizeFileName(info?.descripcion || '').slice(0, 30);
  const fecha = String(info?.fecha || '').replace(/[/\\:]/g, '-') || new Date().toISOString().slice(0, 10);
  const tag = kind === 'empresa' ? 'Interno' : 'Cliente';
  const descPart = descripcion ? `_${descripcion}` : '';
  return `${tag}_${cliente}${descPart}_${fecha}.pdf`;
}

async function writePdfToFile(filePath, summary, kind) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 0 } });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  if (kind === 'empresa') {
    renderCompanyPdf(doc, summary);
  } else {
    renderClientPdf(doc, summary);
  }
  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildPdfBuffer(summary, kind) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 0 } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  if (kind === 'empresa') {
    renderCompanyPdf(doc, summary);
  } else {
    renderClientPdf(doc, summary);
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/* ── Data init / normalize (renderer handles Firestore, main handles logic) ──── */

ipcMain.handle('data:init', async (_evt, rawData, empresa) => {
  empresa = empresa || '3DCC';
  currentEmpresa = empresa;
  if (rawData) {
    cachedData = normalizeData(rawData);
  } else {
    cachedData = normalizeData(createDefaultData());
  }
  cachedData.calc_state.empresa = empresa;
  return cachedData;
});

ipcMain.handle('data:normalize', async (_evt, data) => {
  cachedData = normalizeData(data);
  cachedData.calc_state.empresa = currentEmpresa;
  return cachedData;
});

/* ── Calculator (pure computation, no persistence) ──────────────────────────── */

ipcMain.handle('calc:calculate', async (_evt, payload) => {
  const result = calculateBudget(cachedData, payload);
  cachedData.calc_state = updateCalcState(payload, result.info);
  cachedData.calc_state.empresa = currentEmpresa;
  return { ...result, calcState: cachedData.calc_state };
});

ipcMain.handle('calc:update-state', async (_evt, payload) => {
  cachedData.calc_state = updateCalcState(payload, null);
  cachedData.calc_state.empresa = currentEmpresa;
  return cachedData.calc_state;
});

/* ── Orders (compute + mutate cache, renderer persists) ─────────────────────── */

ipcMain.handle('orders:save-from-result', async (_evt, resultInfo) => {
  const order = saveOrderFromResult(cachedData, resultInfo);
  order.empresa = currentEmpresa;
  return { order, data: cachedData };
});

ipcMain.handle('orders:set-accepted', async (_evt, orderId, partnerStock) => {
  const response = setOrderAccepted(cachedData, orderId, partnerStock || null);
  const order = cachedData.orders.find((o) => o.id === orderId);
  return { ...response, order, inventory: cachedData.filament_stock, data: cachedData };
});

ipcMain.handle('orders:set-sent', async (_evt, orderId) => {
  setOrderSent(cachedData, orderId);
  const order = cachedData.orders.find((o) => o.id === orderId);
  return { ok: true, order, data: cachedData };
});

ipcMain.handle('orders:delete', async (_evt, orderId) => {
  deleteOrder(cachedData, orderId);
  return { ok: true, orderId, data: cachedData };
});

ipcMain.handle('orders:update', async (_evt, params) => {
  const result = updateOrder(cachedData, params);
  return { ...result, data: cachedData };
});

ipcMain.handle('orders:duplicate', async (_evt, orderId) => {
  const result = duplicateOrder(cachedData, orderId);
  return { ...result, data: cachedData };
});

ipcMain.handle('orders:recalculate', async (_evt, params) => {
  const result = recalculateOrder(cachedData, params);
  return { ...result, data: cachedData };
});

ipcMain.handle('orders:add-manual-payment', async (_evt, params) => {
  const result = addManualOrderPayment(cachedData, params);
  return { ...result, data: cachedData };
});

ipcMain.handle('orders:remove-payment-record', async (_evt, params) => {
  const result = removeOrderPaymentRecord(cachedData, params);
  return { ...result, data: cachedData };
});

ipcMain.handle('orders:generate-payment-link', async (_evt, params) => {
  const result = await generateStripePaymentLink(cachedData, params);
  const order = cachedData.orders.find((o) => o.id === params.orderId);
  return { ...result, order, data: cachedData };
});

/* ── Email notifications ────────────────────────────────────────────────── */

ipcMain.handle('mail:send-status', async (_evt, params) => {
  try {
    const result = await sendStatusEmail({
      order: params?.order,
      empresa: params?.empresa || currentEmpresa,
      config: params?.config || cachedData?.global_config || {},
      pdfAttachment: params?.pdfAttachment || null,
    });
    return result;
  } catch (e) {
    return { ok: false, error: e.message || 'Error enviando correo.' };
  }
});

ipcMain.handle('tickets:get-pdf-buffer', async (_evt, payload) => {
  try {
    const summary = payload?.summary && typeof payload.summary === 'object'
      ? payload.summary
      : parseLegacyTicket(payload?.content, payload?.title);
    const ticketKind = summary?.kind || (/empresa|interno/i.test(String(payload?.title || '')) ? 'empresa' : 'cliente');
    const buffer = await buildPdfBuffer(summary, ticketKind);
    return {
      ok: true,
      base64: buffer.toString('base64'),
      filename: buildPdfFileName(summary?.info, ticketKind),
      size: buffer.length,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'No se pudo generar el PDF.' };
  }
});

ipcMain.handle('mail:send-test', async (_evt, params) => {
  try {
    const result = await sendTestEmail({
      config: params?.config || cachedData?.global_config || {},
      empresa: params?.empresa || currentEmpresa,
      to: params?.to,
    });
    return result;
  } catch (e) {
    return { ok: false, error: e.message || 'Error enviando correo de prueba.' };
  }
});

ipcMain.handle('shell:open-url', async (_evt, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('clipboard:write-text', async (_evt, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('tickets:get', async (_evt, info) => {
  return getTickets(info);
});

ipcMain.handle('tickets:save-pdf', async (_evt, payload) => {
  const summary = payload?.summary && typeof payload.summary === 'object'
    ? payload.summary
    : parseLegacyTicket(payload?.content, payload?.title);
  const ticketKind = summary?.kind || (/empresa|interno/i.test(String(payload?.title || '')) ? 'empresa' : 'cliente');
  const defaultDir = String(cachedData?.global_config?.pdf_default_path || '').trim();
  const fileName = buildPdfFileName(summary?.info, ticketKind);

  if (defaultDir && fs.existsSync(defaultDir)) {
    const filePath = path.join(defaultDir, fileName);
    await writePdfToFile(filePath, summary, ticketKind);
    return { canceled: false, filePath };
  }

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: fileName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await writePdfToFile(filePath, summary, ticketKind);
  return { canceled: false, filePath };
});

ipcMain.handle('tickets:save-both-pdfs', async (_evt, payload) => {
  const summary = payload?.summary && typeof payload.summary === 'object'
    ? payload.summary
    : parseLegacyTicket(payload?.content, payload?.title);
  const info = summary?.info || {};
  const defaultDir = String(cachedData?.global_config?.pdf_default_path || '').trim();

  let targetDir = '';
  if (defaultDir && fs.existsSync(defaultDir)) {
    targetDir = defaultDir;
  } else {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona carpeta para guardar los PDFs',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths?.length) return { canceled: true };
    targetDir = filePaths[0];
  }

  const clienteFile = path.join(targetDir, buildPdfFileName(info, 'cliente'));
  const empresaFile = path.join(targetDir, buildPdfFileName(info, 'empresa'));

  const clienteSummary = { kind: 'cliente', info, breakdownDict: summary.breakdownDict || {} };
  const empresaSummary = { kind: 'empresa', info, breakdownDict: summary.breakdownDict || {} };

  await Promise.all([
    writePdfToFile(clienteFile, clienteSummary, 'cliente'),
    writePdfToFile(empresaFile, empresaSummary, 'empresa'),
  ]);

  return { canceled: false, files: [clienteFile, empresaFile] };
});

ipcMain.handle('shell:open-file', async (_evt, filePath) => {
  await shell.openPath(String(filePath || ''));
  return { ok: true };
});

ipcMain.handle('shell:show-item-in-folder', (_evt, filePath) => {
  shell.showItemInFolder(String(filePath || ''));
  return { ok: true };
});

ipcMain.handle('dialog:open-image-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleccionar imagen',
    filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.length) return { canceled: true, filePath: '' };
  return { canceled: false, filePath: filePaths[0] };
});

ipcMain.handle('shell:read-image-as-base64', async (_evt, filePath) => {
  try {
    const resolved = String(filePath || '').trim();
    if (!resolved || !fs.existsSync(resolved)) return { ok: false, data: '', mimeType: '' };
    const buf = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase().replace('.', '');
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const mimeType = mimeMap[ext] || 'image/jpeg';
    return { ok: true, data: buf.toString('base64'), mimeType };
  } catch {
    return { ok: false, data: '', mimeType: '' };
  }
});

ipcMain.handle('dialog:select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths?.length) return { canceled: true, path: '' };
  return { canceled: false, path: filePaths[0] };
});

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Reiniciar ahora', 'Más tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualización lista',
      message: 'Se ha descargado una nueva versión. ¿Reiniciar para aplicarla?',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[updater] check failed', err);
  });
}

app.whenReady().then(async () => {
  // Firestore is now handled by the renderer process (authenticated).
  // Main process is a pure computation engine.
  createWindow();
  setupAutoUpdater();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
