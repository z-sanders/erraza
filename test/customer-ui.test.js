'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function customerUi(overrides = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '', setAttribute() {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(source, /  boot\(\);\s*\}\)\(\);\s*$/);
  const instrumented = source.replace(/  boot\(\);\s*\}\)\(\);\s*$/, '  globalThis.ui = { state, renderAvailability, renderMethod, renderContinue, renderHeading, canCreateCheckout, applyPresetLink, openHelp };\n})();');
  const context = vm.createContext({
    document: { getElementById: element },
    window: { crypto: { randomUUID }, PaymentLinks: require('../public/payment-links') },
  });
  vm.runInContext(instrumented, context);
  const ui = context.ui;
  Object.assign(ui.state, {
    configPhase: 'ready', currency: 'usd', method: 'card',
    config: {
      configured: true, fiatEnabled: true, fiatCurrencies: ['usd', 'eur'], csrfToken: 'fixture-csrf', minAmount: '1', maxAmount: '100000',
      currencies: [
        { code: 'usd', label: 'USD', symbol: '$', decimals: 2 },
        { code: 'eur', label: 'EUR', symbol: '€', decimals: 2 },
        { code: 'cad', label: 'CAD', symbol: 'C$', decimals: 2 },
      ],
      ...overrides,
    },
  });
  element('amountInput').value = '100.00';
  return { ui, element };
}

test('fully configured fiat checkout has no setup notice and enables Continue', () => {
  const { ui, element } = customerUi();
  ui.renderMethod();
  ui.renderContinue();
  assert.equal(element('cryptoPanel').hidden, true);
  assert.equal(element('availabilityNotice').hidden, true);
  assert.equal(element('availabilityText').textContent, '');
  assert.equal(element('continueButton').disabled, false);
});

test('unconfigured checkout shows one customer message without merchant setup chatter', () => {
  const { ui, element } = customerUi({ configured: false, fiatEnabled: false, csrfToken: null });
  ui.renderContinue();
  assert.equal(element('availabilityNotice').hidden, false);
  assert.equal(element('availabilityText').textContent, 'Checkout is temporarily unavailable. Please try again later.');
  assert.equal(element('continueButton').disabled, true);
  assert.equal(element('continueNote').hidden, true);
  assert.doesNotMatch(element('availabilityText').textContent, /merchant|setup|configur|API|keys/i);
});

test('fiat-specific notice disappears when switching to crypto and returns only for unavailable fiat', () => {
  const { ui, element } = customerUi({ fiatEnabled: false });
  ui.renderContinue();
  assert.equal(element('availabilityText').textContent, 'Card payments are temporarily unavailable. Choose crypto or try again later.');
  assert.equal(element('continueButton').disabled, true);
  ui.state.method = 'crypto';
  ui.renderContinue();
  assert.equal(element('availabilityNotice').hidden, true);
  ui.state.method = 'card';
  ui.state.config.fiatEnabled = true;
  ui.renderContinue();
  assert.equal(element('availabilityNotice').hidden, true);
  assert.equal(element('continueButton').disabled, false);
});

test('preset amount and currency autofill once and remain editable', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  ui.applyPresetLink();
  assert.equal(element('amountInput').value, '125.50');
  assert.equal(ui.state.currency, 'eur');
  assert.equal(ui.state.method, 'card');
  assert.equal(ui.state.order, null);
  assert.equal(ui.state.idempotencyKey, null);
  element('amountInput').value = '200.00';
  ui.applyPresetLink();
  assert.equal(element('amountInput').value, '200.00');
});

test('unfinished payments and payer edits take precedence over presets', () => {
  for (const protection of [
    { recoveryRequest: { amount: '300.00' } }, { unreadableAttempt: true },
    { saved: { token: 'existing' } }, { token: 'existing' }, { presetReturning: true }, { presetEdited: true },
  ]) {
    const { ui, element } = customerUi();
    Object.assign(ui.state, protection, { presetSearch: '?amount=125&currency=eur' });
    ui.applyPresetLink();
    assert.equal(element('amountInput').value, '100.00');
    assert.equal(ui.state.currency, 'usd');
  }
});

test('invalid presets never silently use the default payment amount', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=1e3&currency=usd';
  ui.applyPresetLink();
  assert.equal(element('amountInput').value, '');
  assert.match(element('checkoutError').textContent, /payment link could not be applied/);
  assert.equal(ui.canCreateCheckout(), false);
});

test('preset validation waits for configuration rather than discarding a valid link early', () => {
  const { ui, element } = customerUi();
  const settings = ui.state.config;
  ui.state.config = null;
  ui.state.presetSearch = '?amount=125&currency=eur';
  ui.applyPresetLink();
  assert.equal(ui.state.presetHandled, false);
  ui.state.config = settings;
  ui.applyPresetLink();
  assert.equal(element('amountInput').value, '125.00');
});

test('payment help and privacy open separate dialogs with the correct focus target', () => {
  const { ui, element } = customerUi();
  for (const id of ['helpDialog', 'privacyDialog']) {
    element(id).showModal = function () { this.open = true; };
  }
  for (const id of ['helpTitle', 'privacyTitle']) {
    element(id).focus = function () { this.focused = true; };
  }
  ui.openHelp();
  assert.equal(element('helpDialog').open, true);
  assert.equal(element('helpTitle').focused, true);
  assert.equal(element('privacyDialog').open, undefined);
  ui.openHelp(true);
  assert.equal(element('privacyDialog').open, true);
  assert.equal(element('privacyTitle').focused, true);
});

test('personalized presets are kept as a label and do not change the merchant', () => {
  const { ui, element } = customerUi({ brand: 'Erraza' });
  ui.state.presetSearch = '?amount=125&currency=usd&for=Mina';
  ui.applyPresetLink();
  assert.equal(ui.state.reference, 'Mina');
  assert.equal(ui.state.config.brand, 'Erraza');
  assert.equal(element('amountInput').value, '125.00');
});

test('mobile decimal commas are accepted only when unambiguous', () => {
  const { ui, element } = customerUi();
  element('amountInput').value = '125,50';
  assert.equal(ui.canCreateCheckout(), true);
  element('amountInput').value = '1,000';
  assert.equal(ui.canCreateCheckout(), false);
});

test('personalized checkout uses one heading and authoritative resumed reference', () => {
  const { ui, element } = customerUi();
  ui.renderHeading();
  assert.equal(element('checkoutTitle').textContent, 'Payment details');
  ui.state.reference = 'Mina';
  ui.renderHeading();
  assert.equal(element('checkoutTitle').textContent, 'Payment for Mina');
  ui.state.order = { reference: 'Studio invoice' };
  ui.renderHeading();
  assert.equal(element('checkoutTitle').textContent, 'Payment for Studio invoice');
});

test('Continue displays the exact current amount and currency', () => {
  const { ui, element } = customerUi();
  element('amountInput').value = '125.00';
  ui.renderContinue();
  assert.equal(element('continueLabel').textContent, 'Continue');
  assert.equal(element('continueAmount').textContent, '· $125.00 USD');
  assert.equal(element('continueAmount').hidden, false);
  assert.equal(element('continueIcon').hidden, true);
  element('amountInput').value = '250,50';
  ui.state.currency = 'eur';
  ui.renderContinue();
  assert.equal(element('continueAmount').textContent, '· €250.50 EUR');
});

test('invalid amounts never remain visible as stale button totals', () => {
  const { ui, element } = customerUi();
  ui.renderContinue();
  element('amountInput').value = 'invalid';
  ui.renderContinue();
  assert.equal(element('continueAmount').hidden, true);
  assert.equal(element('continueAmount').textContent, '');
  assert.equal(element('continueButton').disabled, true);
});

test('preparation and recovery labels take precedence over the amount', () => {
  const { ui, element } = customerUi();
  ui.state.checkoutBusy = true;
  ui.renderContinue();
  assert.equal(element('continueLabel').textContent, 'Preparing checkout…');
  assert.equal(element('continueAmount').hidden, true);
  ui.state.checkoutBusy = false;
  ui.state.recoveryRequest = { amount: '300.00' };
  ui.renderContinue();
  assert.equal(element('continueLabel').textContent, 'Recover checkout');
  assert.equal(element('continueAmount').hidden, true);
});

test('unsupported fiat explains a usable currency choice instead of merchant configuration', () => {
  const { ui, element } = customerUi();
  ui.state.currency = 'cad';
  ui.renderContinue();
  assert.match(element('availabilityText').textContent, /Card payments aren’t available in CAD/);
  assert.match(element('availabilityText').textContent, /Choose USD, EUR/);
  assert.equal(element('continueButton').disabled, true);
});
