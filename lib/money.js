'use strict';

const { HttpError } = require('./http');

function decimalString(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid decimal type');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid decimal number');
  const text = String(value);
  const match = /^(\d{1,40})(?:\.(\d{0,40}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match) throw new Error('Invalid positive decimal');
  const exponent = Number(match[3] || 0);
  if (Math.abs(exponent) > 40) throw new Error('Decimal exponent outside bounds');
  const digits = match[1] + (match[2] || '');
  const point = match[1].length + exponent;
  let result;
  if (point <= 0) result = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) result = digits + '0'.repeat(point - digits.length);
  else result = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, fraction = ''] = result.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return whole.replace(/^0+(?=\d)/, '') + (trimmed ? `.${trimmed}` : '');
}

function units(value, scale = 40) {
  const [whole, fraction = ''] = decimalString(value).split('.');
  if (fraction.length > scale) throw new Error('Decimal precision exceeds supported scale');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
}

function atLeast(value, expected) {
  try { return units(value) >= units(expected); } catch { return false; }
}

function sameAmount(a, b) {
  try { return units(a) === units(b); } catch { return false; }
}

function validateAmount(value, currency, config) {
  if (typeof value !== 'string' || value.length > 24 || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) {
    throw new HttpError(400, 'invalid_amount', 'Enter a valid amount without separators or scientific notation.');
  }
  const code = config.currencies.find(item => item.code === currency);
  if (!code) throw new HttpError(400, 'invalid_currency', 'Choose a supported currency.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > code.decimals) throw new HttpError(400, 'invalid_precision', `${code.label} accepts ${code.decimals} decimal places.`);
  if (!atLeast(value, config.minAmount) || !atLeast(config.maxAmount, value)) {
    throw new HttpError(400, 'amount_out_of_range', `Enter an amount from ${config.minAmount} to ${config.maxAmount} ${code.label}.`);
  }
  return code.decimals ? `${whole}.${fraction.padEnd(code.decimals, '0')}` : whole;
}

function providerId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe provider ID');
  if (!['string', 'number'].includes(typeof value) || !/^\d{1,40}$/.test(String(value))) throw new Error('Invalid provider ID');
  return String(value);
}

function positiveDecimal(value) {
  const result = decimalString(value);
  if (units(result) <= 0n) throw new Error('Amount must be positive');
  return result;
}

module.exports = { decimalString, units, atLeast, sameAmount, validateAmount, providerId, positiveDecimal };
