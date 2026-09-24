/**
 * PDF generation for client quotes and internal breakdown sheets.
 *
 * The client-facing PDF is fully brand-driven: every business passes a
 * `branding` object (logo, colours, contact block, conditions, footer) so the
 * documents from 3DCC and SILAB3D look like they come from different companies.
 * The internal workshop sheet keeps its original neutral styling.
 *
 * This module is pure: it has no Electron / Firestore dependencies. `main.js`
 * resolves the branding (merging saved config with per-business presets and
 * loading the logo buffer) and hands a ready-to-use object to these functions.
 */

const fs = require('fs');
const PDFDocument = require('pdfkit');
const path = require('path');
const { formatHoras } = require(path.join(__dirname, '..', 'src', 'shared', 'formatos.mjs'));

/* ── Static palette (structural greys + internal-sheet accent) ───────────── */
const COL = {
  dark: '#0f172a', accent: '#7c3aed',
  gray50: '#f8fafc', gray100: '#f1f5f9', gray200: '#e2e8f0',
  gray400: '#94a3b8', gray500: '#64748b', gray700: '#334155',
  white: '#ffffff',
};

/* ── Small formatting helpers ────────────────────────────────────────────── */
function asText(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}
function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function formatMoney(value, unit = '€') {
  return `${toNumber(value, 0).toFixed(2)} ${unit}`;
}
function percentFromRate(rate) {
  return `${Math.round(toNumber(rate, 0) * 100)}%`;
}

/** Decide readable text colour (black/white) for a given hex background. */
function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return COL.white;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // Relative luminance
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? COL.dark : COL.white;
}

/* ── Branded header (client PDF) ─────────────────────────────────────────── */
/**
 * Draws the full company header: logo, name, tagline and contact block.
 * Two visual styles are supported via `brand.headerStyle`:
 *   - 'dark'  → dark slate band, light text (default for 3DCC)
 *   - 'light' → white band with a coloured accent rule (default for SILAB3D)
 * Returns the Y coordinate where body content can start.
 */
function drawBrandHeader(doc, brand, subtitle) {
  const pw = doc.page.width;
  const bandH = 118;
  const light = brand.headerStyle === 'light';
  const bg = light ? COL.white : COL.dark;
  const nameColor = light ? COL.dark : COL.white;
  const subColor = light ? COL.gray500 : COL.gray400;

  doc.save();
  doc.rect(0, 0, pw, bandH).fill(bg);
  if (light) {
    // Hairline separating header from body on light style
    doc.rect(0, bandH, pw, 1).fill(COL.gray200);
  }
  // Accent strip in the brand colour
  doc.rect(0, bandH, pw, 6).fill(brand.primary);
  doc.restore();

  let textLeft = 50;
  // Logo
  if (brand.showLogo && brand.logoBuffer) {
    try {
      const logoSize = 64;
      doc.image(brand.logoBuffer, 50, 27, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
      textLeft = 50 + logoSize + 16;
    } catch {
      textLeft = 50;
    }
  }

  // Company name + tagline
  doc.fillColor(nameColor).fontSize(22).font('Helvetica-Bold')
    .text(asText(brand.legalName, brand.empresa), textLeft, 32, { width: pw - textLeft - 200, lineBreak: false });
  if (brand.tagline) {
    doc.fillColor(brand.primary).fontSize(10).font('Helvetica-Bold')
      .text(brand.tagline.toUpperCase(), textLeft, 62, { width: pw - textLeft - 200, lineBreak: false });
  }
  if (subtitle) {
    doc.fillColor(subColor).fontSize(9).font('Helvetica')
      .text(subtitle, textLeft, brand.tagline ? 78 : 64, { width: pw - textLeft - 200 });
  }

  // Contact block (right-aligned)
  const contact = [brand.email, brand.phone, brand.web, brand.address].filter(Boolean);
  if (contact.length) {
    const blockW = 180;
    const x = pw - 50 - blockW;
    let cy = 30;
    contact.slice(0, 4).forEach((line) => {
      doc.fillColor(light ? COL.gray700 : COL.gray400).fontSize(8.5).font('Helvetica')
        .text(line, x, cy, { width: blockW, align: 'right' });
      cy += 13;
    });
  }

  doc.font('Helvetica');
  return bandH + 26;
}

/** Slim header used on continuation pages so we don't repeat the full block. */
function drawContinuationHeader(doc, brand) {
  const pw = doc.page.width;
  doc.save();
  doc.rect(0, 0, pw, 34).fill(brand.headerStyle === 'light' ? COL.white : COL.dark);
  doc.rect(0, 34, pw, 4).fill(brand.primary);
  doc.restore();
  doc.fillColor(brand.headerStyle === 'light' ? COL.dark : COL.white)
    .fontSize(11).font('Helvetica-Bold')
    .text(asText(brand.legalName, brand.empresa), 50, 11, { width: pw - 100, lineBreak: false });
  doc.font('Helvetica');
  return 56;
}

/* ── Neutral header (internal sheet) ─────────────────────────────────────── */
function drawPlainHeader(doc, title, subtitle, accentColor) {
  const pw = doc.page.width;
  doc.save();
  doc.rect(0, 0, pw, 100).fill(COL.dark);
  doc.rect(0, 100, pw, 6).fill(accentColor);
  doc.restore();
  doc.fillColor(COL.white).fontSize(20).font('Helvetica-Bold').text(title, 50, 32, { width: pw - 100 });
  doc.fillColor(COL.gray400).fontSize(10).font('Helvetica').text(subtitle, 50, 62, { width: pw - 100 });
  doc.font('Helvetica');
  return 126;
}

/* ── Shared content helpers (colour comes from the caller) ───────────────── */
function drawSection(doc, text, y, color) {
  const pw = doc.page.width;
  doc.fillColor(color).fontSize(13).font('Helvetica-Bold').text(text, 50, y);
  doc.moveTo(50, y + 20).lineTo(pw - 50, y + 20).lineWidth(0.75).strokeColor(COL.gray200).stroke();
  doc.font('Helvetica');
  return y + 30;
}

function drawGrid(doc, rows, y) {
  const left = 50;
  const width = doc.page.width - 100;
  const cols = 2;
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

function drawHighlightBox(doc, label, value, y, color) {
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
    doc.fillColor(COL.white).fontSize(9).font('Helvetica-Bold').text(h, xOff + 10, y + 9, { width: w - 20, align });
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

  doc.strokeColor(COL.gray200).lineWidth(0.5);
  let sep = left;
  for (let i = 0; i < widths.length - 1; i++) {
    sep += widths[i] * tableWidth;
    doc.moveTo(sep, y).lineTo(sep, y + totalH).stroke();
  }
  return y + totalH + 16;
}

function drawClientFooter(doc, brand) {
  const pw = doc.page.width;
  const ph = doc.page.height;
  const note = asText(brand.footerNote, '');
  const contact = [brand.email, brand.phone, brand.web].filter(Boolean).join('  ·  ');
  const tagline = `${asText(brand.legalName, brand.empresa)}${contact ? '  ·  ' + contact : ''}`;
  const hasNote = !!note;
  const footerH = hasNote ? 46 : 32;

  doc.save();
  doc.rect(0, ph - footerH, pw, footerH).fill(COL.gray50);
  doc.rect(0, ph - footerH, pw, 3).fill(brand.primary);
  doc.restore();

  let ty = ph - footerH + 9;
  if (hasNote) {
    doc.fillColor(COL.gray700).fontSize(8.5).font('Helvetica-Bold')
      .text(note, 50, ty, { width: pw - 100, align: 'center' });
    ty += 13;
  }
  doc.fillColor(COL.gray400).fontSize(8).font('Helvetica')
    .text(`${tagline}  ·  ${new Date().toLocaleDateString('es-ES')}`, 50, ty, { width: pw - 100, align: 'center' });
}

function drawPlainFooter(doc, label) {
  const pw = doc.page.width;
  const ph = doc.page.height;
  doc.save();
  doc.rect(0, ph - 36, pw, 36).fill(COL.gray50);
  doc.fillColor(COL.gray400).fontSize(8).font('Helvetica')
    .text(`${asText(label)} · Documento generado automáticamente · ${new Date().toLocaleDateString('es-ES')}`, 50, ph - 24, { width: pw - 100, align: 'center' });
  doc.restore();
}

/** Page-break guard. `onNewPage` redraws the appropriate header and returns new y. */
function ensureRoom(doc, y, requiredHeight, onNewPage) {
  const bottomLimit = doc.page.height - 60;
  if (y + requiredHeight <= bottomLimit) return y;
  doc.addPage();
  return onNewPage();
}

function drawImageSection(doc, imagePath, y, color, onNewPage) {
  if (!imagePath) return y;
  try {
    if (!fs.existsSync(imagePath)) return y;
    const pw = doc.page.width;
    const maxW = pw - 100;
    const maxH = 180;
    y = ensureRoom(doc, y, maxH + 50, onNewPage);
    y = drawSection(doc, 'Imagen de referencia', y, color);
    doc.image(imagePath, 50, y, { fit: [maxW, maxH], align: 'center' });
    y += maxH + 14;
  } catch {
    /* ignore unreadable image */
  }
  return y;
}

/* ── Client PDF ──────────────────────────────────────────────────────────── */
function renderClientPdf(doc, summary, brand) {
  const info = summary.info || {};
  const unit = asText(info.unit, '€');
  const accent = brand.primary;
  const cantidad = Math.max(1, Math.floor(Number(info.cantidad) || 1));
  const precioTotal = toNumber(info.precio_final, 0);
  const precioUnitario = Math.round((precioTotal / cantidad) * 100) / 100;
  const cont = () => drawContinuationHeader(doc, brand);

  let y = drawBrandHeader(
    doc, brand,
    `Presupuesto para ${asText(info.cliente)} · ${asText(info.fecha, new Date().toLocaleDateString('es-ES'))}`,
  );

  y = drawSection(doc, 'Datos del Proyecto', y, accent);
  const gridItems = [
    { label: 'CLIENTE', value: asText(info.cliente) },
    { label: 'DESCRIPCIÓN', value: asText(info.descripcion) },
    { label: 'MATERIAL', value: `${asText(info.filamento)} (${asText(info.filamento_color)})` },
    { label: 'PESO ESTIMADO', value: `${asText(info.peso, '0')} g` },
    { label: 'TIEMPO DE IMPRESORA', value: asText(formatHoras(info.horas), '0 h') },
    { label: 'ENTREGA', value: info.urgencia_nivel === 'Normal' ? 'Plazo estándar' : 'Urgente — Lo antes posible' },
  ];
  if (cantidad > 1) {
    gridItems.push({ label: 'CANTIDAD', value: `${cantidad} ud.` });
    gridItems.push({ label: 'PRECIO UNITARIO', value: formatMoney(precioUnitario, unit) });
  }
  y = drawGrid(doc, gridItems, y);

  y = ensureRoom(doc, y, 100, cont);
  y = drawHighlightBox(doc, cantidad > 1 ? 'PRECIO TOTAL' : 'PRECIO FINAL', formatMoney(precioTotal, unit), y, accent);

  y = drawImageSection(doc, asText(info.imagen_path, ''), y, accent, cont);

  const conditions = (Array.isArray(brand.conditions) && brand.conditions.length)
    ? brand.conditions
    : DEFAULT_CONDITIONS;
  const conditionsHeight = 30 + conditions.length * 22 + 20;
  y = ensureRoom(doc, y, conditionsHeight, cont);
  y = drawSection(doc, 'Condiciones', y, accent);
  conditions.forEach((c) => {
    doc.fillColor(COL.gray500).fontSize(9).text(`•  ${c}`, 56, y, { width: doc.page.width - 112 });
    y += 22;
  });

  drawClientFooter(doc, brand);
}

const DEFAULT_CONDITIONS = [
  'El coste indicado es el precio final del proyecto, incluyendo todos los gastos necesarios para llevarlo a cabo.',
  'Para plazos estándar, el tiempo de entrega dependerá de la complejidad del proyecto y la cola de trabajo en curso.',
  'Se requiere el abono del 50% del presupuesto como anticipo para iniciar la producción.',
  'Nuestros términos y condiciones generales están disponibles en nuestra web y se aplican a este presupuesto.',
];

/* ── Internal / company PDF (neutral styling, unchanged look) ────────────── */
function renderCompanyPdf(doc, summary) {
  const info = summary.info || {};
  const unit = asText(info.unit, '€');
  const empresa = asText(info.empresa, '3DCC');
  const accent = COL.accent;
  const breakdownDict = summary.breakdownDict || {};
  const entries = Object.entries(breakdownDict).map(([label, value]) => ({ label, value: toNumber(value, 0) }));
  const subtotalVal = entries.reduce((acc, item) => acc + item.value, 0);
  const isBruto = (label) => ['Filamento', 'Electricidad', 'Deterioro imp.', 'Desgaste impresora'].includes(String(label || '').trim());
  const costeBrutoVal = entries.filter((item) => isBruto(item.label)).reduce((acc, item) => acc + item.value, 0);
  const cantidad = Math.max(1, Math.floor(Number(info.cantidad) || 1));
  const precioTotal = toNumber(info.precio_final, 0);
  const precioUnitario = Math.round((precioTotal / cantidad) * 100) / 100;
  const beneficioNetoVal = precioTotal - costeBrutoVal;
  const cont = () => drawPlainHeader(doc, `${empresa} · Interno`, '', accent);

  let y = drawPlainHeader(
    doc,
    `${empresa} · Desglose Interno`,
    `${asText(info.fecha, new Date().toLocaleDateString('es-ES'))} · ${asText(info.cliente, 'Sin nombre')} · ${asText(info.descripcion)}`,
    accent,
  );

  y = drawSection(doc, 'Datos Operativos', y, accent);
  y = drawGrid(doc, [
    { label: 'CLIENTE', value: asText(info.cliente) },
    { label: 'DESCRIPCIÓN', value: asText(info.descripcion) },
    { label: 'IMPRESORA', value: asText(info.impresora) },
    { label: 'MATERIAL', value: `${asText(info.filamento)} (${asText(info.filamento_color)})` },
    { label: 'PRECIO MATERIAL', value: formatMoney(info.precio_kg, `${unit}/kg`) },
    { label: 'PESO', value: `${asText(info.peso, '0')} g` },
    { label: 'TIEMPO', value: asText(formatHoras(info.horas), '0 h') },
    { label: 'URGENCIA', value: asText(info.urgencia_nivel, 'Normal') },
    ...(cantidad > 1 ? [{ label: 'CANTIDAD', value: `${cantidad} ud.` }] : []),
  ], y);

  y = ensureRoom(doc, y, 200, cont);
  y = drawSection(doc, 'Desglose de Costes', y, accent);
  const tableRows = entries.map((item) => [
    item.label,
    formatMoney(item.value, unit),
    `${subtotalVal > 0 ? ((item.value / subtotalVal) * 100).toFixed(1) : '0.0'}%`,
  ]);
  y = drawTable(doc, ['Concepto', 'Importe', '% Total'], tableRows, y, [0.50, 0.26, 0.24]);

  y = ensureRoom(doc, y, 220, cont);
  y = drawSection(doc, 'Resumen Financiero', y, accent);
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

  y = ensureRoom(doc, y, 160, cont);
  y = drawHighlightBox(doc, cantidad > 1 ? 'PRECIO TOTAL' : 'PRECIO FINAL', formatMoney(precioTotal, unit), y, accent);

  y = drawImageSection(doc, asText(info.imagen_path, ''), y, accent, cont);

  if (info.precio_minimo_aplicado) {
    doc.roundedRect(50, y, doc.page.width - 100, 34, 6).fillAndStroke('#fef3c7', '#fde68a');
    doc.fillColor('#92400e').fontSize(9).font('Helvetica-Bold')
      .text(`Se aplicó precio mínimo: ${formatMoney(info.precio_minimo, unit)}`, 64, y + 12, { width: doc.page.width - 128 });
    doc.font('Helvetica');
    y += 48;
  }

  y = ensureRoom(doc, y, 80, cont);
  y = drawSection(doc, 'Parámetros Utilizados', y, accent);
  const params = [
    `Diseño: ${asText(info.diseno)}${Number(info.diseno_horas) > 0 ? ` (${info.diseno_horas} h)` : ''}`,
    `Post-procesado: ${asText(info.postproc)}${Number(info.cantidad) > 1 ? ` x ${info.cantidad} uds.` : ''}`,
    `Prob. Error: ${asText(info.prob_error)}`, `Urgencia: ${asText(info.urgencia_nivel)}`,
  ];
  doc.fillColor(COL.gray500).fontSize(8).text(params.join('  |  '), 50, y, { width: doc.page.width - 100 });

  drawPlainFooter(doc, empresa);
}

/* ── File-name helper ────────────────────────────────────────────────────── */
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

/* ── Document orchestration ──────────────────────────────────────────────── */
function renderInto(doc, summary, kind, branding) {
  if (kind === 'empresa') {
    renderCompanyPdf(doc, summary);
  } else {
    renderClientPdf(doc, summary, branding || {});
  }
}

function newDoc() {
  return new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 0 } });
}

async function writePdfToFile(filePath, summary, kind, branding) {
  const doc = newDoc();
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  renderInto(doc, summary, kind, branding);
  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildPdfBuffer(summary, kind, branding) {
  const doc = newDoc();
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  renderInto(doc, summary, kind, branding);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

module.exports = {
  writePdfToFile,
  buildPdfBuffer,
  buildPdfFileName,
  DEFAULT_CONDITIONS,
  contrastText,
};
