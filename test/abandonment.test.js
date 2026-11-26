'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../server');
const { createHandlers } = require('../lib/handlers');
const { sortedStringify } = require('../lib/nowpayments');
const { config, memoryStore, providerDouble, checkoutBody } = require('./helpers');

// A simulated settlement must never send a real email.
delete process.env.RESEND_API_KEY;

async function fixture(t, overrides = {}) {
  const settings = { ...config, origin: 'http://localhost:3000', checkoutAbandonEnabled: true, ...overrides };
  const store = memoryStore();
  const provider = providerDouble();
  const routes = createHandlers({ config: settings, store, provider });
  const server = createServer({ handlers: Object.fromEntries(Object.entries(routes).map(([route, handler]) => [`/api/${route}`, handler])) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const session = async () => {
    const res = await fetch(`${root}/api/config`);
    const { csrfToken } = await res.json();
    return { origin: settings.origin, cookie: res.headers.get('set-cookie').split(';')[0], 'x-csrf-token': csrfToken };
  };
  const post = async (path, body, headers) => {
    const res = await fetch(`${root}/api/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  const ipn = payload => post('ipn', payload, {
    'x-nowpayments-sig': createHmac('sha512', settings.ipnSecret).update(sortedStringify(payload)).digest('hex')
  });
  const headers = await session();
  return { store, provider, session, post, headers, ipn };
}

test('verified unpaid checkout releases its slot; late settlement stays on the original payment', async t => {
  const { store, provider, post, headers, ipn } = await fixture(t);
  const initial = checkoutBody();
  const created = await post('checkout', initial, headers);
  assert.equal(created.status, 201);
  assert.equal(created.body.canAbandon, true);
  const firstId = created.body.orderId;
  const token = created.body.token;
  const replacement = checkoutBody({ amount: '150.00' });
  const blocked = await post('checkout', replacement, headers);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.activeToken, token);
  assert.equal(provider.createCalls, 1);

  const release = await post('abandon', { token, confirmed: true }, headers);
  assert.equal(release.status, 200);
  assert.equal(release.body.token, token);
  assert.ok(release.body.abandonedAt);
  assert.equal(release.body.status, 'waiting');
  assert.equal(release.body.payment.address, undefined);
  assert.equal(release.body.checkoutUrl, null);
  const replay = await post('checkout', initial, headers);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.abandonedAt, release.body.abandonedAt);
  assert.equal(provider.createCalls, 1);
  const next = await post('checkout', replacement, headers);
  assert.equal(next.status, 201);
  assert.notEqual(next.body.orderId, firstId);
  assert.equal(provider.createCalls, 2);

  const first = await store.getOrder(firstId);
  const data = await provider.status(first.paymentId);
  provider.payments.set(first.paymentId, { ...data, payment_status: 'finished', actually_paid: data.pay_amount });
  const callback = await ipn({ order_id: firstId, payment_id: first.paymentId, payment_status: 'finished' });
  assert.equal(callback.status, 200);
  const original = await store.getOrder(firstId);
  assert.equal(original.complete, true);
  assert.equal(original.fundsObserved, true);
  assert.equal(original.abandonedAt, release.body.abandonedAt);
  assert.equal((await store.getOrder(next.body.orderId)).status, 'waiting');
  assert.equal((await post('abandon', { token, confirmed: true }, headers)).body.abandonedAt, original.abandonedAt);
  assert.equal((await post('checkout', checkoutBody(), headers)).body.activeToken, next.body.token);
});

test('restart is unavailable before it is explicitly enabled', async t => {
  const { provider, post, headers } = await fixture(t, { checkoutAbandonEnabled: false });
  const created = await post('checkout', checkoutBody(), headers);
  assert.equal(created.status, 201);
  assert.equal(created.body.canAbandon, false);
  assert.equal((await post('abandon', { token: created.body.token, confirmed: true }, headers)).status, 503);
  assert.equal((await post('checkout', checkoutBody(), headers)).status, 409);
  assert.equal(provider.createCalls, 1);
});

test('release requires the owner and proof of no funds; an observed positive amount is sticky', async t => {
  const { store, provider, session, post, headers } = await fixture(t);
  const created = await post('checkout', checkoutBody(), headers);
  assert.equal(created.status, 201);
  const token = created.body.token;
  const id = created.body.orderId;
  const { paymentId } = await store.getOrder(id);
  const data = await provider.status(paymentId);
  const foreign = await session();
  const abandon = () => post('abandon', { token, confirmed: true }, headers);
  assert.equal((await post('abandon', { token, confirmed: true }, foreign)).status, 404);
  assert.equal((await post('abandon', { token, confirmed: true }, { ...headers, origin: 'https://other.example' })).status, 403);
  assert.equal((await post('abandon', { token, confirmed: false }, headers)).status, 400);

  for (const observation of [{ ...data, actually_paid: undefined }, { ...data, payment_status: undefined }, { ...data, pay_amount: '0.002' }]) {
    provider.payments.set(paymentId, observation);
    assert.equal((await abandon()).status, 409);
  }
  provider.payments.delete(paymentId);
  assert.equal((await abandon()).status, 503);
  provider.payments.set(paymentId, { ...data, actually_paid: '0.0004' });
  assert.equal((await abandon()).status, 409);
  provider.payments.set(paymentId, data);
  assert.equal((await abandon()).status, 409, 'a later zero cannot erase observed funds');
  const order = await store.getOrder(id);
  assert.equal(order.fundsObserved, true);
  assert.equal(order.abandonedAt, undefined);
});

test('release fails if provider progress wins the order-version race', async t => {
  const { store, post, headers } = await fixture(t);
  const created = await post('checkout', checkoutBody(), headers);
  const abandon = store.abandon;
  store.abandon = async (id, principal, version) => {
    await store.update(id, order => ({ ...order, status: 'confirming', fundsObserved: true }));
    return abandon(id, principal, version);
  };
  const response = await post('abandon', { token: created.body.token, confirmed: true }, headers);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'payment_changed');
  assert.equal((await post('checkout', checkoutBody(), headers)).status, 409);
});

test('a separately verified child deposit enters review without changing the original identity', async t => {
  const { store, provider, post, headers, ipn } = await fixture(t);
  const created = await post('checkout', checkoutBody(), headers);
  const { orderId, token } = created.body;
  assert.equal((await post('abandon', { token, confirmed: true }, headers)).status, 200);
  const next = await post('checkout', checkoutBody(), headers);
  assert.equal(next.status, 201);
  const original = await store.getOrder(orderId);
  const data = await provider.status(original.paymentId);
  const child = '7100000000000200';
  provider.payments.set(child, { ...data, payment_id: child, parent_payment_id: '123', payment_status: 'finished' });
  const callback = { order_id: orderId, payment_id: child, payment_status: 'finished' };
  assert.equal((await ipn(callback)).status, 502);
  provider.payments.set(child, { ...data, payment_id: child, parent_payment_id: original.paymentId, payment_status: 'finished', actually_paid: '0.0006' });
  assert.equal((await ipn(callback)).status, 200);
  const review = await store.getOrder(orderId);
  assert.equal(review.status, 'review');
  assert.equal(review.paymentId, original.paymentId);
  assert.equal(review.complete, false);
  assert.equal(review.linkedDeposit.id, child);
  assert.equal((await store.getOrder(next.body.orderId)).status, 'waiting');
  assert.equal((await ipn(callback)).status, 200);
  assert.equal((await store.getOrder(orderId)).version, review.version);
});
