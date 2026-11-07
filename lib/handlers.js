'use strict';

const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { getConfig } = require('./config');
const { createStore } = require('./store');
const { createProvider, verifyIpn, ProviderError } = require('./nowpayments');
const { HttpError, json, readJson, query, requireMethod, requireReady, handleError } = require('./http');
const { session, signToken, verifyToken, orderToken, digest, equal } = require('./security');
const { validateAmount, providerId, positiveDecimal } = require('./money');
const { assets, quote } = require('./assets');
const { paymentReference } = require('./reference');
const { validateIdentity, applyProviderState, applyCreation, reconcile, view } = require('./orders');

function clientIp(req, config) {
  // Vercel overwrites these headers at its ingress. Never trust them on a local server.
  const forwarded = config.vercel ? req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] : null;
  const value = typeof forwarded === 'string' ? forwarded.trim() : req.socket?.remoteAddress;
  if (!value || !isIP(value)) throw new HttpError(400, 'client_ip_unavailable', 'The client connection could not be verified.');
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

function createHandlers(dependencies = {}) {
  const config = dependencies.config || getConfig();
  const provider = dependencies.provider || createProvider(config);
  let store = dependencies.store;
  const database = () => store || (store = createStore(config));
  async function limit(req, group, maximum = 90) {
    const ip = clientIp(req, config);
    await database().rateLimit(`${group}:${digest(ip, config.checkoutSecret)}`, maximum, 60);
    return ip;
  }
  function csrf(req, res) {
    if (req.headers.origin !== config.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new HttpError(403, 'invalid_origin', 'Open the checkout on its original website.');
    }
    const sid = session(req, res, config);
    const token = verifyToken(req.headers['x-csrf-token'], 'csrf', config);
    if (!sid || !token || !equal(sid, token.sid || '')) throw new HttpError(403, 'session_expired', 'Your checkout session expired. Refresh the page and try again.');
    return sid;
  }
  async function getAsset(code) {
    if (typeof code !== 'string' || !/^[a-z0-9]{2,32}$/.test(code)) throw new HttpError(400, 'invalid_asset', 'Choose a supported coin and network.');
    const available = await assets(provider, database());
    const asset = available.find(item => item.code === code);
    if (!asset) throw new HttpError(400, 'invalid_asset', 'This coin and network are not enabled by the merchant.');
    return asset;
  }
  const routes = {
    async config(req, res) {
      requireMethod(req, res, 'GET');
      let csrfToken = null;
      if (config.configured) {
        await limit(req, 'config', 30);
        const sid = session(req, res, config, true);
        csrfToken = signToken({ sid }, 'csrf', config, 3600);
      }
      return json(res, 200, {
        brand: config.brand, configured: config.configured, sandbox: config.sandbox,
        fiatEnabled: config.fiatEnabled, fiatCurrencies: config.fiatCurrencies, currencies: config.currencies,
        minAmount: config.minAmount, maxAmount: config.maxAmount, csrfToken, supportEmail: config.supportEmail,
      });
    },
    async currencies(req, res) {
      requireMethod(req, res, 'GET');
      requireReady(config);
      await limit(req, 'read');
      return json(res, 200, { currencies: await assets(provider, database()) });
    },
    async estimate(req, res) {
      requireMethod(req, res, 'GET');
      requireReady(config);
      await limit(req, 'quote', 40);
      const params = query(req);
      const currency = params.get('fiat');
      const amount = validateAmount(params.get('amount'), currency, config);
      const asset = await getAsset(params.get('coin'));
      return json(res, 200, await quote(amount, currency, asset.code, provider, database()));
    },
    async 'min-amount'(req, res) {
      requireMethod(req, res, 'GET');
      requireReady(config);
      await limit(req, 'quote', 40);
      const params = query(req);
      const currency = params.get('fiat') || 'usd';
      if (!config.currencies.some(item => item.code === currency)) throw new HttpError(400, 'invalid_currency', 'Choose a supported currency.');
      const asset = await getAsset(params.get('coin'));
      const minimum = await provider.minimum(asset.code, currency);
      return json(res, 200, { minFiatAmount: positiveDecimal(minimum.fiat_equivalent), currency, asset: asset.code });
    },
    async checkout(req, res) {
      requireMethod(req, res, 'POST');
      requireReady(config);
      const sid = csrf(req, res);
      const ip = await limit(req, 'checkout', 10);
      const body = await readJson(req, 4096);
      const amount = validateAmount(body.amount, body.currency, config);
      const reference = paymentReference(body.reference);
      const method = body.method;
      if (!['crypto', 'card'].includes(method)) throw new HttpError(400, 'invalid_method', 'Choose crypto or card.');
      if (typeof body.idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey)) {
        throw new HttpError(400, 'invalid_idempotency_key', 'This checkout attempt is invalid. Refresh the page and try again.');
      }
      if (method === 'card' && (!config.fiatEnabled || !config.fiatCurrencies.includes(body.currency))) {
        throw new HttpError(400, 'fiat_unavailable', 'Card on-ramp is not available for this merchant or currency. Choose crypto or a supported fiat currency.');
      }
      if (method === 'card' && (ip === '127.0.0.1' || ip === '::1')) throw new HttpError(400, 'public_connection_required', 'Card verification requires the deployed HTTPS site and a public customer connection.');
      const requestedAsset = method === 'crypto' ? body.asset : null;
      if (method === 'crypto' && (typeof requestedAsset !== 'string' || !/^[a-z0-9]{2,32}$/.test(requestedAsset))) throw new HttpError(400, 'invalid_asset', 'Choose a supported coin and network.');
      const fingerprint = digest(JSON.stringify({ sid, amount, currency: body.currency, method, asset: requestedAsset, ...(reference ? { reference } : {}) }), config.checkoutSecret);
      const idempotencyKey = digest(body.idempotencyKey, config.checkoutSecret);
      const existing = await database().lookup(idempotencyKey, fingerprint);
      if (existing) return json(res, ['creating', 'unknown'].includes(existing.status) ? 202 : 200, view(existing, config));
      const asset = method === 'crypto' ? await getAsset(requestedAsset) : null;
      // Read-only quote failures create no payable attempt and remain safe to retry.
      if (asset) await quote(amount, body.currency, asset.code, provider, database());
      const now = new Date().toISOString();
      const fresh = {
        id: `err_${randomUUID()}`, version: 1, amount, currency: body.currency, method, asset, reference, merchant: config.brand,
        payCurrency: asset?.code || body.currency, paymentId: null, expectedPayAmount: null,
        status: 'creating', complete: false, message: 'Preparing your payment. Please do not start another checkout.',
        createdAt: now, updatedAt: now, lastCheckedAt: null, payment: null, checkoutUrl: null,
      };
      const reservation = await database().reserve(idempotencyKey, fingerprint, fresh);
      if (!reservation.created) return json(res, reservation.order.status === 'creating' || reservation.order.status === 'unknown' ? 202 : 200, view(reservation.order, config));
      let order = reservation.order;
      const payload = {
        price_amount: Number(amount), price_currency: body.currency, pay_currency: order.payCurrency,
        order_id: order.id, order_description: `${config.brand} payment`,
        ipn_callback_url: `${config.origin}/api/ipn`,
        is_fixed_rate: false, is_fee_paid_by_user: false,
      };
      let data;
      try {
        data = await provider.create(payload, method === 'card' ? ip : undefined);
      } catch (error) {
        const rejected = error instanceof ProviderError && error.rejected;
        order = await database().update(order.id, current => {
          if (current.paymentId) return current;
          return { ...current, status: rejected ? 'rejected' : 'unknown', message: rejected
            ? 'The payment provider could not create this checkout. Check the amount and payment method, or contact the merchant.'
            : 'The provider has not confirmed whether checkout was created. Do not start another payment. Keep this reference and check again, or contact the merchant.' };
        });
        return json(res, 202, view(order, config));
      }
      // Save the verified payment identity first so it survives later URL/QR failures.
      try {
        const id = validateIdentity(order, data);
        order = await database().update(order.id, current => {
          validateIdentity(current, data);
          const expected = positiveDecimal(data.pay_amount);
          if (current.expectedPayAmount && current.expectedPayAmount !== expected) throw new HttpError(502, 'payment_mismatch', 'The provider payment amount changed unexpectedly.');
          return { ...current, paymentId: id, expectedPayAmount: expected, ...(method === 'card' ? { providerType: 'fiat2crypto' } : {}) };
        });
        order = await applyCreation(order, data, config, database());
      } catch (error) {
        order = await database().update(order.id, current => {
          if (current.complete) return current;
          return { ...current, status: 'review', complete: false, message: 'A checkout was created, but its payment details could not be verified. Do not send funds or create another payment. Contact the merchant with this reference.' };
        });
        return json(res, 202, view(order, config));
      }
      return json(res, 201, view(order, config));
    },
    async status(req, res) {
      requireMethod(req, res, 'GET');
      requireReady(config);
      await limit(req, 'status', 90);
      const claims = verifyToken(query(req).get('token'), 'order', config);
      if (!claims || !/^err_[0-9a-f-]{36}$/.test(claims.orderId || '')) throw new HttpError(403, 'invalid_reference', 'The payment reference is invalid or expired.');
      let order = await database().getOrder(claims.orderId);
      if (!order) throw new HttpError(404, 'order_not_found', 'This payment could not be found. Please contact the merchant.');
      if (order.status === 'creating' && Date.now() - Date.parse(order.createdAt) > 30000) {
        order = await database().update(order.id, current => current.status === 'creating' ? { ...current, status: 'unknown', message: 'The provider response is delayed. Do not start another payment; check again or contact the merchant.' } : current);
      }
      try { order = await reconcile(order, provider, database(), config); }
      catch {
        return json(res, 200, { ...view(order, config), message: 'The latest payment status could not be checked. The last verified status is shown. Please check again shortly.' });
      }
      return json(res, 200, view(order, config));
    },
    async reconcile(req, res) {
      requireMethod(req, res, 'POST');
      requireReady(config);
      if (!config.reconciliationSecret || config.reconciliationSecret.length < 32) throw new HttpError(503, 'operator_disabled', 'Merchant reconciliation is not configured.');
      if (typeof req.headers.authorization !== 'string' || !equal(req.headers.authorization, `Bearer ${config.reconciliationSecret}`)) throw new HttpError(401, 'operator_unauthorized', 'Merchant authorization is required.');
      await limit(req, 'operator', 15);
      const body = await readJson(req, 2048);
      if (!/^err_[0-9a-f-]{36}$/.test(body.orderId || '')) throw new HttpError(400, 'invalid_order', 'Provide a valid order reference.');
      let order = await database().getOrder(body.orderId);
      if (!order) throw new HttpError(404, 'order_not_found', 'The order could not be found.');
      let id;
      try { id = providerId(body.paymentId || order.paymentId); }
      catch { throw new HttpError(400, 'payment_id_required', 'Find the payment in the merchant dashboard and provide its payment ID.'); }
      const data = await provider.status(id);
      validateIdentity(order, data);
      order = await database().update(order.id, current => {
        validateIdentity(current, data);
        current.paymentId = id;
        if (current.method === 'card') current.providerType = 'fiat2crypto';
        if (!current.expectedPayAmount) current.expectedPayAmount = positiveDecimal(data.pay_amount);
        // Explicit operator reconciliation may re-evaluate a prior manual-review state.
        if (current.status === 'review') current.status = 'verification_pending';
        current.lastReconciledAt = new Date().toISOString();
        return applyProviderState(current, data);
      });
      if (!order.complete && order.status !== 'review' && (!order.payment && !order.checkoutUrl)) order = await applyCreation(order, data, config, database());
      return json(res, 200, view(order, config));
    },
    async ipn(req, res) {
      requireMethod(req, res, 'POST');
      requireReady(config);
      const payload = await readJson(req);
      if (!verifyIpn(payload, req.headers['x-nowpayments-sig'], config)) throw new HttpError(401, 'invalid_signature', 'Invalid callback signature.');
      if (!/^err_[0-9a-f-]{36}$/.test(payload.order_id || '')) return json(res, 200, { received: true, ignored: true });
      let order = await database().getOrder(payload.order_id);
      if (!order) throw new HttpError(503, 'order_unavailable', 'The order record is not available yet.');
      let id;
      try { id = providerId(payload.payment_id); }
      catch { throw new HttpError(400, 'invalid_payment', 'Invalid provider payment identity.'); }
      // Fetch authoritative state rather than trusting callback arrival order or numeric parsing.
      const data = await provider.status(id);
      validateIdentity(order, data);
      order = await database().update(order.id, current => {
        validateIdentity(current, data);
        current.paymentId = id;
        if (current.method === 'card') current.providerType = 'fiat2crypto';
        if (!current.expectedPayAmount) current.expectedPayAmount = positiveDecimal(data.pay_amount);
        current.lastWebhookAt = new Date().toISOString();
        return applyProviderState(current, data);
      });
      // No fulfillment side effects here. Acknowledge only after the CAS write succeeds.
      return json(res, 200, { received: true });
    },
  };
  return Object.fromEntries(Object.entries(routes).map(([name, route]) => [name, async (req, res) => {
    try { await route(req, res); } catch (error) { handleError(res, error); }
  }]));
}

function handler(name) {
  return (req, res) => createHandlers()[name](req, res);
}

module.exports = { createHandlers, handler, clientIp };
