'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../public/payment-links');
const { paymentReference } = require('../lib/reference');
const { setup, checkoutBody, call, config } = require('./helpers');

const invalid = ['<img src=x>', 'one\ntwo', '\u202Espoof', '\u200bhidden', 'x'.repeat(81), { name: 'other' }];

test('personalized links preserve optional names and keep the merchant destination unchanged', () => {
  const url = links.create('https://checkout.example', '125', 'usd', config, 'Mina & Studio');
  const preset = links.parse(new URL(url).search, config);
  assert.deepEqual(preset, { amount: '125.00', currency: 'usd', reference: 'Mina & Studio' });
  assert.equal(new URL(url).origin, 'https://checkout.example');
  assert.equal(new URL(url).searchParams.has('recipient'), false);
  assert.throws(() => links.parse('?amount=125&currency=usd&for=Mina&for=Other', config));
});

test('client and server reference validation agree, including Unicode and hidden characters', () => {
  for (const value of ['Mina', 'José', '山田', '  Studio   invoice  ', '', null, undefined]) {
    assert.equal(links.reference(value), paymentReference(value));
  }
  assert.equal(paymentReference('  Studio   invoice  '), 'Studio invoice');
  for (const value of invalid) {
    assert.throws(() => links.reference(value));
    assert.throws(() => paymentReference(value));
  }
});

test('unambiguous decimal commas are normalized but grouping is rejected', () => {
  assert.equal(links.normalizeInput('125,50'), '125.50');
  assert.equal(links.normalizeInput('125,5'), '125.5');
  for (const value of ['1,000', '1,000.50', '1.000,50', '1,00,0']) {
    assert.throws(() => links.validate(links.normalizeInput(value), 'usd', config));
  }
});

test('payment reference is persisted and cannot override merchant or payout configuration', async () => {
  const env = await setup();
  let payload;
  const original = env.provider.create;
  env.provider.create = (...args) => { payload = args[0]; return original(...args); };
  const created = await call(env.handlers.checkout, { method: 'POST', headers: env.headers,
    body: checkoutBody({ reference: 'Mina', merchant: 'Someone else', payout_address: 'attacker-wallet' }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.reference, 'Mina');
  assert.equal(created.body.merchant, 'Erraza');
  assert.equal(payload.order_description, 'Erraza payment');
  assert.equal('reference' in payload, false, 'Reference does not become an instruction to the provider');
  assert.equal('payout_address' in payload, false);
  const resumed = await call(env.handlers.status, { url: `/api/status?token=${created.body.token}` });
  assert.equal(resumed.body.reference, 'Mina');
  assert.equal(resumed.body.merchant, 'Erraza');
});

test('changing a reference cannot reuse another idempotent request', async () => {
  const env = await setup();
  const body = checkoutBody({ reference: 'Mina' });
  const first = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body });
  assert.equal(first.status, 201);
  const second = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: { ...body, reference: 'Other' } });
  assert.equal(second.status, 409);
  assert.equal(env.provider.createCalls, 1);
});

test('invalid references are rejected before provider creation', async () => {
  const env = await setup();
  for (const reference of invalid) {
    const result = await call(env.handlers.checkout, { method: 'POST', headers: env.headers, body: checkoutBody({ reference }) });
    assert.equal(result.status, 400);
  }
  assert.equal(env.provider.createCalls, 0);
});
