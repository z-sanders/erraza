'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { config } = require('./helpers');

async function creator({ clipboardFails = false } = {}) {
  const elements = new Map(), requests = [], copied = [];
  function element(id) {
    if (!elements.has(id)) {
      const handlers = new Map(), attributes = new Map();
      elements.set(id, {
        value: id === 'linkAmount' ? '100.00' : '', textContent: '', hidden: false, disabled: false,
        handlers, attributes, classList: { add() {}, remove() {} },
        addEventListener(name, fn) { handlers.set(name, fn); },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); delete this[name]; },
        replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; },
        focus() { this.focused = true; }, select() { this.selected = true; }, scrollIntoView() { this.scrolled = true; },
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: element, documentElement: { dataset: {} }, querySelector: () => element('meta'), querySelectorAll: () => [], createElement: () => ({}) },
    window: { PaymentLinks: require('../public/payment-links'), location: { origin: 'https://checkout.example', hostname: 'checkout.example' }, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { clipboard: { async writeText(value) { if (clipboardFails) throw new Error('Denied'); copied.push(value); } } },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ...config }) }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/create-link.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { element, requests, copied, submit: () => element('linkForm').handlers.get('submit')({ preventDefault() {} }) };
}

test('creator generates a same-site link with no payment-creation request', async () => {
  const ui = await creator();
  ui.element('linkAmount').value = '125.50';
  ui.element('linkCurrency').value = 'eur';
  ui.submit();
  assert.equal(ui.element('generatedLink').value, 'https://checkout.example/?amount=125.50&currency=eur');
  assert.equal(ui.element('linkResult').hidden, false);
  assert.equal(ui.element('previewLink').href, ui.element('generatedLink').value);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].url, '/api/config');
  assert.equal(ui.requests[0].options.method, undefined);
});

test('creator personalizes the link without changing the merchant and reveals its result', async () => {
  const ui = await creator();
  ui.element('linkReference').value = 'Mina & Studio';
  ui.element('linkAmount').value = '125,50';
  ui.submit();
  const url = new URL(ui.element('generatedLink').value);
  assert.equal(url.searchParams.get('for'), 'Mina & Studio');
  assert.equal(url.searchParams.get('amount'), '125.50');
  assert.equal(ui.element('linkMerchant').textContent, 'Erraza');
  assert.equal(ui.element('linkResult').scrolled, true);
  assert.equal(ui.element('linkResultTitle').focused, true);
});

test('copy confirms only after clipboard succeeds and invalidates stale generated links', async () => {
  const ui = await creator();
  ui.submit();
  await ui.element('copyLink').handlers.get('click')();
  assert.equal(ui.copied[0], 'https://checkout.example/?amount=100.00&currency=usd');
  assert.equal(ui.element('linkFeedback').textContent, 'Link copied. Ready to share.');
  ui.element('linkAmount').value = '200';
  ui.element('linkAmount').handlers.get('input')();
  assert.equal(ui.element('generatedLink').value, '');
  assert.equal(ui.element('previewLink').href, undefined);
  assert.equal(ui.element('linkResult').hidden, true);
});

test('clipboard failure exposes a manual-copy fallback without claiming success', async () => {
  const ui = await creator({ clipboardFails: true });
  ui.submit();
  await ui.element('copyLink').handlers.get('click')();
  assert.equal(ui.element('linkFeedback').textContent, 'Copy the selected link manually.');
  assert.equal(ui.element('generatedLink').selected, true);
  assert.equal(ui.copied.length, 0);
});

test('invalid creator amount shows an error and cannot produce a stale payment link', async () => {
  const ui = await creator();
  ui.submit();
  ui.element('linkAmount').value = '1e3';
  ui.submit();
  assert.equal(ui.element('linkResult').hidden, true);
  assert.equal(ui.element('generatedLink').value, '');
  assert.equal(ui.element('linkError').hidden, false);
  assert.equal(ui.element('linkAmount').attributes.get('aria-invalid'), 'true');
});
