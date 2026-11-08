'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Readable } = require('node:stream');
const { config, setup, checkoutBody, call } = require('./helpers');
const { validateAmount, positiveDecimal, sameAmount, atLeast } = require('../lib/money');
const { signToken, verifyToken } = require('../lib/security');
const { sortedStringify, verifyIpn, createProvider, parseProviderJson, ProviderError } = require('../lib/nowpayments');
const { readJson } = require('../lib/http');
const { safeRedirect, applyProviderState } = require('../lib/orders');
const { clientIp } = require('../lib/handlers');

test('custom amounts reject coercion, scientific notation, separators and precision loss', () => {
  for (const value of [null, true, [50], 50, 'Infinity', 'NaN', '-1', '0', '0.50', '1e3', '01', '1.001', '1,000', '100000.01', '.5', '']) {
    assert.throws(() => validateAmount(value, 'usd', config), String(value));
  }
  assert.equal(validateAmount('25', 'usd', config), '25.00');
  assert.equal(validateAmount('100000', 'usd', config), '100000.00');
  assert.equal(validateAmount('25', 'jpy', config), '25');
  assert.throws(() => validateAmount('25.01', 'jpy', config));
  assert.throws(() => validateAmount('25', 'zzz', config));
});

test('decimal comparison handles small crypto values without floating point arithmetic', () => {
  assert.equal(positiveDecimal(1e-8), '0.00000001');
  assert.equal(positiveDecimal('100.00000'), '100');
  assert.equal(sameAmount('0.100000000000000001', '0.100000000000000000'), false);
  assert.equal(atLeast('1000', '1000.000000000000000001'), false);
  assert.equal(atLeast('0.00000001', '0.000000009'), true);
});

test('provider parser preserves large payment IDs and exact decimal tokens', () => {
  const data = parseProviderJson('{"payment_id":9876543210123456789,"pay_amount":0.100000000000000001,"actually_paid":1e-8}');
  assert.equal(data.payment_id, '9876543210123456789');
  assert.equal(data.pay_amount, '0.100000000000000001');
  assert.equal(data.actually_paid, '1e-8');
});

test('order tokens expire and bind audience, purpose and signature', () => {
  const token = signToken({ orderId: 'test' }, 'order', config, 3600);
  assert.equal(verifyToken(token, 'order', config).orderId, 'test');
  assert.equal(verifyToken(token, 'session', config), null);
  assert.equal(verifyToken(token + 'x', 'order', config), null);
  assert.equal(verifyToken(token, 'order', { ...config, origin: 'https://evil.example' }), null);
  assert.equal(verifyToken(signToken({ orderId: 'test' }, 'order', config, -1), 'order', config), null);
});

test('IPN signatures recursively sort keys, preserve arrays and reject tampering', () => {
  const payload = { payment_id: 123, fee: { z: 1, a: 2 }, payment_extra_ids: [{ b: 1, a: 2 }], order_id: 'err-test' };
  const canonical = '{"fee":{"a":2,"z":1},"order_id":"err-test","payment_extra_ids":[{"a":2,"b":1}],"payment_id":123}';
  assert.equal(sortedStringify(payload), canonical);
  const sig = createHmac('sha512', config.ipnSecret).update(canonical).digest('hex');
  assert.equal(verifyIpn(payload, sig, config), true);
  assert.equal(verifyIpn({ ...payload, order_id: 'other' }, sig, config), false);
  assert.equal(verifyIpn(payload, 'a'.repeat(127), config), false);
  assert.equal(verifyIpn(payload, ['a'.repeat(128)], config), false);
});

test('body parser accepts raw and parsed requests and keeps split UTF-8 intact', async () => {
  const bytes = Buffer.from('{"description":"お支払い"}');
  const req = Readable.from([...bytes].map(byte => Buffer.from([byte])));
  req.headers = { 'content-type': 'application/json' };
  assert.equal((await readJson(req)).description, 'お支払い');
  assert.deepEqual(await readJson({ headers: { 'content-type': 'application/json' }, body: { amount: '25' } }), { amount: '25' });
  await assert.rejects(readJson({ headers: { 'content-type': 'text/plain' }, body: '{}' }), { status: 415 });
  await assert.rejects(readJson({ headers: { 'content-type': 'application/json' }, body: 'no-json' }), { status: 400 });
  await assert.rejects(readJson({ headers: { 'content-type': 'application/json' }, body: { x: 'x'.repeat(5000) } }, 100), { status: 413 });
});

test('optional redirect restrictions require exact configured HTTPS provider hosts', () => {
  assert.equal(safeRedirect('https://pay.provider.example/path?x=1', config), 'https://pay.provider.example/path?x=1');
  for (const url of ['http://pay.provider.example/', 'https://pay.provider.example.evil.test/', 'https://evil.example/', 'javascript:alert(1)', 'https://user@pay.provider.example/', 'https://pay.provider.example:8443/']) {
    assert.throws(() => safeRedirect(url, config));
  }
});

test('client IP trusts Vercel ingress only on Vercel and never body/host overrides', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.2', 'x-vercel-forwarded-for': '203.0.113.3' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, config), '127.0.0.1');
  assert.equal(clientIp(req, { ...config, vercel: true }), '203.0.113.3');
  assert.throws(() => clientIp({ ...req, headers: { 'x-forwarded-for': 'a,b' } }, { ...config, vercel: true }));
});

test('provider adapter uses only documented endpoint parameters and rejects redirecting responses', async () => {
  const seen = [];
  const provider = createProvider(config, async (url, options) => {
    seen.push({ url: new URL(url), options });
    return new Response('{}', { status: 200 });
  });
  await provider.estimate('100.00', 'usd', 'btc');
  await provider.minimum('usdterc20', 'eur');
  await provider.create({ price_amount: 100 }, '203.0.113.7');
  await provider.status('12345');
  assert.equal(seen[0].url.searchParams.get('amount'), '100.00');
  assert.equal(seen[0].url.searchParams.get('currency_from'), 'usd');
  assert.equal(seen[0].url.searchParams.has('price_amount'), false);
  assert.equal(seen[1].url.searchParams.get('currency_to'), 'btc');
  assert.equal(seen[1].url.searchParams.get('fiat_equivalent'), 'eur');
  assert.equal(seen[2].options.headers['origin-ip'], '203.0.113.7');
  assert.equal(seen[3].url.pathname, '/v1/payment/12345');
  assert.ok(seen.every(item => item.options.redirect === 'error'));
});

test('missing credentials disable checkout instead of creating simulated payments', async () => {
  const env = await setup({ config: { configured: false } });
  assert.equal(env.boot.body.configured, false);
  assert.equal(env.boot.body.csrfToken, null);
  const response = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody() });
  assert.equal(response.status, 503);
  assert.equal(env.provider.createCalls, 0);
  assert.equal(JSON.stringify(env.boot.body).includes(config.apiKey), false);
});

test('amount errors, forgery, wrong origins and missing session stop payment creation', async () => {
  const env = await setup();
  const response = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody({ amount: true }), headers: env.headers });
  assert.equal(response.status, 400);
  const forged = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: { ...env.headers, origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);
  const noSession = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: { origin: config.origin } });
  assert.equal(noSession.status, 403);
  assert.equal(env.provider.createCalls, 0);
});

test('merchant assets preserve exact stablecoin network tickers and current minimum units', async () => {
  const env = await setup();
  const coins = await call(env.handlers.currencies);
  assert.deepEqual(coins.body.currencies.filter(item => item.ticker === 'USDT').map(item => [item.code, item.network]).sort(), [['usdterc20', 'Ethereum'], ['usdttrc20', 'TRON']]);
  const badAsset = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody({ asset: 'usdt' }) });
  assert.equal(badAsset.status, 400);
  env.provider.minimum = async () => ({ min_amount: '0.01', fiat_equivalent: '500' });
  const tooSmall = await call(env.handlers.estimate, { url: '/api/estimate?amount=100.00&fiat=usd&coin=btc' });
  assert.equal(tooSmall.status, 400);
  assert.equal(tooSmall.body.error, 'below_minimum');
});

test('merchant assets accept the current NOWPayments selectedCurrencies response', async () => {
  const env = await setup();
  const original = env.provider.merchantCoins;
  env.provider.merchantCoins = async () => {
    const data = await original();
    return { selectedCurrencies: data.currencies };
  };
  const coins = await call(env.handlers.currencies);
  assert.equal(coins.status, 200);
  assert.ok(coins.body.currencies.some(item => item.code === 'btc'));
});

test('raw and Vercel-parsed checkout calls create a real-contract order with memo zero', async () => {
  const env = await setup();
  for (const raw of [true, false]) {
    const response = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody({ asset: 'xrp' }), raw });
    assert.equal(response.status, 201);
    assert.equal(response.body.complete, false);
    assert.equal(response.body.payment.memo, '0');
    assert.match(response.body.payment.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(response.body.payment.amount, '0.001');
  }
});

test('same idempotency key survives concurrent requests and changed request fingerprint is rejected', async () => {
  const env = await setup();
  const body = checkoutBody();
  const responses = await Promise.all(Array.from({ length: 5 }, () => call(env.handlers.checkout, { method: 'POST', headers: env.headers, body })));
  assert.equal(env.provider.createCalls, 1);
  assert.equal(new Set(responses.map(result => result.body.orderId)).size, 1);
  const changed = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: { ...body, amount: '200' } });
  assert.equal(changed.status, 409);
});

test('ambiguous create timeout is not retried as a new provider payment', async () => {
  const env = await setup();
  let attempts = 0;
  env.provider.create = async () => { attempts++; throw new ProviderError(502, 'provider_timeout'); };
  const body = checkoutBody();
  const first = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body });
  const retry = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body });
  assert.equal(first.status, 202);
  assert.equal(first.body.status, 'unknown');
  assert.equal(retry.body.orderId, first.body.orderId);
  assert.equal(attempts, 1);
});

test('NOWPayments new status stays sendable and pending during creation and refresh', async () => {
  const env = await setup();
  const originalCreate = env.provider.create;
  env.provider.create = async (...args) => {
    const payment = await originalCreate(...args);
    payment.payment_status = 'new';
    env.provider.payments.get(payment.payment_id).payment_status = 'new';
    return payment;
  };

  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody() });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'new');
  assert.equal(created.body.terminal, false);
  assert.equal(created.body.complete, false);
  assert.ok(created.body.payment?.address);

  await env.store.update(created.body.orderId, current => ({ ...current, lastCheckedAt: null }));
  const refreshed = await call(env.handlers.status, { url: `/api/status?token=${created.body.token}` });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.status, 'new');
  assert.notEqual(refreshed.body.status, 'verification_pending');
  assert.equal(refreshed.body.terminal, false);
  assert.equal(refreshed.body.complete, false);
  assert.ok(refreshed.body.payment?.address);
});

test('new provider state cannot regress a later pending state', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody() });
  const order = await env.store.getOrder(created.body.orderId);
  const payment = await env.provider.status(order.paymentId);
  const updated = applyProviderState({ ...order, status: 'confirming' }, { ...payment, payment_status: 'new' });
  assert.equal(updated.status, 'confirming');
  assert.equal(updated.complete, false);
});

test('only verified finished status settles; confirmation and sending stay pending', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody() });
  const order = await env.store.getOrder(created.body.orderId);
  const payment = await env.provider.status(order.paymentId);
  for (const status of ['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid']) {
    const updated = applyProviderState({ ...order }, { ...payment, payment_status: status, actually_paid: '0.001' });
    assert.equal(updated.complete, false, status);
  }
  const settled = applyProviderState({ ...order }, { ...payment, payment_status: 'finished', actually_paid: '0.001' });
  assert.equal(settled.complete, true);
  assert.equal(applyProviderState(settled, { ...payment, payment_status: 'waiting' }).status, 'finished');
  assert.equal(applyProviderState({ ...settled }, { ...payment, payment_status: 'refunded' }).complete, false);
});

test('underpaid finished, parent deposits, altered payment ID or currency cannot settle', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody() });
  const order = await env.store.getOrder(created.body.orderId);
  const payment = await env.provider.status(order.paymentId);
  const underpaid = applyProviderState({ ...order }, { ...payment, payment_status: 'finished', actually_paid: '0.000999' });
  assert.equal(underpaid.status, 'review');
  const child = applyProviderState({ ...order }, { ...payment, parent_payment_id: '123', payment_status: 'finished', actually_paid: '0.001' });
  assert.equal(child.complete, false);
  assert.throws(() => applyProviderState({ ...order }, { ...payment, payment_id: '999' }));
  assert.throws(() => applyProviderState({ ...order }, { ...payment, price_currency: 'eur' }));
});

test('IPN verifies signature then reconciles authoritative status; duplicates never regress', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody() });
  const order = await env.store.getOrder(created.body.orderId);
  const payload = { order_id: order.id, payment_id: order.paymentId, payment_status: 'finished' };
  const signature = createHmac('sha512', config.ipnSecret).update(sortedStringify(payload)).digest('hex');
  const invalid = await call(env.handlers.ipn, { method: 'POST', body: payload, headers: { 'x-nowpayments-sig': '0'.repeat(128) } });
  assert.equal(invalid.status, 401);
  const beforeProviderFinishes = await call(env.handlers.ipn, { method: 'POST', body: payload, headers: { 'x-nowpayments-sig': signature }, raw: true });
  assert.equal(beforeProviderFinishes.status, 200);
  assert.equal((await env.store.getOrder(order.id)).complete, false);
  const payment = env.provider.payments.get(order.paymentId);
  payment.payment_status = 'finished'; payment.actually_paid = '0.001';
  for (let i = 0; i < 2; i++) {
    const result = await call(env.handlers.ipn, { method: 'POST', body: payload, headers: { 'x-nowpayments-sig': signature } });
    assert.equal(result.status, 200);
  }
  assert.equal((await env.store.getOrder(order.id)).complete, true);
  const status = await call(env.handlers.status, { url: `/api/status?token=${created.body.token}` });
  assert.equal(status.body.complete, true);
  assert.equal(status.body.amount, '100.00');
});

test('card checkout is capability and currency gated with no invented iframe URL', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody({ method: 'card' }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.checkoutUrl, 'https://pay.provider.example/checkout/fixture');
  assert.equal(created.body.payment, null);
  assert.equal('embedUrl' in created.body, false);
  const invalidCurrency = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody({ method: 'card', currency: 'cad' }) });
  assert.equal(invalidCurrency.status, 400);
  const local = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, ip: '127.0.0.1', body: checkoutBody({ method: 'card' }) });
  assert.equal(local.status, 400);
});
