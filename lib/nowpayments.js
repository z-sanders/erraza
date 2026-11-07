'use strict';

// Contract references and verification limits are recorded in docs/nowpayments.md.
const { createHmac, timingSafeEqual } = require('node:crypto');

class ProviderError extends Error {
  constructor(status, code, rejected = false) {
    super(code);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.rejected = rejected;
  }
}

function parseProviderJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && (key === 'id' || key.endsWith('_id') || key.includes('amount') || key === 'actually_paid' || key === 'fiat_equivalent')) {
      return context?.source || String(value);
    }
    return value;
  });
}

function createProvider(config, transport = fetch) {
  async function request(path, { method = 'GET', body, ip } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await transport(`${config.apiBase}${path}`, {
        method, signal: controller.signal, redirect: 'error',
        headers: {
          'x-api-key': config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(ip ? { 'origin-ip': ip } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ProviderError(502, 'provider_response_too_large');
      let data;
      try { data = parseProviderJson(text); }
      catch { throw new ProviderError(502, 'invalid_provider_response'); }
      if (!response.ok) {
        const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
        throw new ProviderError(response.status, 'provider_rejected', rejected);
      }
      if (!data || typeof data !== 'object') throw new ProviderError(502, 'invalid_provider_response');
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(502, controller.signal.aborted ? 'provider_timeout' : 'provider_unreachable');
    } finally { clearTimeout(timeout); }
  }
  const params = values => new URLSearchParams(values).toString();
  return {
    merchantCoins: () => request('/merchant/coins'),
    fullCurrencies: () => request('/full-currencies'),
    estimate: (amount, from, to) => request(`/estimate?${params({ amount, currency_from: from, currency_to: to })}`),
    minimum: (asset, fiat) => request(`/min-amount?${params({ currency_from: asset, currency_to: config.payoutCurrency, fiat_equivalent: fiat, is_fixed_rate: 'false', is_fee_paid_by_user: 'false' })}`),
    create: (body, ip) => request('/payment', { method: 'POST', body, ip }),
    status: id => request(`/payment/${encodeURIComponent(id)}`),
  };
}

function sortedStringify(value, depth = 0) {
  if (depth > 32) throw new Error('Payload is nested too deeply');
  if (Array.isArray(value)) return '[' + value.map(item => sortedStringify(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + sortedStringify(value[key], depth + 1)).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid JSON number');
  return JSON.stringify(value);
}

function verifyIpn(payload, signature, config) {
  if (!config.ipnSecret || typeof signature !== 'string' || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  try {
    const expected = createHmac('sha512', config.ipnSecret).update(sortedStringify(payload)).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

module.exports = { createProvider, ProviderError, parseProviderJson, sortedStringify, verifyIpn };
