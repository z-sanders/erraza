'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createStore } = require('../lib/store');
const { config } = require('./helpers');

// Opt-in only. Use a dedicated TEST Redis database, never production credentials.
// Test keys live in a unique namespace and expire after two minutes.
const url = process.env.TEST_REDIS_REST_URL;
const token = process.env.TEST_REDIS_REST_TOKEN;

test('real Redis atomically reserves, CAS-updates and expires leases', {
  skip: !url || !token ? 'Set TEST_REDIS_REST_URL and TEST_REDIS_REST_TOKEN for a dedicated test database.' : false,
}, async () => {
  const store = createStore({ ...config, redisUrl: url, redisToken: token, origin: `https://${randomUUID()}.test.invalid`, orderTtlSeconds: 120 });
  const order = { id: `err_${randomUUID()}`, version: 1, value: 0 };
  const results = await Promise.all(Array.from({ length: 5 }, () => store.reserve('test-attempt', 'fingerprint', order)));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal((await store.lookup('test-attempt', 'fingerprint')).id, order.id);
  await assert.rejects(store.reserve('test-attempt', 'different', order), { status: 409 });
  await Promise.all(Array.from({ length: 4 }, () => store.update(order.id, current => ({ ...current, value: current.value + 1 }))));
  assert.equal((await store.getOrder(order.id)).value, 4);
  assert.equal(await store.lock('lease', 'first', 1), true);
  assert.equal(await store.lock('lease', 'second', 1), false);
  await store.unlock('lease', 'wrong');
  assert.equal(await store.lock('lease', 'second', 1), false);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await store.lock('lease', 'second', 1), true);
  await store.unlock('lease', 'first');
  assert.equal(await store.lock('lease', 'third', 1), false);
  await store.unlock('lease', 'second');
});
