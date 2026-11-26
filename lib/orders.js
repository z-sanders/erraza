'use strict';

const QRCode = require('qrcode');
const { randomBytes } = require('node:crypto');
const { isIP } = require('node:net');
const { orderToken } = require('./security');
const { providerId, positiveDecimal, sameAmount, atLeast, decimalString } = require('./money');
const { HttpError } = require('./http');
const notifications = require('./email');

const PROVIDER_STATES = new Set(['new', 'waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired']);
const TERMINAL = new Set(['finished', 'failed', 'refunded', 'expired', 'review']);
const RANK = { creating: 0, unknown: 0, new: 1, waiting: 1, partially_paid: 2, confirming: 3, confirmed: 4, sending: 5, finished: 6 };
const UNPAID_STATES = new Set(['new', 'waiting']);
const FUNDED_STATES = new Set(['partially_paid', 'confirming', 'confirmed', 'sending', 'finished', 'refunded']);

function hasParentPayment(data) {
  return data.parent_payment_id != null && String(data.parent_payment_id) !== '0';
}

function canAbandonCheckout(order, config) {
  return Boolean(config.checkoutAbandonEnabled && config.providerAccount && order.providerAccount === config.providerAccount
    && order.method === 'crypto' && UNPAID_STATES.has(order.status) && order.complete === false
    && !order.abandonedAt && order.paymentId && order.payment?.address && order.expectedPayAmount
    && order.fundsObserved === false && (order.actuallyPaid == null || sameAmount(order.actuallyPaid, '0')));
}

function confirmsUnpaidCheckout(order, data) {
  validateIdentity(order, data);
  return UNPAID_STATES.has(data.payment_status) && !hasParentPayment(data)
    && (!data.type || data.type === 'crypto2crypto')
    && sameAmount(data.pay_amount, order.expectedPayAmount) && sameAmount(data.actually_paid, '0');
}

function verifiedLinkedDeposit(order, id, data, config) {
  if (order.method !== 'crypto' || !order.paymentId || order.paymentId === id || !hasParentPayment(data)
    || !config.providerAccount || config.providerAccount !== order.providerAccount) return false;
  let parent;
  try { parent = providerId(data.parent_payment_id); } catch { return false; }
  if (parent !== order.paymentId) return false;
  // Verify the child separately; never substitute its ID on the stored order.
  return validateIdentity({ ...order, paymentId: id }, data) === id
    && (!data.type || data.type === 'crypto2crypto') && PROVIDER_STATES.has(data.payment_status);
}

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

function providerFundsObserved(data) {
  if (hasParentPayment(data) || FUNDED_STATES.has(String(data.payment_status).toLowerCase())) return true;
  try { return decimalString(data.actually_paid) !== '0'; } catch { return false; }
}

function applyProviderState(order, data) {
  validateIdentity(order, data);
  const status = String(data.payment_status || 'waiting').toLowerCase();
  const previous = order.status;
  order.lastCheckedAt = new Date().toISOString();
  if (providerFundsObserved(data)) order.fundsObserved = true;
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

// Wallet-prefill URI schemes with a stable BIP-21-style format. Only coins with
// no destination tag qualify; everything else keeps an address-only QR so a
// wallet can never prefill a payment that would land without its memo.
const PAYMENT_URI_SCHEMES = new Map([
  ['btc', 'bitcoin'], ['ltc', 'litecoin'], ['doge', 'dogecoin'], ['dash', 'dash'],
]);

function paymentUri(asset, payAddress, amount) {
  if (!asset || asset.extraIdRequired) return null;
  const scheme = PAYMENT_URI_SCHEMES.get(String(asset.ticker || asset.code || '').toLowerCase());
  if (!scheme || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) || !/^[0-9]*\.?[0-9]+$/.test(String(amount))) return null;
  return `${scheme}:${payAddress}?amount=${amount}`;
}

async function applyCreation(order, data, config, store) {
  const paymentId = validateIdentity(order, data);
  let payment, expectedPayAmount, checkoutUrl = null;
  expectedPayAmount = positiveDecimal(data.pay_amount);
  if (order.method === 'crypto') {
    const payAddress = address(data.pay_address);
    const payMemo = memo(data.payin_extra_id);
    if (order.asset.extraIdRequired && payMemo === null) throw new Error('Provider omitted a required destination tag');
    const scanValue = paymentUri(order.asset, payAddress, expectedPayAmount) || payAddress;
    payment = {
      address: payAddress, amount: expectedPayAmount, currency: order.payCurrency,
      memo: payMemo,
      qrDataUrl: await QRCode.toDataURL(scanValue, { width: 256, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#152c26', light: '#ffffff' } }),
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
    const before = current.status;
    current.paymentId = paymentId;
    if (order.method === 'card') current.providerType = 'fiat2crypto';
    current.expectedPayAmount = expectedPayAmount;
    current.payment = payment;
    current.checkoutUrl = checkoutUrl;
    const next = applyProviderState(current, data);
    if (settledDuring(before, next)) { void notifications.notifySettled(next).catch(() => undefined); void notifications.notifyPayerReceipt(next).catch(() => undefined); }
    return next;
  });
}

// True only when this observation performed the first durable transition to a
// settled order. Repeat observations of an already-finished order short-circuit
// inside applyProviderState, so settledDuring is one-shot per order.
function settledDuring(before, after) {
  return before !== 'finished' && Boolean(after) && after.status === 'finished' && after.complete === true;
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
    let settledNow = false;
    const next = await store.update(order.id, current => {
      const before = current.status;
      const result = applyProviderState(current, data);
      settledNow = settledDuring(before, result);
      return result;
    });
    if (settledNow) { void notifications.notifySettled(next).catch(() => undefined); void notifications.notifyPayerReceipt(next).catch(() => undefined); }
    return next;
  } finally { await store.unlock(`poll:${order.id}`, nonce); }
}

// An unconfirmed creation has no known provider identity to poll. After its
// local window elapses it no longer holds the checkout slot; signed callbacks
// can still attach a late provider payment.
const ABANDONED_STATUSES = new Set(['creating', 'unknown']);

function expireAbandonedCreation(order, ttlSeconds, nowMs = Date.now()) {
  if (!order || !ABANDONED_STATUSES.has(order.status) || order.complete) return order;
  if (order.paymentId || order.payment || order.checkoutUrl) return order;
  const created = Date.parse(order.createdAt);
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(created) || !Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(nowMs)) return order;
  if (nowMs - created < ttl * 1000) return order;
  return {
    ...order,
    status: 'expired',
    complete: false,
    message: 'The checkout was never confirmed by the payment provider and its window ended. If you sent funds or see a charge, check with the merchant before paying again.',
  };
}

function view(order, config) {
  const abandonedAt = order.abandonedAt || null;
  const payment = abandonedAt && order.payment
    ? { amount: order.payment.amount, currency: order.payment.currency }
    : order.payment || null;
  return {
    token: orderToken(order.id, config, order.createdAt), orderId: order.id,
    amount: order.amount, currency: order.currency, method: order.method, asset: order.asset,
    reference: order.reference || '', merchant: order.merchant || config.brand,
    status: order.status, terminal: TERMINAL.has(order.status), complete: order.status === 'finished' && order.complete === true,
    actuallyPaid: order.actuallyPaid || null, abandonedAt, canAbandon: canAbandonCheckout(order, config),
    createdAt: order.createdAt, payment, checkoutUrl: abandonedAt ? null : order.checkoutUrl || null,
    message: order.message || null,
  };
}

module.exports = { validateIdentity, safeRedirect, applyProviderState, applyCreation, paymentUri, reconcile, expireAbandonedCreation, view, settledDuring,
  canAbandonCheckout, confirmsUnpaidCheckout, providerFundsObserved, verifiedLinkedDeposit, hasParentPayment, TERMINAL };
