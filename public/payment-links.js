(function (root) {
  'use strict';

  function compare(left, right) {
    const split = value => {
      if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) throw new Error('Payment limits could not be loaded.');
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    };
    const a = split(left), b = split(right);
    return a === b ? 0 : a > b ? 1 : -1;
  }

  function validate(amount, currency, config) {
    if (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) throw new Error('Choose a supported currency.');
    const code = currency.toLowerCase();
    const metadata = config?.currencies?.find(item => item.code === code);
    if (!metadata || !Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 2) {
      throw new Error('Choose a supported currency.');
    }
    if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount)) {
      throw new Error('Enter an amount using a period for decimals, without commas or currency symbols.');
    }
    const [whole, fraction = ''] = amount.split('.');
    if (fraction.length > metadata.decimals) {
      throw new Error(metadata.decimals === 0 ? `${code.toUpperCase()} amounts must be whole numbers.` : `Use no more than ${metadata.decimals} decimal places.`);
    }
    if (compare(amount, '0') <= 0 || compare(amount, config.minAmount) < 0 || compare(amount, config.maxAmount) > 0) {
      throw new Error(`Enter an amount from ${config.minAmount} to ${config.maxAmount} ${code.toUpperCase()}.`);
    }
    return { amount: whole + (metadata.decimals ? `.${fraction.padEnd(metadata.decimals, '0')}` : ''), currency: code };
  }

  function normalizeInput(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    // A single comma followed by one or two digits is unambiguously decimal here.
    if (/^\d+,\d{1,2}$/.test(text)) return text.replace(',', '.');
    return text;
  }

  function reference(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > 80
      || /[<>\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) {
      throw new Error('Use a name or reference of up to 80 characters, without markup or hidden characters.');
    }
    const normalized = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
    if (normalized.length > 80) throw new Error('Use a name or reference of up to 80 characters.');
    return normalized;
  }

  function parse(search, config) {
    if (typeof search !== 'string') throw new Error('This payment link is invalid.');
    const params = new URLSearchParams(search);
    if (!params.has('amount') && !params.has('currency') && !params.has('for')) return null;
    if (search.length > 2048 || params.getAll('amount').length !== 1 || params.getAll('currency').length !== 1 || params.getAll('for').length > 1) {
      throw new Error('This payment link must contain one amount, one currency and at most one reference.');
    }
    const preset = validate(params.get('amount'), params.get('currency'), config);
    const label = reference(params.get('for'));
    return label ? { ...preset, reference: label } : preset;
  }

  function create(origin, amount, currency, config, label = '') {
    const base = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash
      || (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))) {
      throw new Error('Open the link creator on your checkout website.');
    }
    const preset = validate(amount, currency, config);
    const url = new URL('/', base.origin);
    url.searchParams.set('amount', preset.amount);
    url.searchParams.set('currency', preset.currency);
    const name = reference(label);
    if (name) url.searchParams.set('for', name);
    return url.href;
  }

  const api = Object.freeze({ validate, parse, create, normalizeInput, reference });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaymentLinks = api;
})(globalThis);
