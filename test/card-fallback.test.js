'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_PATH = path.join(__dirname, '../public/app.js');
const HTML_PATH = path.join(__dirname, '../public/index.html');
const CSS_PATH = path.join(__dirname, '../public/styles.css');
const GUIDE_KEY = 'pay_page.card-guide.v1';
const STORAGE_KEY = 'pay_page.resume.v1';
const PROVIDER_URL = 'https://www.moonpay.com/buy';

const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const APP_SOURCE = fs.readFileSync(APP_PATH, 'utf8');
const BOOT_PATTERN = /  boot\(\);\s*\}\)\(\);\s*$/;

assert.match(APP_SOURCE, BOOT_PATTERN, 'The VM harness must replace the terminal boot call, not run the application.');

const INSTRUMENTED_APP = APP_SOURCE.replace(BOOT_PATTERN, `  globalThis.cardFallbackUi = {
    state, el, guideContext, guideBlockReason, guideAsset, guideQuoteKey, guideQuoteFresh,
    saveGuide, restoreGuide, renderGuideEntries, renderGuide, refreshGuideQuote, openGuide,
    leaveGuide, nextGuideStep, previousGuideStep, finishGuide, canCreateCheckout, checkout,
    quoteKey, wireEvents, openDialog, stopPollingRequest,
    setCheckStatus: (fn) => { checkStatus = fn; },
    setLoadAssets: (fn) => { loadAssets = fn; },
    setQueueQuote: (fn) => { queueQuote = fn; },
    setRefreshGuideQuote: (fn) => { refreshGuideQuote = fn; },
    constants: { GUIDE_KEY, STORAGE_KEY, GUIDE_MAX_AGE, GUIDE_QUOTE_AGE, GUIDE_PROVIDER_URL },
  };
})();`);

const ASSETS = Object.freeze([
  Object.freeze({ code: 'btc-mainnet', ticker: 'BTC', name: 'Bitcoin', network: 'Bitcoin', extraIdRequired: false }),
  Object.freeze({ code: 'xrp-mainnet', ticker: 'XRP', name: 'XRP', network: 'XRP Ledger', extraIdRequired: true }),
]);

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
    key(index) { return [...values.keys()][index] ?? null; },
    get length() { return values.size; },
    values,
  };
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this.scrollTop = 0;
    this.rows = 1;
    this.clientWidth = 0;
    this.scrollHeight = 0;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
      contains: name => this.classes.has(name),
    };
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, initial = {}) {
    const event = initial;
    event.type = event.type || type;
    if (!Object.prototype.hasOwnProperty.call(event, 'target')) event.target = this;
    event.currentTarget = this;
    event.defaultPrevented = false;
    event.preventDefault = event.preventDefault || function preventDefault() { this.defaultPrevented = true; };
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
    return event;
  }
  showModal() { this.open = true; this.showModalCalls = (this.showModalCalls || 0) + 1; }
  close() { this.open = false; this.dispatch('close'); }
  focus(options) { this.focusCalls = (this.focusCalls || 0) + 1; this.focusOptions = options; }
  blur() { this.blurred = true; }
  select() { this.selected = true; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, right: 600, top: 0, bottom: 600 }; }
  get href() { return this.getAttribute('href') || ''; }
  set href(value) { this.setAttribute('href', value); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
}

function addEventTarget(target) {
  const listeners = new Map();
  target.addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(listener);
  };
  target.dispatch = (type, initial = {}) => {
    const event = initial;
    event.type = event.type || type;
    if (!Object.prototype.hasOwnProperty.call(event, 'target')) event.target = target;
    event.currentTarget = target;
    event.defaultPrevented = false;
    event.preventDefault = event.preventDefault || function preventDefault() { this.defaultPrevented = true; };
    for (const listener of listeners.get(type) || []) listener.call(target, event);
    return event;
  };
  target.listeners = listeners;
  return target;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function cardFallbackVm(options = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const document = addEventTarget({
    hidden: false,
    title: '',
    documentElement: { dataset: {} },
    getElementById: element,
    querySelectorAll() { return []; },
    querySelector() { return new FakeElement('query-result'); },
    createElement(tag) { return new FakeElement(tag); },
    createDocumentFragment() { return new FakeElement('fragment'); },
  });
  const navigator = { onLine: options.online !== false, clipboard: null };
  const sessionStorage = makeStorage(options.sessionSeed);
  const localStorage = makeStorage(options.localSeed);
  const fetchCalls = [];
  const assets = (options.assets || ASSETS).map(item => ({ ...item }));
  let uuidCalls = 0;

  const window = addEventTarget({
    PaymentLinks: require('../public/payment-links'),
    crypto: {
      randomUUID() {
        uuidCalls += 1;
        return `00000000-0000-4000-8000-${String(uuidCalls).padStart(12, '0')}`;
      },
    },
    setTimeout,
    clearTimeout,
    matchMedia() { return { matches: false, addEventListener() {} }; },
    location: { href: 'https://checkout.example/' },
  });

  async function fakeFetch(input, fetchOptions = {}) {
    const call = {
      url: String(input),
      method: String(fetchOptions.method || 'GET').toUpperCase(),
      headers: fetchOptions.headers || {},
      body: fetchOptions.body,
    };
    fetchCalls.push(call);
    if (options.fetchRouter) {
      const routed = await options.fetchRouter(call, { assets });
      if (routed !== undefined) return response(routed.body, routed.status ?? 200);
    }
    const url = new URL(call.url, 'https://checkout.example');
    if (url.pathname === '/api/estimate' && call.method === 'GET') {
      return response({
        estimatedAmount: '0.00420000',
        minFiatAmount: '1.00',
        priceAmount: url.searchParams.get('amount'),
        priceCurrency: url.searchParams.get('fiat'),
        payCurrency: url.searchParams.get('coin'),
      });
    }
    if (url.pathname === '/api/currencies' && call.method === 'GET') {
      return response({ currencies: assets });
    }
    if (url.pathname === '/api/checkout' && call.method === 'POST') {
      const body = JSON.parse(call.body);
      return response({
        token: 'new-checkout-token',
        orderId: 'new-crypto-order',
        amount: body.amount,
        currency: body.currency,
        reference: body.reference || '',
        merchant: 'Erraza',
        method: body.method,
        asset: assets.find(item => item.code === body.asset) || null,
        status: 'finished',
        terminal: true,
        complete: true,
      }, 201);
    }
    throw new Error(`Unexpected fetch in card fallback test: ${call.method} ${call.url}`);
  }

  const context = vm.createContext({
    document,
    window,
    navigator,
    sessionStorage,
    localStorage,
    fetch: fakeFetch,
    AbortController,
    URL,
    URLSearchParams,
    history: { replaceState() {} },
    getComputedStyle: () => ({ lineHeight: '24px', paddingTop: '0px', paddingBottom: '0px' }),
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(INSTRUMENTED_APP, context, { filename: APP_PATH });
  const ui = context.cardFallbackUi;

  const config = {
    brand: 'Erraza',
    configured: true,
    sandbox: false,
    fiatEnabled: true,
    fiatCurrencies: ['usd', 'eur'],
    csrfToken: 'fixture-csrf',
    minAmount: '1.00',
    maxAmount: '100000.00',
    currencies: [
      { code: 'usd', label: 'USD', symbol: '$', decimals: 2 },
      { code: 'eur', label: 'EUR', symbol: '€', decimals: 2 },
    ],
  };
  Object.assign(ui.state, {
    config,
    configPhase: 'ready',
    configBusy: false,
    assets,
    assetsPhase: 'ready',
    currency: 'usd',
    method: 'card',
    reference: 'Form reference',
    asset: '',
    quote: null,
    quotePhase: 'empty',
    idempotencyKey: null,
    checkoutBusy: false,
    recoveryRequest: null,
    unreadableAttempt: false,
    sessionExpired: false,
    saved: null,
    token: null,
    order: null,
    lookupMissing: false,
    pollBusy: false,
    guide: null,
    guideQuote: null,
    guideMessage: '',
    guideBusy: false,
    guideChoosingAsset: false,
    guidePaymentChanged: false,
    rejectedRetryApproved: false,
  });
  element('amountInput').value = '125.00';
  element('currencySelect').value = 'usd';
  element('methodCard').value = 'card';
  element('methodCard').checked = true;
  element('methodCrypto').value = 'crypto';
  element('cardGuideProvider').setAttribute('aria-disabled', 'true');

  return {
    ui,
    element,
    elements,
    document,
    window,
    navigator,
    sessionStorage,
    localStorage,
    fetchCalls,
    assets,
    get uuidCalls() { return uuidCalls; },
  };
}

function formGuide(overrides = {}) {
  return {
    amount: '125.00',
    currency: 'usd',
    reference: 'Invoice 125',
    asset: 'btc-mainnet',
    step: 1,
    source: { kind: 'form' },
    noCharge: false,
    walletReady: false,
    networkConfirmed: false,
    fundsReady: false,
    ...overrides,
  };
}

function terminalCardOrder(overrides = {}) {
  return {
    token: 'original-card-token',
    orderId: 'card-order-authoritative',
    amount: '479.35',
    currency: 'eur',
    reference: 'Authoritative invoice',
    merchant: 'Erraza',
    method: 'card',
    status: 'failed',
    terminal: true,
    complete: false,
    ...overrides,
  };
}

function setFreshGuideQuote(ui, overrides = {}) {
  ui.state.guideQuote = {
    estimatedAmount: '0.00420000',
    key: ui.guideQuoteKey(),
    timestamp: Date.now(),
    ...overrides,
  };
  return ui.state.guideQuote;
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), message);
}

function checkoutRequests(harness) {
  return harness.fetchCalls.filter(call => call.method === 'POST' && new URL(call.url, 'https://checkout.example').pathname === '/api/checkout');
}

function guideMarkup() {
  const start = HTML.indexOf('<dialog class="dialog card-guide-dialog"');
  const end = HTML.indexOf('</dialog>', start);
  assert.ok(start >= 0 && end > start, 'card guide dialog markup exists');
  return HTML.slice(start, end + '</dialog>'.length);
}

test('buying-guide markup is an explicit external handoff without sensitive collection or an embedded provider', () => {
  const guide = guideMarkup();
  const providerTag = guide.match(/<a\b[^>]*\bid="cardGuideProvider"[^>]*>/i)?.[0];
  assert.ok(providerTag, 'provider handoff is an anchor');
  assert.doesNotMatch(providerTag, /\shref\s*=/i, 'the provider URL is not present until JavaScript validates the guide state');
  assert.doesNotMatch(HTML, /https:\/\/www\.moonpay\.com\/buy/i, 'the official URL is not hardcoded into HTML');
  assert.match(providerTag, /\btarget="_blank"/i);
  assert.match(providerTag, /\brel="noopener noreferrer"/i);
  assert.match(providerTag, /\breferrerpolicy="no-referrer"/i);
  assert.doesNotMatch(guide, /<iframe\b/i);
  assert.doesNotMatch(guide, /<textarea\b|<select\b/i);

  const inputs = [...guide.matchAll(/<input\b[^>]*>/gi)].map(match => match[0]);
  assert.ok(inputs.length >= 4, 'safety confirmations remain native checkboxes');
  for (const input of inputs) assert.match(input, /\btype="checkbox"/i, `no free-form data field: ${input}`);
  assert.doesNotMatch(guide, /<input\b[^>]*(?:cardNumber|cardCvc|walletAddress|seedPhrase|recoveryPhrase|privateKey)/i);
  assert.doesNotMatch(guide, /autocomplete="(?:cc-|one-time-code)/i);
  assert.match(guide, /purchase[^<]{0,160}does not pay Erraza/i);
  assert.match(guide, /return to (?:this )?Erraza guide/i);
  assert.match(guide, /Return to Erraza and pay/i);
  assert.match(guide, /Never enter card details or a recovery phrase here/i);
});

test('guide eligibility uses ready assets and authoritative rejected-order details', () => {
  const form = cardFallbackVm();
  form.ui.state.assets = [];
  form.ui.state.assetsPhase = 'idle';
  const formContext = plain(form.ui.guideContext());
  assert.deepEqual(formContext, {
    amount: '125.00', currency: 'usd', reference: 'Form reference', asset: '', step: 1, source: { kind: 'form' },
  });
  assert.match(form.ui.guideBlockReason(), /coin and network options must be loaded/i);
  form.ui.openGuide();
  assert.equal(form.ui.state.guide, null);
  assert.equal(form.element('cardGuideDialog').open, false);
  assert.equal(form.fetchCalls.length, 0);

  form.ui.state.assets = form.assets;
  form.ui.state.assetsPhase = 'ready';
  form.ui.openGuide();
  assert.equal(form.ui.guideBlockReason(), '');
  assert.equal(form.ui.state.guide.source.kind, 'form');
  assert.equal(form.element('cardGuideDialog').open, true);
  assert.equal(form.element('cardGuideDialog').scrollTop, 0);
  assert.equal(form.element('cardGuideTitle').focusOptions.preventScroll, true);
  assert.equal(form.fetchCalls.length, 0, 'opening an asset-less guide performs no request');

  const rejected = cardFallbackVm();
  rejected.element('amountInput').value = '1.00';
  rejected.ui.state.currency = 'usd';
  rejected.ui.state.reference = 'Untrusted form value';
  rejected.ui.state.order = terminalCardOrder();
  rejected.ui.state.token = 'original-card-token';
  const orderContext = plain(rejected.ui.guideContext());
  assert.deepEqual(orderContext, {
    amount: '479.35',
    currency: 'eur',
    reference: 'Authoritative invoice',
    asset: '',
    step: 1,
    source: { kind: 'terminal_card', orderId: 'card-order-authoritative' },
  });
  assert.equal(rejected.ui.guideBlockReason(), '');
  rejected.ui.openGuide();
  assert.deepEqual(plain(rejected.ui.state.guide.source), { kind: 'terminal_card', orderId: 'card-order-authoritative' });
  assert.equal(rejected.ui.state.guide.amount, '479.35');
  assert.equal(rejected.ui.state.guide.currency, 'eur');
  assert.equal(rejected.ui.state.guide.reference, 'Authoritative invoice');
  assert.equal(rejected.fetchCalls.length, 0);
});

test('unknown, active, recovery, unreadable, saved-unverified, and offline states cannot open a new guide', () => {
  const scenarios = [
    ...['unknown', 'creating', 'review', 'pending'].map(status => ({
      name: `card order ${status}`,
      setup(harness) {
        harness.ui.state.order = terminalCardOrder({ status, terminal: false });
        harness.ui.state.token = 'existing-token';
      },
    })),
    { name: 'unreadable attempt', setup: harness => { harness.ui.state.unreadableAttempt = true; } },
    { name: 'recovery request', setup: harness => { harness.ui.state.recoveryRequest = { amount: '125.00' }; } },
    { name: 'saved but unverified payment', setup: harness => { harness.ui.state.saved = { token: 'saved-token', timestamp: Date.now() }; } },
    { name: 'offline', setup: harness => { harness.navigator.onLine = false; } },
  ];

  for (const scenario of scenarios) {
    const harness = cardFallbackVm();
    scenario.setup(harness);
    assert.notEqual(harness.ui.guideBlockReason(), '', scenario.name);
    harness.ui.openGuide();
    assert.equal(harness.ui.state.guide, null, scenario.name);
    assert.equal(harness.element('cardGuideDialog').open, false, scenario.name);
    assert.equal(harness.fetchCalls.length, 0, scenario.name);
    assert.equal(harness.uuidCalls, 0, scenario.name);
  }
});

test('opening and moving through the guide is local-only and keeps native dialog focus', () => {
  const harness = cardFallbackVm();
  harness.ui.openGuide();
  assert.equal(harness.element('cardGuideDialog').showModalCalls, 1);
  assert.equal(harness.element('cardGuideTitle').focusOptions.preventScroll, true);

  Object.assign(harness.ui.state.guide, { asset: 'btc-mainnet', walletReady: true });
  setFreshGuideQuote(harness.ui);
  harness.ui.nextGuideStep();
  assert.equal(harness.ui.state.guide.step, 2);
  harness.ui.state.guide.networkConfirmed = true;
  harness.ui.nextGuideStep();
  assert.equal(harness.ui.state.guide.step, 3);
  assert.equal(harness.element('cardGuideReturn').hidden, false);
  assert.match(harness.element('cardGuideStepLabel').textContent, /Phase 2 of 2.*Pay Erraza/);
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(checkoutRequests(harness).length, 0);
  assert.equal(harness.uuidCalls, 0);
});

test('provider handoff is exact, data-free, and enabled only for confirmed step 2 with a fresh quote', async () => {
  const harness = cardFallbackVm();
  harness.ui.state.guide = formGuide({
    amount: '987.65',
    reference: 'customer@example.test / order #private',
    asset: 'btc-mainnet',
    step: 2,
    networkConfirmed: true,
    customerWallet: 'bc1-customer-address-must-not-leak',
  });
  setFreshGuideQuote(harness.ui);
  harness.ui.renderGuide();
  const provider = harness.element('cardGuideProvider');
  assert.equal(provider.getAttribute('href'), PROVIDER_URL);
  assert.equal(provider.getAttribute('aria-disabled'), 'false');
  const url = new URL(provider.getAttribute('href'));
  assert.equal(url.origin + url.pathname, PROVIDER_URL);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.doesNotMatch(provider.getAttribute('href'), /987|customer|private|bc1|order/i);

  harness.ui.state.guide.step = 1;
  harness.ui.renderGuide();
  assert.equal(provider.getAttribute('href'), null);
  harness.ui.state.guide.step = 2;
  harness.ui.state.guideQuote.timestamp = Date.now() - harness.ui.constants.GUIDE_QUOTE_AGE - 1;
  harness.ui.renderGuide();
  assert.equal(provider.getAttribute('href'), null, 'stale quote');
  setFreshGuideQuote(harness.ui);
  harness.ui.state.guide.networkConfirmed = false;
  harness.ui.renderGuide();
  assert.equal(provider.getAttribute('href'), null, 'network not confirmed');
  harness.ui.state.guide.networkConfirmed = true;
  harness.ui.state.guidePaymentChanged = true;
  harness.ui.renderGuide();
  assert.equal(provider.getAttribute('href'), null, 'blocked guide');

  harness.ui.state.guidePaymentChanged = false;
  setFreshGuideQuote(harness.ui);
  harness.ui.renderGuide();
  assert.equal(provider.getAttribute('href'), PROVIDER_URL);
  harness.ui.wireEvents();
  const click = provider.dispatch('click');
  assert.equal(click.defaultPrevented, false);
  assert.equal(harness.ui.state.guide.step, 2, 'navigation keeps its href through the click event');
  assert.equal(provider.getAttribute('href'), PROVIDER_URL);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(harness.ui.state.guide.step, 3);
  assert.equal(harness.element('cardGuideReturn').hidden, false);
  assert.match(harness.element('cardGuideStepLabel').textContent, /Phase 2 of 2.*Pay Erraza/);
  assert.equal(provider.getAttribute('href'), null, 'step 3 cannot reopen the provider link accidentally');
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(checkoutRequests(harness).length, 0);
  assert.equal(harness.uuidCalls, 0);
});

test('guide persistence is minimal and restore rejects expired, corrupt, and invalid drafts', () => {
  const savedHarness = cardFallbackVm();
  savedHarness.ui.state.token = 'payment-token-that-must-not-persist';
  savedHarness.ui.state.customerWallet = 'customer-wallet-that-must-not-persist';
  savedHarness.ui.state.guide = formGuide({
    step: 2,
    noCharge: true,
    walletReady: true,
    networkConfirmed: true,
    fundsReady: true,
    customerWallet: 'wallet-address-that-must-not-persist',
    cardNumber: '4111111111111111',
    seedPhrase: 'never persist seed words',
    token: 'guide-token-that-must-not-persist',
  });
  savedHarness.ui.saveGuide();
  const raw = savedHarness.sessionStorage.getItem(GUIDE_KEY);
  const persisted = JSON.parse(raw);
  assert.deepEqual(Object.keys(persisted).sort(), ['amount', 'asset', 'currency', 'reference', 'source', 'step', 'timestamp', 'version']);
  assert.deepEqual(persisted.source, { kind: 'form' });
  for (const key of ['noCharge', 'walletReady', 'networkConfirmed', 'fundsReady', 'customerWallet', 'cardNumber', 'seedPhrase', 'token']) {
    assert.equal(Object.prototype.hasOwnProperty.call(persisted, key), false, key);
  }
  assert.doesNotMatch(raw, /411111|seed words|wallet-address|payment-token|guide-token/);

  const valid = {
    version: 1,
    amount: '88.40',
    currency: 'eur',
    reference: '  Restored  invoice  ',
    asset: 'xrp-mainnet',
    step: 2,
    source: { kind: 'form' },
    timestamp: Date.now(),
  };
  const restored = cardFallbackVm({ sessionSeed: { [GUIDE_KEY]: JSON.stringify(valid) } });
  restored.ui.restoreGuide();
  assert.equal(restored.ui.state.guide.amount, '88.40');
  assert.equal(restored.ui.state.guide.currency, 'eur');
  assert.equal(restored.ui.state.guide.reference, 'Restored invoice');
  assert.equal(restored.ui.state.guide.asset, 'xrp-mainnet');
  assert.equal(restored.ui.state.guide.step, 1, 'reload returns to visible safety confirmations');
  assert.equal(restored.ui.state.guide.noCharge, false);
  assert.equal(restored.ui.state.guide.walletReady, false);
  assert.equal(restored.ui.state.guide.networkConfirmed, false);
  assert.equal(restored.ui.state.guide.fundsReady, false);

  const invalidDrafts = [
    ['corrupt JSON', '{not-json'],
    ['expired', JSON.stringify({ ...valid, timestamp: Date.now() - restored.ui.constants.GUIDE_MAX_AGE - 1 })],
    ['invalid amount', JSON.stringify({ ...valid, amount: '-1.00' })],
    ['invalid step', JSON.stringify({ ...valid, step: 4 })],
    ['invalid source', JSON.stringify({ ...valid, source: { kind: 'unknown' } })],
  ];
  for (const [name, value] of invalidDrafts) {
    const harness = cardFallbackVm({ sessionSeed: { [GUIDE_KEY]: value } });
    harness.ui.restoreGuide();
    assert.equal(harness.ui.state.guide, null, name);
    assert.equal(harness.sessionStorage.getItem(GUIDE_KEY), null, name);
    assert.match(harness.ui.state.guideMessage, /could not be restored.*No payment was created/i, name);
  }
});

test('verified payment state takes precedence over a restored guide', () => {
  const draft = {
    version: 1,
    amount: '125.00',
    currency: 'usd',
    reference: 'Restored form',
    asset: 'btc-mainnet',
    step: 2,
    source: { kind: 'form' },
    timestamp: Date.now(),
  };
  const harness = cardFallbackVm({ sessionSeed: { [GUIDE_KEY]: JSON.stringify(draft) } });
  harness.ui.state.saved = { token: 'saved-unverified-payment', timestamp: Date.now() };
  harness.ui.restoreGuide();
  harness.ui.state.guide.networkConfirmed = true;
  setFreshGuideQuote(harness.ui);
  assert.match(harness.ui.guideBlockReason(), /earlier payment/i);
  harness.ui.renderGuide();
  assert.equal(harness.element('cardGuideProvider').getAttribute('href'), null);
  assert.equal(harness.element('cardGuideNext').disabled, true);
  assert.equal(harness.element('cardGuideFinish').disabled, true);

  harness.ui.state.saved = null;
  harness.ui.state.recoveryRequest = { amount: '125.00' };
  assert.match(harness.ui.guideBlockReason(), /Recover the earlier checkout/i);
  harness.ui.state.recoveryRequest = null;
  harness.ui.state.unreadableAttempt = true;
  assert.match(harness.ui.guideBlockReason(), /Recover the earlier checkout/i);
});

test('terminal-card guide requires no-charge, wallet, and fresh-quote checks before step 2', () => {
  const harness = cardFallbackVm();
  harness.ui.state.order = terminalCardOrder();
  harness.ui.state.token = 'original-card-token';
  harness.ui.openGuide();
  Object.assign(harness.ui.state.guide, { asset: 'xrp-mainnet' });
  setFreshGuideQuote(harness.ui);

  harness.ui.nextGuideStep();
  assert.equal(harness.ui.state.guide.step, 1, 'neither confirmation is present');
  harness.ui.state.guide.walletReady = true;
  harness.ui.nextGuideStep();
  assert.equal(harness.ui.state.guide.step, 1, 'no-charge confirmation is still required');
  harness.ui.state.guide.noCharge = true;
  harness.ui.state.guideQuote.timestamp = Date.now() - harness.ui.constants.GUIDE_QUOTE_AGE - 1;
  let refreshes = 0;
  harness.ui.setRefreshGuideQuote(() => { refreshes += 1; });
  harness.ui.nextGuideStep();
  assert.equal(harness.ui.state.guide.step, 1, 'a stale quote cannot advance');
  assert.equal(refreshes, 1);
  setFreshGuideQuote(harness.ui);
  harness.ui.nextGuideStep();
  assert.equal(harness.ui.state.guide.step, 2);
  assert.equal(checkoutRequests(harness).length, 0);
  assert.equal(harness.uuidCalls, 0);
});

test('terminal-card finish cannot hand off or allocate a UUID after a failed or changed status check', async () => {
  for (const result of ['failed-check', 'changed-to-unknown']) {
    const harness = cardFallbackVm();
    harness.ui.state.order = terminalCardOrder();
    harness.ui.state.token = 'original-card-token';
    harness.ui.state.idempotencyKey = 'old-card-idempotency-key';
    harness.ui.state.guide = formGuide({
      amount: '479.35',
      currency: 'eur',
      reference: 'Authoritative invoice',
      asset: 'xrp-mainnet',
      step: 3,
      source: { kind: 'terminal_card', orderId: 'card-order-authoritative' },
      noCharge: true,
      walletReady: true,
      networkConfirmed: true,
      fundsReady: true,
    });
    let assetLoads = 0;
    harness.ui.setLoadAssets(async () => { assetLoads += 1; });
    harness.ui.setQueueQuote(() => { throw new Error('queueQuote must not run after an unsafe status check'); });
    if (result === 'failed-check') {
      harness.ui.setCheckStatus(async () => false);
    } else {
      harness.ui.setCheckStatus(async () => {
        harness.ui.state.order = terminalCardOrder({ status: 'unknown', terminal: false });
        return true;
      });
    }

    await harness.ui.finishGuide();
    assert.ok(harness.ui.state.guide, result);
    assert.equal(harness.ui.state.method, 'card', result);
    assert.equal(harness.ui.state.idempotencyKey, 'old-card-idempotency-key', result);
    assert.equal(harness.ui.state.rejectedRetryApproved, false, result);
    assert.equal(assetLoads, 0, result);
    assert.equal(checkoutRequests(harness).length, 0, result);
    assert.equal(harness.uuidCalls, 0, result);
    assert.match(harness.ui.state.guideMessage, /status (?:could not be refreshed|changed)/i, result);
  }

  const success = cardFallbackVm();
  success.ui.state.order = terminalCardOrder();
  success.ui.state.token = 'original-card-token';
  success.ui.openGuide();
  Object.assign(success.ui.state.guide, {
    asset: 'xrp-mainnet', step: 3, noCharge: true, walletReady: true, networkConfirmed: true, fundsReady: true,
  });
  const sequence = [];
  success.ui.setCheckStatus(async () => { sequence.push('fresh-status'); return true; });
  success.ui.setLoadAssets(async () => { sequence.push('fresh-assets'); });
  success.ui.setQueueQuote(() => { sequence.push('fresh-quote'); });
  await success.ui.finishGuide();
  assert.deepEqual(sequence, ['fresh-status', 'fresh-assets', 'fresh-quote']);
  assert.equal(success.ui.state.guide, null);
  assert.equal(success.ui.state.method, 'crypto');
  assert.equal(success.ui.state.asset, 'xrp-mainnet');
  assert.equal(success.ui.state.rejectedRetryApproved, true);
  assert.equal(checkoutRequests(success).length, 0);
  assert.equal(success.uuidCalls, 0);
});

test('form guide finish copies its exact draft but only a later explicit checkout creates an invoice and UUID', async () => {
  const harness = cardFallbackVm();
  harness.ui.state.idempotencyKey = 'old-form-key';
  harness.ui.state.guide = formGuide({
    amount: '88.40',
    currency: 'eur',
    reference: 'Exact draft reference',
    asset: 'xrp-mainnet',
    step: 3,
    walletReady: true,
    networkConfirmed: true,
    fundsReady: false,
  });
  let assetLoads = 0;
  let quoteQueues = 0;
  harness.ui.setLoadAssets(async () => { assetLoads += 1; });
  harness.ui.setQueueQuote(() => { quoteQueues += 1; });

  await harness.ui.finishGuide();
  assert.ok(harness.ui.state.guide, 'no handoff before funds are confirmed');
  assert.equal(harness.ui.state.order, null);
  assert.equal(assetLoads, 0);
  assert.equal(checkoutRequests(harness).length, 0);
  assert.equal(harness.uuidCalls, 0);

  harness.ui.state.guide.fundsReady = true;
  await harness.ui.finishGuide();
  assert.equal(assetLoads, 1);
  assert.equal(quoteQueues, 1);
  assert.equal(harness.ui.state.guide, null);
  assert.equal(harness.ui.state.method, 'crypto');
  assert.equal(harness.ui.state.currency, 'eur');
  assert.equal(harness.ui.state.reference, 'Exact draft reference');
  assert.equal(harness.ui.state.asset, 'xrp-mainnet');
  assert.equal(harness.element('amountInput').value, '88.40');
  assert.equal(harness.element('currencySelect').value, 'eur');
  assert.equal(harness.element('methodCrypto').checked, true);
  assert.equal(harness.element('methodCard').checked, false);
  assert.equal(harness.ui.state.idempotencyKey, null);
  assert.equal(harness.ui.state.order, null, 'finishing the guide is not invoice creation');
  assert.equal(checkoutRequests(harness).length, 0);
  assert.equal(harness.uuidCalls, 0);
  assert.equal(harness.ui.canCreateCheckout(), false, 'a refreshed ordinary checkout quote is still required');

  const key = harness.ui.quoteKey();
  harness.ui.state.quote = { key, estimatedAmount: '0.00250000' };
  harness.ui.state.quotePhase = 'valid';
  assert.equal(harness.ui.canCreateCheckout(), true);
  await harness.ui.checkout({ preventDefault() {} });
  const requests = checkoutRequests(harness);
  assert.equal(requests.length, 1);
  assert.equal(harness.uuidCalls, 1);
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body, {
    amount: '88.40',
    currency: 'eur',
    method: 'crypto',
    reference: 'Exact draft reference',
    asset: 'xrp-mainnet',
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(harness.ui.state.order.orderId, 'new-crypto-order');
});

test('foreground and bfcache returns reset confirmations and quotes, while cross-tab payment changes block the guide', () => {
  const harness = cardFallbackVm();
  harness.ui.state.order = terminalCardOrder();
  harness.ui.state.guide = formGuide({
    amount: '479.35',
    currency: 'eur',
    reference: 'Authoritative invoice',
    asset: 'btc-mainnet',
    step: 3,
    source: { kind: 'terminal_card', orderId: 'card-order-authoritative' },
    noCharge: true,
    walletReady: true,
    networkConfirmed: true,
    fundsReady: true,
  });
  setFreshGuideQuote(harness.ui);
  harness.ui.wireEvents();

  harness.document.hidden = true;
  harness.document.dispatch('visibilitychange');
  harness.document.hidden = false;
  harness.document.dispatch('visibilitychange');
  assert.equal(harness.ui.state.guide.noCharge, false, 'terminal-card return requires a fresh no-charge check');
  assert.equal(harness.ui.state.guide.walletReady, true, 'return step keeps the selected wallet/network context');
  assert.equal(harness.ui.state.guide.networkConfirmed, true);
  assert.equal(harness.ui.state.guide.fundsReady, false);
  assert.ok(harness.ui.state.guideQuote, 'return step keeps the indicative quote for context');

  Object.assign(harness.ui.state.guide, { noCharge: true, walletReady: true, networkConfirmed: true, fundsReady: true });
  setFreshGuideQuote(harness.ui);
  harness.window.dispatch('pageshow', { persisted: true });
  assert.equal(harness.ui.state.guide.noCharge, false, 'bfcache return requires a fresh no-charge check');
  assert.equal(harness.ui.state.guide.walletReady, true);
  assert.equal(harness.ui.state.guide.networkConfirmed, true);
  assert.equal(harness.ui.state.guide.fundsReady, false);
  assert.ok(harness.ui.state.guideQuote);

  Object.assign(harness.ui.state.guide, { step: 2, networkConfirmed: true });
  setFreshGuideQuote(harness.ui);
  harness.ui.renderGuide();
  assert.equal(harness.element('cardGuideProvider').getAttribute('href'), PROVIDER_URL);
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'payment-from-another-tab', timestamp: Date.now() }));
  harness.window.dispatch('storage', { key: STORAGE_KEY });
  assert.equal(harness.ui.state.guidePaymentChanged, true);
  assert.match(harness.ui.guideBlockReason(), /changed in another tab/i);
  assert.equal(harness.element('cardGuideProvider').getAttribute('href'), null);
  assert.equal(harness.element('cardGuideNext').disabled, true);
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(checkoutRequests(harness).length, 0);
});

test('a payment created in another tab blocks checkout even after guide handoff', async () => {
  const harness = cardFallbackVm();
  harness.ui.state.guide = formGuide({
    asset: 'btc-mainnet', step: 3, walletReady: true, networkConfirmed: true, fundsReady: true,
  });
  harness.ui.setLoadAssets(async () => {});
  harness.ui.setQueueQuote(() => {});
  harness.ui.wireEvents();
  await harness.ui.finishGuide();
  assert.equal(harness.ui.state.guide, null);
  assert.equal(harness.ui.state.method, 'crypto');

  const key = harness.ui.quoteKey();
  harness.ui.state.quote = { key, estimatedAmount: '0.00155' };
  harness.ui.state.quotePhase = 'valid';
  assert.equal(harness.ui.canCreateCheckout(), true);

  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'payment-from-another-tab', timestamp: Date.now() }));
  harness.window.dispatch('storage', { key: STORAGE_KEY });
  assert.equal(harness.ui.state.saved.token, 'payment-from-another-tab');
  assert.equal(harness.ui.state.quote, null);
  assert.equal(harness.ui.state.idempotencyKey, null);
  assert.equal(harness.ui.canCreateCheckout(), false);
  await harness.ui.checkout({ preventDefault() {} });
  assert.equal(checkoutRequests(harness).length, 0);
  assert.equal(harness.uuidCalls, 0);
});

test('coin picker closes the guide and reopens it after exact asset selection', async () => {
  const harness = cardFallbackVm();
  harness.ui.state.guide = formGuide({ asset: '' });
  harness.ui.wireEvents();
  harness.element('cardGuideDialog').open = true;

  harness.element('cardGuideChooseAsset').dispatch('click');
  assert.equal(harness.element('cardGuideDialog').open, false);
  assert.equal(harness.element('assetDialog').open, true);

  const bitcoin = {
    dataset: { assetCode: 'btc-mainnet' },
    closest(selector) { return selector === 'button[data-asset-code]' ? this : null; },
  };
  harness.element('assetResults').dispatch('click', { target: bitcoin });
  await waitFor(() => harness.element('cardGuideDialog').open, 'guide reopens after picker closes');
  assert.equal(harness.element('assetDialog').open, false);
  assert.equal(harness.ui.state.guide.asset, 'btc-mainnet');
});

test('asset selection preserves the exact code, resets confirmations, requests that code, and renders memo risk', async () => {
  const harness = cardFallbackVm();
  harness.ui.state.guide = formGuide({
    asset: 'btc-mainnet',
    noCharge: true,
    walletReady: true,
    networkConfirmed: true,
    fundsReady: true,
  });
  setFreshGuideQuote(harness.ui);
  harness.ui.state.guideChoosingAsset = true;
  harness.element('cardGuideDialog').open = false;
  harness.element('assetDialog').open = true;
  harness.ui.wireEvents();

  const resultButton = {
    dataset: { assetCode: 'xrp-mainnet' },
    closest(selector) { return selector === 'button[data-asset-code]' ? this : null; },
  };
  harness.element('assetResults').dispatch('click', { target: resultButton });
  await waitFor(() => !harness.ui.state.guideBusy && Boolean(harness.ui.state.guideQuote), 'selected asset quote completes');

  assert.equal(harness.ui.state.guide.asset, 'xrp-mainnet');
  assert.equal(harness.element('cardGuideDialog').open, true, 'the guide reopens after the coin picker closes');
  assert.equal(harness.element('assetDialog').open, false);
  assert.equal(harness.ui.state.guide.walletReady, false);
  assert.equal(harness.ui.state.guide.networkConfirmed, false);
  assert.equal(harness.ui.state.guide.fundsReady, false);
  assert.equal(harness.ui.state.guideQuote.key, JSON.stringify(['125.00', 'usd', 'xrp-mainnet']));
  assert.equal(harness.element('cardGuideAssetChoice').textContent, 'XRP (XRP) · XRP Ledger');
  assert.equal(harness.element('cardGuideMemoWarning').hidden, false);

  const estimates = harness.fetchCalls.filter(call => new URL(call.url, 'https://checkout.example').pathname === '/api/estimate');
  assert.equal(estimates.length, 1);
  const quoteUrl = new URL(estimates[0].url, 'https://checkout.example');
  assert.equal(quoteUrl.searchParams.get('amount'), '125.00');
  assert.equal(quoteUrl.searchParams.get('fiat'), 'usd');
  assert.equal(quoteUrl.searchParams.get('coin'), 'xrp-mainnet');
  assert.equal(JSON.parse(harness.sessionStorage.getItem(GUIDE_KEY)).asset, 'xrp-mainnet');
  assert.equal(checkoutRequests(harness).length, 0);
});

test('guide uses native dialog semantics, two-phase labels, final wording, and responsive IDs', () => {
  const guide = guideMarkup();
  assert.match(guide, /<dialog\b[^>]*\bid="cardGuideDialog"[^>]*\baria-labelledby="cardGuideTitle"[^>]*\baria-describedby="cardGuideDescription"/i);
  assert.match(guide, /<h2\b[^>]*\bid="cardGuideTitle"[^>]*\btabindex="-1"/i);
  assert.match(guide, /Two phases:/i);
  assert.match(guide, /id="cardGuideFinish"[^>]*>Return to Erraza crypto checkout</i);
  assert.match(HTML, /<meta\b[^>]*name="viewport"[^>]*width=device-width/i);

  const responsiveIds = [
    'cardGuideDialog', 'cardGuideTitle', 'cardGuideStepLabel', 'cardGuideStep1', 'cardGuideStep2', 'cardGuideStep3',
    'cardGuidePrepare', 'cardGuideBuy', 'cardGuideReturn', 'cardGuideBack', 'cardGuideNext', 'cardGuideFinish', 'cardGuideCancel',
  ];
  for (const id of responsiveIds) {
    assert.equal((HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} is a unique responsive hook`);
  }
  assert.match(CSS, /@media \(max-width: 767px\)[\s\S]*?\.card-guide-dialog \{ width: 100%; \}/);
  assert.match(CSS, /@media \(max-width: 767px\)[\s\S]*?\.card-guide-controls \{ grid-template-columns: 1fr; \}/);
  assert.match(CSS, /\.card-guide-controls #cardGuideNext, \.card-guide-controls #cardGuideFinish \{ order: 1; \}/);

  const harness = cardFallbackVm();
  harness.ui.state.guide = formGuide();
  const expected = new Map([
    [1, 'Phase 1 of 2 · Choose crypto'],
    [2, 'Phase 1 of 2 · Get crypto'],
    [3, 'Phase 2 of 2 · Pay Erraza'],
  ]);
  for (const [step, label] of expected) {
    harness.ui.state.guide.step = step;
    harness.ui.renderGuide();
    assert.equal(harness.element('cardGuideStepLabel').textContent, label);
    for (let marker = 1; marker <= 3; marker += 1) {
      assert.equal(harness.element(`cardGuideStep${marker}`).getAttribute('aria-current'), marker === step ? 'step' : null);
    }
  }
});
