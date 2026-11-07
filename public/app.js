(() => {
  'use strict';

  const STORAGE_KEY = 'pay_page.resume.v1';
  const ATTEMPT_KEY = 'pay_page.pending-attempt.v1';
  const POLL_INTERVAL = 6000;
  const POLL_WINDOW = 20 * 60 * 1000;
  const FINAL_PROBLEMS = new Set(['failed', 'expired', 'refunded', 'rejected', 'canceled', 'cancelled', 'cancel']);
  const AWAITING_PAYMENT = new Set(['waiting', 'waiting_for_deposit', 'pending', 'created', 'new', 'ready']);
  const $ = (id) => document.getElementById(id);
  const el = Object.fromEntries([
    'brandLink', 'environmentLabel', 'themeToggle', 'themeIcon', 'themeLabel', 'helpButton', 'privacyButton',
    'paymentForm', 'paymentFields', 'amountInput', 'amountControl', 'amountError', 'currencySelect', 'currencySymbol',
    'quickAmounts', 'methodCrypto', 'methodCard', 'cryptoPanel',
    'assetPicker', 'selectedAssetAvatar', 'selectedAssetName', 'selectedAssetNetwork', 'assetLoadMessage',
    'assetLoadText', 'retryAssets', 'estimateArea', 'estimateValue', 'estimateFeedback', 'estimateError', 'retryEstimate',
    'availabilityNotice', 'availabilityText', 'retryConfig', 'checkoutErrorBox', 'checkoutError',
    'checkoutTitle', 'continueButton', 'continueLabel', 'continueAmount', 'continueIcon', 'continueNote', 'resumeNotice', 'resumeTitle', 'resumeDescription',
    'resumeButton', 'assetDialog', 'assetDialogTitle', 'assetSearch', 'assetResults', 'assetResultsCount', 'assetEmpty',
    'paymentDialog', 'paymentStatusIcon', 'paymentStatusGlyph', 'paymentStatusLabel', 'paymentTitle',
    'paymentDescription', 'returnNote', 'providerMessage', 'cryptoPayment', 'paymentAmountLabel', 'paymentAmount',
    'paymentTicker', 'paymentNetwork', 'paymentQrWrap', 'paymentQr', 'paymentAddress', 'paymentMemoWrap', 'paymentMemo',
    'networkCaution', 'paymentExpiry', 'paymentExpiryValue', 'cardPayment', 'externalCheckout', 'cardDestinationNote',
    'paymentReceipt', 'receiptOrder', 'copyOrderButton', 'receiptAmount', 'receiptMerchant', 'receiptReferenceRow', 'receiptReference', 'receiptMethod', 'receiptAssetRow', 'receiptAsset',
    'receiptCreatedRow', 'receiptCreated', 'copyFallback', 'copyFallbackValue', 'copyFeedback', 'statusCheckMessage',
    'checkStatusButton', 'checkStatusLabel', 'storageNote', 'missingPaymentActions', 'forgetPaymentButton',
    'paymentHelpButton', 'helpDialog', 'helpTitle', 'privacyDialog', 'privacyTitle', 'supportEmail', 'announcer',
  ].map((id) => [id, $(id)]));

  const state = {
    config: null,
    configPhase: 'loading',
    configBusy: false,
    assets: [],
    assetsPhase: 'idle',
    assetsGeneration: 0,
    assetsController: null,
    currency: '',
    method: 'card',
    reference: '',
    asset: '',
    amountTouched: false,
    quote: null,
    quotePhase: 'empty',
    quoteError: '',
    quoteGeneration: 0,
    quoteController: null,
    quoteTimer: null,
    idempotencyKey: null,
    checkoutBusy: false,
    recoveryRequest: null,
    recoveryStorageFailed: false,
    unreadableAttempt: false,
    sessionExpired: false,
    saved: null,
    token: null,
    order: null,
    storageFailed: false,
    lookupMissing: false,
    pollTimer: null,
    pollController: null,
    pollGeneration: 0,
    pollBusy: false,
    pollErrors: 0,
    lastForegroundCheck: 0,
    pollDeadline: 0,
    pollStopped: false,
    expiryTimer: null,
    expiryCheckedFor: null,
    returnMessage: '',
    manualTheme: false,
    presetSearch: '',
    presetHandled: false,
    presetEdited: false,
    presetReturning: false,
  };

  class ApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  async function request(path, { method = 'GET', body, headers = {}, signal, timeout = 15000 } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new ApiError('The payment service returned an unreadable response.', response.status); }
      if (!response.ok) {
        const message = typeof data?.message === 'string' && data.message.trim()
          ? data.message.slice(0, 1200)
          : 'The payment service could not complete this request.';
        throw new ApiError(message, response.status);
      }
      return data;
    } catch (error) {
      if (timedOut) throw new ApiError('The payment service took too long to respond.');
      throw error;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function validText(value, maxLength = 512) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
  }

  function validToken(value) {
    return validText(value, 4096) && !/[\s\u0000-\u001f\u007f]/.test(value);
  }

  // Money remains decimal text. No floating-point rounding is used for validation or requests.
  function decimalParts(value) {
    if (typeof value !== 'string' || value.length > 128) return null;
    const text = value.trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const [integer = '', fraction = ''] = text.split('.');
    return {
      integer: (integer || '0').replace(/^0+(?=\d)/, ''),
      fraction: fraction.replace(/0+$/, ''),
    };
  }

  function compareDecimals(left, right) {
    const a = decimalParts(left);
    const b = decimalParts(right);
    if (!a || !b) return null;
    const precision = Math.max(a.fraction.length, b.fraction.length);
    const aa = BigInt(a.integer + a.fraction.padEnd(precision, '0'));
    const bb = BigInt(b.integer + b.fraction.padEnd(precision, '0'));
    return aa === bb ? 0 : aa > bb ? 1 : -1;
  }

  function canonicalDecimal(value, decimals) {
    const parts = decimalParts(value);
    if (!parts || parts.fraction.length > decimals) return null;
    return parts.integer + (decimals ? `.${parts.fraction.padEnd(decimals, '0')}` : '');
  }

  function currencyMeta(code = state.currency) {
    return state.config?.currencies.find((item) => item.code === code) || null;
  }

  function selectedAsset() {
    return state.assets.find((item) => item.code === state.asset) || null;
  }

  function formatMoney(value, code, includeCode = true) {
    const parts = decimalParts(value);
    if (!parts) return 'Amount unavailable';
    const metadata = currencyMeta(code);
    const places = Math.max(parts.fraction.length, metadata?.decimals ?? 0);
    const number = parts.integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      + (places ? `.${parts.fraction.padEnd(places, '0')}` : '');
    const label = metadata?.label || String(code).toUpperCase();
    return `${metadata?.symbol || ''}${number}${includeCode && label ? ` ${label}` : ''}`;
  }

  function amountValidation() {
    const raw = window.PaymentLinks.normalizeInput(el.amountInput.value);
    if (!raw) return { value: null, error: 'Enter an amount to continue.' };
    if (raw.includes(',')) return { value: null, error: 'Enter decimals without thousands separators, for example 125.50.' };
    const parts = decimalParts(raw);
    if (!parts) return { value: null, error: 'Enter a number without spaces or currency symbols.' };
    if (compareDecimals(raw, '0') !== 1) return { value: null, error: 'Enter an amount greater than zero.' };
    const currency = currencyMeta();
    if (!currency) return { value: null, error: '' };
    const value = canonicalDecimal(raw, currency.decimals);
    if (value === null) {
      return { value: null, error: currency.decimals === 0
        ? `${currency.label} amounts must be whole numbers.`
        : `Use no more than ${currency.decimals} decimal places for ${currency.label}.` };
    }
    if (state.config.minAmount && compareDecimals(value, state.config.minAmount) === -1) {
      return { value: null, error: `Enter at least ${formatMoney(state.config.minAmount, currency.code)}.` };
    }
    if (state.config.maxAmount && compareDecimals(value, state.config.maxAmount) === 1) {
      return { value: null, error: `Enter no more than ${formatMoney(state.config.maxAmount, currency.code)}.` };
    }
    return { value, error: '' };
  }

  function renderAmount() {
    const validation = amountValidation();
    const showError = state.amountTouched && Boolean(validation.error);
    el.amountError.textContent = showError ? validation.error : '';
    el.amountError.hidden = !showError;
    el.amountInput.setAttribute('aria-invalid', String(showError));
    el.amountControl.classList.toggle('is-invalid', showError);
    const currency = currencyMeta();
    el.currencySymbol.textContent = currency?.symbol || '';
    const entered = decimalParts(el.amountInput.value);
    el.quickAmounts.querySelectorAll('button[data-amount]').forEach((button) => {
      const value = button.dataset.amount;
      button.textContent = `${currency?.symbol || ''}${value}`;
      button.setAttribute('aria-label', currency ? `Set amount to ${value} ${currency.label}` : `Set amount to ${value}`);
      button.setAttribute('aria-pressed', String(Boolean(entered) && compareDecimals(el.amountInput.value, value) === 0));
      button.disabled = Boolean(state.config && (
        compareDecimals(value, state.config.minAmount) === -1 || compareDecimals(value, state.config.maxAmount) === 1
      ));
    });
  }

  function isOffline() {
    return globalThis.navigator?.onLine === false;
  }

  function paymentsReady() {
    return !isOffline() && state.configPhase === 'ready' && state.config?.configured === true
      && validText(state.config.csrfToken, 4096) && state.config.currencies.length > 0
      && !state.sessionExpired && typeof window.crypto?.randomUUID === 'function';
  }

  function cardAvailable() {
    return state.config?.fiatEnabled === true && state.config.fiatCurrencies.includes(state.currency);
  }

  function settledOrder(order) {
    return Boolean(order && (order.complete === true || (order.terminal === true && FINAL_PROBLEMS.has(order.status))));
  }

  function hasUnresolvedPayment() {
    return Boolean((state.token || state.saved?.token) && !settledOrder(state.order));
  }

  function canCreateCheckout() {
    if (!paymentsReady() || state.checkoutBusy || hasUnresolvedPayment() || state.unreadableAttempt) return false;
    if (state.recoveryRequest) return true;
    if (!amountValidation().value) return false;
    if (state.method === 'card') return cardAvailable();
    return state.quotePhase === 'valid' && state.quote?.key === quoteKey() && Boolean(selectedAsset());
  }

  function renderAvailability() {
    let message = '';
    el.retryConfig.hidden = true;
    el.retryConfig.disabled = state.configBusy;
    if (isOffline()) {
      message = 'You’re offline. Reconnect to continue.';
    } else if (state.configPhase === 'loading') {
      message = 'Loading checkout…';
    } else if (state.configPhase === 'error') {
      message = 'Checkout couldn’t be loaded. Please try again.';
      el.retryConfig.hidden = false;
    } else if (state.sessionExpired) {
      message = 'Please refresh your session to continue.';
      el.retryConfig.hidden = false;
    } else if (!state.config?.configured) {
      message = 'Checkout is temporarily unavailable. Please try again later.';
    } else if (typeof window.crypto?.randomUUID !== 'function') {
      message = 'Please use an up-to-date browser to continue.';
    } else if (state.method === 'card' && !state.config.fiatEnabled) {
      message = 'Card payments are temporarily unavailable. Choose crypto or try again later.';
    } else if (state.method === 'card' && !cardAvailable()) {
      const supported = state.config.currencies.filter((item) => state.config.fiatCurrencies.includes(item.code));
      const suggestion = supported.length ? `Choose ${supported.map((item) => item.label).join(', ')}, or pay with crypto.` : 'Choose crypto instead.';
      message = `Card payments aren’t available in ${currencyMeta()?.label || 'this currency'}. ${suggestion}`;
    }
    el.availabilityText.textContent = message;
    el.availabilityNotice.hidden = !message;
  }

  function renderMethod() {
    el.cryptoPanel.hidden = state.method !== 'crypto';
  }

  function renderContinue() {
    renderAvailability();
    el.paymentFields.disabled = state.checkoutBusy || Boolean(state.recoveryRequest) || state.unreadableAttempt;
    el.currencySelect.disabled = !state.config?.currencies.length;
    el.continueButton.disabled = !canCreateCheckout();
    el.continueButton.setAttribute('aria-busy', String(state.checkoutBusy));
    el.continueLabel.textContent = state.checkoutBusy ? 'Preparing checkout…' : state.recoveryRequest ? 'Recover checkout' : 'Continue';
    const paymentNeedsAttention = state.unreadableAttempt || state.recoveryRequest || hasUnresolvedPayment();
    const amount = amountValidation().value;
    const showAmount = Boolean(amount && !state.checkoutBusy && !paymentNeedsAttention);
    el.continueAmount.hidden = !showAmount;
    el.continueAmount.textContent = showAmount ? `· ${formatMoney(amount, state.currency)}` : '';
    el.continueIcon.hidden = state.checkoutBusy || showAmount;
    el.continueNote.hidden = !paymentNeedsAttention && (!paymentsReady() || (state.method === 'card' && !cardAvailable()));
    if (state.unreadableAttempt) {
      el.continueNote.textContent = 'Check with the merchant before starting another payment.';
    } else if (state.recoveryRequest) {
      el.continueNote.textContent = 'Keep this page open. Recovery uses the same payment request.';
    } else if (hasUnresolvedPayment()) {
      el.continueNote.textContent = 'Check your existing payment before starting another.';
    } else if (state.method === 'card') {
      el.continueNote.textContent = 'Review your total before you pay.';
    } else {
      el.continueNote.textContent = 'You’ll review the payment details next.';
    }
  }

  function showCheckoutError(message = '') {
    el.checkoutError.textContent = message;
    el.checkoutErrorBox.hidden = !message;
  }

  function normalizeConfig(data) {
    if (!data || typeof data.configured !== 'boolean' || typeof data.sandbox !== 'boolean'
      || typeof data.fiatEnabled !== 'boolean' || !Array.isArray(data.currencies)
      || !decimalParts(data.minAmount) || !decimalParts(data.maxAmount)
      || compareDecimals(data.maxAmount, data.minAmount) === -1) {
      throw new Error('Payment configuration could not be verified.');
    }
    const currencies = [];
    const codes = new Set();
    for (const item of data.currencies) {
      if (!item || !validText(item.code, 24) || !validText(item.label, 24)
        || typeof item.symbol !== 'string' || item.symbol.length > 12
        || !Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 18 || codes.has(item.code)) {
        throw new Error('Payment currencies could not be verified.');
      }
      codes.add(item.code);
      currencies.push({ code: item.code, label: item.label, symbol: item.symbol, decimals: item.decimals });
    }
    return {
      brand: validText(data.brand, 100) ? data.brand : 'Erraza',
      configured: data.configured,
      sandbox: data.sandbox,
      fiatEnabled: data.fiatEnabled,
      fiatCurrencies: Array.isArray(data.fiatCurrencies) ? data.fiatCurrencies.filter((code) => validText(code, 24)) : [],
      currencies,
      minAmount: data.minAmount,
      maxAmount: data.maxAmount,
      csrfToken: validText(data.csrfToken, 4096) ? data.csrfToken : null,
      supportEmail: typeof data.supportEmail === 'string' ? data.supportEmail : null,
    };
  }

  function renderHeading() {
    const reference = state.order?.reference ?? state.reference;
    el.checkoutTitle.textContent = reference ? `Payment for ${reference}` : 'Payment details';
  }

  function renderConfig() {
    const config = state.config;
    if (config) {
      document.querySelectorAll('[data-brand]').forEach((node) => { node.textContent = config.brand; });
      document.title = `${config.brand} | Payment checkout`;
      renderHeading();
      el.brandLink.setAttribute('aria-label', `${config.brand} checkout`);
    }
    el.environmentLabel.hidden = !config?.sandbox;
    document.querySelectorAll('[data-sandbox]').forEach((node) => { node.hidden = !config?.sandbox; });
    const options = document.createDocumentFragment();
    if (config?.currencies.length) {
      for (const currency of config.currencies) {
        const option = document.createElement('option');
        option.value = currency.code;
        option.textContent = currency.label;
        options.append(option);
      }
      if (!config.currencies.some((item) => item.code === state.currency)) state.currency = config.currencies[0].code;
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = state.configPhase === 'loading' ? 'Loading' : 'Unavailable';
      options.append(option);
      state.currency = '';
    }
    el.currencySelect.replaceChildren(options);
    el.currencySelect.value = state.currency;
    const email = config?.supportEmail;
    const emailValid = typeof email === 'string' && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email);
    el.supportEmail.hidden = !emailValid;
    if (emailValid) el.supportEmail.href = `mailto:${encodeURIComponent(email)}`;
    else el.supportEmail.removeAttribute('href');
    renderAmount();
    renderMethod();
    renderAvailability();
    renderContinue();
  }

  async function loadConfig() {
    if (state.configBusy || state.checkoutBusy) return;
    if (isOffline()) { renderContinue(); return; }
    state.configBusy = true;
    state.configPhase = 'loading';
    invalidateQuote();
    renderAvailability();
    renderContinue();
    try {
      state.config = normalizeConfig(await request('/api/config'));
      state.configPhase = 'ready';
      state.sessionExpired = false;
    } catch {
      state.config = null;
      state.configPhase = 'error';
      state.assetsController?.abort();
      state.assetsGeneration += 1;
      state.assets = [];
      state.asset = '';
      state.assetsPhase = 'idle';
    } finally {
      state.configBusy = false;
      applyPresetLink();
      renderConfig();
    }
    if (state.config?.configured) {
      await loadAssets();
    } else {
      state.assetsController?.abort();
      state.assetsGeneration += 1;
      state.assets = [];
      state.asset = '';
      state.assetsPhase = 'idle';
      renderAssetPicker();
    }
    if (state.order) renderOrder();
  }

  function normalizeAsset(item) {
    if (!item || !validText(item.code, 100) || !validText(item.ticker, 100)
      || !validText(item.name, 200) || !validText(item.network, 200)) return null;
    return { code: item.code, ticker: item.ticker, name: item.name, network: item.network };
  }

  async function loadAssets() {
    if (!state.config?.configured) return;
    state.assetsController?.abort();
    const controller = new AbortController();
    state.assetsController = controller;
    const generation = ++state.assetsGeneration;
    state.assetsPhase = 'loading';
    invalidateQuote();
    renderAssetPicker();
    renderContinue();
    try {
      const result = await request('/api/currencies', { signal: controller.signal });
      if (generation !== state.assetsGeneration) return;
      if (!Array.isArray(result?.currencies)) throw new Error('Unsupported currency response.');
      const codes = new Set();
      const assets = result.currencies.map((item) => {
        const asset = normalizeAsset(item);
        if (!asset || codes.has(asset.code)) throw new Error('Coin and network details could not be verified.');
        codes.add(asset.code);
        return asset;
      });
      state.assets = assets;
      if (!assets.some((asset) => asset.code === state.asset)) state.asset = '';
      state.assetsPhase = 'ready';
    } catch (error) {
      if (generation !== state.assetsGeneration || error.name === 'AbortError') return;
      state.assets = [];
      state.asset = '';
      state.assetsPhase = 'error';
    } finally {
      if (generation === state.assetsGeneration) {
        state.assetsController = null;
        renderAssetPicker();
        renderAssetResults();
        queueQuote();
      }
    }
  }

  function makeIcon(name) {
    const icon = document.createElement('span');
    icon.className = `icon icon-${name}`;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function renderAssetPicker() {
    const asset = selectedAsset();
    el.assetPicker.disabled = state.assetsPhase !== 'ready' || !state.assets.length;
    el.assetLoadMessage.hidden = state.assetsPhase !== 'error';
    el.retryAssets.disabled = state.assetsPhase === 'loading';
    el.assetLoadText.textContent = 'Supported coins and networks couldn’t be loaded.';
    if (asset) {
      el.selectedAssetName.textContent = `${asset.name} (${asset.ticker})`;
      el.selectedAssetNetwork.textContent = `Network: ${asset.network}`;
      el.selectedAssetAvatar.textContent = asset.ticker.slice(0, 3);
    } else {
      el.selectedAssetAvatar.replaceChildren(makeIcon('wallet'));
      el.selectedAssetName.textContent = 'Choose a coin';
      el.selectedAssetNetwork.textContent = state.assetsPhase === 'loading' ? 'Loading supported networks…'
        : state.assetsPhase === 'error' ? 'Networks are temporarily unavailable'
          : state.assetsPhase === 'ready' && state.assets.length ? 'Select the network your wallet uses'
            : state.configPhase === 'error' ? 'Payment availability could not be checked'
              : state.config?.configured ? 'No supported networks are available'
                : 'Payment methods are temporarily unavailable';
    }
  }

  function renderAssetResults() {
    const query = el.assetSearch.value.trim().toLocaleLowerCase();
    const matches = state.assets.filter((asset) => [asset.code, asset.ticker, asset.name, asset.network]
      .some((text) => text.toLocaleLowerCase().includes(query)));
    const fragment = document.createDocumentFragment();
    for (const asset of matches) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'asset-result';
      button.dataset.assetCode = asset.code;
      button.setAttribute('aria-pressed', String(asset.code === state.asset));
      const avatar = document.createElement('span');
      avatar.className = 'asset-avatar';
      avatar.textContent = asset.ticker.slice(0, 3);
      avatar.setAttribute('aria-hidden', 'true');
      const main = document.createElement('span');
      main.className = 'asset-result-main';
      const name = document.createElement('span');
      name.className = 'asset-result-name';
      name.textContent = `${asset.name} (${asset.ticker})`;
      const network = document.createElement('span');
      network.className = 'asset-result-network';
      network.textContent = `Network: ${asset.network}`;
      main.append(name, network);
      button.append(avatar, main);
      if (asset.code === state.asset) button.append(makeIcon('check'));
      li.append(button);
      fragment.append(li);
    }
    el.assetResults.replaceChildren(fragment);
    el.assetEmpty.hidden = matches.length > 0;
    el.assetResultsCount.textContent = `${matches.length} ${matches.length === 1 ? 'coin and network pair' : 'coin and network pairs'}`;
  }

  function quoteKey() {
    const amount = amountValidation().value;
    return amount && state.currency && state.asset ? JSON.stringify([amount, state.currency, state.asset]) : null;
  }

  function invalidateQuote() {
    state.quoteGeneration += 1;
    window.clearTimeout(state.quoteTimer);
    state.quoteTimer = null;
    state.quoteController?.abort();
    state.quoteController = null;
    state.quote = null;
    state.quotePhase = 'empty';
    state.quoteError = '';
    renderQuote();
  }

  function renderQuote() {
    el.estimateArea.dataset.state = state.quotePhase;
    el.estimateArea.setAttribute('aria-busy', String(state.quotePhase === 'loading'));
    el.estimateFeedback.hidden = !state.quoteError;
    el.estimateError.textContent = state.quoteError;
    el.retryEstimate.hidden = state.quotePhase === 'minimum';
    if (state.quotePhase === 'valid' && state.quote) {
      el.estimateValue.textContent = `${state.quote.estimatedAmount} ${selectedAsset()?.ticker || ''}`;
    } else if (state.quotePhase === 'loading') {
      el.estimateValue.textContent = 'Getting estimate…';
    } else if (state.quotePhase === 'minimum') {
      el.estimateValue.textContent = 'Amount below minimum';
    } else if (state.quotePhase === 'error') {
      el.estimateValue.textContent = 'Estimate unavailable';
    } else {
      el.estimateValue.textContent = state.asset ? 'Enter a valid amount' : 'Choose a coin first';
    }
  }

  function normalizeQuote(data, amount, fiat, coin) {
    if (!data || !decimalParts(data.estimatedAmount) || compareDecimals(data.estimatedAmount, '0') !== 1
      || !decimalParts(data.priceAmount) || compareDecimals(data.priceAmount, amount) !== 0
      || data.priceCurrency !== fiat || data.payCurrency !== coin) {
      throw new Error('The estimate could not be verified for these payment details. Please refresh it.');
    }
    if (data.minFiatAmount != null && !decimalParts(data.minFiatAmount)) {
      throw new Error('The minimum amount could not be verified. Please refresh the estimate.');
    }
    return {
      estimatedAmount: data.estimatedAmount,
      minFiatAmount: data.minFiatAmount ?? null,
      priceAmount: data.priceAmount,
      priceCurrency: data.priceCurrency,
      payCurrency: data.payCurrency,
    };
  }

  function queueQuote(delay = 400) {
    invalidateQuote();
    if (!paymentsReady() || state.method !== 'crypto' || !selectedAsset() || !amountValidation().value
      || state.assetsPhase !== 'ready' || state.recoveryRequest || document.hidden) {
      renderContinue();
      return;
    }
    const generation = state.quoteGeneration;
    const amount = amountValidation().value;
    const fiat = state.currency;
    const coin = state.asset;
    const key = quoteKey();
    state.quotePhase = 'loading';
    renderQuote();
    renderContinue();
    state.quoteTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      state.quoteController = controller;
      const params = new URLSearchParams({ amount, fiat, coin });
      try {
        const data = await request(`/api/estimate?${params}`, { signal: controller.signal });
        if (generation !== state.quoteGeneration || key !== quoteKey()) return;
        const quote = normalizeQuote(data, amount, fiat, coin);
        if (quote.minFiatAmount !== null && compareDecimals(amount, quote.minFiatAmount) === -1) {
          state.quotePhase = 'minimum';
          state.quoteError = `The minimum for this coin and network is ${formatMoney(quote.minFiatAmount, fiat)}. Increase the amount or choose another coin.`;
        } else {
          state.quote = { ...quote, key };
          state.quotePhase = 'valid';
        }
      } catch (error) {
        if (generation !== state.quoteGeneration || error.name === 'AbortError') return;
        state.quotePhase = 'error';
        state.quoteError = error instanceof ApiError || error.message.startsWith('The ')
          ? error.message : 'An estimate isn’t available right now. Please refresh it before continuing.';
      } finally {
        if (generation === state.quoteGeneration) {
          state.quoteController = null;
          state.quoteTimer = null;
          renderQuote();
          renderContinue();
        }
      }
    }, delay);
  }

  function applyPresetLink() {
    if (state.presetHandled || !state.config) return;
    state.presetHandled = true;
    // A shared link is only a convenience; it must never replace an existing payment.
    if (state.presetEdited || state.presetReturning || state.recoveryRequest || state.unreadableAttempt || state.saved?.token || state.token) return;
    try {
      const preset = window.PaymentLinks.parse(state.presetSearch, state.config);
      if (!preset) return;
      state.currency = preset.currency;
      state.reference = preset.reference || '';
      el.amountInput.value = preset.amount;
      state.amountTouched = false;
      state.idempotencyKey = null;
    } catch (error) {
      el.amountInput.value = '';
      state.amountTouched = false;
      showCheckoutError(`This payment link could not be applied. ${error.message}`);
    }
  }

  function paymentDetailsChanged() {
    if (state.checkoutBusy || state.recoveryRequest) return;
    state.presetEdited = true;
    state.idempotencyKey = null;
    showCheckoutError();
    renderAmount();
    renderMethod();
    renderAssetPicker();
    queueQuote();
    renderContinue();
  }

  function attemptFingerprint(body) {
    const parts = [body.amount, body.currency, body.method, body.asset ?? null, body.idempotencyKey];
    if (body.reference) parts.push(body.reference);
    return JSON.stringify(parts);
  }

  function rememberAttempt(body) {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ body, fingerprint: attemptFingerprint(body), timestamp: Date.now() }));
      state.recoveryStorageFailed = false;
    } catch { state.recoveryStorageFailed = true; }
  }

  function clearAttempt() {
    try { sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* Keep the verified order reference in memory. */ }
  }

  function restoreAttempt() {
    let raw;
    try { raw = sessionStorage.getItem(ATTEMPT_KEY); }
    catch { state.recoveryStorageFailed = true; return; }
    if (!raw) return;
    try {
      const attempt = JSON.parse(raw);
      const body = attempt?.body;
      if (!body || !decimalParts(body.amount) || compareDecimals(body.amount, '0') !== 1
        || !validText(body.currency, 24) || !['card', 'crypto'].includes(body.method)
        || (body.method === 'crypto' && !validText(body.asset, 100))
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey)
        || attempt.fingerprint !== attemptFingerprint(body)) {
        state.unreadableAttempt = true;
        showCheckoutError('A previous checkout attempt is saved but could not be recovered safely. Contact the merchant before making another payment.');
        return;
      }
      const reference = window.PaymentLinks.reference(body.reference);
      state.recoveryRequest = {
        amount: body.amount, currency: body.currency, method: body.method,
        ...(body.method === 'crypto' ? { asset: body.asset } : {}), ...(reference ? { reference } : {}), idempotencyKey: body.idempotencyKey,
      };
      state.idempotencyKey = body.idempotencyKey;
      state.currency = body.currency;
      state.reference = reference;
      state.method = body.method;
      state.asset = body.asset || '';
      el.amountInput.value = body.amount;
      el.methodCrypto.checked = body.method === 'crypto';
      el.methodCard.checked = body.method === 'card';
      showCheckoutError('An earlier checkout attempt is unconfirmed. Recover the same request below before making another payment. These saved inputs are not a payment receipt.');
    } catch {
      state.unreadableAttempt = true;
      showCheckoutError('A previous checkout attempt is saved but could not be read safely. Contact the merchant before making another payment.');
    }
  }

  async function checkout(event) {
    event.preventDefault();
    if (state.checkoutBusy) return;
    state.amountTouched = true;
    renderAmount();
    if (!canCreateCheckout()) {
      if (amountValidation().error) el.amountInput.focus();
      return;
    }
    // A manual retry reuses the exact request after a lost response. POST is never automatically retried.
    if (!state.idempotencyKey) state.idempotencyKey = window.crypto.randomUUID();
    const body = state.recoveryRequest || {
      amount: amountValidation().value,
      currency: state.currency,
      method: state.method,
      ...(state.reference ? { reference: state.reference } : {}),
      ...(state.method === 'crypto' ? { asset: state.asset } : {}),
      idempotencyKey: state.idempotencyKey,
    };
    const recovering = Boolean(state.recoveryRequest);
    state.checkoutBusy = true;
    rememberAttempt(body);
    showCheckoutError();
    renderContinue();
    try {
      const data = await request('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.config.csrfToken },
        body,
        timeout: 30000,
      });
      const order = normalizeOrder(data);
      state.recoveryRequest = null;
      clearAttempt();
      state.returnMessage = '';
      adoptOrder(order);
      openDialog(el.paymentDialog, el.paymentTitle);
      startExpiryClock();
      if (!order.terminal && !order.complete) schedulePoll(POLL_INTERVAL);
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || (error.status >= 200 && error.status < 300);
      if (uncertain) {
        state.recoveryRequest = body;
        showCheckoutError('We couldn’t retrieve the checkout result. Recover it with the same details below; don’t start a separate payment. Keep this page open while you recover it.');
      } else if (error.status === 401 || error.status === 403) {
        state.sessionExpired = true;
        if (!recovering) clearAttempt();
        showCheckoutError('Refresh your checkout session, then try again. Your payment request reference will stay the same.');
        renderAvailability();
      } else if (recovering) {
        showCheckoutError(`${error.message || 'The checkout could not be recovered.'} The earlier attempt is still unconfirmed. Keep this page and contact the merchant before making another payment.`);
      } else {
        clearAttempt();
        showCheckoutError(error.message || 'Checkout could not be started. Review the payment details and try again.');
      }
    } finally {
      state.checkoutBusy = false;
      renderContinue();
    }
  }

  function normalizeOrder(data, expectedToken = null) {
    if (!data || !validToken(data.token) || (expectedToken && data.token !== expectedToken)
      || !validText(data.orderId, 300) || !decimalParts(data.amount) || !validText(data.currency, 100)
      || !['crypto', 'card'].includes(data.method) || !validText(data.status, 100)
      || typeof data.complete !== 'boolean' || typeof data.terminal !== 'boolean') {
      throw new Error('The payment details could not be verified.');
    }
    let payment = null;
    if (data.payment && typeof data.payment === 'object') {
      payment = {
        address: validText(data.payment.address, 4096) ? data.payment.address : null,
        amount: decimalParts(data.payment.amount) && compareDecimals(data.payment.amount, '0') === 1 ? data.payment.amount : null,
        currency: validText(data.payment.currency, 100) ? data.payment.currency : null,
        memo: typeof data.payment.memo === 'string' ? data.payment.memo : data.payment.memo === 0 ? '0' : null,
        qrDataUrl: typeof data.payment.qrDataUrl === 'string' ? data.payment.qrDataUrl : null,
        expiresAt: typeof data.payment.expiresAt === 'string' ? data.payment.expiresAt : null,
      };
    }
    return {
      token: data.token,
      orderId: data.orderId,
      amount: data.amount,
      currency: data.currency,
      reference: window.PaymentLinks.reference(data.reference),
      merchant: validText(data.merchant, 100) ? data.merchant : state.config?.brand || '',
      method: data.method,
      asset: normalizeAsset(data.asset),
      status: data.status.toLowerCase(),
      terminal: data.terminal,
      complete: data.complete,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
      payment,
      checkoutUrl: typeof data.checkoutUrl === 'string' ? data.checkoutUrl : null,
      message: validText(data.message, 4000) ? data.message : null,
    };
  }

  function statusPresentation(order) {
    // Only this explicit server boolean can render a successful payment.
    if (order.complete === true) {
      return { label: 'Complete', title: 'Payment received', description: 'The payment provider has confirmed that your payment is complete. Keep the order reference below.', tone: 'complete', icon: 'check' };
    }
    const map = {
      confirming: ['Confirming', 'Waiting for confirmations', 'Your payment has been detected. The provider is waiting for network confirmations. Please don’t send it again.'],
      confirmed: ['Still processing', 'Final confirmation pending', 'Network confirmation is recorded, but the payment is not complete. We’re waiting for the provider’s final status.'],
      exchanging: ['Converting funds', 'Conversion in progress', 'The provider is converting the funds. Your payment is not complete yet. Please don’t send it again.'],
      sending: ['Settling payment', 'Your payment is being settled', 'The provider is transferring the payment. We’re still waiting for its final completion status.'],
      finished: ['Completion not verified', 'Checking the final result', 'Completion hasn’t been verified for this payment. Keep your order reference and check again or contact the merchant.'],
      partially_paid: ['Partial payment', 'Partial payment received', 'Less than the required amount was received. Don’t send the full amount again. Contact the merchant with your order reference before sending more.'],
      expired: ['Expired', 'The payment window has ended', 'Don’t send funds to these payment details. If you already sent a payment, contact the merchant with your order reference.'],
      rejected: ['Checkout unavailable', 'The checkout was not created', 'The provider rejected this checkout request. Review the payment details or contact the merchant.'],
      failed: ['Failed', 'Payment could not be completed', 'The provider reported a failed payment. If you sent funds or see a card charge, contact the merchant with your order reference.'],
      refunded: ['Refunded', 'The provider reports a refund', 'Check the original payment method for the refund. Contact the merchant if you need help tracing it.'],
      canceled: ['Cancelled', 'Payment cancelled', 'The provider marked this payment as cancelled. If you sent funds or see a charge, contact the merchant with your order reference.'],
      cancelled: ['Cancelled', 'Payment cancelled', 'The provider marked this payment as cancelled. If you sent funds or see a charge, contact the merchant with your order reference.'],
      cancel: ['Cancelled', 'Payment cancelled', 'The provider marked this payment as cancelled. If you sent funds or see a charge, contact the merchant with your order reference.'],
      creating: ['Preparing payment', 'Preparing your payment', 'The provider is preparing the checkout details. Keep this payment reference; you don’t need to create another payment.'],
      processing: ['Processing', 'Your payment is processing', 'The provider is still processing this payment. Keep your order reference and check here for updates.'],
      unknown: ['Status unverified', 'We’re checking your payment', 'The provider has not returned a verified outcome. Don’t start a separate payment. Keep your order reference and check again.'],
      uncertain: ['Status unverified', 'We’re checking your payment', 'The provider has not returned a verified outcome. Don’t start a separate payment. Keep your order reference and check again.'],
      review: ['Review needed', 'Your payment needs a review', 'The payment has not been confirmed complete. Don’t start another payment. Contact the merchant with your order reference.'],
      under_review: ['Under review', 'Your payment is under review', 'The payment has not been confirmed complete. Don’t start another payment. Contact the merchant with your order reference.'],
    };
    if (AWAITING_PAYMENT.has(order.status)) {
      const ready = order.method === 'card' ? Boolean(safeCheckoutUrl(order.checkoutUrl))
        : Boolean(order.payment?.address && order.payment?.amount && order.asset);
      return {
        label: ready ? 'Awaiting payment' : 'Preparing payment',
        title: ready ? (order.method === 'card' ? 'Continue with your card' : 'Ready when you are') : 'Preparing your payment',
        description: ready ? (order.method === 'card'
          ? 'Open the provider’s checkout below. This page will check the payment status when you return.'
          : 'Use the exact coin, network and amount below. This page checks the payment status with the provider.')
          : 'Your payment reference is saved. The provider is preparing the payment details; there’s no need to start another payment.',
        tone: 'pending', icon: order.method === 'card' ? 'credit-card' : 'wallet',
      };
    }
    const values = map[order.status] || ['Status unverified', 'Your payment needs a status check', 'Completion has not been verified. Don’t start a separate payment. Keep your order reference and check again or contact the merchant.'];
    const problem = FINAL_PROBLEMS.has(order.status) || order.status === 'partially_paid';
    return { label: values[0], title: values[1], description: values[2], tone: problem ? 'problem' : 'pending', icon: problem ? 'info' : 'arrow-clockwise' };
  }

  function safeCheckoutUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url : null;
    } catch { return null; }
  }

  function safeQr(value) {
    return typeof value === 'string' && value.length < 2000000
      && /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value);
  }

  function expiryTime(order = state.order) {
    const value = order?.payment?.expiresAt;
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  function canSendPayment(order) {
    const expiry = expiryTime(order);
    return !order.complete && !order.terminal && AWAITING_PAYMENT.has(order.status)
      && (expiry === null || expiry > Date.now());
  }

  function renderOrder() {
    const order = state.order;
    if (!order) return;
    const presentation = statusPresentation(order);
    el.paymentStatusLabel.textContent = presentation.label;
    el.paymentTitle.textContent = presentation.title;
    el.paymentDescription.textContent = presentation.description;
    el.paymentStatusIcon.dataset.tone = presentation.tone;
    el.paymentStatusGlyph.className = `icon icon-${presentation.icon}`;
    el.providerMessage.textContent = order.message || '';
    el.providerMessage.hidden = !order.message;
    el.returnNote.textContent = state.returnMessage;
    el.returnNote.hidden = !state.returnMessage;
    el.storageNote.hidden = !state.storageFailed;
    el.paymentReceipt.hidden = false;
    el.receiptOrder.textContent = order.orderId;
    el.copyOrderButton.disabled = !validText(order.orderId, 300);
    el.receiptAmount.textContent = formatMoney(order.amount, order.currency);
    el.receiptMerchant.textContent = order.merchant;
    el.receiptReferenceRow.hidden = !order.reference;
    el.receiptReference.textContent = order.reference;
    el.receiptMethod.textContent = order.method === 'card' ? 'Card (fiat on-ramp)' : 'Crypto';
    el.receiptAssetRow.hidden = !order.asset;
    el.receiptAsset.textContent = order.asset ? `${order.asset.ticker} · ${order.asset.network}` : '';
    const created = order.createdAt ? Date.parse(order.createdAt) : NaN;
    el.receiptCreatedRow.hidden = !Number.isFinite(created);
    el.receiptCreated.textContent = Number.isFinite(created)
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(created)) : '';
    const payment = order.payment;
    const hasCryptoDetails = order.method === 'crypto' && payment?.address && payment?.amount && order.asset;
    el.cryptoPayment.hidden = !hasCryptoDetails || order.complete;
    if (hasCryptoDetails) {
      const sendable = canSendPayment(order);
      el.paymentAmountLabel.textContent = sendable ? 'Send exactly' : 'Original requested amount';
      el.paymentAmount.textContent = payment.amount;
      el.paymentTicker.textContent = order.asset.ticker;
      el.paymentNetwork.textContent = order.asset.network;
      if (el.paymentAddress.value !== payment.address) el.paymentAddress.value = payment.address;
      el.paymentMemoWrap.hidden = payment.memo === null;
      if (el.paymentMemo.value !== (payment.memo ?? '')) el.paymentMemo.value = payment.memo ?? '';
      const showQr = sendable && safeQr(payment.qrDataUrl);
      el.paymentQrWrap.hidden = !showQr;
      if (showQr && el.paymentQr.getAttribute('src') !== payment.qrDataUrl) el.paymentQr.src = payment.qrDataUrl;
      if (!showQr) el.paymentQr.removeAttribute('src');
      el.cryptoPayment.querySelectorAll('[data-copy]').forEach((button) => { button.disabled = !sendable; });
      el.networkCaution.textContent = sendable
        ? `Send only ${order.asset.ticker} on ${order.asset.network}. A different coin or network may result in lost funds.`
        : order.status === 'partially_paid'
          ? 'This is the original requested amount, not the amount remaining. Contact the merchant before sending any more funds.'
          : 'These details are for your reference. Don’t send another payment without checking the latest status with the merchant.';
      updateExpiry();
    } else {
      el.paymentQrWrap.hidden = true;
      el.paymentQr.removeAttribute('src');
      el.paymentExpiry.hidden = true;
    }
    el.cardPayment.hidden = order.method !== 'card' || order.complete;
    const checkoutUrl = safeCheckoutUrl(order.checkoutUrl);
    const showCheckoutLink = order.method === 'card' && canSendPayment(order) && checkoutUrl;
    el.externalCheckout.hidden = !showCheckoutLink;
    if (showCheckoutLink) {
      el.externalCheckout.href = checkoutUrl.href;
      el.cardDestinationNote.textContent = `Opens ${checkoutUrl.hostname} in a new tab. Keep this page open to follow your payment.`;
    } else {
      el.externalCheckout.removeAttribute('href');
      el.cardDestinationNote.textContent = order.terminal || !AWAITING_PAYMENT.has(order.status)
        ? 'Keep your order reference and check the latest status before making any other payment.'
        : 'The provider’s checkout link is being prepared. Check the status again shortly.';
    }
    el.missingPaymentActions.hidden = !state.lookupMissing;
    renderResume();
    renderContinue();
    renderStatusButton();
    if (el.paymentDialog.open) fitReadonlyFields(el.paymentDialog);
  }

  function showOrderLoading() {
    el.paymentStatusLabel.textContent = 'Checking status';
    el.paymentTitle.textContent = 'Finding your payment';
    el.paymentDescription.textContent = 'Retrieving the latest payment details. A return from checkout does not, by itself, confirm a payment.';
    el.paymentStatusIcon.dataset.tone = 'pending';
    el.paymentStatusGlyph.className = 'icon icon-arrow-clockwise';
    el.cryptoPayment.hidden = true;
    el.cardPayment.hidden = true;
    el.paymentReceipt.hidden = true;
    el.copyOrderButton.disabled = true;
    el.providerMessage.hidden = true;
    el.copyFallback.hidden = true;
    el.copyFeedback.textContent = '';
    el.paymentQr.removeAttribute('src');
    el.externalCheckout.removeAttribute('href');
    el.returnNote.textContent = state.returnMessage;
    el.returnNote.hidden = !state.returnMessage;
    el.missingPaymentActions.hidden = true;
    el.storageNote.hidden = !state.storageFailed;
  }

  function readSavedPayment() {
    try {
      // Discard the old receipt cache; browser-stored receipt amounts are never read.
      localStorage.removeItem('pay_page.lastOrder');
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (validToken(saved?.token) && Number.isFinite(saved.timestamp) && saved.timestamp > 0) {
        return { token: saved.token, timestamp: saved.timestamp };
      }
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* Storage can be blocked. Checkout still works within this tab. */ }
    return null;
  }

  function rememberPayment(token) {
    const timestamp = state.saved?.token === token ? state.saved.timestamp : Date.now();
    state.saved = { token, timestamp };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, timestamp }));
      state.storageFailed = false;
    } catch { state.storageFailed = true; }
    el.storageNote.hidden = !state.storageFailed;
  }

  function renderResume() {
    const exists = Boolean(state.saved?.token || state.token);
    el.resumeNotice.hidden = !exists;
    if (!exists) return;
    const order = state.order;
    el.resumeTitle.textContent = order ? statusPresentation(order).title : 'Your previous payment';
    el.resumeDescription.textContent = order?.complete ? 'Your receipt is available to review.'
      : settledOrder(order) ? 'Review the provider’s latest status and order reference.'
        : 'Check this payment before starting another.';
  }

  function adoptOrder(order) {
    if (state.token !== order.token) {
      stopPollingRequest();
      state.token = order.token;
      state.pollDeadline = Date.now() + POLL_WINDOW;
      state.expiryCheckedFor = null;
    }
    state.order = order;
    renderHeading();
    if (settledOrder(order)) state.idempotencyKey = null;
    state.lookupMissing = false;
    state.pollStopped = order.terminal || order.complete;
    rememberPayment(order.token);
    renderOrder();
    el.statusCheckMessage.textContent = state.pollStopped
      ? 'Showing the latest status from the payment provider.'
      : 'Status updates automatically while this page is open.';
    if (state.pollStopped) window.clearTimeout(state.pollTimer);
  }

  function stopPollingRequest() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.pollGeneration += 1;
    state.pollController?.abort();
    state.pollController = null;
    state.pollBusy = false;
  }

  function renderStatusButton() {
    el.checkStatusButton.disabled = state.pollBusy || !state.token || isOffline();
    el.checkStatusButton.setAttribute('aria-busy', String(state.pollBusy));
    el.checkStatusLabel.textContent = state.pollBusy ? 'Checking…' : 'Check status';
  }

  function schedulePoll(delay = POLL_INTERVAL) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (!state.token || state.pollStopped || document.hidden || state.pollBusy) return;
    if (Date.now() >= state.pollDeadline) {
      state.pollStopped = true;
      el.statusCheckMessage.textContent = 'Automatic checks paused after 20 minutes. This does not mean the payment failed. Use Check status for the latest result.';
      return;
    }
    state.pollTimer = window.setTimeout(() => { void checkStatus(); }, Math.min(delay, Math.max(1, state.pollDeadline - Date.now())));
  }

  async function checkStatus(manual = false) {
    if (!state.token || state.pollBusy || document.hidden) return;
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (manual) {
      state.pollDeadline = Date.now() + POLL_WINDOW;
      state.pollStopped = false;
      state.pollErrors = 0;
    }
    if (!manual && (state.pollStopped || Date.now() >= state.pollDeadline)) {
      schedulePoll();
      return;
    }
    if (navigator.onLine === false) {
      el.statusCheckMessage.textContent = 'You’re offline. Status checks will resume when you reconnect. Don’t send another payment while the result is unknown.';
      state.pollErrors += 1;
      schedulePoll(Math.min(POLL_INTERVAL * (2 ** Math.min(state.pollErrors, 4)), 60000));
      return;
    }
    const token = state.token;
    const generation = state.pollGeneration;
    const controller = new AbortController();
    state.pollController = controller;
    state.pollBusy = true;
    renderStatusButton();
    if (manual || !state.order) el.statusCheckMessage.textContent = 'Checking the provider’s latest status…';
    let delay = POLL_INTERVAL;
    try {
      const data = await request(`/api/status?${new URLSearchParams({ token })}`, { signal: controller.signal });
      if (generation !== state.pollGeneration || token !== state.token) return;
      const order = normalizeOrder(data, token);
      state.pollErrors = 0;
      adoptOrder(order);
      if (manual) announce(`Status checked. ${statusPresentation(order).label}.`);
      if (el.paymentDialog.open) startExpiryClock();
    } catch (error) {
      if (generation !== state.pollGeneration || error.name === 'AbortError') return;
      state.pollErrors += 1;
      delay = Math.min(POLL_INTERVAL * (2 ** Math.min(state.pollErrors, 4)), 60000);
      state.lookupMissing = error instanceof ApiError && [404, 410].includes(error.status);
      if (state.lookupMissing) {
        state.pollStopped = true;
        el.statusCheckMessage.textContent = 'This payment reference could not be retrieved. Contact the merchant if you sent funds or see a charge. Removing the saved link does not cancel a payment.';
      } else {
        el.statusCheckMessage.textContent = `The latest status couldn’t be retrieved. Retrying in ${Math.round(delay / 1000)} seconds. Don’t send another payment while the result is unknown.`;
      }
      if (!state.order) {
        el.paymentStatusLabel.textContent = 'Status unavailable';
        el.paymentTitle.textContent = state.lookupMissing ? 'Payment reference unavailable' : 'We couldn’t check your payment';
        el.paymentDescription.textContent = 'There is no verified result to show. Keep any order reference you have and contact the merchant if you need help.';
      }
      el.missingPaymentActions.hidden = !state.lookupMissing;
      renderResume();
    } finally {
      if (generation === state.pollGeneration) {
        state.pollBusy = false;
        state.pollController = null;
        renderStatusButton();
        renderContinue();
        schedulePoll(delay);
      }
    }
  }

  function refreshOnReturn() {
    if (!state.token || state.order?.complete || state.pollBusy || document.hidden || isOffline()) return;
    const now = Date.now();
    if (state.lastForegroundCheck && now - state.lastForegroundCheck < 5000) return;
    state.lastForegroundCheck = now;
    void checkStatus(true);
  }

  function resumePayment(token, open = true) {
    if (!validToken(token)) return;
    if (state.token !== token) {
      stopPollingRequest();
      state.order = null;
      state.token = token;
      state.lookupMissing = false;
      state.pollErrors = 0;
      state.pollStopped = false;
      state.pollDeadline = Date.now() + POLL_WINDOW;
      showOrderLoading();
    }
    renderResume();
    renderContinue();
    if (open) {
      if (state.order) renderOrder();
      openDialog(el.paymentDialog, el.paymentTitle);
      startExpiryClock();
    }
    void checkStatus(true);
  }

  function updateExpiry() {
    const expiry = expiryTime();
    const order = state.order;
    const show = expiry !== null && order?.method === 'crypto' && !order.complete;
    el.paymentExpiry.hidden = !show;
    if (!show) return;
    const seconds = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
    el.paymentExpiry.classList.toggle('is-expired', seconds === 0);
    if (!seconds) {
      el.paymentExpiryValue.textContent = 'Window ended. Check the latest status.';
      el.paymentQrWrap.hidden = true;
      el.paymentAmountLabel.textContent = 'Original requested amount';
      el.cryptoPayment.querySelectorAll('[data-copy]').forEach((button) => { button.disabled = true; });
      if (AWAITING_PAYMENT.has(order.status)) {
        el.networkCaution.textContent = 'The displayed payment window has ended. Don’t send funds until the provider or merchant confirms what to do next.';
      }
      const expiryKey = `${order.token}|${order.payment.expiresAt}`;
      if (state.expiryCheckedFor !== expiryKey && !state.pollBusy && !order.terminal) {
        state.expiryCheckedFor = expiryKey;
        // A clock is not an authoritative payment status. Ask the server instead.
        schedulePoll(1);
      }
      return;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = String(seconds % 60).padStart(2, '0');
    el.paymentExpiryValue.textContent = hours ? `${hours}h ${minutes}m remaining` : `${minutes}:${remainder} remaining`;
  }

  function startExpiryClock() {
    window.clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    if (!el.paymentDialog.open || document.hidden || expiryTime() === null || state.order?.complete) return;
    updateExpiry();
    if (expiryTime() > Date.now()) state.expiryTimer = window.setTimeout(startExpiryClock, 1000);
  }

  function announce(message) {
    el.announcer.textContent = '';
    window.setTimeout(() => { el.announcer.textContent = message; }, 30);
  }

  async function copyPayment(button) {
    if (button.disabled || !state.order) return;
    const field = button.dataset.copy;
    if (!['order', 'amount', 'address', 'memo'].includes(field)) return;
    const value = field === 'order' ? state.order.orderId
      : field === 'amount' ? state.order.payment?.amount
        : field === 'address' ? state.order.payment?.address : state.order.payment?.memo;
    if (value == null) return;
    const label = field === 'order' ? 'Order reference' : field === 'memo' ? 'Memo' : field === 'amount' ? 'Exact amount' : 'Address';
    el.copyFallback.hidden = true;
    el.copyFeedback.textContent = '';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
      await navigator.clipboard.writeText(value);
      el.copyFeedback.textContent = `${label} copied.`;
      const copyLabel = button.querySelector('.copy-label');
      if (copyLabel) {
        copyLabel.textContent = 'Copied';
        window.setTimeout(() => { copyLabel.textContent = 'Copy'; }, 1800);
      }
    } catch {
      el.copyFallback.hidden = false;
      el.copyFallbackValue.value = value;
      fitReadonlyFields(el.paymentDialog);
      el.copyFallbackValue.focus();
      el.copyFallbackValue.select();
      el.copyFeedback.textContent = 'Automatic copy isn’t available. Copy the selected text manually.';
    }
  }

  function fitReadonlyFields(container) {
    container.querySelectorAll('textarea[readonly]').forEach((field) => {
      if (!field.clientWidth || (field.dataset.fitWidth === String(field.clientWidth) && field.dataset.fitValue === field.value)) return;
      const style = getComputedStyle(field);
      const lineHeight = parseFloat(style.lineHeight) || 24;
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      field.rows = 1;
      field.rows = Math.min(20, Math.max(1, Math.ceil((field.scrollHeight - padding) / lineHeight)));
      field.dataset.fitWidth = String(field.clientWidth);
      field.dataset.fitValue = field.value;
    });
  }

  function openDialog(dialog, focusTarget) {
    if (!dialog.open) {
      dialog.showModal();
      dialog.scrollTop = 0;
    }
    focusTarget?.focus({ preventScroll: true });
    fitReadonlyFields(dialog);
  }

  function openHelp(privacy = false) {
    openDialog(privacy ? el.privacyDialog : el.helpDialog, privacy ? el.privacyTitle : el.helpTitle);
  }

  function configureTheme() {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark) => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      el.themeToggle.setAttribute('aria-pressed', String(dark));
      el.themeToggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
      el.themeIcon.className = `icon icon-${dark ? 'moon' : 'sun'}`;
      el.themeLabel.textContent = dark ? 'Dark' : 'Light';
      document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#111b1e' : '#f1f4f4');
    };
    apply(media.matches);
    media.addEventListener('change', (event) => { if (!state.manualTheme) apply(event.matches); });
    el.themeToggle.addEventListener('click', () => {
      state.manualTheme = true;
      apply(document.documentElement.dataset.theme !== 'dark');
    });
  }

  function consumeReturnLink() {
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    const hashToken = hash.get('checkout');
    const returned = ['success', 'cancel'].includes(url.searchParams.get('return'));
    const token = validToken(hashToken) ? hashToken : state.saved?.token;
    if (returned) {
      state.returnMessage = url.searchParams.get('return') === 'cancel'
        ? 'You returned from checkout. This does not confirm a cancellation; the provider’s status below is what matters.'
        : 'You’re back from checkout. We’ll verify the payment with the provider before showing a completed result.';
    }
    if (returned || hash.has('checkout')) {
      url.searchParams.delete('return');
      if (hash.has('checkout')) {
        hash.delete('checkout');
        url.hash = hash.toString();
      }
      try { history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* URL cleanup is not payment verification. */ }
      if (token) resumePayment(token, true);
      else showCheckoutError('There isn’t a payment reference to check in this browser. If you already paid, contact the merchant rather than starting another payment.');
    } else if (token) {
      resumePayment(token, false);
    }
  }

  function handleOffline() {
    // Cancel reads only. An in-flight checkout keeps its original retry identity.
    stopPollingRequest();
    window.clearTimeout(state.expiryTimer);
    invalidateQuote();
    renderContinue();
    renderStatusButton();
    if (state.token) el.statusCheckMessage.textContent = 'You’re offline. Reconnect to check the latest payment status.';
  }

  function handleOnline() {
    if (isOffline()) return;
    renderContinue();
    renderStatusButton();
    if (state.configPhase !== 'ready' || state.sessionExpired) {
      void loadConfig();
    } else if (state.config?.configured && state.method === 'crypto' && state.assetsPhase !== 'ready') {
      void loadAssets();
    } else if (state.quotePhase === 'error' || state.quotePhase === 'empty') {
      queueQuote(0);
    }
    startExpiryClock();
    refreshOnReturn();
    // Reconnecting never submits or retries POST /api/checkout.
  }

  function wireEvents() {
    el.paymentForm.addEventListener('submit', checkout);
    el.amountInput.addEventListener('input', () => {
      if (state.amountTouched) renderAmount();
      paymentDetailsChanged();
    });
    el.amountInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && window.matchMedia('(pointer: coarse)').matches) {
        event.preventDefault();
        el.amountInput.blur();
      }
    });
    el.amountInput.addEventListener('blur', () => {
      state.amountTouched = true;
      const validation = amountValidation();
      if (validation.value) el.amountInput.value = validation.value;
      renderAmount();
      renderContinue();
    });
    el.quickAmounts.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-amount]');
      if (!button || button.disabled || state.checkoutBusy || state.recoveryRequest) return;
      const decimals = currencyMeta()?.decimals;
      el.amountInput.value = decimals === undefined ? button.dataset.amount : canonicalDecimal(button.dataset.amount, decimals);
      state.amountTouched = true;
      paymentDetailsChanged();
    });
    el.currencySelect.addEventListener('change', () => {
      state.currency = el.currencySelect.value;
      paymentDetailsChanged();
    });
    [el.methodCrypto, el.methodCard].forEach((input) => input.addEventListener('change', () => {
      if (!input.checked) return;
      state.method = input.value;
      paymentDetailsChanged();
    }));
    el.assetPicker.addEventListener('click', () => {
      el.assetSearch.value = '';
      renderAssetResults();
      const touch = window.matchMedia('(pointer: coarse)').matches;
      openDialog(el.assetDialog, touch ? el.assetDialogTitle : el.assetSearch);
    });
    el.assetSearch.addEventListener('input', renderAssetResults);
    el.assetResults.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-asset-code]');
      if (!button || !state.assets.some((asset) => asset.code === button.dataset.assetCode)) return;
      state.asset = button.dataset.assetCode;
      el.assetDialog.close();
      paymentDetailsChanged();
      const asset = selectedAsset();
      announce(`${asset.name} selected. Network: ${asset.network}.`);
    });
    el.retryAssets.addEventListener('click', () => { void loadAssets(); });
    el.retryConfig.addEventListener('click', () => { void loadConfig(); });
    el.retryEstimate.addEventListener('click', () => queueQuote(0));
    el.resumeButton.addEventListener('click', () => resumePayment(state.token || state.saved?.token));
    el.checkStatusButton.addEventListener('click', () => { void checkStatus(true); });
    el.helpButton.addEventListener('click', () => openHelp());
    el.privacyButton.addEventListener('click', () => openHelp(true));
    el.paymentHelpButton.addEventListener('click', () => openHelp());
    document.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => $(button.dataset.close).close());
    });
    document.querySelectorAll('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
    });
    el.paymentDialog.addEventListener('close', () => {
      window.clearTimeout(state.expiryTimer);
      el.copyFallback.hidden = true;
      el.copyFeedback.textContent = '';
      renderResume();
      // The payment remains active. Closing a dialog never calls a cancellation endpoint.
    });
    el.paymentDialog.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', () => { void copyPayment(button); });
    });
    el.paymentQr.addEventListener('error', () => {
      el.paymentQrWrap.hidden = true;
      el.paymentQr.removeAttribute('src');
    });
    el.externalCheckout.addEventListener('click', () => {
      el.statusCheckMessage.textContent = 'Finish in the provider’s tab, then return here to check the payment status.';
    });
    el.forgetPaymentButton.addEventListener('click', () => {
      if (!state.lookupMissing) return;
      stopPollingRequest();
      state.token = null;
      state.order = null;
      state.saved = null;
      state.lookupMissing = false;
      state.pollStopped = true;
      state.idempotencyKey = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Current tab can still forget the token. */ }
      el.paymentDialog.close();
      renderResume();
      renderContinue();
      showCheckoutError('The saved link was removed from this tab. This did not cancel a payment. Contact the merchant if you already sent funds.');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPollingRequest();
        window.clearTimeout(state.expiryTimer);
        invalidateQuote();
        renderContinue();
      } else {
        queueQuote(0);
        startExpiryClock();
        refreshOnReturn();
        renderStatusButton();
      }
    });
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('pagehide', () => {
      stopPollingRequest();
      window.clearTimeout(state.expiryTimer);
      invalidateQuote();
    });
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      renderContinue();
      queueQuote(0);
      startExpiryClock();
      refreshOnReturn();
    });
    window.addEventListener('resize', () => {
      if (el.paymentDialog.open) fitReadonlyFields(el.paymentDialog);
    });
  }

  function boot() {
    configureTheme();
    wireEvents();
    state.saved = readSavedPayment();
    restoreAttempt();
    const entryUrl = new URL(window.location.href);
    state.presetSearch = entryUrl.search;
    state.presetReturning = entryUrl.searchParams.has('return') || new URLSearchParams(entryUrl.hash.slice(1)).has('checkout');
    if (!state.saved?.token && !state.recoveryRequest && !state.unreadableAttempt && !state.presetReturning
      && (entryUrl.searchParams.has('amount') || entryUrl.searchParams.has('currency') || entryUrl.searchParams.has('for'))) el.amountInput.value = '';
    renderResume();
    renderAmount();
    renderMethod();
    renderQuote();
    renderContinue();
    consumeReturnLink();
    void loadConfig();
  }

  boot();
})();
