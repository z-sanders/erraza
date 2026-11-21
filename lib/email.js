// Best-effort Resend notifications for durable settlement events.
// Delivery must never affect payment handling: every failure is contained
// here and callers may ignore the returned status entirely.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function adminRecipients() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.includes('@'));
}

function notificationConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) && adminRecipients().length > 0;
}

// Payer receipts need sending credentials only — not the admin list.
function emailSendingConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// `order` is the persisted order after a store.update that transitioned it to
// a durable finished state. The deterministic Idempotency-Key deduplicates a
// concurrent double-observation of the same first settlement.
async function notifySettled(order, fetchImpl = fetch) {
  try {
    if (!order || order.status !== 'finished' || order.complete !== true || !notificationConfigured()) {
      return 'disabled';
    }
    const asset = order.asset && (order.asset.assetCode || order.asset.ticker) ? ` · ${order.asset.assetCode || order.asset.ticker}` : '';
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
        'Idempotency-Key': `erraza-payment-settled:${order.id}`
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: adminRecipients(),
        subject: `Erraza payment settled — ${order.amount} ${order.currency} (${order.method})`,
        text:
          `Order ${order.id}\n` +
          `Reference: ${order.reference || 'n/a'}\n` +
          `Amount: ${order.amount} ${order.currency}\n` +
          `Method: ${order.method}${asset}\n` +
          `Provider payment: ${order.paymentId || 'n/a'}\n` +
          `Settled: ${new Date().toISOString()}`
      }),
      signal: AbortSignal.timeout(15000)
    });
    return response.ok ? 'sent' : `failed:${response.status}`;
  } catch (error) {
    return `failed:${error && error.name === 'AbortError' ? 'timeout' : 'error'}`;
  }
}

// Payer receipts. Enabled is decided at send time by the receipts gate
// (runtime toggle → env default → off), so a payment whose settlement is
// observed while the toggle is on receives its receipt even if collection
// happened earlier; fail-closed when no gate is registered.
let payerReceiptGate = null;

function setPayerReceiptGate(gate) {
  payerReceiptGate = typeof gate === 'function' ? gate : null;
}

async function payerReceiptsActive() {
  if (!payerReceiptGate) return false;
  try {
    const state = await payerReceiptGate();
    return Boolean(state && state.enabled === true && state.configured === true);
  } catch {
    return false;
  }
}

async function notifyPayerReceipt(order, fetchImpl = fetch) {
  try {
    if (!order || order.status !== 'finished' || order.complete !== true || !order.payerEmail) return 'disabled';
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return 'disabled';
    if (!await payerReceiptsActive()) return 'disabled';
    const asset = order.asset && (order.asset.assetCode || order.asset.ticker) ? ` · ${order.asset.assetCode || order.asset.ticker}` : '';
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
        'Idempotency-Key': `erraza-payer-receipt:${order.id}`
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [order.payerEmail],
        subject: `Your Erraza receipt — ${order.amount} ${order.currency}`,
        text:
          `Thank you for your payment to ${order.merchant || 'Erraza'}.\n` +
          `Order ${order.id}\n` +
          `Reference: ${order.reference || 'n/a'}\n` +
          `Amount: ${order.amount} ${order.currency}\n` +
          `Method: ${order.method}${asset}\n` +
          `Settled: ${new Date().toISOString()}\n\n` +
          `Keep your order reference for any questions about this payment.`
      }),
      signal: AbortSignal.timeout(15000)
    });
    return response.ok ? 'sent' : `failed:${response.status}`;
  } catch (error) {
    return `failed:${error && error.name === 'AbortError' ? 'timeout' : 'error'}`;
  }
}

module.exports = { adminRecipients, notificationConfigured, emailSendingConfigured, notifySettled, setPayerReceiptGate, notifyPayerReceipt };
