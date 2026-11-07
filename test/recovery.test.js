'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { setup, checkoutBody, call, memoryStore, config } = require('./helpers');
const { ProviderError, sortedStringify } = require('../lib/nowpayments');
const { createHandlers } = require('../lib/handlers');
const { applyProviderState } = require('../lib/orders');

async function signedCallback(env, order, paymentId) {
  const payload = { order_id: order, payment_id: paymentId, payment_status: 'waiting' };
  const signature = createHmac('sha512', config.ipnSecret).update(sortedStringify(payload)).digest('hex');
  return call(env.handlers.ipn, { method: 'POST', headers: { 'x-nowpayments-sig': signature }, body: payload });
}

test('quote failure is retryable and does not reserve an unusable checkout attempt', async () => {
  const env = await setup();
  const original = env.provider.minimum;
  env.provider.minimum = async () => { throw new Error('temporary quote outage'); };
  const body = checkoutBody();
  const failed = await call(env.handlers.checkout, { method: 'POST', body, headers: env.headers });
  assert.equal(failed.status, 503);
  assert.equal(env.store.orders.size, 0);
  env.provider.minimum = original;
  const retry = await call(env.handlers.checkout, { method: 'POST', body, headers: env.headers });
  assert.equal(retry.status, 201);
  assert.equal(env.provider.createCalls, 1);
});

test('callbacks recover an ambiguous creation after payment details were lost', async () => {
  const env = await setup();
  const original = env.provider.create;
  env.provider.create = async (...args) => {
    await original(...args);
    throw new ProviderError(502, 'provider_timeout');
  };
  const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  assert.equal(created.body.status, 'unknown');
  const [paymentId] = env.provider.payments.keys();
  assert.equal((await signedCallback(env, created.body.orderId, paymentId)).status, 200);
  let order = await env.store.getOrder(created.body.orderId);
  assert.equal(order.paymentId, paymentId);
  await env.store.update(order.id, current => ({ ...current, lastCheckedAt: null }));
  const recovered = await call(env.handlers.status, { url: `/api/status?token=${created.body.token}` });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.payment.address, 'TEST_ONLY_NOT_A_REAL_PAYMENT_ADDRESS');
  assert.equal(recovered.body.complete, false);
});

test('callback before creation response cannot be overwritten by stale waiting data', async () => {
  const env = await setup();
  const original = env.provider.create;
  env.provider.create = async (...args) => {
    const pending = await original(...args);
    const current = env.provider.payments.get(pending.payment_id);
    current.payment_status = 'finished'; current.actually_paid = '0.001';
    const callback = await signedCallback(env, pending.order_id, pending.payment_id);
    assert.equal(callback.status, 200);
    return pending;
  };
  const result = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  assert.equal(result.body.status, 'finished');
  assert.equal(result.body.complete, true);
});

test('durability failures do not acknowledge IPNs', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  const order = await env.store.getOrder(created.body.orderId);
  env.store.update = async () => { throw new Error('database write failed'); };
  const response = await signedCallback(env, order.id, order.paymentId);
  assert.equal(response.status, 503);
});

test('idempotency keys cannot return another customer session payment', async () => {
  const store = memoryStore();
  const first = await setup({ store });
  const second = await setup({ store, provider: first.provider });
  const body = checkoutBody();
  const result = await call(first.handlers.checkout, { method: 'POST', body, headers: first.headers });
  assert.equal(result.status, 201);
  const leakedKey = await call(second.handlers.checkout, { method: 'POST', body, headers: second.headers });
  assert.equal(leakedKey.status, 409);
});

test('an invalid provider redirect retains payment identity without exposing the URL', async () => {
  const env = await setup();
  const original = env.provider.create;
  env.provider.create = async (...args) => {
    const data = await original(...args);
    data.redirectData.redirect_url = 'https://attacker.invalid/phish';
    return data;
  };
  const result = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody({ method: 'card' }), headers: env.headers });
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'review');
  assert.equal(result.body.checkoutUrl, null);
  assert.ok((await env.store.getOrder(result.body.orderId)).paymentId);
});

test('no provider request is issued when shared store/rate-limiting is unavailable', async () => {
  const env = await setup();
  env.store.rateLimit = async () => { throw new Error('database outage'); };
  const response = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  assert.equal(response.status, 503);
  assert.equal(env.provider.createCalls, 0);
});

test('unsupported HTTP methods and duplicate query parameters fail explicitly', async () => {
  const env = await setup();
  const method = await call(env.handlers.checkout, { method: 'GET' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'POST');
  const duplicate = await call(env.handlers.estimate, { url: '/api/estimate?amount=1&amount=100&coin=btc&fiat=usd' });
  assert.equal(duplicate.status, 400);
});

test('late finished payment after expiry is re-verified and not assumed unpaid', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  const order = await env.store.getOrder(created.body.orderId);
  const payment = await env.provider.status(order.paymentId);
  const expired = applyProviderState({ ...order }, { ...payment, payment_status: 'expired' });
  assert.equal(expired.complete, false);
  const paidLater = applyProviderState(expired, { ...payment, payment_status: 'finished', actually_paid: '0.001' });
  assert.equal(paidLater.complete, true);
});

test('underpayment discovered after confirmation replaces the pending confirmation state', async () => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  const order = await env.store.getOrder(created.body.orderId);
  const payment = await env.provider.status(order.paymentId);
  for (const status of ['confirming', 'confirmed', 'sending']) {
    const partial = applyProviderState({ ...order, status }, { ...payment, payment_status: 'partially_paid', actually_paid: '0.0005' });
    assert.equal(partial.status, 'partially_paid');
    assert.equal(partial.complete, false);
  }
});

test('an existing checkout recovers during an unrelated quote outage', async () => {
  const env = await setup();
  const body = checkoutBody();
  const created = await call(env.handlers.checkout, { method: 'POST', body, headers: env.headers });
  env.store.getCache = async () => null;
  env.provider.merchantCoins = async () => { throw new Error('assets down'); };
  env.provider.minimum = async () => { throw new Error('quotes down'); };
  const retried = await call(env.handlers.checkout, { method: 'POST', body, headers: env.headers });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.orderId, created.body.orderId);
  assert.equal(env.provider.createCalls, 1);
});

test('callback-first card payments must establish fiat type and sufficient fiat-denominated amount', async () => {
  for (const invalidType of [true, false]) {
    const env = await setup();
    const original = env.provider.create;
    env.provider.create = async (...args) => {
      const data = await original(...args);
      const stored = env.provider.payments.get(data.payment_id);
      stored.type = invalidType ? 'crypto2crypto' : 'fiat2crypto';
      stored.pay_amount = '0.001'; stored.actually_paid = '0.001'; stored.payment_status = 'finished';
      throw new ProviderError(502, 'provider_timeout');
    };
    const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody({ method: 'card' }), headers: env.headers });
    const [paymentId] = env.provider.payments.keys();
    const response = await signedCallback(env, created.body.orderId, paymentId);
    assert.equal(response.status, invalidType ? 502 : 200);
    assert.equal((await env.store.getOrder(created.body.orderId)).complete, false);
  }
});

test('merchant reconciliation recovers late settlement without depending on a browser or callback', async () => {
  const secret = 'operator-secret-only-for-testing-32characters';
  const env = await setup({ config: { reconciliationSecret: secret } });
  const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  const order = await env.store.getOrder(created.body.orderId);
  await env.store.update(order.id, current => ({ ...current, status: 'expired' }));
  const payment = env.provider.payments.get(order.paymentId);
  payment.payment_status = 'finished'; payment.actually_paid = '0.001';
  const unauthorized = await call(env.handlers.reconcile, { method: 'POST', body: { orderId: order.id } });
  assert.equal(unauthorized.status, 401);
  const reconciled = await call(env.handlers.reconcile, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: { orderId: order.id } });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.complete, true);
});

test('receipt tokens remain stable when polling happens seconds after creation', async (t) => {
  const env = await setup();
  const created = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 15000 });
  const status = await call(env.handlers.status, { url: `/api/status?token=${created.body.token}` });
  assert.equal(status.status, 200);
  assert.equal(status.body.token, created.body.token);
});

test('status retrieval remains correct across cold handler instances', async () => {
  const env = await setup();
  const result = await call(env.handlers.checkout, { method: 'POST', body: checkoutBody(), headers: env.headers });
  const cold = createHandlers({ config: env.config, provider: env.provider, store: env.store });
  const status = await call(cold.status, { url: `/api/status?token=${result.body.token}` });
  assert.equal(status.body.orderId, result.body.orderId);
  assert.equal(status.body.amount, '100.00');
  assert.equal(status.body.complete, false);
});
