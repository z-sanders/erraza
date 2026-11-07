'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfig } = require('../lib/config');
const { safeRedirect } = require('../lib/orders');
const { config, setup, checkoutBody, call } = require('./helpers');

test('fiat defaults on for the activated merchant without a provider-host setup step', () => {
  const settings = getConfig({});
  assert.equal(settings.fiatEnabled, true);
  assert.deepEqual(settings.fiatRedirectHosts, []);
  assert.equal(settings.configured, false, 'Missing payment credentials still block checkout.');
});

test('fiat can be intentionally disabled and malformed host restrictions fail closed', () => {
  assert.equal(getConfig({ NOWPAYMENTS_FIAT_ENABLED: 'false' }).fiatEnabled, false);
  for (const value of ['https://pay.provider.example', '*.provider.example', 'pay.provider.example,', 'pay.provider.example/path']) {
    assert.equal(getConfig({ NOWPAYMENTS_FIAT_REDIRECT_HOSTS: value }).fiatEnabled, false, value);
  }
  assert.equal(getConfig({ NOWPAYMENTS_FIAT_REDIRECT_HOSTS: 'pay.provider.example' }).fiatEnabled, true);
});

test('provider-returned checkout URLs work without a manual hostname list', () => {
  const settings = { ...config, fiatRedirectHosts: [] };
  assert.equal(safeRedirect('https://checkout.provider.example/payment/abc?amount=100', settings), 'https://checkout.provider.example/payment/abc?amount=100');
  for (const value of ['http://checkout.provider.example/', '//checkout.provider.example/', 'https://user:password@checkout.provider.example/', 'https://checkout.provider.example:8443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://payments.internal/', 'https://payments.local/', 'https://checkout.provider.example/\nother']) {
    assert.throws(() => safeRedirect(value, settings), value);
  }
});

test('an optional exact-host restriction is still enforced', () => {
  assert.throws(() => safeRedirect('https://another.provider.example/payment', config));
  assert.equal(safeRedirect('https://pay.provider.example/payment', config), 'https://pay.provider.example/payment');
});

test('activated fiat checkout uses only the provider response URL, not a customer-supplied URL', async () => {
  const env = await setup({ config: { fiatRedirectHosts: [] } });
  const result = await call(env.handlers.checkout, {
    method: 'POST', headers: env.headers,
    body: checkoutBody({ method: 'card', checkoutUrl: 'https://attacker.example/phish' }),
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.checkoutUrl, 'https://pay.provider.example/checkout/fixture');
  assert.equal(env.provider.createCalls, 1);
});
