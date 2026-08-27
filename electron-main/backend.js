/**
 * Backend del proceso main de Electron — wrapper fino.
 *
 * TODA la lógica de negocio vive en src/shared/backend.mjs (única fuente de
 * verdad, compartida con la app móvil/web vía src/platform.js). Este archivo
 * solo:
 *   1. Reexporta el módulo compartido (require síncrono de ESM,
 *      soportado por el Node >= 22.12 embebido en Electron).
 *   2. Añade generateStripePaymentLink, que necesita la SDK de Stripe (Node)
 *      y por eso no puede ir en el módulo compartido.
 *
 * ⚠️ No añadas lógica de negocio aquí: hazlo en src/shared/backend.mjs para
 * que PC y móvil se comporten igual.
 */
const path = require('path');
const Stripe = require('stripe');

const shared = require(path.join(__dirname, '..', 'src', 'shared', 'backend.mjs'));

const { findOrder, refreshOrderPaymentFields, roundMoney, currencyFromUnit } = shared;

/* ── Stripe (solo escritorio: requiere clave secreta y SDK de Node) ─────── */

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

module.exports = {
  ...shared,
  generateStripePaymentLink,
};
