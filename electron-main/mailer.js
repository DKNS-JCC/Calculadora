const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { app, nativeImage } = require('electron');

/* ── Logo resolution + on-the-fly optimization ─────────────────────────── */
const LOGO_FILE = { '3DCC': 'logo3dcc.png', 'SILAB3D': 'silab3dlogo.jpg' };
const BRAND_COLOR = { '3DCC': '#2563eb', 'SILAB3D': '#7c3aed' };
const BRAND_GRADIENT = {
  '3DCC': 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 50%, #3b82f6 100%)',
  'SILAB3D': 'linear-gradient(135deg, #6d28d9 0%, #7c3aed 50%, #a855f7 100%)',
};

// Cache resized logos so we only do the resize once per session.
const LOGO_CACHE = new Map();
const LOGO_TARGET_WIDTH = 240;   // ~120px display × 2 for retina
const LOGO_JPEG_QUALITY = 82;

function resolveLogoPath(empresa) {
  const file = LOGO_FILE[empresa] || LOGO_FILE['3DCC'];
  const candidates = [
    path.join(app.getAppPath(), 'logos', file),
    path.join(process.resourcesPath || '', 'logos', file),
    path.join(__dirname, '..', 'logos', file),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Returns a small, optimized buffer of the empresa's logo so emails load
 * fast on slow connections. PNG with alpha is preserved as PNG; otherwise
 * we encode JPEG @ 82 to keep weight low. Cached in memory by empresa.
 */
function getOptimizedLogo(empresa) {
  if (LOGO_CACHE.has(empresa)) return LOGO_CACHE.get(empresa);
  const logoPath = resolveLogoPath(empresa);
  if (!logoPath) {
    LOGO_CACHE.set(empresa, null);
    return null;
  }
  try {
    const ext = path.extname(logoPath).toLowerCase();
    const img = nativeImage.createFromPath(logoPath);
    if (img.isEmpty()) throw new Error('nativeImage returned empty');
    const { width, height } = img.getSize();
    const scale = Math.min(1, LOGO_TARGET_WIDTH / Math.max(width || 1, height || 1));
    const targetW = Math.max(1, Math.round((width || LOGO_TARGET_WIDTH) * scale));
    const resized = scale < 1
      ? img.resize({ width: targetW, quality: 'best' })
      : img;
    // PNG keeps transparency for the dark gradient header; JPG photos go to JPEG.
    const useJpeg = ext === '.jpg' || ext === '.jpeg';
    const buffer = useJpeg ? resized.toJPEG(LOGO_JPEG_QUALITY) : resized.toPNG();
    const result = {
      buffer,
      filename: useJpeg ? 'logo.jpg' : 'logo.png',
      contentType: useJpeg ? 'image/jpeg' : 'image/png',
      size: buffer.length,
    };
    LOGO_CACHE.set(empresa, result);
    return result;
  } catch (e) {
    console.warn('[mailer] Logo optimization failed, falling back to raw file:', e?.message || e);
    try {
      const buffer = fs.readFileSync(logoPath);
      const ext = path.extname(logoPath).toLowerCase();
      const result = {
        buffer,
        filename: path.basename(logoPath),
        contentType: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png',
        size: buffer.length,
      };
      LOGO_CACHE.set(empresa, result);
      return result;
    } catch {
      LOGO_CACHE.set(empresa, null);
      return null;
    }
  }
}

/* ── Lifecycle copy ─────────────────────────────────────────────────────── */
const STATUS_COPY = {
  'Presupuesto enviado': {
    title: 'Tu presupuesto está listo',
    eyebrow: 'PRESUPUESTO',
    accent: '#3b82f6',
    icon: '📨',
    message: 'Hemos preparado el presupuesto de tu pedido. Revísalo cuando puedas y, en cuanto lo aceptes, lo metemos en producción.',
    nextStep: 'A la espera de tu confirmación.',
    showPrice: true,
    showProgress: true,
    showNextStep: true,
  },
  'Aceptado': {
    title: '¡Pedido confirmado!',
    eyebrow: 'CONFIRMACIÓN',
    accent: '#10b981',
    icon: '✅',
    message: 'Hemos recibido tu confirmación. Tu pedido entra en cola y muy pronto comenzaremos a imprimirlo.',
    nextStep: 'Te avisaremos cuando entre en la impresora.',
    showPrice: true,
    showPayment: true,
    showProgress: true,
    showNextStep: true,
  },
  'En producción': {
    title: 'Imprimiendo tu pedido',
    eyebrow: 'EN PRODUCCIÓN',
    accent: '#f59e0b',
    icon: '🖨️',
    message: 'Tu pedido está ahora mismo en la impresora. Cuando termine pasará al post-procesado: limpieza, soportes y acabados.',
    nextStep: 'Te avisaremos cuando pase a la siguiente fase.',
    showPrice: false,
    showProgress: true,
    showNextStep: true,
  },
  'Post-procesado': {
    title: 'Dándole los últimos retoques',
    eyebrow: 'ACABADOS',
    accent: '#8b5cf6',
    icon: '🛠️',
    message: 'La impresión ha terminado. Estamos retirando soportes, lijando, ensamblando o pintando — según lo que acordamos.',
    nextStep: 'Próximo paso: revisión final y empaquetado.',
    showPrice: false,
    showProgress: true,
    showNextStep: true,
  },
  'Listo para entregar': {
    title: '¡Tu pedido está listo!',
    eyebrow: 'LISTO',
    accent: '#0ea5e9',
    icon: '📦',
    message: 'Hemos terminado tu pedido y ya está empaquetado. Coordina con nosotros la recogida o el envío.',
    nextStep: 'Te esperamos para coordinar la entrega.',
    showPrice: true,    // only displays if there's still a pending balance
    showPayment: true,
    showProgress: true,
    showNextStep: true,
  },
  'Entregado': {
    title: '¡Gracias por tu pedido!',
    eyebrow: 'ENTREGADO',
    accent: '#059669',
    icon: '🎉',
    message: 'Tu pedido ha sido entregado. Esperamos que cumpla con todo lo que esperabas. Si tienes cualquier comentario, sugerencia o necesitas algo más, estamos aquí.',
    nextStep: 'Cuentanos qué tal tu experiencia o si necesitas algo más.',
    showPrice: false,
    showProgress: false,
    showNextStep: false,
    isFinal: true,
  },
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMoney(value, unit = '€') {
  const n = Number(value || 0);
  return `${n.toFixed(2)} ${unit}`;
}

function fmtFecha(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (m) return `${parseInt(m[3], 10)}/${parseInt(m[2], 10)}/${m[1]}`;
  return String(s);
}

function normalizeUrl(input, prefix = 'https://') {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return prefix + s.replace(/^\/+/, '');
}

function sanitizePhone(input) {
  const s = String(input || '').trim().replace(/[\s\-()]/g, '');
  if (!s) return '';
  // Keep + only at start
  return s.replace(/(?!^)\+/g, '');
}

function whatsappLink(phone, message) {
  const num = sanitizePhone(phone).replace(/^\+/, '');
  if (!num) return '';
  const params = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${num}${params}`;
}

function instagramLink(handleOrUrl) {
  const s = String(handleOrUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const handle = s.replace(/^@/, '');
  return `https://instagram.com/${handle}`;
}

/* ── Contact / Social block ─────────────────────────────────────────────── */

function buildContactButtons(config, order, copy) {
  const wa = whatsappLink(config.email_whatsapp, copy.isFinal
    ? `Hola, gracias por mi pedido #${order.id}.`
    : `Hola, te escribo por mi pedido #${order.id}.`);
  const ig = instagramLink(config.email_instagram);
  const web = normalizeUrl(config.email_website);

  const buttons = [];
  if (copy.isFinal) {
    buttons.push({
      href: 'https://reviewthis.biz/3dcc',
      label: 'Dejar una reseña',
      bg: '#fbbf24', // Amber/Yellow color for reviews
      color: '#111827',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:6px;"><path d="M12 .587l3.668 7.425 8.167 1.186-5.914 5.763 1.396 8.134L12 19.231l-7.317 3.864 1.396-8.134-5.914-5.763 8.167-1.186z"/></svg>`,
    });
  }
  if (wa) buttons.push({
    href: wa,
    label: copy.isFinal ? 'Cuéntanos qué tal' : 'WhatsApp',
    bg: '#25D366',
    color: '#ffffff',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#fff" style="vertical-align:-2px;margin-right:6px;"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.81 11.81 0 0 1 8.413 3.488 11.825 11.825 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.371-.025-.52-.075-.149-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.71.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>`,
  });
  if (ig) buttons.push({
    href: ig,
    label: 'Instagram',
    bg: 'linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)',
    color: '#ffffff',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#fff" style="vertical-align:-2px;margin-right:6px;"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>`,
  });
  if (web) buttons.push({
    href: web,
    label: 'Web',
    bg: '#0f172a',
    color: '#ffffff',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#fff" style="vertical-align:-2px;margin-right:6px;"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/></svg>`,
  });

  if (!buttons.length) return '';

  const items = buttons.map((b) => `
    <td style="padding:0 4px;">
      <a href="${escapeHtml(b.href)}" style="display:inline-block;background:${b.bg};color:${b.color};text-decoration:none;font:600 13px/1 -apple-system,Segoe UI,sans-serif;padding:11px 16px;border-radius:10px;white-space:nowrap;">
        ${b.icon}${escapeHtml(b.label)}
      </a>
    </td>`).join('');

  const heading = copy.isFinal ? '¿Qué tal te ha ido?' : '¿Hablamos?';

  return `
    <tr><td style="padding:8px 32px 0;">
      <div style="font:600 11px/1 -apple-system,Segoe UI,sans-serif;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;">${escapeHtml(heading)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>${items}</tr>
      </table>
    </td></tr>`;
}

/* ── Section builders ───────────────────────────────────────────────────── */

function buildProgressSteps(currentStatus, accent) {
  const lifecycle = ['Presupuesto enviado', 'Aceptado', 'En producción', 'Post-procesado', 'Listo para entregar', 'Entregado'];
  const shortLabels = ['Presupuesto', 'Aceptado', 'Producción', 'Acabados', 'Listo', 'Entregado'];
  const currentIdx = lifecycle.indexOf(currentStatus);
  return lifecycle.map((step, i) => {
    const done = i < currentIdx;
    const current = i === currentIdx;
    const bg = (done || current) ? accent : '#e5e7eb';
    const txtColor = (done || current) ? '#ffffff' : '#9ca3af';
    const labelColor = current ? accent : (done ? '#374151' : '#9ca3af');
    const fontWeight = current ? '700' : '500';
    return `
      <td align="center" valign="top" style="padding:0 2px;width:${100 / lifecycle.length}%;">
        <div style="width:26px;height:26px;border-radius:13px;background:${bg};color:${txtColor};font:600 11px/26px -apple-system,Segoe UI,sans-serif;margin:0 auto 6px;${current ? `box-shadow:0 0 0 4px ${accent}26;` : ''}">${done ? '✓' : i + 1}</div>
        <div style="font:${fontWeight} 9px/1.2 -apple-system,Segoe UI,sans-serif;color:${labelColor};letter-spacing:.02em;">${escapeHtml(shortLabels[i])}</div>
      </td>`;
  }).join('');
}

function buildOrderCard(order, copy, brand, unit) {
  const total = fmtMoney(order.precio_final, unit);
  const pagado = fmtMoney(order.importe_pagado, unit);
  const pendienteNum = Math.max(0, Number(order.precio_final || 0) - Number(order.importe_pagado || 0));
  const pendiente = fmtMoney(pendienteNum, unit);
  const showPrice = !!copy.showPrice && (copy.eyebrow !== 'LISTO' || pendienteNum > 0);
  const showPaymentBlock = !!copy.showPayment && Number(order.precio_final || 0) > 0;

  const rows = [];
  rows.push(`
    <tr>
      <td style="padding:8px 0;color:#6b7280;width:38%;">Pedido</td>
      <td style="padding:8px 0;text-align:right;font-weight:600;font-family:Menlo,Consolas,monospace;color:#111827;">#${escapeHtml(order.id)}</td>
    </tr>`);
  if (order.descripcion) rows.push(`
    <tr>
      <td style="padding:6px 0;color:#6b7280;">Descripción</td>
      <td style="padding:6px 0;text-align:right;font-weight:500;color:#111827;">${escapeHtml(order.descripcion)}</td>
    </tr>`);
  if (order.fecha) rows.push(`
    <tr>
      <td style="padding:6px 0;color:#6b7280;">Fecha</td>
      <td style="padding:6px 0;text-align:right;color:#111827;">${escapeHtml(fmtFecha(order.fecha))}</td>
    </tr>`);
  if (Number(order.cantidad || 0) > 1) rows.push(`
    <tr>
      <td style="padding:6px 0;color:#6b7280;">Cantidad</td>
      <td style="padding:6px 0;text-align:right;color:#111827;">${escapeHtml(String(order.cantidad))} ud.</td>
    </tr>`);

  let priceBlock = '';
  if (showPrice) {
    const priceRows = [];
    priceRows.push(`
      <tr>
        <td style="padding:10px 0 4px;color:#374151;font-weight:600;">Total</td>
        <td style="padding:10px 0 4px;text-align:right;font-weight:700;font-size:17px;color:${brand};">${total}</td>
      </tr>`);
    if (showPaymentBlock && Number(order.importe_pagado || 0) > 0) priceRows.push(`
      <tr>
        <td style="padding:4px 0;color:#6b7280;font-size:13px;">Cobrado</td>
        <td style="padding:4px 0;text-align:right;color:#059669;font-weight:600;font-size:13px;">${pagado}</td>
      </tr>`);
    if (showPaymentBlock && pendienteNum > 0) priceRows.push(`
      <tr>
        <td style="padding:4px 0;color:#6b7280;font-size:13px;">Pendiente</td>
        <td style="padding:4px 0;text-align:right;color:#d97706;font-weight:700;font-size:13px;">${pendiente}</td>
      </tr>`);
    priceBlock = `<tr><td colspan="2" style="border-top:1px solid #e5e7eb;padding:0;height:1px;"></td></tr>${priceRows.join('')}`;
  }

  return `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;">
      <div style="font:600 11px/1 -apple-system,Segoe UI,sans-serif;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Resumen del pedido</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111827;">
        ${rows.join('')}
        ${priceBlock}
      </table>
    </div>`;
}

/* ── HTML template ──────────────────────────────────────────────────────── */
function buildEmailHtml({ order, empresa, copy, senderName, hasLogo, unit, config }) {
  const brand = BRAND_COLOR[empresa] || '#2563eb';
  const grad = BRAND_GRADIENT[empresa] || BRAND_GRADIENT['3DCC'];
  const accent = copy.accent;

  const logoBlock = hasLogo
    ? `<img src="cid:brand-logo" alt="${escapeHtml(senderName)}" width="84" style="display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;height:auto;max-width:84px;border-radius:14px;background:rgba(255,255,255,0.08);padding:6px;" />`
    : `<div style="font:700 22px/1 -apple-system,Segoe UI,sans-serif;color:#fff;letter-spacing:.06em;margin-bottom:14px;">${escapeHtml(empresa)}</div>`;

  const progressSection = copy.showProgress ? `
    <tr><td style="padding:24px 22px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>${buildProgressSteps(order.estado, accent)}</tr>
      </table>
    </td></tr>` : '';

  const nextStepSection = (copy.showNextStep && copy.nextStep) ? `
    <tr><td style="padding:18px 32px 8px;">
      <div style="background:${accent}0F;border-left:3px solid ${accent};border-radius:8px;padding:14px 16px;">
        <div style="font:600 11px/1 -apple-system,Segoe UI,sans-serif;color:${accent};letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Siguiente paso</div>
        <div style="font:500 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#374151;">${escapeHtml(copy.nextStep)}</div>
      </div>
    </td></tr>` : '';

  const pendienteNum = Math.max(0, Number(order.precio_final || 0) - Number(order.importe_pagado || 0));
  const showPayCta = !!order.stripe_payment_url && pendienteNum > 0 && (copy.eyebrow === 'CONFIRMACIÓN' || copy.eyebrow === 'LISTO');
  const payCtaSection = showPayCta ? `
    <tr><td style="padding:14px 32px 4px;text-align:center;">
      <a href="${escapeHtml(order.stripe_payment_url)}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font:600 14px/1 -apple-system,Segoe UI,sans-serif;padding:14px 26px;border-radius:12px;box-shadow:0 4px 12px ${brand}33;">
        Pagar pendiente · ${fmtMoney(pendienteNum, unit)}
      </a>
    </td></tr>` : '';

  const contactSection = buildContactButtons(config, order, copy);

  const customFooter = String(config.email_footer_note || '').trim();
  const customFooterHtml = customFooter
    ? `<div style="margin-top:14px;padding-top:14px;border-top:1px dashed #e5e7eb;font:400 12px/1.55 -apple-system,Segoe UI,sans-serif;color:#6b7280;font-style:italic;">${escapeHtml(customFooter)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(copy.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(copy.message)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.06);">

        <!-- HEADER -->
        <tr><td style="background:${grad};padding:32px 32px 26px;text-align:center;color:#fff;">
          ${logoBlock}
          <div style="font:600 11px/1.4 -apple-system,Segoe UI,sans-serif;color:rgba(255,255,255,0.85);letter-spacing:.12em;text-transform:uppercase;">${copy.icon} ${escapeHtml(copy.eyebrow)}</div>
          <div style="font:700 26px/1.25 -apple-system,Segoe UI,sans-serif;margin-top:6px;color:#fff;">${escapeHtml(copy.title)}</div>
        </td></tr>

        <!-- GREETING + MESSAGE -->
        <tr><td style="padding:30px 32px 4px;">
          <p style="margin:0 0 12px;font:500 16px/1.4 -apple-system,Segoe UI,sans-serif;color:#111827;">Hola${order.cliente ? ` <strong>${escapeHtml(order.cliente)}</strong>` : ''} 👋</p>
          <p style="margin:0;font:400 15px/1.65 -apple-system,Segoe UI,sans-serif;color:#374151;">${escapeHtml(copy.message)}</p>
        </td></tr>

        <!-- STATUS BADGE -->
        <tr><td style="padding:18px 32px 4px;">
          <div style="display:inline-block;background:${accent}1A;border:1px solid ${accent}55;color:${accent};padding:7px 14px;border-radius:999px;font:600 12px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.02em;">
            <span style="display:inline-block;width:7px;height:7px;background:${accent};border-radius:50%;vertical-align:middle;margin-right:7px;"></span>
            ${escapeHtml(order.estado)}
          </div>
        </td></tr>

        ${progressSection}

        <!-- ORDER CARD -->
        <tr><td style="padding:22px 32px 4px;">
          ${buildOrderCard(order, copy, brand, unit)}
        </td></tr>

        ${nextStepSection}
        ${payCtaSection}
        ${contactSection}

        <!-- FOOTER -->
        <tr><td style="padding:28px 32px 12px;">
          <p style="margin:0;font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#6b7280;">
            ${copy.isFinal
              ? 'Si tu pedido te ha gustado, nos encantaría saberlo. Si algo no fue como esperabas, también — escríbenos respondiendo a este correo.'
              : 'Si tienes cualquier duda sobre tu pedido, responde a este correo o contáctanos por los canales de abajo.'}
          </p>
          <p style="margin:14px 0 0;font:400 13px/1.55 -apple-system,Segoe UI,sans-serif;color:#6b7280;">
            Un saludo,<br />
            <strong style="color:#111827;">${escapeHtml(senderName)}</strong>
          </p>
          ${customFooterHtml}
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <div style="border-top:1px solid #e5e7eb;padding-top:14px;text-align:center;font:400 11px/1.5 -apple-system,Segoe UI,sans-serif;color:#9ca3af;">
            Recibes este correo porque facilitaste tu email al hacer un pedido a ${escapeHtml(senderName)}.<br />
            Pedido #${escapeHtml(order.id)}${order.fecha ? ` · ${escapeHtml(fmtFecha(order.fecha))}` : ''}
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildEmailText({ order, copy, senderName, unit, config }) {
  const lines = [];
  lines.push(`${copy.icon} ${copy.title}`);
  lines.push('');
  lines.push(`Hola${order.cliente ? ` ${order.cliente}` : ''},`);
  lines.push('');
  lines.push(copy.message);
  lines.push('');
  lines.push(`Estado: ${order.estado}`);
  lines.push(`Pedido: #${order.id}`);
  if (order.descripcion) lines.push(`Descripción: ${order.descripcion}`);
  if (copy.showPrice && Number(order.precio_final || 0) > 0) {
    lines.push(`Total: ${fmtMoney(order.precio_final, unit)}`);
    if (copy.showPayment) {
      const pendiente = Math.max(0, Number(order.precio_final || 0) - Number(order.importe_pagado || 0));
      if (pendiente > 0) lines.push(`Pendiente: ${fmtMoney(pendiente, unit)}`);
    }
  }
  if (copy.showNextStep && copy.nextStep) {
    lines.push('');
    lines.push(`Siguiente paso: ${copy.nextStep}`);
  }
  //Si el pedido a pasado a estado entregado poner enlace reseña de google

  
  const links = [];
  if (copy.isFinal) links.push(`Dejar una reseña: https://reviewthis.biz/3dcc`);
  const wa = whatsappLink(config?.email_whatsapp);
  const ig = instagramLink(config?.email_instagram);
  const web = normalizeUrl(config?.email_website);
  if (wa) links.push(`WhatsApp: ${wa}`);
  if (ig) links.push(`Instagram: ${ig}`);
  if (web) links.push(`Web: ${web}`);
  if (links.length) {
    lines.push('');
    lines.push(...links);
  }
  lines.push('');
  lines.push('Un saludo,');
  lines.push(senderName);
  return lines.join('\n');
}

/* ── Transporter ────────────────────────────────────────────────────────── */
function buildTransporter(cfg) {
  const user = String(cfg.email_from || '').trim();
  const pass = String(cfg.email_app_password || '').trim();
  if (!user || !pass) throw new Error('Falta el correo Gmail o la App Password en Configuración → Notificaciones.');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendStatusEmail({ order, empresa, config, pdfAttachment }) {
  if (!config?.email_enabled) return { ok: false, skipped: true, reason: 'Notificaciones desactivadas.' };
  const to = String(order?.cliente_email || '').trim();
  if (!to) return { ok: false, skipped: true, reason: 'El pedido no tiene email de cliente.' };

  const copy = STATUS_COPY[order.estado];
  if (!copy) return { ok: false, skipped: true, reason: `Estado "${order.estado}" sin plantilla de correo.` };

  const senderName = String(config.email_sender_name || empresa || '3DCC').trim() || empresa || '3DCC';
  const unit = '€';
  const optimizedLogo = getOptimizedLogo(empresa);

  const html = buildEmailHtml({ order, empresa, copy, senderName, hasLogo: !!optimizedLogo, unit, config });
  const text = buildEmailText({ order, copy, senderName, unit, config });

  const attachments = [];
  if (optimizedLogo) {
    attachments.push({
      filename: optimizedLogo.filename,
      content: optimizedLogo.buffer,
      contentType: optimizedLogo.contentType,
      cid: 'brand-logo',
    });
  }

  if (pdfAttachment && pdfAttachment.contentBase64 && order.estado === 'Presupuesto enviado') {
    attachments.push({
      filename: pdfAttachment.filename || `pedido-${order.id}.pdf`,
      content: Buffer.from(String(pdfAttachment.contentBase64), 'base64'),
      contentType: 'application/pdf',
    });
  }

  const transporter = buildTransporter(config);
  const info = await transporter.sendMail({
    from: `"${senderName}" <${config.email_from}>`,
    to,
    replyTo: String(config.email_reply_to || '').trim() || undefined,
    subject: `${copy.icon} ${copy.title} · #${order.id}`,
    text,
    html,
    attachments,
  });

  return {
    ok: true,
    messageId: info.messageId,
    to,
    status: order.estado,
    attachedPdf: !!(pdfAttachment && pdfAttachment.contentBase64),
    logoBytes: optimizedLogo ? optimizedLogo.size : 0,
  };
}

async function sendTestEmail({ config, empresa, to }) {
  const senderName = String(config.email_sender_name || empresa || '3DCC').trim() || empresa || '3DCC';
  const target = String(to || config.email_from || '').trim();
  if (!target) throw new Error('Indica un destinatario para la prueba.');

  const fakeOrder = {
    id: 'TEST0000',
    cliente: 'Cliente de prueba',
    cliente_email: target,
    descripcion: 'Pedido de prueba — esto es solo un test de configuración.',
    fecha: new Date().toISOString().slice(0, 10),
    estado: 'Aceptado',
    precio_final: 19.95,
    importe_pagado: 0,
    cantidad: 1,
    stripe_payment_url: '',
  };

  const copy = STATUS_COPY['Aceptado'];
  const optimizedLogo = getOptimizedLogo(empresa);
  const html = buildEmailHtml({ order: fakeOrder, empresa, copy, senderName, hasLogo: !!optimizedLogo, unit: '€', config });
  const text = buildEmailText({ order: fakeOrder, copy, senderName, unit: '€', config });
  const attachments = [];
  if (optimizedLogo) {
    attachments.push({
      filename: optimizedLogo.filename,
      content: optimizedLogo.buffer,
      contentType: optimizedLogo.contentType,
      cid: 'brand-logo',
    });
  }

  const transporter = buildTransporter(config);
  await transporter.verify();
  const info = await transporter.sendMail({
    from: `"${senderName}" <${config.email_from}>`,
    to: target,
    replyTo: String(config.email_reply_to || '').trim() || undefined,
    subject: `[PRUEBA] ${copy.icon} ${copy.title}`,
    text: `[PRUEBA DE CONFIGURACIÓN]\n\n${text}`,
    html,
    attachments,
  });

  return { ok: true, messageId: info.messageId, to: target, logoBytes: optimizedLogo ? optimizedLogo.size : 0 };
}

module.exports = {
  sendStatusEmail,
  sendTestEmail,
  ORDER_STATUS_COPY: STATUS_COPY,
};
