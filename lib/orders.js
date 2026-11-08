'use strict';

const QRCode = require('qrcode');
const { randomBytes } = require('node:crypto');
const { isIP } = require('node:net');
const { orderToken } = require('./security');
const { providerId, positiveDecimal, sameAmount, atLeast, decimalString } = require('./money');
const { HttpError } = require('./http');

const PROVIDER_STATES = new Set(['new', 'waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired']);
const TERMINAL = new Set(['finished', 'failed', 'refunded', 'expired', 'rejected', 'review']);
const RANK = { creating: 0, unknown: 0, new: 1, waiting: 1, partially_paid: 2, confirming: 3, confirmed: 4, sending: 5, finished: 6 };

function validateIdentity(order, data) {
  let id;
  try { id = providerId(data.payment_id); } catch { throw new HttpError(502, 'payment_mismatch', 'The provider payment could not be verified.'); }
  if (data.order_id !== order.id || !sameAmount(data.price_amount, order.amount)
    || String(data.price_currency).toLowerCase() !== order.currency
    || String(data.pay_currency).toLowerCase() !== order.payCurrency
    || (order.paymentId && order.paymentId !== id)
    || (order.method === 'card' && (data.type ? data.type !== 'fiat2crypto' : order.providerType !== 'fiat2crypto'))) {
    throw new HttpError(502, 'payment_mismatch', 'The provider payment does not match this checkout. Please contact the merchant.');
  }
  return id;
}

function safeRedirect(value, config) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) {
    throw new HttpError(502, 'invalid_redirect', 'The provider checkout link could not be verified.');
  }
  let url;
  try { url = new URL(value); } catch { throw new HttpError(502, 'invalid_redirect', 'The provider checkout link could not be verified.'); }
  const hostname = url.hostname.toLowerCase();
  const publicHostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
    && !isIP(hostname) && !/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|onion)$/.test(hostname);
  const restrictions = config.fiatRedirectHosts || [];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !publicHostname
    || (restrictions.length > 0 && !restrictions.includes(hostname))) {
    throw new HttpError(502, 'redirect_not_allowed', 'The provider checkout link could not be verified.');
  }
  // This URL comes only from a validated NOWPayments response, never customer input.
  // An optional host list can further restrict it without being required for activation.
  return url.href;
}

function address(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256 || /[\s<>\x00-\x1f]/.test(value)) throw new Error('Invalid payment address');
  return value;
}

function memo(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!['string', 'number'].includes(typeof value)) throw new Error('Invalid payment memo');
  const result = String(value);
  if (result.length > 256 || /[\x00-\x1f]/.test(result)) throw new Error('Invalid payment memo');
  return result;
}

function expiry(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function applyProviderState(order, data) {
  validateIdentity(order, data);
  const status = String(data.payment_status || 'waiting').toLowerCase();
  const previous = order.status;
  order.lastCheckedAt = new Date().toISOString();
  if (!PROVIDER_STATES.has(status)) {
    if (!TERMINAL.has(previous)) { order.status = 'verification_pending'; order.message = 'The provider returned an unrecognized status. Please check again or contact the merchant.'; }
    return order;
  }
  if (data.parent_payment_id !== null && data.parent_payment_id !== undefined && String(data.parent_payment_id) !== '0') {
    order.status = 'review';
    order.complete = false;
    order.message = 'An additional deposit needs merchant review. Do not send another payment.';
    return order;
  }
  // Never regress a settled payment because a delayed response arrived later.
  if (previous === 'refunded') return order;
  if (previous === 'finished' && status !== 'refunded') return order;
  if (previous === 'review' && status !== 'refunded') return order;
  if (['failed', 'expired'].includes(previous) && !['finished', 'refunded'].includes(status)) return order;
  if (status === 'finished') {
    let expected;
    try { expected = positiveDecimal(order.expectedPayAmount || data.pay_amount); } catch { expected = null; }
    const moneyVerified = expected !== null && sameAmount(data.pay_amount, expected) && atLeast(data.actually_paid, expected)
      && (order.method !== 'card' || atLeast(expected, order.amount));
    if (!moneyVerified) {
      order.status = 'review';
      order.complete = false;
      order.message = 'Settlement was reported, but the full payment amount could not be verified. The merchant needs to review this payment.';
      return order;
    }
    order.status = 'finished';
    order.complete = true;
    order.message = 'Your payment has been received.';
  } else if (status === 'partially_paid' || !(previous in RANK && status in RANK && RANK[status] < RANK[previous])) {
    order.status = status;
    order.complete = false;
    order.message = null;
  }
  if (data.actually_paid !== undefined && data.actually_paid !== null) {
    try { order.actuallyPaid = decimalString(data.actually_paid); } catch { /* Do not accept invalid amounts. */ }
  }
  return order;
}

async function applyCreation(order, data, config, store) {
  const paymentId = validateIdentity(order, data);
  let payment, expectedPayAmount, checkoutUrl = null;
  expectedPayAmount = positiveDecimal(data.pay_amount);
  if (order.method === 'crypto') {
    const payAddress = address(data.pay_address);
    const payMemo = memo(data.payin_extra_id);
    if (order.asset.extraIdRequired && payMemo === null) throw new Error('Provider omitted a required destination tag');
    payment = {
      address: payAddress, amount: expectedPayAmount, currency: order.payCurrency,
      memo: payMemo,
      qrDataUrl: await QRCode.toDataURL(payAddress, { width: 256, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#152c26', light: '#ffffff' } }),
      expiresAt: expiry(data.expiration_estimate_date),
    };
  } else {
    if (data.type !== 'fiat2crypto') throw new HttpError(502, 'fiat_unavailable', 'This account did not return a supported fiat on-ramp checkout. Please contact the merchant.');
    checkoutUrl = safeRedirect(data.redirectData?.redirect_url, config);
    payment = null;
  }
  return store.update(order.id, current => {
    if (current.paymentId && current.paymentId !== paymentId) throw new HttpError(502, 'payment_mismatch', 'A conflicting payment was returned.');
    if (current.expectedPayAmount && !sameAmount(current.expectedPayAmount, expectedPayAmount)) throw new HttpError(502, 'payment_mismatch', 'A conflicting payment amount was returned.');
    current.paymentId = paymentId;
    if (order.method === 'card') current.providerType = 'fiat2crypto';
    current.expectedPayAmount = expectedPayAmount;
    current.payment = payment;
    current.checkoutUrl = checkoutUrl;
    return applyProviderState(current, data);
  });
}

async function reconcile(order, provider, store, config, force = false) {
  if (!order.paymentId) return order;
  if (!force && order.lastCheckedAt && Date.now() - Date.parse(order.lastCheckedAt) < 5000) return order;
  const nonce = randomBytes(16).toString('hex');
  if (!await store.lock(`poll:${order.id}`, nonce, 18)) return (await store.getOrder(order.id)) || order;
  try {
    const data = await provider.status(order.paymentId);
    validateIdentity(order, data);
    if (order.status !== 'review' && !order.complete && ((order.method === 'crypto' && !order.payment) || (order.method === 'card' && !order.checkoutUrl))) {
      return await applyCreation(order, data, config, store);
    }
    return await store.update(order.id, current => applyProviderState(current, data));
  } finally { await store.unlock(`poll:${order.id}`, nonce); }
}

function view(order, config) {
  return {
    token: orderToken(order.id, config, order.createdAt), orderId: order.id,
    amount: order.amount, currency: order.currency, method: order.method, asset: order.asset,
    reference: order.reference || '', merchant: order.merchant || config.brand,
    status: order.status, terminal: TERMINAL.has(order.status), complete: order.status === 'finished' && order.complete === true,
    createdAt: order.createdAt, payment: order.payment || null, checkoutUrl: order.checkoutUrl || null,
    message: order.message || null,
  };
}

module.exports = { validateIdentity, safeRedirect, applyProviderState, applyCreation, reconcile, view, TERMINAL };
