const test = require('node:test');
const assert = require('node:assert/strict');

const { adminRecipients, notificationConfigured, notifySettled } = require('../lib/email');
const { settledDuring } = require('../lib/orders');

function withEnv(overrides, run) {
  const saved = { ...process.env };
  Object.assign(process.env, overrides);
  return Promise.resolve(run()).finally(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('notification config requires key, sender, and at least one recipient', () => {
  process.env.ADMIN_EMAILS = 'ops@example.com';
  process.env.EMAIL_FROM = 'Erraza <payments@jadeinstitutional.com>';
  assert.deepEqual(adminRecipients(), ['ops@example.com']);
  delete process.env.RESEND_API_KEY;
  assert.equal(notificationConfigured(), false);
  process.env.RESEND_API_KEY = 'x'.repeat(20);
  assert.equal(notificationConfigured(), true);
  process.env.ADMIN_EMAILS = 'not-an-email';
  assert.equal(notificationConfigured(), false);
});

test('settledDuring fires only on the first durable finished transition', () => {
  const settled = { status: 'finished', complete: true };
  const pending = { status: 'waiting', complete: false };
  const unfinished = { status: 'finished', complete: false };
  assert.equal(settledDuring('waiting', settled), true);
  assert.equal(settledDuring('confirming', settled), true);
  assert.equal(settledDuring('finished', settled), false, 'repeat observation of a settled order must not re-notify');
  assert.equal(settledDuring('finished', { ...settled, status: 'refunded' }), false);
  assert.equal(settledDuring('waiting', pending), false);
  assert.equal(settledDuring('waiting', unfinished), false, 'finished without verified completion is not settlement');
  assert.equal(settledDuring('waiting', null), false);
});

test('notifySettled never throws and fails closed without configuration', async () => {
  const settled = {
    id: 'err_00000000-0000-4000-8000-000000000001',
    status: 'finished',
    complete: true,
    amount: '250',
    currency: 'usd',
    method: 'crypto',
    asset: { assetCode: 'usdterc20' },
    paymentId: '4321',
    reference: 'REF-1'
  };
  await withEnv({}, async () => {
    assert.equal(await notifySettled(settled), 'disabled', 'missing env must disable, never throw');
    assert.equal(await notifySettled(null), 'disabled');
  });
  let called = 0;
  await withEnv({ RESEND_API_KEY: 'x'.repeat(20), EMAIL_FROM: 'Erraza <payments@jadeinstitutional.com>', ADMIN_EMAILS: 'ops@example.com' }, async () => {
    const status = await notifySettled(settled, async () => { called += 1; throw new Error('provider down'); });
    assert.equal(status, 'failed:error');
    const timeoutStatus = await notifySettled(settled, async () => { called += 1; throw Object.assign(new Error('late'), { name: 'AbortError' }); });
    assert.equal(timeoutStatus, 'failed:timeout');
    assert.equal(called, 2, 'delivery attempts were made once configured');
  });
});

test('notifySettled posts a minimized payload with a deterministic idempotency key', async () => {
  const seen = [];
  const settled = {
    id: 'err_00000000-0000-4000-8000-000000000002',
    status: 'finished',
    complete: true,
    amount: '250',
    currency: 'usd',
    method: 'crypto',
    asset: { assetCode: 'usdterc20' },
    paymentId: '4321',
    reference: 'REF-2'
  };
  await withEnv({ RESEND_API_KEY: 'x'.repeat(20), EMAIL_FROM: 'Erraza <payments@jadeinstitutional.com>', ADMIN_EMAILS: 'ops@example.com' }, async () => {
    await notifySettled(settled, async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] });
      return { ok: true, status: 200 };
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].key, 'erraza-payment-settled:err_00000000-0000-4000-8000-000000000002');
  assert.equal(seen[0].body.from, 'Erraza <payments@jadeinstitutional.com>');
  assert.deepEqual(seen[0].body.to, ['ops@example.com']);
  assert.match(seen[0].body.subject, /Erraza payment settled/);
  assert.doesNotMatch(JSON.stringify(seen[0].body), /seed|private|token|wallet/i);
});
