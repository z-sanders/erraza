'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfig } = require('../lib/config');
const { safeRedirect } = require('../lib/orders');
const { config, setup, checkoutBody, call } = require('./helpers');

test('sandbox mode must be explicitly true or false before checkout is configured', () => {
  const valid = {
    NOWPAYMENTS_API_KEY: 'test-api-key',
    NOWPAYMENTS_IPN_SECRET: 'test-ipn-secret',
    CHECKOUT_SECRET: 'test-checkout-secret-at-least-32-characters',
    PUBLIC_BASE_URL: 'https://checkout.example',
    SUPABASE_URL: 'https://project-ref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    NOWPAYMENTS_PAYOUT_CURRENCY: 'btc',
  };

  const sandbox = getConfig({ ...valid, NOWPAYMENTS_SANDBOX: 'true' });
  assert.equal(sandbox.configured, true);
  assert.equal(sandbox.sandbox, true);
  assert.equal(sandbox.apiBase, 'https://api-sandbox.nowpayments.io/v1');

  const live = getConfig({ ...valid, NOWPAYMENTS_SANDBOX: 'false' });
  assert.equal(live.configured, true);
  assert.equal(live.sandbox, false);
  assert.equal(live.apiBase, 'https://api.nowpayments.io/v1');

  for (const value of [undefined, '', 'TRUE', 'False', ' false ', '1']) {
    const env = { ...valid };
    if (value !== undefined) env.NOWPAYMENTS_SANDBOX = value;
    const settings = getConfig(env);
    assert.equal(settings.configured, false, String(value));
  }
});

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
