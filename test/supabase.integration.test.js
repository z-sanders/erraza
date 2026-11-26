'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { createStore } = require('../lib/store');

// Opt in only with a disposable Supabase test project with the base, monitoring,
// and abandonment migrations already applied. Never supply production credentials.
// Each test uses its own scope. Typed attempts, events and alerts outlive JSON TTLs.
const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const skip = url && key
  ? false
  : 'Set TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY for a disposable Supabase test project only.';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const newPrincipal = () => createHash('sha256').update(randomUUID()).digest('hex');

function testStore(orderTtlSeconds = 30) {
  return createStore({
    supabaseUrl: url,
    supabaseKey: key,
    origin: `https://${randomUUID()}.test.invalid`,
    sandbox: true,
    orderTtlSeconds,
  });
}

function order(extra = {}) {
  const now = new Date().toISOString();
  const method = extra.method ?? 'crypto';
  return {
    id: `err_${randomUUID()}`,
    version: 1,
    principal: newPrincipal(),
    providerAccount: 'f'.repeat(20),
    amount: '100.00',
    currency: 'usd',
    method,
    asset: method === 'crypto' ? { code: 'btc' } : null,
    status: 'creating',
    complete: false,
    fundsObserved: false,
    createdAt: now,
    updatedAt: now,
    value: 0,
    ...extra,
  };
}

function payableOrder(extra = {}) {
  return order({
    status: 'waiting',
    paymentId: BigInt(`0x${randomUUID().replaceAll('-', '')}`).toString(),
    expectedPayAmount: '0.001',
    actuallyPaid: '0',
    ...extra,
  });
}

test('Supabase order fixtures include typed reservation facts without a database', () => {
  const fresh = order();
  const payable = payableOrder();
  const card = payableOrder({ method: 'card', expectedPayAmount: '100.00', providerType: 'fiat2crypto' });
  for (const fixture of [fresh, payable, card]) {
    assert.match(fixture.id, /^err_[0-9a-f-]{36}$/);
    assert.match(fixture.principal, /^[0-9a-f]{64}$/);
    assert.match(fixture.providerAccount, /^[0-9a-f]{20}$/);
    assert.match(fixture.amount, /^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
    assert.match(fixture.currency, /^[a-z]{3,24}$/);
    assert.equal(fixture.version, 1);
    assert.equal(fixture.complete, false);
    assert.equal(fixture.fundsObserved, false);
    assert.ok(Number.isFinite(Date.parse(fixture.createdAt)));
    assert.equal(fixture.updatedAt, fixture.createdAt);
  }
  assert.equal(fresh.status, 'creating');
  assert.equal(fresh.asset.code, 'btc');
  assert.equal(payable.status, 'waiting');
  assert.match(payable.paymentId, /^[0-9]{1,40}$/);
  assert.equal(payable.expectedPayAmount, '0.001');
  assert.equal(payable.actuallyPaid, '0');
  assert.equal(card.asset, null);
});

test('dedicated Supabase test project only: fresh scoped reads miss', { skip }, async () => {
  const store = testStore();

  assert.equal(await store.lookup(`attempt-${randomUUID()}`, `fingerprint-${randomUUID()}`), null);
  assert.equal(await store.getOrder(order().id), null);
  assert.equal(await store.getCache(`cache-${randomUUID()}`), null);
});

test('dedicated Supabase test project only: concurrent reservations choose one order', { skip }, async () => {
  const store = testStore();
  const attempt = `attempt-${randomUUID()}`;
  const fingerprint = `fingerprint-${randomUUID()}`;
  const principal = newPrincipal();
  const candidates = Array.from({ length: 16 }, (_, candidate) => order({ principal, candidate }));

  const reservations = await Promise.all(
    candidates.map(candidate => store.reserve(attempt, fingerprint, candidate))
  );
  const created = reservations.filter(reservation => reservation.created);

  assert.equal(created.length, 1);
  const winner = created[0].order;
  assert.equal(new Set(reservations.map(reservation => reservation.order.id)).size, 1);
  for (const reservation of reservations) assert.deepEqual(reservation.order, winner);
  assert.deepEqual(await store.lookup(attempt, fingerprint), winner);
  assert.deepEqual(await store.getOrder(winner.id), winner);

  await assert.rejects(
    store.reserve(attempt, `changed-${randomUUID()}`, order({ principal })),
    { status: 409 }
  );
});

test('dedicated Supabase test project only: concurrent CAS updates preserve every increment', { skip }, async () => {
  const store = testStore();
  const initial = order();
  const attempt = `attempt-${randomUUID()}`;
  const fingerprint = `fingerprint-${randomUUID()}`;
  const increments = 8;

  assert.equal((await store.reserve(attempt, fingerprint, initial)).created, true);
  await Promise.all(Array.from({ length: increments }, () => (
    store.update(initial.id, current => ({ ...current, value: current.value + 1 }))
  )));

  const final = await store.getOrder(initial.id);
  assert.equal(final.value, initial.value + increments);
  assert.equal(final.version, initial.version + increments);
});

test('dedicated Supabase test project only: releasing an invoice opens the slot without repointing its key', { skip }, async () => {
  const store = testStore(120);
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const invoice = payableOrder({ reference: 'test-only private reference', payerEmail: 'fixture@example.invalid' });
  const replacement = order({ principal: invoice.principal });
  const invoiceKey = randomUUID(), replacementKey = randomUUID();
  const invoiceFingerprint = randomUUID(), replacementFingerprint = randomUUID();
  assert.deepEqual(await store.reserve(invoiceKey, invoiceFingerprint, { ...invoice, abandonedAt: invoice.createdAt }), {
    created: true, reason: 'created', order: invoice,
  });

  const forged = await store.update(invoice.id, current => ({ ...current, abandonedAt: current.createdAt }));
  assert.equal(forged.abandonedAt, undefined);
  assert.deepEqual(await store.reserve(replacementKey, replacementFingerprint, replacement), {
    created: false, reason: 'unresolved', order: forged,
  });
  assert.equal(await store.lookup(replacementKey, replacementFingerprint), null);
  assert.deepEqual(await store.abandon(invoice.id, invoice.principal, invoice.version), { status: 'conflict' });
  assert.deepEqual(await store.abandon(invoice.id, newPrincipal(), forged.version), { status: 'missing' });
  assert.deepEqual(await testStore().abandon(invoice.id, invoice.principal, forged.version), { status: 'missing' });

  const releases = await Promise.all([
    store.abandon(invoice.id, invoice.principal, forged.version),
    store.abandon(invoice.id, invoice.principal, forged.version),
  ]);
  assert.deepEqual(releases.map(result => result.status).sort(), ['abandoned', 'existing']);
  const released = releases.find(result => result.status === 'abandoned').order;
  assert.ok(Number.isFinite(Date.parse(released.abandonedAt)));
  assert.deepEqual(released, {
    ...forged, version: forged.version + 1, abandonedAt: released.abandonedAt, updatedAt: released.abandonedAt,
  });
  assert.deepEqual(releases.find(result => result.status === 'existing').order, released);
  assert.deepEqual(await store.abandon(invoice.id, newPrincipal(), forged.version), { status: 'missing' });

  assert.deepEqual(await store.reserve(replacementKey, replacementFingerprint, replacement), {
    created: true, reason: 'created', order: replacement,
  });
  assert.deepEqual(await store.reserve(invoiceKey, invoiceFingerprint, order({ principal: invoice.principal })), {
    created: false, reason: 'idempotent', order: released,
  });
  assert.deepEqual(await store.lookup(invoiceKey, invoiceFingerprint), released);
  assert.deepEqual(await store.lookup(replacementKey, replacementFingerprint), replacement);

  const alertKey = `late_abandoned_funds:${invoice.id}`;
  const getAlert = async () => {
    const { data, error } = await db.from('erraza_ops_alerts').select().eq('key', alertKey).maybeSingle();
    assert.ifError(error);
    return data;
  };
  assert.equal(await getAlert(), null);
  const late = await store.update(invoice.id, current => ({
    ...current, abandonedAt: null, status: 'partially_paid', actuallyPaid: '0.0001', fundsObserved: true,
  }));
  assert.equal(late.abandonedAt, released.abandonedAt);
  assert.equal(late.status, 'partially_paid');
  assert.equal(late.actuallyPaid, '0.0001');
  assert.equal(late.paymentId, invoice.paymentId);
  assert.equal(late.expectedPayAmount, invoice.expectedPayAmount);
  assert.equal(late.fundsObserved, true);
  assert.deepEqual(await store.getOrder(replacement.id), replacement);
  assert.deepEqual(await store.abandon(invoice.id, invoice.principal, forged.version), { status: 'existing', order: late });

  const alert = await getAlert();
  assert.equal(alert?.order_id, invoice.id);
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.category, 'review_required');
  assert.equal(alert.raised_count, 1);
  assert.equal(alert.resolved_at, null);
  assert.deepEqual(alert.detail, {});
  const repeated = await store.update(invoice.id, current => {
    delete current.abandonedAt;
    return { ...current, fundsObserved: false };
  });
  assert.equal(repeated.fundsObserved, true);
  assert.equal(repeated.abandonedAt, released.abandonedAt);
  assert.equal((await getAlert()).raised_count, 1);
  assert.deepEqual(await store.lookup(invoiceKey, invoiceFingerprint), repeated);

  const { data: attempt, error: attemptError } = await db.from('erraza_payment_attempts')
    .select('scope,principal,status,complete,version,provider_payment_id,expected_pay_amount,abandoned_at')
    .eq('order_id', invoice.id).single();
  assert.ifError(attemptError);
  assert.equal(attempt.scope, alert.scope);
  assert.equal(attempt.principal, invoice.principal);
  assert.equal(attempt.status, repeated.status);
  assert.equal(attempt.complete, false);
  assert.equal(attempt.version, repeated.version);
  assert.equal(attempt.provider_payment_id, invoice.paymentId);
  assert.equal(attempt.expected_pay_amount, invoice.expectedPayAmount);
  assert.equal(new Date(attempt.abandoned_at).toISOString(), released.abandonedAt);

  const { data: events, error: eventError } = await db.from('erraza_payment_events')
    .select('from_status,to_status,version').eq('order_id', invoice.id).eq('source', 'abandonment');
  assert.ifError(eventError);
  assert.deepEqual(events, [{ from_status: 'waiting', to_status: 'waiting', version: released.version }]);
});

test('dedicated Supabase test project only: release fails closed on ineligible state and evidence', { skip }, async () => {
  const store = testStore(120);
  const ineligible = [
    ['card', { method: 'card', expectedPayAmount: '100.00', providerType: 'fiat2crypto' }],
    ['creating', { status: 'creating' }],
    ['partially paid', { status: 'partially_paid' }],
    ['complete', { status: 'finished', complete: true }],
    ['missing payment ID', { paymentId: null }],
    ['invalid payment ID', { paymentId: 'not-a-provider-id' }],
    ['missing expected amount', { expectedPayAmount: null }],
    ['zero expected amount', { expectedPayAmount: '0' }],
    ['funds observed', { fundsObserved: true }],
    ['invalid funds flag', { fundsObserved: 'false' }],
    ['nonzero payment', { actuallyPaid: '0.0001' }],
    ['invalid payment', { actuallyPaid: 'unknown' }],
    ['noncanonical zero', { actuallyPaid: '0.0' }],
    ['JSON number zero', { actuallyPaid: 0 }],
  ];
  for (const [label, evidence] of ineligible) {
    const invoice = payableOrder(evidence);
    assert.equal((await store.reserve(randomUUID(), randomUUID(), invoice)).created, true, label);
    assert.deepEqual(await store.abandon(invoice.id, invoice.principal, invoice.version), { status: 'blocked' }, label);
    assert.deepEqual(await store.getOrder(invoice.id), invoice, label);
  }

  const legacy = payableOrder();
  delete legacy.fundsObserved;
  assert.equal((await store.reserve(randomUUID(), randomUUID(), legacy)).created, true);
  assert.deepEqual(await store.abandon(legacy.id, legacy.principal, legacy.version), { status: 'blocked' });
  const notBackfilled = await store.update(legacy.id, current => ({ ...current, fundsObserved: false }));
  assert.equal(notBackfilled.fundsObserved, undefined);
  assert.deepEqual(await store.abandon(legacy.id, legacy.principal, notBackfilled.version), { status: 'blocked' });
});

test('dedicated Supabase test project only: release accepts missing or null prior paid amount with explicit no-funds evidence', { skip }, async () => {
  const store = testStore(120);
  const missing = payableOrder({ status: 'new' });
  delete missing.actuallyPaid;
  for (const invoice of [missing, payableOrder({ actuallyPaid: null })]) {
    assert.equal((await store.reserve(randomUUID(), randomUUID(), invoice)).created, true);
    const released = await store.abandon(invoice.id, invoice.principal, invoice.version);
    assert.equal(released.status, 'abandoned');
    assert.equal(released.order.status, invoice.status);
    assert.equal(released.order.actuallyPaid, invoice.actuallyPaid);
  }
});

test('dedicated Supabase test project only: leases have one owner and stale unlocks are harmless', { skip }, async () => {
  const store = testStore();
  const lockId = `lease-${randomUUID()}`;
  const nonces = Array.from({ length: 8 }, () => randomUUID());
  const claims = await Promise.all(nonces.map(nonce => store.lock(lockId, nonce, 2)));

  assert.equal(claims.filter(Boolean).length, 1);
  const oldOwner = nonces[claims.findIndex(Boolean)];

  await store.unlock(lockId, randomUUID());
  assert.equal(await store.lock(lockId, randomUUID(), 2), false);

  await wait(2300);
  const newOwner = randomUUID();
  assert.equal(await store.lock(lockId, newOwner, 2), true);

  await store.unlock(lockId, oldOwner);
  const nextOwner = randomUUID();
  assert.equal(await store.lock(lockId, nextOwner, 2), false);

  await store.unlock(lockId, newOwner);
  assert.equal(await store.lock(lockId, nextOwner, 2), true);
  await store.unlock(lockId, nextOwner);
});

test('dedicated Supabase test project only: cache values round trip and expire', { skip }, async () => {
  const store = testStore();
  const name = `cache-${randomUUID()}`;
  const value = { marker: randomUUID(), nested: { enabled: true }, values: [1, 2, 3] };

  await store.setCache(name, value, 1);
  assert.deepEqual(await store.getCache(name), value);

  await wait(1300);
  assert.equal(await store.getCache(name), null);
});

test('dedicated Supabase test project only: concurrent rate limits are exact and reset', { skip }, async () => {
  const store = testStore();
  const subject = `subject-${randomUUID()}`;
  const limit = 4;
  const attempts = 10;
  const outcomes = await Promise.allSettled(
    Array.from({ length: attempts }, () => store.rateLimit(subject, limit, 2))
  );
  const accepted = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected');

  assert.equal(accepted.length, limit);
  assert.equal(rejected.length, attempts - limit);
  for (const outcome of rejected) assert.equal(outcome.reason?.status, 429);

  await wait(2300);
  await store.rateLimit(subject, limit, 2);
});

test('dedicated Supabase test project only: orders expire without an explicit cleanup call', { skip }, async () => {
  const store = testStore(1);
  const initial = order();
  const attempt = `attempt-${randomUUID()}`;
  const fingerprint = `fingerprint-${randomUUID()}`;

  await store.reserve(attempt, fingerprint, initial);
  assert.deepEqual(await store.getOrder(initial.id), initial);
  assert.deepEqual(await store.lookup(attempt, fingerprint), initial);

  await wait(1300);
  assert.equal(await store.getOrder(initial.id), null);
  assert.equal(await store.lookup(attempt, fingerprint), null);
});
