const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log/main');
const path = require('path');
const fs = require('fs');
const pdf = require('./pdf');

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

/* ── PDF branding ────────────────────────────────────────────────────────── */
/**
 * Per-business visual presets. Used as defaults when the saved config does not
 * override a field, so 3DCC and SILAB3D produce clearly different documents out
 * of the box. Everything here is overridable from Settings → Marca / PDF.
 */
const BRAND_PRESETS = {
  '3DCC': {
    logoFile: 'logos/logo3dcc.png',
    primary: '#2563eb',
    headerStyle: 'dark',
    tagline: 'Impresión 3D al alcance de todos',
  },
  'SILAB3D': {
    logoFile: 'logos/silab3dlogo.jpg',
    primary: '#0f766e',
    headerStyle: 'light',
    tagline: 'Innovación capa a capa',
  },
  DEFAULT: {
    logoFile: '',
    primary: '#2563eb',
    headerStyle: 'dark',
    tagline: '',
  },
};

// Logo buffers are cached by absolute path + mtime so repeated PDF exports
// don't re-read the file from disk each time.
const logoCache = new Map();
function loadLogoBuffer(logoPath) {
  const raw = String(logoPath || '').trim();
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? raw : path.join(app.getAppPath(), raw);
  try {
    const { mtimeMs } = fs.statSync(resolved);
    const key = `${resolved}:${mtimeMs}`;
    if (logoCache.has(key)) return logoCache.get(key);
    const buf = fs.readFileSync(resolved);
    logoCache.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}

function parseConditions(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Build the branding object handed to the client-PDF renderer. Merges saved
 * config (`global_config.pdf_*`) over the per-business preset, falling back to
 * existing email contact fields so contact details work without re-entry.
 */
function resolveBranding(empresa) {
  const cfg = cachedData?.global_config || {};
  const name = String(empresa || currentEmpresa || '3DCC');
  const preset = BRAND_PRESETS[name.toUpperCase()] || BRAND_PRESETS.DEFAULT;
  const logoPath = String(cfg.pdf_logo_path || '').trim() || preset.logoFile;

  return {
    empresa: name,
    showLogo: cfg.pdf_show_logo !== false,
    logoBuffer: (cfg.pdf_show_logo !== false) ? loadLogoBuffer(logoPath) : null,
    primary: String(cfg.pdf_primary_color || '').trim() || preset.primary,
    headerStyle: String(cfg.pdf_header_style || '').trim() || preset.headerStyle,
    legalName: String(cfg.pdf_company_legal || '').trim() || name,
    tagline: String(cfg.pdf_tagline || '').trim() || preset.tagline,
    email: String(cfg.pdf_contact_email || cfg.email_from || '').trim(),
    phone: String(cfg.pdf_contact_phone || cfg.email_whatsapp || '').trim(),
    web: String(cfg.pdf_contact_web || cfg.email_website || '').trim(),
    address: String(cfg.pdf_contact_address || '').trim(),
    footerNote: String(cfg.pdf_footer_note || cfg.email_footer_note || '').trim(),
    conditions: parseConditions(cfg.pdf_conditions),
  };
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
    const branding = resolveBranding(summary?.info?.empresa);
    const buffer = await pdf.buildPdfBuffer(summary, ticketKind, branding);
    return {
      ok: true,
      base64: buffer.toString('base64'),
      filename: pdf.buildPdfFileName(summary?.info, ticketKind),
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
  const branding = resolveBranding(summary?.info?.empresa);
  const defaultDir = String(cachedData?.global_config?.pdf_default_path || '').trim();
  const fileName = pdf.buildPdfFileName(summary?.info, ticketKind);

  if (defaultDir && fs.existsSync(defaultDir)) {
    const filePath = path.join(defaultDir, fileName);
    await pdf.writePdfToFile(filePath, summary, ticketKind, branding);
    return { canceled: false, filePath };
  }

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: fileName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await pdf.writePdfToFile(filePath, summary, ticketKind, branding);
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

  const branding = resolveBranding(info.empresa);
  const clienteFile = path.join(targetDir, pdf.buildPdfFileName(info, 'cliente'));
  const empresaFile = path.join(targetDir, pdf.buildPdfFileName(info, 'empresa'));

  const clienteSummary = { kind: 'cliente', info, breakdownDict: summary.breakdownDict || {} };
  const empresaSummary = { kind: 'empresa', info, breakdownDict: summary.breakdownDict || {} };

  await Promise.all([
    pdf.writePdfToFile(clienteFile, clienteSummary, 'cliente', branding),
    pdf.writePdfToFile(empresaFile, empresaSummary, 'empresa', branding),
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

  // Log a fichero: %APPDATA%\3dcalc\logs\main.log — en la app empaquetada la
  // consola no existe, así que sin esto los fallos del updater son invisibles.
  log.initialize();
  log.transports.file.level = 'info';
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  // Fallback: si eligen "Al salir de la app", se instala sola al cerrar.
  autoUpdater.autoInstallOnAppQuit = true;

  // El fallo clásico "no se puede actualizar: la app está abierta" ocurre
  // porque el instalador NSIS (lanzado por la propia app) encuentra ALGÚN
  // proceso 3DCALC.exe vivo: un renderer/GPU que tarda en morir, un zombi
  // de una sesión anterior o una instancia elevada. Estrategia:
  //   1. destroy() de todas las ventanas → los procesos hijos mueren YA,
  //      sin pasar por close/beforeunload.
  //   2. taskkill de cualquier 3DCALC.exe huérfano que no sea este proceso.
  //   3. quitAndInstall silencioso con margen para liberar ficheros.
  let installing = false;
  const installUpdateNow = () => {
    if (installing) return;
    installing = true;
    log.info('[updater] Instalando: cerrando ventanas y lanzando instalador…');

    app.removeAllListeners('window-all-closed');
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.removeAllListeners('close'); w.destroy(); } catch { /* ya cerrada */ }
    }
    mainWindow = null;

    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /F /IM "3DCALC.exe" /FI "PID ne ${process.pid}"`, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      // Sin huérfanos, o proceso de otro usuario/elevado que no podemos matar.
      log.warn('[updater] taskkill de huérfanos (ignorable):', e.message);
    }

    setTimeout(() => {
      try {
        // isSilent=true: NSIS /S cierra el proceso principal él mismo.
        // isForceRunAfter=true: relanza 3DCALC al terminar.
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        log.error('[updater] quitAndInstall falló:', e);
        installing = false;
      }
    }, 400);
  };

  autoUpdater.on('checking-for-update', () => log.info('[updater] Comprobando actualizaciones…'));
  autoUpdater.on('update-available', (info) => log.info(`[updater] Disponible: ${info?.version}`));
  autoUpdater.on('update-not-available', () => log.info('[updater] Sin novedades.'));
  autoUpdater.on('error', (err) => log.error('[updater] Error en la actualización:', err));

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] Descargada ${info?.version || '?'} → ${info?.downloadedFile || ''}`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Reiniciar y actualizar', 'Al salir de la app'],
      defaultId: 0,
      cancelId: 1,
      title: 'Actualización lista',
      message: `Nueva versión ${info?.version || ''} descargada. ¿Aplicarla ahora?`,
      detail: 'Si eliges "Al salir de la app", se instalará sola cuando cierres 3DCALC.',
    }).then(({ response }) => {
      if (response === 0) installUpdateNow();
      else log.info('[updater] Pospuesta: se instalará al salir (autoInstallOnAppQuit).');
    });
  });

  // Comprobar actualizaciones al inicio
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.error('[updater] Fallo al comprobar actualizaciones:', err);
  });
}

// Una sola instancia: si hay procesos duplicados, el instalador de
// actualizaciones nunca puede cerrarlos todos y la actualización falla.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
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

// Al salir, rematar cualquier 3DCALC.exe huérfano (p. ej. el crashpad handler
// de Electron, que se llama igual que la app y a veces sobrevive al cierre).
// Un solo fantasma hace fallar TODOS los instaladores NSIS con el aviso de
// "No se puede cerrar 3DCALC", incluso con la app cerrada.
app.on('quit', () => {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    execSync(`taskkill /F /IM "3DCALC.exe" /FI "PID ne ${process.pid}"`, { stdio: 'ignore', windowsHide: true });
  } catch { /* no había huérfanos */ }
});
