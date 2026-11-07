'use strict';

// Isolated test doubles. Never imported by deployed code or the normal server.
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { CURRENCIES, ONRAMP_CURRENCIES } = require('../lib/config');
const { createHandlers } = require('../lib/handlers');
const { HttpError } = require('../lib/http');

const config = {
  configured: true, deployed: false, vercel: false, sandbox: false, origin: 'https://checkout.example',
  brand: 'Erraza', supportEmail: null, apiKey: 'test-api-key-not-real', ipnSecret: 'test-ipn-not-real',
  checkoutSecret: 'test-only-secret-with-at-least-32-characters', apiBase: 'https://api.nowpayments.io/v1',
  redisUrl: 'https://redis.example', redisToken: 'test-only', minAmount: '1', maxAmount: '100000',
  fiatEnabled: true, fiatRedirectHosts: ['pay.provider.example'], payoutCurrency: 'btc',
  currencies: CURRENCIES, fiatCurrencies: ONRAMP_CURRENCIES, orderTtlSeconds: 7776000, tokenTtlSeconds: 2592000,
};

function memoryStore() {
  const orders = new Map(), idem = new Map(), cache = new Map(), locks = new Map();
  return {
    orders,
    async rateLimit() {},
    async getCache(key) { return cache.get(key) || null; },
    async setCache(key, value) { cache.set(key, structuredClone(value)); },
    async lookup(key, fingerprint) {
      const prior = idem.get(key);
      if (!prior) return null;
      if (prior.fingerprint !== fingerprint) throw new HttpError(409, 'idempotency_conflict', 'Conflict');
      return structuredClone(orders.get(prior.orderId));
    },
    async reserve(key, fingerprint, order) {
      if (idem.has(key)) {
        const prior = idem.get(key);
        if (prior.fingerprint !== fingerprint) throw new HttpError(409, 'idempotency_conflict', 'Conflict');
        return { created: false, order: structuredClone(orders.get(prior.orderId)) };
      }
      idem.set(key, { fingerprint, orderId: order.id });
      orders.set(order.id, structuredClone(order));
      return { created: true, order: structuredClone(order) };
    },
    async getOrder(id) { return orders.has(id) ? structuredClone(orders.get(id)) : null; },
    async update(id, transform) {
      const old = orders.get(id);
      if (!old) throw new HttpError(404, 'order_not_found', 'Not found');
      const next = transform(structuredClone(old));
      if (!next) return structuredClone(old);
      next.version = old.version + 1;
      next.updatedAt = new Date().toISOString();
      orders.set(id, structuredClone(next));
      return structuredClone(next);
    },
    async lock(id, nonce) {
      if (locks.has(id)) return false;
      locks.set(id, nonce); return true;
    },
    async unlock(id, nonce) { if (locks.get(id) === nonce) locks.delete(id); },
  };
}

function providerDouble() {
  const payments = new Map();
  let calls = 0;
  return {
    payments,
    get createCalls() { return calls; },
    async merchantCoins() { return { currencies: ['btc', 'xrp', 'usdttrc20', 'usdterc20'] }; },
    async fullCurrencies() { return { currencies: [
      { code: 'BTC', name: 'Bitcoin', network: 'btc', enable: true, extra_id_exists: false },
      { code: 'XRP', name: 'XRP', network: 'xrp', enable: true, extra_id_exists: true },
      { code: 'USDTTRC20', name: 'Tether', network: 'trx', enable: true, extra_id_exists: false },
      { code: 'USDTERC20', name: 'Tether', network: 'eth', enable: true, extra_id_exists: false },
    ] }; },
    async estimate(amount, from, to) { return { currency_from: from, currency_to: to, amount_from: amount, estimated_amount: '0.001' }; },
    async minimum(asset, fiat) { return { currency_from: asset, currency_to: 'btc', min_amount: '0.00001', fiat_equivalent: '1' }; },
    async create(payload, ip) {
      calls += 1;
      const id = String(7100000000000000n + BigInt(calls));
      const fiat = ONRAMP_CURRENCIES.includes(payload.pay_currency);
      const data = {
        payment_id: id, payment_status: 'waiting', order_id: payload.order_id,
        price_amount: String(payload.price_amount), price_currency: payload.price_currency, pay_currency: payload.pay_currency,
        pay_amount: fiat ? String(payload.price_amount) : '0.001', actually_paid: '0',
        pay_address: 'TEST_ONLY_NOT_A_REAL_PAYMENT_ADDRESS', payin_extra_id: payload.pay_currency === 'xrp' ? '0' : null,
        network: payload.pay_currency, type: fiat ? 'fiat2crypto' : 'crypto2crypto',
        expiration_estimate_date: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        ...(fiat ? { redirectData: { redirect_url: 'https://pay.provider.example/checkout/fixture' }, originIp: ip } : {}),
      };
      payments.set(id, structuredClone(data));
      return data;
    },
    async status(id) {
      if (!payments.has(id)) throw new Error('Unknown test payment');
      return structuredClone(payments.get(id));
    },
  };
}

async function call(handler, { method = 'GET', url = '/', body, raw = false, headers = {}, ip = '203.0.113.7' } = {}) {
  const rawChunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(raw ? rawChunks : []);
  req.method = method; req.url = url; req.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: ip };
  if (!raw && body !== undefined) req.body = body;
  const result = { status: 0, headers: {}, body: null };
  const res = {
    headersSent: false,
    setHeader(key, value) { result.headers[key.toLowerCase()] = value; },
    writeHead(status, values) { result.status = status; this.headersSent = true; for (const [key, value] of Object.entries(values)) result.headers[key.toLowerCase()] = value; },
    end(bytes) { if (bytes) result.body = JSON.parse(bytes.toString()); },
  };
  await handler(req, res);
  return result;
}

async function setup(overrides = {}) {
  const chosen = { ...config, ...(overrides.config || {}) };
  const store = overrides.store || memoryStore();
  const provider = overrides.provider || providerDouble();
  const handlers = createHandlers({ config: chosen, store, provider });
  const boot = await call(handlers.config, { url: '/api/config' });
  const headers = { origin: chosen.origin, cookie: boot.headers['set-cookie']?.split(';')[0], 'x-csrf-token': boot.body?.csrfToken };
  return { config: chosen, store, provider, handlers, headers, boot };
}

function checkoutBody(extra = {}) {
  return { amount: '100.00', currency: 'usd', method: 'crypto', asset: 'btc', idempotencyKey: randomUUID(), ...extra };
}

module.exports = { config, memoryStore, providerDouble, call, setup, checkoutBody };
