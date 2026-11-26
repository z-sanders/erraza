const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function customerUi(overrides = {}, { fetch: fetchImpl, localStorage: sharedStorage } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '', dataset: {}, className: '', classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, getAttribute: () => null, removeAttribute() {}, append() {}, replaceChildren() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(source, /  boot\(\);\s*\}\)\(\);\s*$/);
  const instrumented = source.replace(/  boot\(\);\s*\}\)\(\);\s*$/, '  globalThis.ui = { state, renderAvailability, renderMethod, renderContinue, renderHeading, canCreateCheckout, applyPresetLink, openHelp, renderResume, renderOrder, renderAmount, statusPresentation, canDismissOrder, canDismissSaved, validGuideCardSource, dismissedTokens, dismissPayment, readSavedPayment, applyPresetFromLink, maybeApplyPendingPreset, referenceUnresolvable, dropDismissedLocalPayment, partialAmounts, subtractDecimals, needsDismissConfirmation, adoptOrder, resumePayment, syncPaymentStorage, activePaymentToken, checkStatus, handleOffline, copyPayment, updateExpiry };\n})();');
  const storage = () => {
    const map = new Map();
    return {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: key => map.delete(key),
    };
  };
  const localStorageStore = sharedStorage || storage();
  const sessionStorageStore = storage();
  const navigator = { onLine: true };
  const context = vm.createContext({
    document: { getElementById: element },
    window: { crypto: { randomUUID }, PaymentLinks: require('../public/payment-links'), setTimeout: () => 0, clearTimeout() {}, addEventListener() {} },
    AbortController, URL, URLSearchParams, navigator,
    fetch: fetchImpl || (async () => { throw new Error('No fixture response'); }),
    localStorage: localStorageStore,
    sessionStorage: sessionStorageStore,
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
  return { ui, element, navigator, localStorage: localStorageStore };
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

const HOUR = 60 * 60 * 1000;

function cardOrder(overrides = {}) {
  const ageHours = overrides.ageHours === undefined ? 30 * 24 : overrides.ageHours;
  const rest = { ...overrides };
  delete rest.ageHours;
  return {
    token: 'tok_test_payment_token_0123456789', orderId: 'err_00000000-0000-4000-8000-000000000000',
    amount: '100.00', currency: 'usd', method: 'card', asset: null, reference: '', merchant: 'Erraza',
    status: 'review', terminal: true, complete: false,
    createdAt: new Date(Date.now() - ageHours * HOUR).toISOString(),
    payment: null, checkoutUrl: null, message: null,
    ...rest,
  };
}

function readyAssets(ui) {
  ui.state.assetsPhase = 'ready';
  ui.state.assets = [{ code: 'btc', ticker: 'BTC', name: 'Bitcoin', network: 'Bitcoin', extraIdRequired: false }];
}

test('a stale unverified card payment keeps its checkout lock and offers the crypto guide', () => {
  const { ui, element } = customerUi();
  ui.state.order = cardOrder();
  ui.state.token = ui.state.order.token;
  ui.state.saved = { token: ui.state.order.token, timestamp: Date.now() };
  readyAssets(ui);
  ui.renderOrder();
  assert.equal(element('stalePaymentActions').hidden, true);
  assert.equal(element('statusGuideSection').hidden, false);
  assert.equal(element('statusGuideButton').disabled, false);
  assert.equal(element('dismissNoticeButton').hidden, true);
  assert.equal(ui.canCreateCheckout(), false);
  assert.match(ui.statusPresentation(ui.state.order).description, /Don’t pay again yet/);
});

test('a card checkout that never opened does not claim there was no charge', () => {
  const { ui, element } = customerUi();
  ui.state.order = cardOrder({ ageHours: 2, status: 'unknown', terminal: false });
  ui.state.token = ui.state.order.token;
  ui.state.saved = { token: ui.state.order.token, timestamp: Date.now() };
  readyAssets(ui);
  ui.renderOrder();
  assert.equal(element('stalePaymentActions').hidden, true);
  assert.equal(element('dismissNoticeButton').hidden, true);
  assert.equal(ui.canDismissOrder(ui.state.order), false);
  assert.equal(element('statusGuideSection').hidden, false);
  assert.equal(element('statusGuideButton').disabled, false);
  assert.equal(ui.validGuideCardSource(ui.state.order), true);
  const presentation = ui.statusPresentation(ui.state.order);
  assert.equal(presentation.title, 'Card checkout didn’t open');
  assert.match(presentation.description, /couldn’t confirm this checkout/);
  assert.equal(element('providerMessage').hidden, true);
  assert.equal(element('cardPayment').hidden, true);
  const opened = cardOrder({ ageHours: 2, status: 'unknown', terminal: false, checkoutUrl: 'https://pay.provider.example/checkout/fixture' });
  assert.match(ui.statusPresentation(opened).description, /check the status before trying again/);
  const cryptoUnknown = cardOrder({ ageHours: 2, method: 'crypto', status: 'unknown', terminal: false });
  assert.match(ui.statusPresentation(cryptoUnknown).description, /check the status before trying again/);
});

test('a rejected card checkout settles immediately and points to the crypto guide', () => {
  const { ui, element } = customerUi();
  ui.state.order = cardOrder({ status: 'rejected', terminal: false, ageHours: 1 });
  ui.state.token = ui.state.order.token;
  ui.state.saved = { token: ui.state.order.token, timestamp: Date.now() };
  readyAssets(ui);
  ui.renderOrder();
  assert.equal(ui.canDismissOrder(ui.state.order), true);
  assert.equal(element('stalePaymentActions').hidden, false);
  assert.equal(element('statusGuideSection').hidden, false);
  assert.equal(element('statusGuideButton').disabled, false);
  assert.equal(ui.validGuideCardSource(ui.state.order), true);
  assert.equal(ui.canCreateCheckout(), true);
});

test('terminal card problems stay dismissible and usable as the guide source', () => {
  const { ui } = customerUi();
  const failed = cardOrder({ status: 'failed', ageHours: 1 });
  assert.equal(ui.canDismissOrder(failed), true);
  assert.equal(ui.validGuideCardSource(failed), true);
  const expired = cardOrder({ status: 'expired', ageHours: 25 * 24 });
  assert.equal(ui.canDismissOrder(expired), true);
  assert.equal(ui.validGuideCardSource(expired), true);
  const complete = cardOrder({ status: 'finished', terminal: true, complete: true, ageHours: 30 * 24 });
  assert.equal(ui.canDismissOrder(complete), false);
  assert.equal(ui.validGuideCardSource(complete), false);
});

test('removing a terminal payment saves a local dismissal without claiming cancellation', async () => {
  const { ui, element } = customerUi();
  ui.state.order = cardOrder({ status: 'failed', terminal: true });
  ui.state.token = ui.state.order.token;
  ui.state.saved = { token: ui.state.order.token, timestamp: Date.now() };
  ui.state.idempotencyKey = '00000000-0000-4000-8000-000000000000';
  readyAssets(ui);
  ui.renderOrder();
  ui.dismissPayment();
  assert.equal(ui.state.token, null);
  assert.equal(ui.state.order, null);
  assert.equal(ui.state.saved, null);
  assert.equal(ui.state.idempotencyKey, null);
  // Spread into this realm: arrays from the VM context have a different Array prototype.
  assert.deepEqual([...ui.dismissedTokens()], ['tok_test_payment_token_0123456789']);
  assert.match(element('checkoutError').textContent, /did not cancel/);
  assert.equal(element('resumeNotice').hidden, true);
  assert.equal(element('continueButton').disabled, false);
});

test('a dismissed saved payment no longer resumes from storage', () => {
  const { ui, localStorage } = customerUi();
  const token = 'tok_dismissed_payment_0123456789';
  localStorage.setItem('pay_page.resume.v1', JSON.stringify({ token, timestamp: Date.now() }));
  assert.equal(ui.readSavedPayment()?.token, token);
  localStorage.setItem('pay_page.dismissed.v1', JSON.stringify([token]));
  assert.equal(ui.readSavedPayment(), null);
  assert.equal(JSON.parse(localStorage.getItem('pay_page.resume.v1')).token, token, 'a local dismissal does not delete the shared pointer');
});

test('checkout page exposes the link creator, larger presets, and reworked guidance copy', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(markup, /href="\/create-link\.html">Create payment link</);
  for (const preset of ['250', '500', '1000', '2500']) assert.match(markup, new RegExp(`data-amount="${preset}"`));
  assert.doesNotMatch(markup, /data-amount="(25|50|100)"/);
  assert.match(markup, /Guide me: buy crypto with a card/);
  assert.match(markup, /id="stalePaymentActions"/);
  assert.match(markup, /id="statusGuideButton"/);
  assert.match(markup, /Removing the saved link does not cancel/);
});

test('a link preset applies over a settled earlier payment', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur&for=Invoice+9';
  const order = cardOrder({ status: 'finished', terminal: true, complete: true, ageHours: 30 * 24 });
  ui.state.saved = { token: order.token, timestamp: Date.now() - 30 * 24 * HOUR };
  ui.state.token = order.token;
  ui.state.order = order;
  ui.applyPresetLink();
  assert.equal(element('amountInput').value, '125.50');
  assert.equal(ui.state.currency, 'eur');
  assert.equal(ui.state.reference, 'Invoice 9');
  assert.equal(ui.state.presetPending, null);
  ui.renderResume();
  assert.equal(element('presetNotice').hidden, true);
});

test('an unresolved payment keeps a pending preset with an explicit choice', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  ui.state.saved = { token: 'tok_unresolved_payment_001', timestamp: Date.now() };
  ui.applyPresetLink();
  assert.equal(element('amountInput').value, '100.00');
  assert.deepEqual({ ...ui.state.presetPending }, { amount: '125.50', currency: 'eur', reference: '' });
  ui.renderResume();
  assert.equal(element('presetNotice').hidden, false);
  assert.match(element('presetNoticeTitle').textContent, /This payment link is for €125\.50 EUR/);
  assert.match(element('presetNoticeText').textContent, /Review the earlier payment first/);
  assert.equal(element('applyPresetButton').disabled, false, 'the button opens status for review, not a replacement');
});

test('applying a preset opens the blocking payment without bypassing release', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  const token = 'tok_stale_payment_pending_1';
  ui.state.saved = { token, timestamp: Date.now() - 25 * HOUR };
  ui.applyPresetLink();
  ui.applyPresetFromLink();
  assert.equal(ui.state.token, token);
  assert.equal(element('paymentDialog').open, true);
  assert.equal(element('amountInput').value, '100.00');
  assert.equal(ui.state.presetPending?.amount, '125.50');
  assert.deepEqual([...ui.dismissedTokens()], []);
  assert.equal(element('continueButton').disabled, true);
});

test('settling the earlier payment auto-applies the pending preset', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  ui.state.saved = { token: 'tok_unresolved_payment_001', timestamp: Date.now() };
  ui.applyPresetLink();
  assert.equal(ui.state.presetPending?.amount, '125.50');
  // The status check always returns an order carrying the checked token.
  ui.state.token = 'tok_unresolved_payment_001';
  ui.state.order = cardOrder({ status: 'finished', terminal: true, complete: true, ageHours: 1, token: 'tok_unresolved_payment_001' });
  ui.maybeApplyPendingPreset();
  assert.equal(element('amountInput').value, '125.50');
  assert.equal(ui.state.presetPending, null);
});

test('dismissal is blocked while a checkout is in flight', () => {
  const { ui } = customerUi();
  ui.state.order = cardOrder({ status: 'failed', ageHours: 1 });
  ui.state.token = ui.state.order.token;
  ui.state.saved = { token: ui.state.order.token, timestamp: Date.now() };
  ui.state.checkoutBusy = true;
  ui.dismissPayment();
  assert.equal(ui.state.token, ui.state.order.token, 'reference survives the in-flight checkout');
  assert.deepEqual([...ui.dismissedTokens()], []);
});

test('an edited form is never overwritten by the auto-applied preset', () => {
  const { ui, element } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  ui.state.saved = { token: 'tok_unresolved_payment_001', timestamp: Date.now() };
  ui.applyPresetLink();
  ui.state.presetEdited = true;
  ui.state.token = 'tok_unresolved_payment_001';
  ui.state.order = cardOrder({ status: 'finished', terminal: true, complete: true, ageHours: 1, token: 'tok_unresolved_payment_001' });
  const applied = ui.maybeApplyPendingPreset();
  assert.equal(applied, null, 'auto-apply skips an edited form');
  assert.equal(ui.state.presetPending?.amount, '125.50', 'the offer stays available');
  ui.renderResume();
  assert.equal(element('presetNotice').hidden, false);
  assert.equal(element('applyPresetButton').disabled, false, 'the explicit Apply still works');
  ui.applyPresetFromLink();
  assert.equal(element('amountInput').value, '125.50');
});

test('a dismissal in another tab drops the payment here and applies the pending preset', () => {
  const { ui, element, localStorage } = customerUi();
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  ui.state.saved = { token: 'tok_cross_tab_dismiss_01', timestamp: Date.now() - 25 * HOUR };
  ui.applyPresetLink();
  ui.renderResume();
  localStorage.setItem('pay_page.dismissed.v1', JSON.stringify(['tok_cross_tab_dismiss_01']));
  const applied = ui.dropDismissedLocalPayment();
  assert.equal(applied?.amount, '125.50');
  assert.equal(ui.state.token, null);
  assert.equal(ui.state.saved, null);
  assert.equal(ui.state.presetPending, null);
  assert.equal(element('amountInput').value, '125.50');
  assert.equal(element('resumeNotice').hidden, true);
  assert.equal(element('presetNotice').hidden, true);
  assert.equal(element('continueButton').disabled, false);
  // Unrelated dismissals in other tabs leave this tab untouched.
  localStorage.setItem('pay_page.dismissed.v1', JSON.stringify(['tok_cross_tab_dismiss_01', 'tok_other_tab_payment_1']));
  ui.state.saved = { token: 'tok_this_tab_payment_1', timestamp: Date.now() };
  assert.equal(ui.dropDismissedLocalPayment(), null);
  assert.equal(ui.state.saved?.token, 'tok_this_tab_payment_1');
});

test('an unverifiable reference offers removal in the payment dialog', () => {
  const { ui, element } = customerUi();
  ui.state.order = cardOrder({ status: 'review', ageHours: 2 });
  ui.state.token = ui.state.order.token;
  ui.state.unverifiableChecks = 2;
  ui.renderOrder();
  assert.equal(ui.referenceUnresolvable(), false);
  assert.equal(element('missingPaymentActions').hidden, true);
  ui.state.unverifiableChecks = 3;
  ui.renderOrder();
  assert.equal(ui.referenceUnresolvable(), true);
  assert.equal(element('missingPaymentActions').hidden, false);
  assert.equal(element('stalePaymentActions').hidden, true, 'the 24h dismiss stays exclusive of the removal offer');
});


function cryptoOrder(overrides = {}) {
  return cardOrder({
    status: 'waiting', terminal: false, method: 'crypto', actuallyPaid: '0', ageHours: 0,
    asset: { code: 'usdterc20', ticker: 'USDT', name: 'Tether', network: 'Ethereum', extraIdRequired: false },
    payment: { address: '0xfixture0000000000000000000000000000000', amount: '0.001', currency: 'usdterc20', memo: 'fixture', qrDataUrl: 'data:image/png;base64,AA==', expiresAt: null },
    ...overrides,
  });
}

test('partial payments display the exact coin shortfall without usable send instructions', async () => {
  const { ui, element, navigator } = customerUi();
  const order = cryptoOrder();
  ui.state.token = order.token;
  ui.state.order = order;
  ui.renderOrder();
  assert.equal(element('paymentQrWrap').hidden, false);
  element('copyFallback').dataset.field = 'address';
  element('copyFallbackValue').value = order.payment.address;
  ui.state.order = { ...order, status: 'partially_paid', actuallyPaid: '0.0004' };
  ui.renderOrder();
  assert.match(element('paymentDescription').textContent, /Don’t send more yet/);
  assert.equal(element('receiptExpected').textContent, '0.001 USDT');
  assert.equal(element('receiptReceived').textContent, '0.0004 USDT');
  assert.equal(element('receiptShortfall').textContent, '0.0006 USDT');
  assert.equal(element('receiptAsset').textContent, 'USDT · Ethereum');
  assert.equal(element('cryptoPayment').hidden, true);
  assert.equal(element('paymentQrWrap').hidden, true);
  assert.equal(element('paymentAddress').value, '');
  assert.equal(element('paymentMemo').value, '');
  assert.equal(element('copyFallbackValue').value, '');
  const clipboard = [];
  navigator.clipboard = { writeText: async text => clipboard.push(text) };
  await ui.copyPayment({ dataset: { copy: 'address' } });
  const button = element('copyOrderButton');
  button.dataset.copy = 'order';
  await ui.copyPayment(button);
  assert.deepEqual(clipboard, [order.orderId]);
});

test('partial amounts remain informational when expired, offline, missing, or inconsistent', () => {
  const { ui, element, navigator } = customerUi();
  const order = cryptoOrder({ status: 'partially_paid', actuallyPaid: '0.0004' });
  order.payment.expiresAt = new Date(Date.now() - 60000).toISOString();
  ui.state.order = order;
  ui.state.token = order.token;
  ui.renderOrder();
  assert.match(element('paymentDescription').textContent, /The payment window has ended/);
  navigator.onLine = false;
  ui.handleOffline();
  assert.match(element('paymentDescription').textContent, /last reported amounts/);
  assert.equal(element('receiptExpected').textContent, '0.001 USDT');
  assert.equal(element('cryptoPayment').hidden, true);
  for (const amount of [null, '0', '0.001', '0.002']) {
    ui.state.order = { ...order, actuallyPaid: amount };
    ui.renderOrder();
    assert.equal(element('receiptShortfallRow').hidden, true);
    assert.notEqual(element('paymentTitle').textContent, 'Payment received');
  }
  ui.state.order = { ...order, payment: { ...order.payment, currency: 'usdttrc20' } };
  ui.renderOrder();
  assert.equal(element('receiptReceivedRow').hidden, true, 'mismatched network code cannot be labeled as the selected coin');
  ui.state.order = cardOrder({ status: 'partially_paid', terminal: false, actuallyPaid: '40.00' });
  ui.renderOrder();
  assert.equal(element('cardPayment').hidden, true);
  assert.equal(element('receiptAmount').textContent, '$100.00 USD');
  assert.equal(element('receiptReceived').textContent, '$40.00 USD');
  assert.equal(element('receiptShortfall').textContent, '$60.00 USD');
});

function selectActive(ui, order) {
  ui.state.saved = { token: order.token, timestamp: Date.now() };
  ui.adoptOrder(order);
}

test('start over keeps checkout blocked until an acknowledgement and then applies the pending preset', async () => {
  const order = cryptoOrder({ canAbandon: true });
  const acknowledged = { ...order, canAbandon: false, abandonedAt: new Date().toISOString() };
  const calls = [];
  const response = Promise.withResolvers();
  const { ui, element } = customerUi({}, { fetch: async (path, options) => { calls.push({ path, options }); return response.promise; } });
  selectActive(ui, order);
  ui.state.presetSearch = '?amount=125.50&currency=eur';
  ui.applyPresetLink();
  assert.equal(element('dismissNoticeButton').hidden, true);
  assert.equal(element('dismissConfirmWrap').hidden, false, 'an explicit zero can qualify');
  await ui.dismissPayment();
  assert.equal(calls.length, 0, 'no confirmation');
  ui.state.confirmedToken = order.token;
  element('dismissConfirm').checked = true;
  const finishing = ui.dismissPayment();
  assert.equal(calls[0].path, '/api/abandon');
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: order.token, confirmed: true });
  assert.equal(ui.canCreateCheckout(), false);
  assert.equal(ui.state.presetPending?.amount, '125.50');
  await ui.dismissPayment();
  assert.equal(calls.length, 1, 'no duplicate release while busy');
  response.resolve({ ok: true, json: async () => acknowledged });
  await finishing;
  assert.equal(ui.canCreateCheckout(), true);
  assert.equal(ui.state.saved, null);
  assert.equal(element('amountInput').value, '125.50');
  assert.equal(ui.state.previousPayment.token, order.token);
  assert.equal(element('previousPaymentNotice').hidden, false);
});

test('a lost acknowledgement leaves checkout locked until status returns the release', async () => {
  const order = cryptoOrder({ canAbandon: true });
  const released = { ...order, canAbandon: false, abandonedAt: new Date().toISOString() };
  const { ui, element } = customerUi({}, { fetch: async path => {
    if (path === '/api/abandon') throw new Error('Lost response');
    return { ok: true, json: async () => released };
  } });
  selectActive(ui, order);
  ui.state.confirmedToken = order.token;
  element('dismissConfirm').checked = true;
  await ui.dismissPayment();
  assert.equal(ui.canCreateCheckout(), false);
  assert.equal(ui.state.saved.token, order.token);
  assert.match(element('dismissPaymentError').textContent, /Couldn’t confirm/);
  await ui.checkStatus(true);
  assert.equal(ui.canCreateCheckout(), true);
  assert.equal(ui.state.viewingHistory, true);
  assert.equal(ui.state.previousPayment.token, order.token);
  assert.equal(element('cryptoPayment').hidden, true);
});

test('reading a previous order never republishes it over a replacement from another tab', () => {
  for (const replacementFirst of [true, false]) {
    const { ui, element, localStorage } = customerUi();
    const old = cryptoOrder({ canAbandon: true });
    const next = cryptoOrder({ token: 'tok_replacement', orderId: 'err_replacement' });
    const save = token => localStorage.setItem('pay_page.resume.v1', JSON.stringify({ token, timestamp: Date.now() }));
    selectActive(ui, old);
    save(old.token);
    const recordReplacement = () => { save(next.token); ui.syncPaymentStorage('pay_page.resume.v1'); };
    if (replacementFirst) recordReplacement();
    localStorage.setItem('pay_page.dismissed.v1', JSON.stringify([old.token]));
    ui.syncPaymentStorage('pay_page.dismissed.v1');
    if (!replacementFirst) recordReplacement();
    ui.adoptOrder({ ...old, abandonedAt: new Date().toISOString() });
    assert.equal(ui.activePaymentToken(), next.token);
    assert.equal(ui.readSavedPayment().token, next.token);
    assert.equal(ui.state.viewingHistory, true);
    assert.equal(element('cryptoPayment').hidden, true);
    assert.equal(ui.canCreateCheckout(), false);
  }
});

test('a stale provider response cannot reopen the address or QR after reconnecting', async () => {
  const order = cryptoOrder({ canAbandon: true });
  const { ui, element, navigator } = customerUi({}, { fetch: async () => ({ ok: true, json: async () => ({ ...order, statusStale: true }) }) });
  selectActive(ui, order);
  assert.equal(element('cryptoPayment').hidden, false);
  navigator.onLine = false;
  ui.handleOffline();
  assert.equal(element('cryptoPayment').hidden, true);
  navigator.onLine = true;
  assert.equal(await ui.checkStatus(true), false);
  assert.equal(element('cryptoPayment').hidden, true);
  assert.equal(element('paymentQrWrap').hidden, true);
  assert.equal(ui.canCreateCheckout(), false);
});

test('older payments with funds cannot be dismissed based on age', () => {
  const { ui, element } = customerUi();
  selectActive(ui, cryptoOrder({ status: 'partially_paid', actuallyPaid: '0.0004', ageHours: 36 }));
  assert.equal(element('stalePaymentActions').hidden, true);
  assert.equal(element('dismissNoticeButton').hidden, true);
  assert.equal(ui.canCreateCheckout(), false);
});
