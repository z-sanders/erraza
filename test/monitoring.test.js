'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const { alertPlan, backoffSeconds, runReconciliation, PARKED_SECONDS } = require('../lib/monitoring');
const { expireAbandonedCreation } = require('../lib/orders');
const { orderToken } = require('../lib/security');
const { createHandlers } = require('../lib/handlers');
const { createServer } = require('../server');
const { config, memoryStore, providerDouble, call } = require('./helpers');

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function order(overrides = {}) {
  return {
    id: `err_${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
    amount: '250.00', currency: 'usd', method: 'crypto', payCurrency: 'usdterc20',
    asset: { code: 'usdterc20' },
    status: 'waiting', complete: false, version: 3,
    createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    updatedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    paymentId: '5444421707',
    expectedPayAmount: '250.00',
    payment: { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '250.00', currency: 'usdterc20', memo: null },
    ...overrides
  };
}

function baseIo(claims) {
  const io = {
    claims,
    completions: [],
    raised: [],
    resolved: [],
    runs: [],
    async claimBatch() { return io.claims; },
    async completeClaim(orderId, leaseUntil, nextDueSeconds) { io.completions.push({ orderId, nextDueSeconds }); return true; },
    async raiseAlert(entry) { io.raised.push(entry); },
    async resolveAlert(key) { io.resolved.push(key); },
    async recordRun(entry) { io.runs.push(entry); }
  };
  return io;
}

function memoryOrders(orders) {
  return {
    async getOrder(id) { return orders.find(o => o.id === id) ? structuredClone(orders.find(o => o.id === id)) : null; },
    async update(id, transform) {
      const index = orders.findIndex(o => o.id === id);
      if (index === -1) return null;
      const next = transform(structuredClone(orders[index]));
      if (!next) return structuredClone(orders[index]);
      orders[index] = next;
      return structuredClone(next);
    },
    async lock() { return true; },
    async unlock() {}
  };
}

test('alert policy raises review as critical, escalates stuck states, and self-resolves', () => {
  const review = alertPlan(order({ status: 'review', message: 'An additional deposit needs merchant review.' }), NOW);
  const reviewRaise = review.filter(e => e.key.startsWith('review:'));
  assert.equal(reviewRaise.length, 1);
  assert.equal(reviewRaise[0].action, 'raise');
  assert.equal(reviewRaise[0].severity, 'critical');
  assert.equal(reviewRaise[0].category, 'review_required');

  const waiting = alertPlan(order(), NOW);
  assert.equal(waiting.find(e => e.key.startsWith('review:')).action, 'resolve');
  assert.equal(waiting.find(e => e.key.startsWith('stuck_unknown:')).action, 'resolve');
  assert.equal(waiting.find(e => e.key.startsWith('stale_pending:')).action, 'resolve');

  const stuck = alertPlan(order({ status: 'verification_pending' }), NOW);
  const stuckRaise = stuck.find(e => e.key.startsWith('stuck_unknown:'));
  assert.equal(stuckRaise.action, 'raise');
  assert.equal(stuckRaise.severity, 'warning');
  assert.equal(stuckRaise.category, 'stuck_attempt');

  const stuckValuable = alertPlan(order({ status: 'unknown', amount: '25000.00' }), NOW);
  assert.equal(stuckValuable.find(e => e.key.startsWith('stuck_unknown:')).severity, 'critical');

  const aged = alertPlan(order({ createdAt: new Date(NOW - 50 * 60 * 60 * 1000).toISOString() }), NOW);
  const stale = aged.find(e => e.key.startsWith('stale_pending:'));
  assert.equal(stale.action, 'raise');
  assert.equal(stale.severity, 'warning');
  assert.equal(stale.category, 'stale_pending');
});

test('backoff schedule ages with the attempt and parks manual states', () => {
  assert.equal(backoffSeconds('waiting', 10 * 60 * 1000), 600);
  assert.equal(backoffSeconds('waiting', 5 * 60 * 60 * 1000), 1800);
  assert.equal(backoffSeconds('waiting', 30 * 60 * 60 * 1000), 5400);
  assert.equal(backoffSeconds('unknown', 0), 900);
  assert.equal(backoffSeconds('verification_pending', 0), 900);
});

test('reconciler drives authoritative settlement, parks terminal rows, and records runs', async () => {
  const live = order();
  const finished = order({ id: 'err_11111111-2222-3333-4444-555555555555', status: 'finished', complete: true });
  const orders = [live, finished];
  const store = memoryOrders(orders);
  const io = baseIo([
    { order_id: live.id, reconcile_lease_until: 'lease-1' },
    { order_id: finished.id, reconcile_lease_until: 'lease-2' }
  ]);
  const provider = providerDouble();
  provider.status = async () => ({
    payment_id: '5444421707', order_id: live.id, price_amount: '250.00', price_currency: 'usd',
    pay_currency: 'usdterc20', pay_amount: '250.00', actually_paid: '250.00',
    payment_status: 'finished', parent_payment_id: null, type: 'crypto'
  });

  const summary = await runReconciliation({ store, provider, config, io, limit: 5 });

  assert.equal(summary.outcome, 'completed');
  assert.equal(summary.claimed, 2);
  assert.equal(summary.transitions, 1);
  assert.equal(orders.find(o => o.id === live.id).status, 'finished');
  const liveCompletion = io.completions.find(c => c.orderId === live.id);
  const finishedCompletion = io.completions.find(c => c.orderId === finished.id);
  assert.equal(liveCompletion.nextDueSeconds, PARKED_SECONDS);
  assert.equal(finishedCompletion.nextDueSeconds, PARKED_SECONDS);
  assert.equal(io.runs.length, 1);
  assert.equal(io.runs[0].outcome, 'completed');
  assert.equal(io.runs[0].claimed, 2);
});

test('review claims are parked and alerted, never auto-resolved', async () => {
  const reviewing = order({ status: 'review', message: 'An additional deposit needs merchant review.' });
  const store = memoryOrders([reviewing]);
  const io = baseIo([{ order_id: reviewing.id, reconcile_lease_until: 'lease-r' }]);
  const provider = providerDouble();
  provider.status = async () => { throw new Error('provider must not be called for review claims'); };

  const summary = await runReconciliation({ store, provider, config, io, limit: 5 });

  assert.equal(summary.outcome, 'completed');
  assert.equal(summary.transitions, 0);
  assert.equal(reviewing.status, 'review');
  assert.ok(io.raised.some(e => e.key === `review:${reviewing.id}` && e.severity === 'critical'));
  const completion = io.completions.find(c => c.orderId === reviewing.id);
  assert.equal(completion.nextDueSeconds, PARKED_SECONDS);
});

test('provider outage circuit breaker aborts the batch and raises one deduplicated alert', async () => {
  const ids = ['err_11111111-2222-3333-4444-555555555551', 'err_11111111-2222-3333-4444-555555555552', 'err_11111111-2222-3333-4444-555555555553', 'err_11111111-2222-3333-4444-555555555554'];
  const orders = ids.map((id, i) => order({ id, createdAt: new Date(NOW - (i + 1) * 60 * 1000).toISOString() }));
  const store = memoryOrders(orders);
  const io = baseIo(ids.map(id => ({ order_id: id, reconcile_lease_until: `lease-${id.slice(-4)}` })));
  const provider = providerDouble();
  provider.status = async () => { throw new Error('upstream unavailable'); };

  const summary = await runReconciliation({ store, provider, config, io, limit: 10 });

  assert.equal(summary.outcome, 'aborted_provider_outage');
  assert.equal(summary.failures, 4);
  assert.equal(io.raised.filter(e => e.key === 'provider_outage').length, 1);
  assert.deepEqual(io.completions.map(c => c.nextDueSeconds), [120, 120, 120, 300]);
});

test('kill switch disables the reconciler without claiming', async () => {
  const disabled = { ...config, reconciliationEnabled: false };
  const io = baseIo([{ order_id: 'err_1', reconcile_lease_until: 'lease-x' }]);
  const summary = await runReconciliation({ store: memoryOrders([]), provider: providerDouble(), config: disabled, io });
  assert.equal(summary.outcome, 'disabled');
  assert.equal(io.runs.length, 0);
});

test('operator identity is required for cron and ops endpoints', async () => {
  const secretConfig = { ...config, reconciliationSecret: 's'.repeat(32), reconciliationEnabled: true, configured: true };
  const handlers = Object.fromEntries(Object.entries(createHandlers({ config: secretConfig, store: memoryStore(), provider: providerDouble() })).map(([name, handler]) => [`/api/${name}`, handler]));
  const application = createServer({ handlers });
  const requestHandler = application.listeners('request')[0];
  const server = require('node:http').createServer((req, res) => requestHandler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hit = async (path, headers) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const unauthorized = await hit('/api/cron-reconcile', { });
  assert.equal(unauthorized.status, 401);
  const opsUnauthorized = await hit('/api/ops', { });
  assert.equal(opsUnauthorized.status, 401);
  const wrongSecret = await hit('/api/ops', { authorization: 'Bearer ' + 'x'.repeat(32) });
  assert.equal(wrongSecret.status, 401);

  await new Promise(resolve => server.close(resolve));
});

test('scheduled reconciliation uses CRON_SECRET without granting operator access', async () => {
  const reconciliationSecret = 'o'.repeat(32);
  const cronSecret = 'c'.repeat(32);
  const store = memoryStore();
  let claims = 0;
  store.rpc = async (name) => {
    assert.equal(name, 'erraza_reconcile_claim');
    claims += 1;
    return { claims: [] };
  };
  store.recordRun = async () => {};
  const handlers = createHandlers({ config: { ...config, reconciliationSecret, cronSecret }, store, provider: providerDouble() });
  const auth = secret => ({ authorization: `Bearer ${secret}` });
  const runCron = (method, secret) => call(handlers['cron-reconcile'], {
    method, url: '/api/cron-reconcile', headers: auth(secret), ...(method === 'POST' ? { body: {} } : {}),
  });

  assert.equal((await runCron('GET', reconciliationSecret)).status, 401);
  assert.equal((await runCron('POST', cronSecret)).status, 401);
  assert.equal((await call(handlers.ops, { headers: auth(cronSecret) })).status, 401);
  assert.equal((await call(handlers.reconcile, { method: 'POST', headers: auth(cronSecret), body: {} })).status, 401);
  assert.equal(claims, 0);
  assert.equal((await runCron('GET', cronSecret)).status, 200);
  assert.equal((await runCron('POST', reconciliationSecret)).status, 200);
  assert.equal(claims, 2);
});

test('monitoring migration locks down tables and functions to the service role', () => {
  const migration = readFileSync(resolve(__dirname, '../supabase-monitoring.sql'), 'utf8');
  for (const table of ['erraza_ops_alerts', 'erraza_reconcile_runs']) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /REVOKE ALL ON TABLE public\.erraza_ops_alerts, public\.erraza_reconcile_runs FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT USAGE, SELECT ON SEQUENCE public\.erraza_reconcile_runs_id_seq TO service_role/);
  for (const fn of ['erraza_reconcile_claim', 'erraza_reconcile_complete', 'erraza_ops_alert_raise', 'erraza_ops_alert_resolve', 'erraza_ops_alert_acknowledge', 'erraza_ops_alert_snooze']) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`));
  }
  // Money stays in the guarded lifecycle RPCs.
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public.(erraza_payment_sync|erraza_reserve|erraza_order_cas)/);
  // Review is never auto-claimed.
  assert.match(migration, /status IN \('unknown','new','waiting','partially_paid','confirming','confirmed','sending','verification_pending'\)/);
  assert.doesNotMatch(migration, /'review'\s*\)/);
});

test('abandoned creations expire past their TTL; anything reconcilable never expires', () => {
  const old = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(NOW - 10 * 60 * 1000).toISOString();
  const abandoned = { ...order({ status: 'unknown', paymentId: null, payment: null }), createdAt: old };
  const expired = expireAbandonedCreation(abandoned, 3600, NOW);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.complete, false);
  assert.match(expired.message, /No payment was taken/);
  // Young orders keep waiting.
  assert.equal(expireAbandonedCreation({ ...abandoned, createdAt: fresh }, 3600, NOW).status, 'unknown');
  // Any provider identity or surfaced payment details block expiry.
  assert.equal(expireAbandonedCreation({ ...abandoned, paymentId: '5444421707' }, 3600, NOW).status, 'unknown');
  assert.equal(expireAbandonedCreation({ ...abandoned, payment: { address: 'x' } }, 3600, NOW).status, 'unknown');
  assert.equal(expireAbandonedCreation({ ...abandoned, checkoutUrl: 'https://pay.provider.example/fixture' }, 3600, NOW).status, 'unknown');
  // Provider-facing or settled statuses are never touched.
  assert.equal(expireAbandonedCreation({ ...abandoned, status: 'waiting' }, 3600, NOW).status, 'waiting');
  assert.equal(expireAbandonedCreation({ ...abandoned, status: 'finished', complete: true }, 3600, NOW).status, 'finished');
});

test('reconciler retires abandoned creations, resolves their alerts, and parks them', async () => {
  const stuck = order({ status: 'unknown', paymentId: null, payment: null, message: 'The provider has not confirmed whether checkout was created.' });
  stuck.createdAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const orders = [stuck];
  const store = memoryOrders(orders);
  const io = baseIo([{ order_id: stuck.id, reconcile_lease_until: 'lease-stuck' }]);
  const provider = providerDouble();
  provider.status = async () => { throw new Error('provider must not be called for identity-less claims'); };

  const summary = await runReconciliation({ store, provider, config, io, limit: 5 });

  assert.equal(summary.outcome, 'completed');
  assert.equal(summary.transitions, 1);
  assert.equal(orders.find(o => o.id === stuck.id).status, 'expired');
  assert.ok(io.resolved.some(key => key === `stuck_unknown:${stuck.id}`));
  assert.ok(!io.raised.some(entry => entry.orderId === stuck.id));
  const completion = io.completions.find(c => c.orderId === stuck.id);
  assert.equal(completion.nextDueSeconds, PARKED_SECONDS);
});

test('concurrent provider identity attachment wins over abandoned expiry', async () => {
  const stale = order({ status: 'unknown', paymentId: null, payment: null });
  stale.createdAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const providerBacked = {
    ...stale,
    status: 'waiting', paymentId: '5444421707', expectedPayAmount: '250.00',
    payment: { address: '0x1234567890abcdef1234567890abcdef12345678', amount: '250.00', currency: 'usdterc20', memo: null }
  };
  const reads = [structuredClone(stale), structuredClone(providerBacked), structuredClone(providerBacked)];
  const store = {
    async getOrder() { return structuredClone(reads.shift() || providerBacked); },
    async update(_id, transform) {
      const next = transform(structuredClone(providerBacked));
      return structuredClone(next || providerBacked);
    },
    async lock() { return true; },
    async unlock() {}
  };
  const io = baseIo([{ order_id: stale.id, reconcile_lease_until: 'lease-race' }]);
  const provider = providerDouble();
  let statusCalls = 0;
  provider.status = async () => {
    statusCalls += 1;
    return {
      payment_id: '5444421707', order_id: stale.id, price_amount: '250.00', price_currency: 'usd',
      pay_currency: 'usdterc20', pay_amount: '250.00', actually_paid: '0',
      payment_status: 'waiting', parent_payment_id: null, type: 'crypto'
    };
  };

  const summary = await runReconciliation({ store, provider, config, io, limit: 5 });

  assert.equal(statusCalls, 1, 'the fresh provider identity is reconciled, not parked');
  assert.equal(summary.transitions, 0);
  assert.notEqual(io.completions[0].nextDueSeconds, PARKED_SECONDS, 'a provider-backed order re-checks on schedule, never parks');
  assert.equal(io.completions[0].nextDueSeconds, backoffSeconds('waiting', Date.now() - Date.parse(stale.createdAt)));
});

test('status endpoint retires an abandoned creation and answers with a terminal state', async () => {
  const store = memoryStore();
  const provider = providerDouble();
  const abandoned = {
    id: 'err_22222222-3333-4333-8333-444444444444', version: 0, principal: 'a'.repeat(64),
    amount: '100.00', currency: 'usd', method: 'crypto', payCurrency: 'btc', asset: { code: 'btc' },
    reference: '', sourceOrderId: null, merchant: 'Erraza',
    status: 'unknown', complete: false, message: 'The provider has not confirmed whether checkout was created.',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), updatedAt: new Date().toISOString(),
    lastCheckedAt: null, paymentId: null, expectedPayAmount: null, payment: null, checkoutUrl: null,
  };
  store.orders.set(abandoned.id, abandoned);
  const token = orderToken(abandoned.id, config, abandoned.createdAt);
  const handlers = createHandlers({ config, store, provider });

  const response = await call(handlers.status, { url: `/api/status?token=${encodeURIComponent(token)}` });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'expired');
  assert.equal(response.body.terminal, true);
  assert.equal(response.body.complete, false);
  assert.match(response.body.message, /No payment was taken/);
  assert.equal(store.orders.get(abandoned.id).status, 'expired');
  // A young unresolved creation is left alone.
  const young = { ...abandoned, id: 'err_33333333-4444-4333-8333-555555555555', createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
  store.orders.set(young.id, young);
  const youngToken = orderToken(young.id, config, young.createdAt);
  const youngResponse = await call(handlers.status, { url: `/api/status?token=${encodeURIComponent(youngToken)}` });
  assert.equal(youngResponse.body.status, 'unknown');
  assert.equal(youngResponse.body.terminal, false);
});
