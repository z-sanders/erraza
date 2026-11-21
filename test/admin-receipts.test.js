'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config, setup, checkoutBody, call, memoryStore, providerDouble } = require('./helpers');
const { createHandlers } = require('../lib/handlers');
const {
  attemptAdminLogin, getAdminSession, adminLogout, isAdminEmail, encodeSessionCookie,
} = require('../lib/admin-auth');
const { notifyPayerReceipt, setPayerReceiptGate } = require('../lib/email');
const { payerEmail } = require('../lib/reference');
const PaymentLinks = require('../public/payment-links');

const adminConfig = {
  ...config,
  adminEmails: ['admin@jadeinstitutional.com'],
  supabaseUrl: 'https://project-ref.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.sig',
  supabaseAuthConfigured: true,
  emailReceiptsDefault: false,
};

const tokenForEmail = (email) => 'tok-' + email;
const ACCESS = tokenForEmail('admin@jadeinstitutional.com');
const REFRESH = 'refresh-token-value';

function grantResponder(fetchLog = [], { email = 'admin@jadeinstitutional.com', password = 'supabase-password' } = {}) {
  return async (url, options = {}) => {
    fetchLog.push({ url, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.includes('/auth/v1/token?grant_type=password')) {
      if (body.email === email && body.password === password) {
        return { ok: true, status: 200, json: async () => ({ access_token: tokenForEmail(email), refresh_token: REFRESH, expires_in: 3600 }) };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    }
    if (url.includes('/auth/v1/user')) {
      const token = (options.headers?.Authorization || '').replace('Bearer ', '');
      if (token === tokenForEmail(email)) {
        return { ok: true, status: 200, json: async () => ({ id: 'user-1', email }) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.includes('/auth/v1/logout')) return { ok: true, status: 204, json: async () => ({}) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

const { clearVerificationCache } = require('../lib/admin-auth');

test('admin login grants through Supabase Auth, verifies, and gates on ADMIN_EMAILS', async () => {
  clearVerificationCache();
  const fetchLog = [];
  const granted = await attemptAdminLogin(
    'Admin@JadeInstitutional.com', 'supabase-password', adminConfig,
    grantResponder(fetchLog)
  );
  assert.equal(granted.ok, true);
  assert.equal(granted.email, 'admin@jadeinstitutional.com');
  assert.equal(granted.cookieValue, encodeSessionCookie(ACCESS, REFRESH));
  assert.ok(fetchLog.some(call => call.url.includes('/auth/v1/token?grant_type=password')));
  assert.ok(fetchLog.some(call => call.url.includes('/auth/v1/user')));

  // Wrong password fails closed; a non-admin email is rejected after verification.
  await assert.rejects(
    () => attemptAdminLogin('admin@jadeinstitutional.com', 'wrong', adminConfig, grantResponder(fetchLog, { password: 'other' })),
    /Invalid email or password/
  );
  await assert.rejects(
    () => attemptAdminLogin('stranger@example.com', 'supabase-password', adminConfig,
      grantResponder(fetchLog, { email: 'stranger@example.com' })),
    /not an Erraza administrator/
  );
  assert.equal(isAdminEmail('Admin@JadeInstitutional.com', adminConfig), true);
  assert.equal(isAdminEmail('stranger@example.com', adminConfig), false);
});

test('admin session verification, silent refresh, and logout', async () => {
  clearVerificationCache();
  const fetchLog = [];
  const req = { headers: { cookie: `erraza_admin_session=${encodeSessionCookie(ACCESS, REFRESH)}` } };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };

  const session = await getAdminSession(req, res, adminConfig, grantResponder(fetchLog));
  assert.equal(session?.email, 'admin@jadeinstitutional.com');

  // Non-admin sessions are invisible to admin routes.
  const strangerReq = { headers: { cookie: `erraza_admin_session=${encodeSessionCookie(tokenForEmail('stranger@example.com'), REFRESH)}` } };
  assert.equal(await getAdminSession(strangerReq, res, adminConfig,
    grantResponder(fetchLog, { email: 'stranger@example.com' })), null);

  // Logout clears the cookie and calls the provider scope-wide.
  await adminLogout(req, res, adminConfig, grantResponder(fetchLog));
  assert.equal(res.headers['Set-Cookie'].includes('Max-Age=0'), true);
  assert.ok(fetchLog.some(call => call.url.includes('/auth/v1/logout')));
});

test('admin routes gate overview and toggle behind a signed-in admin', async () => {
  const store = memoryStore();
  const handlers = createHandlers({ config: adminConfig, store, provider: providerDouble() });
  await store.setCache('email_receipts', { enabled: true, updatedAt: 'now' }, 3600);
  const overview = await call(handlers['admin/overview'], { ip: '203.0.113.9' });
  assert.equal(overview.status, 403, 'overview requires a signed-in admin');
  const toggle = await call(handlers['admin/receipts-toggle'], {
    method: 'POST', ip: '203.0.113.9', body: { enabled: false },
  });
  assert.equal(toggle.status, 403);
  const stored = await store.getCache('email_receipts');
  assert.equal(stored.enabled, true);
});

test('checkout accepts payer email only while the receipts toggle is on, and persists it', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'receipts@example.com';
  try {
    const env = await setup({ config: { emailReceiptsDefault: false } });
    // Toggle on at runtime (store cache beats the env default).
    await env.store.setCache('email_receipts', { enabled: true, updatedAt: 'now' }, 3600);
    const on = await call(env.handlers.checkout, {
      method: 'POST', headers: env.headers,
      body: checkoutBody({ payerEmail: ' Payer@Example.COM ' }),
    });
    assert.equal(on.status, 201);
    const stored = await env.store.getOrder(on.body.orderId);
    assert.equal(stored.payerEmail, 'payer@example.com', 'normalized and persisted');

    // Settle the first order so the one-unresolved-principal rule allows another.
    await env.store.update(on.body.orderId, order => ({ ...order, status: 'expired' }));

    // Toggle off: the email is dropped silently so stale tabs keep working.
    await env.store.setCache('email_receipts', { enabled: false, updatedAt: 'now' }, 3600);
    const off = await call(env.handlers.checkout, {
      method: 'POST', headers: env.headers,
      body: checkoutBody({ payerEmail: 'payer2@example.com' }),
    });
    assert.equal(off.status, 201);
    const storedOff = await env.store.getOrder(off.body.orderId);
    assert.equal(storedOff.payerEmail, undefined);

    // Invalid email while on fails loudly.
    await env.store.setCache('email_receipts', { enabled: true, updatedAt: 'now' }, 3600);
    const invalid = await call(env.handlers.checkout, {
      method: 'POST', headers: env.headers,
      body: checkoutBody({ payerEmail: 'not-an-email' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_payer_email');
  } finally {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  }
});

test('config exposes the receipts toggle to the checkout form', async () => {
  const env = await setup({ config: { emailReceiptsDefault: false } });
  const off = await call(env.handlers.config, { url: '/api/config' });
  assert.equal(off.body.emailReceipts.enabled, false);
  assert.equal(off.body.emailReceipts.configured, false, 'notificationConfigured is false without Resend env');
  await env.store.setCache('email_receipts', { enabled: true, updatedAt: 'now' }, 3600);
  const on = await call(env.handlers.config, { url: '/api/config' });
  assert.equal(on.body.emailReceipts.enabled, true);
});

test('notifyPayerReceipt sends once, gated, and never throws', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'receipts@example.com';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const settled = {
    id: 'err_44444444-5555-4333-8333-666666666666', status: 'finished', complete: true,
    amount: '100.00', currency: 'usd', method: 'crypto', reference: 'Invoice 12',
    merchant: 'Erraza', payerEmail: 'payer@example.com',
    asset: { code: 'btc', ticker: 'BTC' }, paymentId: '7100000000',
  };

  // No gate registered → fail closed.
  setPayerReceiptGate(null);
  assert.equal(await notifyPayerReceipt(settled, fetchImpl), 'disabled');
  assert.equal(calls.length, 0);

  // Gate on → one minimized Resend call with a deterministic idempotency key.
  setPayerReceiptGate(async () => ({ enabled: true, configured: true }));
  assert.equal(await notifyPayerReceipt(settled, fetchImpl), 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['Idempotency-Key'], `erraza-payer-receipt:${settled.id}`);
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.to, ['payer@example.com']);
  assert.match(payload.subject, /Your Erraza receipt — 100\.00 usd/);
  assert.match(payload.text, /Invoice 12/);

  // Gate off → disabled without a network call.
  setPayerReceiptGate(async () => ({ enabled: false, configured: true }));
  assert.equal(await notifyPayerReceipt(settled, fetchImpl), 'disabled');
  assert.equal(calls.length, 1);
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;

  // Unsettled or email-less orders never send.
  setPayerReceiptGate(async () => ({ enabled: true, configured: true }));
  assert.equal(await notifyPayerReceipt({ ...settled, status: 'waiting', complete: false }, fetchImpl), 'disabled');
  assert.equal(await notifyPayerReceipt({ ...settled, payerEmail: null }, fetchImpl), 'disabled');
  assert.equal(calls.length, 1);
});

test('payer email validation agrees on the server and the client', () => {
  for (const value of ['Payer@Example.COM ', 'payer@example.com']) {
    assert.equal(payerEmail(value), 'payer@example.com');
    assert.equal(PaymentLinks.email(value), 'payer@example.com');
  }
  assert.equal(payerEmail(''), '');
  assert.equal(PaymentLinks.email(''), '');
  assert.equal(payerEmail(undefined), '');
  for (const value of ['not-an-email', 'a@b', 'a@x.com\nmore']) {
    assert.throws(() => payerEmail(value), undefined, value);
    assert.throws(() => PaymentLinks.email(value), undefined, value);
  }
});
