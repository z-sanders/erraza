'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createStore } = require('../lib/store');
const { config } = require('./helpers');

// Opt in only with a dedicated Supabase test project. Never supply production credentials.
// Every test has a unique scope, and its rows are left to expire through short TTLs.
const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const skip = url && key
  ? false
  : 'Set TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY for a dedicated Supabase test project only.';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function testStore(orderTtlSeconds = 30) {
  return createStore({
    ...config,
    supabaseUrl: url,
    supabaseKey: key,
    origin: `https://${randomUUID()}.test.invalid`,
    orderTtlSeconds,
  });
}

function order(extra = {}) {
  return {
    id: `order-${randomUUID()}`,
    version: 1,
    value: 0,
    ...extra,
  };
}

test('dedicated Supabase test project only: fresh scoped reads miss', { skip }, async () => {
  const store = testStore();

  assert.equal(await store.lookup(`attempt-${randomUUID()}`, `fingerprint-${randomUUID()}`), null);
  assert.equal(await store.getOrder(`order-${randomUUID()}`), null);
  assert.equal(await store.getCache(`cache-${randomUUID()}`), null);
});

test('dedicated Supabase test project only: concurrent reservations choose one order', { skip }, async () => {
  const store = testStore();
  const attempt = `attempt-${randomUUID()}`;
  const fingerprint = `fingerprint-${randomUUID()}`;
  const candidates = Array.from({ length: 16 }, (_, candidate) => order({ candidate }));

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
    store.reserve(attempt, `changed-${randomUUID()}`, order()),
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
