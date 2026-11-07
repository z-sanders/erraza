'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../public/payment-links');
const { config } = require('./helpers');

for (const [amount, currency, normalized] of [['125', 'usd', '125.00'], ['42.5', 'EUR', '42.50'], ['2500', 'jpy', '2500']]) {
  test(`preset links round-trip ${amount} ${currency} without floating-point rounding`, () => {
    const url = new URL(links.create('https://checkout.example', amount, currency, config));
    assert.equal(url.pathname, '/');
    assert.equal(url.origin, 'https://checkout.example');
    assert.equal(url.searchParams.get('amount'), normalized);
    assert.deepEqual(links.parse(url.search, config), { amount: normalized, currency: currency.toLowerCase() });
  });
}

test('no preset parameters means ordinary custom-amount checkout', () => {
  assert.equal(links.parse('', config), null);
  assert.equal(links.parse('?utm_source=email', config), null);
});

test('malformed, partial and duplicate presets are rejected', () => {
  for (const search of ['?amount=25', '?currency=usd', '?amount=25&amount=50&currency=usd', '?amount=25&currency=usd&currency=eur', '?amount=25&currency=zzz', '?amount=%3Cscript%3E&currency=usd']) {
    assert.throws(() => links.parse(search, config), search);
  }
});

test('preset amounts obey the same precision and bounds as server validation', () => {
  for (const amount of ['', '-25', '0', '0.99', '100000.01', '1e3', 'NaN', 'Infinity', '1,000', '01', '1.001', '.50', ' 25 ', true, 25]) {
    assert.throws(() => links.validate(amount, 'usd', config), String(amount));
  }
  assert.throws(() => links.validate('2500.01', 'jpy', config));
  assert.deepEqual(links.validate('100000.00', 'usd', config), { amount: '100000.00', currency: 'usd' });
});

test('link generation uses the checkout origin only and never copies recipient or redirect parameters', () => {
  const url = new URL(links.create('https://checkout.example', '50', 'usd', config));
  assert.deepEqual([...url.searchParams.keys()], ['amount', 'currency']);
  assert.deepEqual(links.parse('?amount=50&currency=usd&address=other&redirect=https://other.example', config), { amount: '50.00', currency: 'usd' });
  for (const origin of ['javascript:alert(1)', 'https://user@checkout.example', 'https://checkout.example/create-link.html', 'https://checkout.example/?recipient=other', 'http://checkout.example']) {
    assert.throws(() => links.create(origin, '50', 'usd', config));
  }
  assert.equal(new URL(links.create('http://localhost:3000', '50', 'usd', config)).origin, 'http://localhost:3000');
});
