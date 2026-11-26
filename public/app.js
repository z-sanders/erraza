(() => {
  'use strict';

  const STORAGE_KEY = 'pay_page.resume.v1';
  const ATTEMPT_KEY = 'pay_page.pending-attempt.v1';
  const DISMISS_KEY = 'pay_page.dismissed.v1';
  const PREVIOUS_KEY = 'pay_page.released.v1';
  const GUIDE_KEY = 'pay_page.card-guide.v1';
  const GUIDE_MAX_AGE = 24 * 60 * 60 * 1000;
  const GUIDE_QUOTE_AGE = 2 * 60 * 1000;
  const GUIDE_PROVIDER_URL = 'https://www.moonpay.com/buy';
  const POLL_INTERVAL = 6000;
  const POLL_WINDOW = 20 * 60 * 1000;
  // 'rejected' means the provider never created a checkout, so no funds could have moved.
  const FINAL_PROBLEMS = new Set(['failed', 'expired', 'refunded', 'canceled', 'cancelled', 'cancel', 'rejected']);
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
    'resumeButton', 'dismissNoticeButton', 'presetNotice', 'presetNoticeTitle', 'presetNoticeText', 'applyPresetButton', 'assetDialog', 'assetDialogTitle', 'assetSearch', 'assetResults', 'assetResultsCount', 'assetEmpty',
    'paymentDialog', 'paymentStatusIcon', 'paymentStatusGlyph', 'paymentStatusLabel', 'paymentTitle',
    'paymentDescription', 'returnNote', 'providerMessage', 'cryptoPayment', 'paymentAmountLabel', 'paymentAmount',
    'paymentTicker', 'paymentNetwork', 'paymentQrWrap', 'paymentQr', 'paymentAddress', 'paymentMemoWrap', 'paymentMemo',
    'networkCaution', 'paymentExpiry', 'paymentExpiryValue', 'cardPayment', 'externalCheckout', 'cardDestinationNote',
    'paymentReceipt', 'receiptOrder', 'copyOrderButton', 'receiptAmount', 'receiptMerchant', 'receiptReferenceRow', 'receiptReference', 'receiptMethod', 'receiptAssetRow', 'receiptAsset',
    'receiptExpectedRow', 'receiptExpected', 'receiptReceivedRow', 'receiptReceived', 'receiptShortfallRow', 'receiptShortfall',
    'receiptField', 'payerEmailInput', 'receiptConsent', 'payerEmailError',
    'receiptCreatedRow', 'receiptCreated', 'copyFallback', 'copyFallbackValue', 'copyFeedback', 'statusCheckMessage',
    'checkStatusButton', 'checkStatusLabel', 'storageNote', 'missingPaymentActions', 'forgetPaymentButton',
    'stalePaymentActions', 'dismissPaymentButton', 'statusGuideSection', 'statusGuideButton',
    'dismissConfirmWrap', 'dismissConfirm', 'dismissPaymentNote', 'dismissPaymentError', 'previousPaymentNotice', 'previousPaymentButton',
    'paymentHelpButton', 'helpDialog', 'helpTitle', 'privacyDialog', 'privacyTitle', 'supportEmail', 'announcer',
    'cryptoGuideButton', 'fiatGuideButton', 'helpGuideButton', 'helpGuideBlocked', 'cardRecovery', 'rejectedCardGuideButton',
    'cardGuideNotice', 'cardGuideNoticeText', 'resumeGuideButton', 'cancelGuideButton', 'cardGuideDialog', 'cardGuideTitle',
    'cardGuideDescription', 'cardGuideStepLabel', 'cardGuideStep1', 'cardGuideStep2', 'cardGuideStep3', 'cardGuideAmount',
    'cardGuideReferenceRow', 'cardGuideReference', 'cardGuideSource', 'cardGuideStatus', 'cardGuideStorageNote',
    'cardGuideChargeWarning', 'cardGuideNoCharge', 'cardGuidePrepare', 'cardGuideChooseAsset', 'cardGuideAssetChoice',
    'cardGuideMemoWarning', 'cardGuideWalletReady', 'cardGuideBuy', 'cardGuideEstimate', 'cardGuideRefreshQuote',
    'cardGuideNetworkConfirm', 'cardGuideNetworkLabel', 'cardGuideProvider', 'cardGuideReturn', 'cardGuideFundsReady',
    'cardGuideBack', 'cardGuideNext', 'cardGuideFinish', 'cardGuideCancel',
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
    payerEmail: '',
    receiptConsent: false,
    receiptsAvailable: false,
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
    previousPayment: null,
    viewingHistory: false,
    abandonBusy: false,
    confirmedToken: null,
    token: null,
    order: null,
    paymentDetailsStale: false,
    storageFailed: false,
    lookupMissing: false,
    unverifiableChecks: 0,
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
    presetPending: null,
    guide: null,
    guideQuote: null,
    guideMessage: '',
    guideBusy: false,
    guideGeneration: 0,
    guideController: null,
    guideChoosingAsset: false,
    guideStorageFailed: false,
    guidePaymentChanged: false,
    rejectedRetryApproved: false,
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
        const error = new ApiError(message, response.status);
        if (response.status === 409 && data?.error === 'payment_in_progress' && validToken(data.activeToken)) {
          error.activeToken = data.activeToken;
        }
        throw error;
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

  // Exact decimal subtraction for display amounts; returns null when an input
  // is not a plain decimal. Never used for payment validation.
  function subtractDecimals(a, b) {
    const left = decimalParts(a);
    const right = decimalParts(b);
    if (!left || !right) return null;
    const precision = Math.max(left.fraction.length, right.fraction.length);
    const scaled = (parts) => BigInt(parts.integer + parts.fraction.padEnd(precision, '0'));
    const diff = scaled(left) - scaled(right);
    const digits = (diff < 0n ? -diff : diff).toString().padStart(precision + 1, '0');
    const text = precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits;
    return diff < 0n ? `-${text}` : text;
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
      button.textContent = formatMoney(value, currency?.code || '', false);
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

  function guideContext() {
    const order = state.order;
    if (validGuideCardSource(order)) {
      return {
        amount: order.amount,
        currency: order.currency,
        reference: order.reference || '',
        asset: '',
        step: 1,
        source: { kind: 'terminal_card', orderId: order.orderId },
      };
    }
    if (state.order || state.token || state.saved?.token) return null;
    return {
      amount: amountValidation().value,
      currency: state.currency,
      reference: state.reference,
      asset: state.asset,
      step: 1,
      source: { kind: 'form' },
    };
  }

  function guideBlockReason(draft = state.guide || guideContext()) {
    if (isOffline()) return 'Reconnect before using the buying guide.';
    if (!paymentsReady()) return 'Payment availability must be loaded before using the buying guide.';
    if (state.checkoutBusy || state.recoveryRequest || state.unreadableAttempt) return 'Recover the earlier checkout before starting another payment.';
    if (state.pollBusy || state.lookupMissing) return 'Finish checking the original payment before using another payment method.';
    if (state.guidePaymentChanged) return 'A payment changed in another tab. Check its status before continuing.';
    if (!draft) return state.order || state.token || state.saved?.token
      ? 'Review your earlier payment first — choose “Return to payment”. Once it’s complete or over a day old, you can dismiss it and start a new payment.'
      : 'Enter a valid amount before opening the buying guide.';
    if (!decimalParts(draft.amount) || compareDecimals(draft.amount, '0') !== 1
      || !state.config.currencies.some((item) => item.code === draft.currency)) {
      return 'Enter a valid amount and currency before opening the buying guide.';
    }
    if (draft.source?.kind === 'terminal_card') {
      const order = state.order;
      if (!order || order.orderId !== draft.source.orderId || !validGuideCardSource(order)) {
        return 'Check the original card attempt before using another payment method.';
      }
    } else if (draft.source?.kind !== 'form' || state.order || state.token || state.saved?.token) {
      return 'Review your earlier payment first — choose “Return to payment”. Once it’s complete or over a day old, you can dismiss it and start a new payment.';
    }
    if (state.assetsPhase !== 'ready' || !state.assets.length) return 'Supported coin and network options must be loaded first.';
    return '';
  }

  function guideAsset(draft = state.guide) {
    return draft ? state.assets.find((item) => item.code === draft.asset) || null : null;
  }

  function guideQuoteKey(draft = state.guide) {
    return draft?.amount && draft.currency && draft.asset
      ? JSON.stringify([draft.amount, draft.currency, draft.asset]) : null;
  }

  function guideQuoteFresh() {
    return Boolean(state.guideQuote && state.guideQuote.key === guideQuoteKey()
      && Number.isFinite(state.guideQuote.timestamp) && Date.now() - state.guideQuote.timestamp <= GUIDE_QUOTE_AGE);
  }

  function saveGuide() {
    if (!state.guide) return;
    const draft = {
      version: 1,
      amount: state.guide.amount,
      currency: state.guide.currency,
      reference: state.guide.reference,
      asset: state.guide.asset,
      step: state.guide.step,
      source: state.guide.source,
      timestamp: Date.now(),
    };
    try {
      sessionStorage.setItem(GUIDE_KEY, JSON.stringify(draft));
      state.guideStorageFailed = false;
    } catch { state.guideStorageFailed = true; }
  }

  function clearGuideStorage() {
    try { sessionStorage.removeItem(GUIDE_KEY); } catch { /* The in-memory guide can still be cleared. */ }
  }

  function restoreGuide() {
    let raw;
    try { raw = sessionStorage.getItem(GUIDE_KEY); }
    catch { state.guideStorageFailed = true; return; }
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      const reference = window.PaymentLinks.reference(draft?.reference);
      const sourceValid = draft?.source?.kind === 'form'
        || (draft?.source?.kind === 'terminal_card' && validText(draft.source.orderId, 300));
      if (draft?.version !== 1 || !Number.isFinite(draft.timestamp) || Date.now() - draft.timestamp > GUIDE_MAX_AGE
        || !decimalParts(draft.amount) || compareDecimals(draft.amount, '0') !== 1
        || !validText(draft.currency, 24) || (draft.asset && !validText(draft.asset, 100))
        || !Number.isInteger(draft.step) || draft.step < 1 || draft.step > 3 || !sourceValid) {
        throw new Error('Invalid guide');
      }
      state.guide = {
        amount: draft.amount,
        currency: draft.currency,
        reference,
        asset: draft.asset || '',
        step: 1,
        source: draft.source,
        noCharge: false,
        walletReady: false,
        networkConfirmed: false,
        fundsReady: false,
      };
      state.guideMessage = 'Your buying guide is ready to resume. Review each confirmation again before continuing.';
    } catch {
      clearGuideStorage();
      state.guide = null;
      state.guideMessage = 'The saved buying guide could not be restored. No payment was created.';
    }
  }

  function renderGuideEntries() {
    const candidate = state.guide || guideContext();
    const blocked = guideBlockReason(candidate);
    const guideReady = Boolean(candidate && !blocked && !state.rejectedRetryApproved);
    el.cryptoGuideButton.hidden = state.method !== 'crypto' || Boolean(state.guide) || !guideReady;
    const fiatUnavailable = state.method === 'card' && state.configPhase === 'ready'
      && (!state.config?.fiatEnabled || !cardAvailable());
    el.fiatGuideButton.hidden = !fiatUnavailable || Boolean(state.guide) || !guideReady;
    el.helpGuideButton.disabled = !guideReady;
    el.helpGuideButton.setAttribute('aria-disabled', String(!guideReady));
    el.helpGuideBlocked.hidden = !blocked;
    el.helpGuideBlocked.textContent = blocked;
    if (el.rejectedCardGuideButton) el.rejectedCardGuideButton.disabled = !guideReady;
    el.statusGuideButton.disabled = !guideReady;
    el.statusGuideButton.setAttribute('aria-disabled', String(!guideReady));

    const showNotice = Boolean(state.guide || state.guideMessage);
    el.cardGuideNotice.hidden = !showNotice;
    if (showNotice) {
      el.cardGuideNoticeText.textContent = state.guideMessage || 'Buy into your own wallet, then return here to prepare a fresh crypto payment.';
      el.resumeGuideButton.hidden = !state.guide;
      el.cancelGuideButton.textContent = state.guide ? 'Use regular checkout' : 'Dismiss';
    }
  }

  function guideConfirmationsReady(draft = state.guide) {
    return Boolean(draft && guideAsset(draft) && draft.walletReady && draft.networkConfirmed && draft.fundsReady
      && (draft.source.kind !== 'terminal_card' || draft.noCharge));
  }

  function renderGuide() {
    renderGuideEntries();
    const draft = state.guide;
    if (!draft) return;
    const asset = guideAsset(draft);
    const blocked = guideBlockReason(draft);
    const step = draft.step;
    const quoteFresh = guideQuoteFresh();
    el.cardGuideStepLabel.textContent = step === 1 ? 'Phase 1 of 2 · Choose crypto'
      : step === 2 ? 'Phase 1 of 2 · Get crypto' : 'Phase 2 of 2 · Pay Erraza';
    for (const [index, marker] of [[1, el.cardGuideStep1], [2, el.cardGuideStep2], [3, el.cardGuideStep3]]) {
      if (index === step) marker.setAttribute('aria-current', 'step');
      else marker.removeAttribute('aria-current');
    }
    el.cardGuidePrepare.hidden = step !== 1;
    el.cardGuideBuy.hidden = step !== 2;
    el.cardGuideReturn.hidden = step !== 3;
    el.cardGuideAmount.textContent = formatMoney(draft.amount, draft.currency);
    el.cardGuideReferenceRow.hidden = !draft.reference;
    el.cardGuideReference.textContent = draft.reference;
    el.cardGuideSource.hidden = draft.source.kind !== 'terminal_card';
    el.cardGuideSource.textContent = draft.source.kind === 'terminal_card' ? `Original card order: ${draft.source.orderId}` : '';
    el.cardGuideChargeWarning.hidden = draft.source.kind !== 'terminal_card';
    el.cardGuideNoCharge.checked = Boolean(draft.noCharge);
    el.cardGuideWalletReady.checked = Boolean(draft.walletReady);
    el.cardGuideNetworkConfirm.checked = Boolean(draft.networkConfirmed);
    el.cardGuideFundsReady.checked = Boolean(draft.fundsReady);
    el.cardGuideAssetChoice.textContent = asset ? `${asset.name} (${asset.ticker}) · ${asset.network}` : 'Choose a coin and network';
    el.cardGuideChooseAsset.disabled = state.guideBusy || Boolean(blocked) || state.assetsPhase !== 'ready';
    el.cardGuideMemoWarning.hidden = !asset?.extraIdRequired;
    el.cardGuideNetworkLabel.textContent = asset
      ? `${asset.ticker} on ${asset.network}`
      : 'the exact selected coin and network';
    el.cardGuideEstimate.textContent = state.guideBusy ? 'Refreshing the estimate…'
      : quoteFresh ? `About ${state.guideQuote.estimatedAmount} ${asset?.ticker || ''}, before purchase, withdrawal and network fees.`
        : asset ? 'Refresh the estimate before continuing.' : 'Choose a coin and network first.';
    el.cardGuideRefreshQuote.hidden = !asset;
    el.cardGuideRefreshQuote.disabled = state.guideBusy || Boolean(blocked) || !asset;
    const providerReady = step === 2 && quoteFresh && draft.networkConfirmed && !blocked;
    if (providerReady) el.cardGuideProvider.setAttribute('href', GUIDE_PROVIDER_URL);
    else el.cardGuideProvider.removeAttribute('href');
    el.cardGuideProvider.setAttribute('aria-disabled', String(!providerReady));
    el.cardGuideBack.hidden = step === 1;
    el.cardGuideBack.disabled = state.guideBusy;
    el.cardGuideNext.hidden = step === 3;
    el.cardGuideNext.textContent = step === 1 ? 'Next: Get crypto' : 'I’ll use another service';
    el.cardGuideNext.disabled = state.guideBusy || Boolean(blocked) || (step === 1
      ? !asset || !quoteFresh || !draft.walletReady || (draft.source.kind === 'terminal_card' && !draft.noCharge)
      : !draft.networkConfirmed);
    el.cardGuideFinish.hidden = step !== 3;
    el.cardGuideFinish.disabled = state.guideBusy || Boolean(blocked) || !guideConfirmationsReady(draft);
    el.cardGuideStorageNote.hidden = !state.guideStorageFailed;
    el.cardGuideStatus.textContent = blocked || state.guideMessage || (step === 1
      ? 'Choose the exact network your wallet can receive and send.'
      : step === 2 ? 'The external purchase only funds your wallet. It does not pay Erraza.'
        : 'Return to Erraza, then use Continue to create the crypto payment request.');
  }

  async function refreshGuideQuote() {
    const draft = state.guide;
    const asset = guideAsset(draft);
    const blocked = guideBlockReason(draft);
    if (!draft || !asset || blocked || state.guideBusy) { renderGuide(); return; }
    state.guideController?.abort();
    const controller = new AbortController();
    state.guideController = controller;
    const generation = ++state.guideGeneration;
    state.guideBusy = true;
    state.guideMessage = '';
    renderGuide();
    try {
      const params = new URLSearchParams({ amount: draft.amount, fiat: draft.currency, coin: draft.asset });
      const quote = normalizeQuote(await request(`/api/estimate?${params}`, { signal: controller.signal }), draft.amount, draft.currency, draft.asset);
      if (generation !== state.guideGeneration || draft !== state.guide) return;
      state.guideQuote = { ...quote, key: guideQuoteKey(draft), timestamp: Date.now() };
      state.guideMessage = 'Estimate refreshed. The buy service’s final total and fees may differ.';
    } catch (error) {
      if (generation !== state.guideGeneration || error.name === 'AbortError') return;
      state.guideQuote = null;
      state.guideMessage = error instanceof ApiError || error.message?.startsWith('The ')
        ? error.message : 'The estimate could not be refreshed. Try again before continuing.';
    } finally {
      if (generation === state.guideGeneration) {
        state.guideBusy = false;
        state.guideController = null;
        renderGuide();
        saveGuide();
      }
    }
  }

  function openGuide() {
    let draft = state.guide;
    if (!draft) {
      const candidate = guideContext();
      const blocked = guideBlockReason(candidate);
      if (!candidate || blocked) {
        state.guideMessage = blocked || 'The buying guide is not available for these payment details.';
        renderGuideEntries();
        announce(state.guideMessage);
        return;
      }
      draft = {
        ...candidate,
        noCharge: false,
        walletReady: false,
        networkConfirmed: false,
        fundsReady: false,
      };
      state.guide = draft;
      state.guideQuote = null;
      state.guideMessage = '';
      state.guidePaymentChanged = false;
      saveGuide();
    }
    if (el.paymentDialog.open) el.paymentDialog.close();
    if (el.helpDialog.open) el.helpDialog.close();
    renderGuide();
    openDialog(el.cardGuideDialog, el.cardGuideTitle);
    if (guideAsset() && !guideQuoteFresh()) void refreshGuideQuote();
  }

  function leaveGuide(message = '') {
    state.guideController?.abort();
    state.guideGeneration += 1;
    state.guideController = null;
    state.guideBusy = false;
    const handoffApproved = state.rejectedRetryApproved && Boolean(message);
    state.guide = null;
    state.guideQuote = null;
    state.guidePaymentChanged = false;
    state.rejectedRetryApproved = handoffApproved;
    state.guideMessage = message;
    clearGuideStorage();
    if (el.cardGuideDialog.open) el.cardGuideDialog.close();
    renderGuideEntries();
    renderContinue();
  }

  function resumeGuideAfterAssetPicker() {
    if (!state.guideChoosingAsset) return;
    state.guideChoosingAsset = false;
    if (!state.guide) return;
    renderGuide();
    openDialog(el.cardGuideDialog, el.cardGuideTitle);
  }

  function openGuideAssetPicker() {
    if (!state.guide || state.guideBusy || guideBlockReason()) return;
    state.guideChoosingAsset = true;
    if (el.cardGuideDialog.open) el.cardGuideDialog.close();
    el.assetSearch.value = '';
    renderAssetResults();
    const touch = window.matchMedia('(pointer: coarse)').matches;
    openDialog(el.assetDialog, touch ? el.assetDialogTitle : el.assetSearch);
  }

  function nextGuideStep() {
    const draft = state.guide;
    if (!draft || guideBlockReason(draft) || state.guideBusy) { renderGuide(); return; }
    if (draft.step === 1) {
      if (!guideAsset() || !draft.walletReady || (draft.source.kind === 'terminal_card' && !draft.noCharge)) {
        state.guideMessage = 'Complete the wallet and earlier-charge checks before continuing.';
        renderGuide();
        return;
      }
      if (!guideQuoteFresh()) { void refreshGuideQuote(); return; }
      draft.step = 2;
      state.guideMessage = 'Buy this exact coin and network into your own wallet. The purchase does not pay Erraza.';
    } else if (draft.step === 2) {
      if (!draft.networkConfirmed) {
        state.guideMessage = 'Confirm that the buy service supports the exact coin and network.';
        renderGuide();
        return;
      }
      draft.step = 3;
      state.guideMessage = 'When the crypto arrives in your wallet, confirm it below and return to Erraza crypto checkout.';
    }
    saveGuide();
    renderGuide();
    el.cardGuideDialog.scrollTop = 0;
    el.cardGuideTitle.focus({ preventScroll: true });
  }

  function previousGuideStep() {
    if (!state.guide || state.guideBusy || state.guide.step <= 1) return;
    state.guide.step -= 1;
    state.guideMessage = '';
    saveGuide();
    renderGuide();
    el.cardGuideDialog.scrollTop = 0;
  }

  async function finishGuide() {
    const draft = state.guide;
    if (!draft || draft.step !== 3 || !guideConfirmationsReady(draft) || state.guideBusy) return;
    state.guideBusy = true;
    state.guideMessage = 'Refreshing payment availability…';
    renderGuide();
    try {
      if (draft.source.kind === 'terminal_card') {
        if (!state.token) throw new Error('The original card payment reference is unavailable. Check it before continuing.');
        const checked = await checkStatus(true);
        if (!checked) throw new Error('The original payment status could not be refreshed. Check it before continuing.');
        const order = state.order;
        if (!order || order.orderId !== draft.source.orderId || !validGuideCardSource(order)) {
          throw new Error('The original payment status changed. Check it before making another payment.');
        }
      }
      const blocked = guideBlockReason(draft);
      if (blocked) throw new Error(blocked);
      if (!guideConfirmationsReady(draft)) throw new Error('Review the wallet, network, funds, and earlier-card checks before continuing.');
      await loadAssets();
      if (!state.assets.some((item) => item.code === draft.asset)) throw new Error('That coin and network is no longer available. Choose another before paying.');
      if (!guideConfirmationsReady(draft)) throw new Error('Review the wallet, network, funds, and earlier-card checks before continuing.');
      state.currency = draft.currency;
      state.reference = draft.reference;
      state.method = 'crypto';
      state.asset = draft.asset;
      // Only a terminal-problem card payment can be linked server-side as a fallback
      // source. Stale unverified payments hand off as a fresh crypto payment instead.
      state.rejectedRetryApproved = draft.source.kind === 'terminal_card' && state.order
        && state.order.orderId === draft.source.orderId
        && state.order.terminal && ['failed', 'expired', 'refunded'].includes(state.order.status);
      state.idempotencyKey = null;
      state.presetEdited = true;
      el.amountInput.value = draft.amount;
      el.currencySelect.value = draft.currency;
      el.methodCrypto.checked = true;
      el.methodCard.checked = false;
      const handoffMessage = 'Crypto is selected. Review the refreshed estimate, then use Continue to create a fresh payment request.';
      leaveGuide(handoffMessage);
      renderAmount();
      renderMethod();
      renderAssetPicker();
      queueQuote(0);
      announce(handoffMessage);
    } catch (error) {
      state.guideMessage = error.message || 'Payment availability could not be refreshed.';
      state.guideBusy = false;
      renderGuide();
    }
  }

  function cardAvailable() {
    return state.config?.fiatEnabled === true && state.config.fiatCurrencies.includes(state.currency);
  }

  function settledOrder(order) {
    if (!order) return false;
    // A rejected checkout never created a payment, so it settles without a provider verdict.
    if (order.status === 'rejected') return true;
    return order.complete === true || (order.terminal === true && FINAL_PROBLEMS.has(order.status));
  }

  // A crypto deposit and its expected amount must be denominated in the same coin.
  function partialAmounts(order) {
    const crypto = order.method === 'crypto';
    if (crypto && (!order.asset || order.payment?.currency !== order.asset.code)) return {};
    const currency = crypto ? order.asset.ticker : order.currency;
    const price = crypto ? order.payment?.amount : order.amount;
    const paid = order.actuallyPaid;
    const expected = compareDecimals(price, '0') === 1 ? formatMoney(price, currency) : '';
    const received = decimalParts(paid) ? formatMoney(paid, currency) : '';
    const shortfall = expected && compareDecimals(paid, '0') === 1 && compareDecimals(paid, price) === -1
      ? formatMoney(subtractDecimals(price, paid), currency) : '';
    return { expected, received, shortfall };
  }

  // Card orders the buying guide may treat as a dead end: a terminal problem, a
  // rejected checkout, or an unverified card checkout that never surfaced a
  // provider link (so no charge was possible). The guide's "no charge"
  // confirmation stays mandatory for all of them.
  const STALE_GUIDE_STATUSES = ['review', 'under_review', 'unknown', 'uncertain'];

  function validGuideCardSource(order) {
    if (order?.method !== 'card' || order.complete) return false;
    if (order.terminal && ['failed', 'expired', 'refunded'].includes(order.status)) return true;
    if (order.status === 'rejected') return true;
    return STALE_GUIDE_STATUSES.includes(order.status);
  }

  function activePaymentToken() {
    return state.saved?.token || (!state.viewingHistory ? state.token : null);
  }

  function needsDismissConfirmation(order) {
    return Boolean(order?.canAbandon && !order.abandonedAt && !order.complete);
  }

  function canDismissOrder(order) {
    return Boolean(order && !order.abandonedAt && !order.complete && (needsDismissConfirmation(order) || settledOrder(order)));
  }

  function canDismissSaved() {
    return Boolean(state.order?.token === activePaymentToken() && canDismissOrder(state.order));
  }

  function dismissedTokens() {
    try {
      const list = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
      return Array.isArray(list) ? list.filter(validToken).slice(-10) : [];
    } catch { return []; }
  }

  function rememberDismissedToken(token) {
    try {
      const list = dismissedTokens().filter((item) => item !== token);
      list.push(token);
      localStorage.setItem(DISMISS_KEY, JSON.stringify(list.slice(-10)));
    } catch { /* A dismissed token that can't be stored may reappear; payment data is unaffected. */ }
  }

  // The saved reference is unusable: the order is gone, or the provider keeps
  // rejecting the reference itself (e.g. after a signing-secret rotation).
  function referenceUnresolvable() {
    return state.lookupMissing || state.unverifiableChecks >= 3;
  }

  function clearLocalPayment(token) {
    const active = activePaymentToken() === token;
    const displayed = state.token === token && !state.viewingHistory;
    if (!token || (!active && !displayed)) return null;
    if (state.saved?.token === token || !state.saved) {
      const stored = readSavedPayment();
      state.saved = stored?.token === token ? null : stored;
    }
    if (displayed) {
      stopPollingRequest();
      window.clearTimeout(state.expiryTimer);
      state.token = null;
      state.order = null;
      state.lookupMissing = false;
      state.unverifiableChecks = 0;
      state.pollStopped = true;
      if (el.paymentDialog.open) el.paymentDialog.close();
    }
    if (!state.checkoutBusy && !state.recoveryRequest) state.idempotencyKey = null;
    state.rejectedRetryApproved = false;
    resetDismissConfirmation();
    renderResume();
    renderContinue();
    return maybeApplyPendingPreset();
  }

  function dropDismissedLocalPayment(token = activePaymentToken()) {
    if (!token || !dismissedTokens().includes(token)) return null;
    return clearLocalPayment(token);
  }

  function showDismissError(message = '') {
    el.dismissPaymentError.textContent = message;
    el.dismissPaymentError.hidden = !message;
  }

  function resetDismissConfirmation() {
    state.confirmedToken = null;
    el.dismissConfirm.checked = false;
    showDismissError();
  }

  function renderDismissControl(order) {
    const active = !state.viewingHistory && activePaymentToken() === order.token;
    const confirmNeeded = active && needsDismissConfirmation(order);
    if (!confirmNeeded && state.confirmedToken) resetDismissConfirmation();
    el.stalePaymentActions.hidden = !active || referenceUnresolvable() || !canDismissOrder(order);
    el.dismissConfirmWrap.hidden = !confirmNeeded;
    el.dismissConfirm.disabled = state.abandonBusy || state.checkoutBusy;
    el.dismissPaymentButton.disabled = state.abandonBusy || state.checkoutBusy
      || (confirmNeeded && (!el.dismissConfirm.checked || state.confirmedToken !== order.token || !paymentsReady()));
    el.dismissPaymentButton.textContent = state.abandonBusy ? 'Checking with provider…' : confirmNeeded ? 'Start over' : 'Remove saved link';
    el.dismissPaymentNote.textContent = confirmNeeded
      ? 'This does not cancel the old payment. Don’t use its address. You can still check its status after you start over.'
      : 'Removing the saved link does not cancel the provider’s payment.';
  }

  async function dismissPayment() {
    const token = activePaymentToken();
    const order = state.order;
    if (!token || order?.token !== token || !canDismissSaved() || state.viewingHistory || state.checkoutBusy || state.abandonBusy) return;
    if (!needsDismissConfirmation(order)) {
      rememberDismissedToken(token);
      const applied = clearLocalPayment(token);
      const message = 'Saved link removed. This did not cancel a payment.';
      showCheckoutError(message);
      if (applied) announcePendingPreset(applied);
      else announce(message);
      return;
    }
    if (state.confirmedToken !== token || !el.dismissConfirm.checked || !paymentsReady()) return;
    state.abandonBusy = true;
    stopPollingRequest();
    showDismissError();
    renderDismissControl(order);
    renderContinue();
    try {
      const response = await request('/api/abandon', {
        method: 'POST', body: { token, confirmed: true },
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.config.csrfToken },
      });
      const released = normalizeOrder(response, token);
      if (!released.abandonedAt || released.orderId !== order.orderId) throw new Error('Unconfirmed release');
      rememberReleasedPayment(released);
      const applied = clearLocalPayment(token);
      const message = 'Checkout released. The old payment was not canceled. Don’t use its address.';
      showCheckoutError(message);
      if (applied) announcePendingPreset(applied);
      else announce(message);
    } catch (error) {
      if (state.token === token && !state.viewingHistory) {
        resetDismissConfirmation();
        showDismissError(error instanceof ApiError && error.status ? error.message : 'Couldn’t confirm that the checkout was released. Check its status before starting over.');
        schedulePoll();
      }
    } finally {
      state.abandonBusy = false;
      if (state.order) renderDismissControl(state.order);
      renderResume();
      renderContinue();
    }
  }

  function hasUnresolvedPayment() {
    const token = activePaymentToken();
    return Boolean(token && (state.order?.token !== token || (!state.order.abandonedAt && !settledOrder(state.order))));
  }

  function canCreateCheckout() {
    if (!paymentsReady() || state.checkoutBusy || state.abandonBusy || state.guide || hasUnresolvedPayment() || state.unreadableAttempt) return false;
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
    renderGuideEntries();
  }

  function renderMethod() {
    el.cryptoPanel.hidden = state.method !== 'crypto';
  }

  function renderContinue() {
    renderAvailability();
    el.paymentFields.disabled = state.checkoutBusy || Boolean(state.recoveryRequest) || state.unreadableAttempt || Boolean(state.guide);
    el.currencySelect.disabled = !state.config?.currencies.length;
    el.continueButton.disabled = !canCreateCheckout();
    el.continueButton.setAttribute('aria-busy', String(state.checkoutBusy));
    el.continueLabel.textContent = state.checkoutBusy ? 'Preparing checkout…' : state.recoveryRequest ? 'Recover checkout' : 'Continue';
    const paymentNeedsAttention = state.unreadableAttempt || state.recoveryRequest || hasUnresolvedPayment() || Boolean(state.guide);
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
    } else if (state.guide) {
      el.continueNote.textContent = 'Finish or leave the buying guide before creating a payment.';
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

  function renderReceiptField() {
    el.receiptField.hidden = !state.receiptsAvailable;
    if (!state.receiptsAvailable) {
      state.payerEmail = '';
      state.receiptConsent = false;
      el.payerEmailInput.value = '';
      el.receiptConsent.checked = false;
      el.payerEmailError.hidden = true;
    }
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
      emailReceipts: data.emailReceipts && typeof data.emailReceipts === 'object'
        && typeof data.emailReceipts.enabled === 'boolean' && typeof data.emailReceipts.configured === 'boolean'
        ? { enabled: data.emailReceipts.enabled, configured: data.emailReceipts.configured }
        : { enabled: false, configured: false },
    };
  }

  function renderHeading() {
    const reference = (!state.viewingHistory ? state.order?.reference : null) ?? state.reference;
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
    state.receiptsAvailable = Boolean(config.emailReceipts?.enabled && config.emailReceipts?.configured);
    renderAmount();
    renderMethod();
    renderAvailability();
    renderContinue();
    renderReceiptField();
    if (state.guide) renderGuide();
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
    return { code: item.code, ticker: item.ticker, name: item.name, network: item.network, extraIdRequired: item.extraIdRequired === true };
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
      if (state.guide && !assets.some((asset) => asset.code === state.guide.asset)) {
        state.guide.asset = '';
        state.guide.walletReady = false;
        state.guide.networkConfirmed = false;
        state.guide.fundsReady = false;
        state.guideQuote = null;
        state.guideMessage = 'Choose an available coin and network before continuing.';
        saveGuide();
      }
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
        if (state.guide) renderGuide();
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

  function applyPreset(preset) {
    state.currency = preset.currency;
    state.reference = preset.reference || '';
    el.amountInput.value = preset.amount;
    state.amountTouched = false;
    state.idempotencyKey = null;
    // Applying outside the boot path must sync the visible controls too.
    if (el.currencySelect.querySelector(`option[value="${preset.currency}"]`)) el.currencySelect.value = preset.currency;
    renderHeading();
  }

  function announcePendingPreset(preset) {
    announce(`The payment link amount ${formatMoney(preset.amount, preset.currency)} was applied.`);
  }

  // A link preset applies over an earlier payment once that payment is settled or
  // dismissed here — never silently over one that may still be funded. A payer who
  // edited the form keeps their edits; the notice's explicit Apply still works.
  function maybeApplyPendingPreset() {
    if (!state.presetPending || hasUnresolvedPayment() || state.presetEdited) return null;
    const preset = state.presetPending;
    state.presetPending = null;
    applyPreset(preset);
    renderAmount();
    renderResume();
    queueQuote(0);
    renderContinue();
    return preset;
  }

  function applyPresetFromLink() {
    const preset = state.presetPending;
    if (!preset || state.checkoutBusy || state.abandonBusy) return;
    if (hasUnresolvedPayment()) {
      resumePayment(activePaymentToken());
      return;
    }
    state.presetPending = null;
    applyPreset(preset);
    renderAmount();
    renderResume();
    queueQuote(0);
    renderContinue();
    announcePendingPreset(preset);
  }

  function applyPresetLink() {
    if (state.presetHandled || !state.config) return;
    state.presetHandled = true;
    // A shared link is only a convenience: it waits as a pending offer behind an
    // unresolved payment instead of replacing it or being silently dropped.
    if (state.presetEdited || state.presetReturning || state.recoveryRequest || state.unreadableAttempt) return;
    try {
      const preset = window.PaymentLinks.parse(state.presetSearch, state.config);
      if (!preset) return;
      if (hasUnresolvedPayment()) {
        state.presetPending = { ...preset, reference: preset.reference || '' };
        return;
      }
      applyPreset(preset);
    } catch (error) {
      el.amountInput.value = '';
      state.amountTouched = false;
      showCheckoutError(`This payment link could not be applied. ${error.message}`);
    } finally {
      renderResume();
    }
  }

  function paymentDetailsChanged() {
    if (state.checkoutBusy || state.recoveryRequest) return;
    state.rejectedRetryApproved = false;
    if (state.guide) {
      state.guidePaymentChanged = true;
      state.guideMessage = 'Payment details changed outside the guide. Leave and restart the guide to use the new details.';
      renderGuide();
    }
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
    const parts = [body.amount, body.currency, body.method, body.asset ?? null, body.sourceOrderId ?? null, body.idempotencyKey];
    if (body.reference) parts.push(body.reference);
    if (body.payerEmail) parts.push(body.payerEmail);
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
        || (body.sourceOrderId !== undefined && !/^err_[0-9a-f-]{36}$/.test(body.sourceOrderId))
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey)
        || attempt.fingerprint !== attemptFingerprint(body)) {
        state.unreadableAttempt = true;
        showCheckoutError('A previous checkout attempt is saved but could not be recovered safely. Contact the merchant before making another payment.');
        return;
      }
      const reference = window.PaymentLinks.reference(body.reference);
      const payerEmail = body.payerEmail === undefined || body.payerEmail === '' ? '' : window.PaymentLinks.email(body.payerEmail);
      state.recoveryRequest = {
        amount: body.amount, currency: body.currency, method: body.method,
        ...(body.method === 'crypto' ? { asset: body.asset } : {}),
        ...(body.sourceOrderId ? { sourceOrderId: body.sourceOrderId } : {}),
        ...(reference ? { reference } : {}),
        ...(payerEmail ? { payerEmail } : {}), idempotencyKey: body.idempotencyKey,
      };
      state.payerEmail = payerEmail;
      state.receiptConsent = Boolean(payerEmail);
      el.payerEmailInput.value = payerEmail;
      el.receiptConsent.checked = Boolean(payerEmail);
      if (state.guide) {
        state.guidePaymentChanged = true;
        state.guideMessage = 'An earlier checkout attempt must be recovered before the buying guide can continue.';
      }
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
      ...(state.payerEmail ? { payerEmail: state.payerEmail } : {}),
      ...(state.method === 'crypto' ? { asset: state.asset } : {}),
      ...(state.rejectedRetryApproved && state.order?.orderId ? { sourceOrderId: state.order.orderId } : {}),
      idempotencyKey: state.idempotencyKey,
    };
    // Receipt email: intent must be explicit before anything is stored.
    if (state.receiptsAvailable && !state.recoveryRequest) {
      const entered = el.payerEmailInput.value.trim();
      if (entered && !state.receiptConsent) {
        el.payerEmailError.textContent = 'Tick the receipt box, or clear the email to continue without a receipt.';
        el.payerEmailError.hidden = false;
        el.receiptConsent.focus();
        return;
      }
      if (!entered && state.receiptConsent) {
        el.payerEmailError.textContent = 'Enter your email address, or clear the checkbox.';
        el.payerEmailError.hidden = false;
        el.payerEmailInput.focus();
        return;
      }
      if (entered) {
        try { state.payerEmail = window.PaymentLinks.email(entered); }
        catch (error) {
          el.payerEmailError.textContent = error.message;
          el.payerEmailError.hidden = false;
          el.payerEmailInput.focus();
          return;
        }
      } else { state.payerEmail = ''; }
      state.receiptConsent = Boolean(state.payerEmail);
      el.payerEmailError.hidden = true;
    }
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
      state.viewingHistory = Boolean(order.abandonedAt) || !rememberPayment(order.token);
      adoptOrder(order);
      openDialog(el.paymentDialog, el.paymentTitle);
      startExpiryClock();
      if (!order.terminal && !order.complete) schedulePoll(POLL_INTERVAL);
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || (error.status >= 200 && error.status < 300);
      if (error instanceof ApiError && error.activeToken) {
        state.recoveryRequest = null;
        state.idempotencyKey = null;
        clearAttempt();
        rememberPayment(error.activeToken, true);
        showCheckoutError(error.message);
        resumePayment(error.activeToken);
      } else if (uncertain) {
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
      abandonedAt: typeof data.abandonedAt === 'string' && Number.isFinite(Date.parse(data.abandonedAt)) ? data.abandonedAt : null,
      canAbandon: data.canAbandon === true,
      statusStale: data.statusStale === true,
      actuallyPaid: decimalParts(data.actuallyPaid) && compareDecimals(data.actuallyPaid, '0') !== -1
        ? data.actuallyPaid : null,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
      payment,
      checkoutUrl: typeof data.checkoutUrl === 'string' ? data.checkoutUrl : null,
      message: validText(data.message, 4000) ? data.message : null,
    };
  }

  function statusPresentation(order) {
    if (order.abandonedAt) {
      const received = order.complete || compareDecimals(order.actuallyPaid, '0') === 1 || order.status === 'partially_paid';
      return {
        label: 'Previous checkout', title: received ? 'Funds reported on the earlier payment' : 'You left this checkout',
        description: 'The original payment was not canceled. Don’t use its old address. If you sent funds, check this status and give the merchant its order reference before paying again.',
        tone: received || order.status === 'review' ? 'problem' : 'pending', icon: 'info',
      };
    }
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
      expired: ['Expired', 'The payment window has ended', 'Don’t send funds to these payment details. If you already sent a payment, contact the merchant with your order reference.'],
      rejected: ['Checkout unavailable', 'The checkout was not created', 'The provider rejected this checkout request, so no payment was taken. You can review the details and start a new payment — including the crypto option below.'],
      failed: ['Failed', 'Payment could not be completed', 'The provider reported a failed payment. If you sent funds or see a card charge, contact the merchant with your order reference.'],
      refunded: ['Refunded', 'The provider reports a refund', 'Check the original payment method for the refund. Contact the merchant if you need help tracing it.'],
      canceled: ['Cancelled', 'Payment cancelled', 'The provider marked this payment as cancelled. If you sent funds or see a charge, contact the merchant with your order reference.'],
      cancelled: ['Cancelled', 'Payment cancelled', 'The provider marked this payment as cancelled. If you sent funds or see a charge, contact the merchant with your order reference.'],
      cancel: ['Cancelled', 'Payment cancelled', 'The provider marked this payment as cancelled. If you sent funds or see a charge, contact the merchant with your order reference.'],
      creating: ['Preparing payment', 'Preparing your payment', 'The provider is preparing the checkout details. Keep this payment reference; you don’t need to create another payment.'],
      processing: ['Processing', 'Your payment is processing', 'The provider is still processing this payment. Keep your order reference and check here for updates.'],
      unknown: ['Status unverified', 'We’re checking your payment', 'The provider hasn’t confirmed the outcome. Keep your order reference and check the status before trying again.'],
      uncertain: ['Status unverified', 'We’re checking your payment', 'The provider hasn’t confirmed the outcome. Keep your order reference and check the status before trying again.'],
      review: ['Review needed', 'Your payment needs a review', 'Don’t pay again yet. Contact the merchant with your order reference.'],
      under_review: ['Under review', 'Your payment is under review', 'Don’t pay again yet. Contact the merchant with your order reference.'],
    };
    if (AWAITING_PAYMENT.has(order.status)) {
      const expires = expiryTime(order);
      if (expires !== null && expires <= Date.now()) {
        return { label: 'Window ended', title: 'Check your payment status', description: 'Don’t send funds to the old address. Check the latest status if you already paid.', tone: 'problem', icon: 'info' };
      }
      if (isOffline() || state.paymentDetailsStale) {
        return { label: 'Awaiting payment', title: 'Refresh your payment details', description: 'Reconnect and check the latest status before sending funds.', tone: 'pending', icon: 'arrow-clockwise' };
      }
      const ready = order.method === 'card' ? Boolean(safeCheckoutUrl(order.checkoutUrl))
        : Boolean(order.payment?.address && order.payment?.amount && order.asset);
      return {
        label: ready ? 'Awaiting payment' : 'Preparing payment',
        title: ready ? (order.method === 'card' ? 'Continue with your card' : 'Ready when you are') : 'Preparing your payment',
        description: ready ? (order.method === 'card'
          ? 'Open the provider’s checkout below. This page will check the payment status when you return.'
          : `Use the exact coin, network and amount below.${needsDismissConfirmation(order) ? ' Made a mistake? Choose Start over if you haven’t sent funds.' : ''}`)
          : 'Your payment reference is saved. The provider is preparing the payment details; there’s no need to start another payment.',
        tone: 'pending', icon: order.method === 'card' ? 'credit-card' : 'wallet',
      };
    }
    if (order.method === 'card' && ['unknown', 'uncertain'].includes(order.status) && !order.checkoutUrl) {
      return {
        label: 'Checkout unconfirmed', title: 'Card checkout didn’t open',
        description: 'We couldn’t confirm this checkout. Check its status before paying again. If you submitted card details or see a charge, contact the merchant.',
        tone: 'problem', icon: 'info', hideProviderMessage: true,
      };
    }
    if (order.status === 'partially_paid') {
      const offline = isOffline() ? 'These are the last reported amounts. Reconnect to check the latest status. ' : '';
      const expires = expiryTime(order);
      const ended = expires !== null && expires <= Date.now() ? 'The payment window has ended. ' : '';
      return {
        label: 'Partial payment', title: 'Partial payment received',
        description: `${offline}${ended}Don’t send more yet. Check the status or contact the merchant with your order reference for next steps.`,
        tone: 'problem', icon: 'info',
      };
    }
    const values = map[order.status] || ['Status unverified', 'Your payment needs a status check', 'Completion has not been verified. Don’t start a separate payment. Keep your order reference and check again or contact the merchant.'];
    const problem = FINAL_PROBLEMS.has(order.status);
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
    return !isOffline() && !state.paymentDetailsStale && !state.viewingHistory && !order.abandonedAt && !order.complete && !order.terminal
      && AWAITING_PAYMENT.has(order.status) && (expiry === null || expiry > Date.now());
  }

  function clearCopyFallback() {
    el.copyFallback.hidden = true;
    el.copyFallbackValue.value = '';
    el.copyFeedback.textContent = '';
  }

  function hideCryptoInstructions() {
    el.cryptoPayment.hidden = true;
    el.paymentAddress.value = '';
    el.paymentMemo.value = '';
    el.paymentMemoWrap.hidden = true;
    el.paymentAmount.textContent = '';
    el.paymentQrWrap.hidden = true;
    el.paymentQr.removeAttribute('src');
    el.paymentExpiry.hidden = true;
    el.cryptoPayment.querySelectorAll('[data-copy]').forEach((button) => { button.disabled = true; });
    if (el.copyFallback.dataset.field !== 'order') clearCopyFallback();
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
    el.providerMessage.textContent = presentation.hideProviderMessage ? '' : order.message || '';
    el.providerMessage.hidden = Boolean(presentation.hideProviderMessage) || !order.message;
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
    const partial = order.status === 'partially_paid' ? partialAmounts(order) : {};
    // The card receipt already shows the original fiat price.
    const expected = order.method === 'crypto' ? partial.expected : '';
    el.receiptExpectedRow.hidden = !expected;
    el.receiptExpected.textContent = expected || '';
    el.receiptReceivedRow.hidden = !partial.received;
    el.receiptReceived.textContent = partial.received || '';
    el.receiptShortfallRow.hidden = !partial.shortfall;
    el.receiptShortfall.textContent = partial.shortfall || '';
    const created = order.createdAt ? Date.parse(order.createdAt) : NaN;
    el.receiptCreatedRow.hidden = !Number.isFinite(created);
    el.receiptCreated.textContent = Number.isFinite(created)
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(created)) : '';
    const payment = order.payment;
    const hasCryptoDetails = order.method === 'crypto' && payment?.address && payment?.amount && order.asset;
    const sendable = canSendPayment(order);
    if (hasCryptoDetails && sendable) {
      el.cryptoPayment.hidden = false;
      el.paymentAmountLabel.textContent = 'Send exactly';
      el.paymentAmount.textContent = payment.amount;
      el.paymentTicker.textContent = order.asset.ticker;
      el.paymentNetwork.textContent = order.asset.network;
      if (el.paymentAddress.value !== payment.address) el.paymentAddress.value = payment.address;
      el.paymentMemoWrap.hidden = payment.memo === null;
      if (el.paymentMemo.value !== (payment.memo ?? '')) el.paymentMemo.value = payment.memo ?? '';
      const showQr = safeQr(payment.qrDataUrl);
      el.paymentQrWrap.hidden = !showQr;
      if (showQr && el.paymentQr.getAttribute('src') !== payment.qrDataUrl) el.paymentQr.src = payment.qrDataUrl;
      if (!showQr) el.paymentQr.removeAttribute('src');
      el.cryptoPayment.querySelectorAll('[data-copy]').forEach((button) => { button.disabled = false; });
      el.networkCaution.textContent = `Send only ${order.asset.ticker} on ${order.asset.network}. A different coin or network may result in lost funds.`;
      updateExpiry();
    } else {
      hideCryptoInstructions();
    }
    el.cardPayment.hidden = order.method !== 'card' || !sendable;
    el.cardRecovery.hidden = !(order.method === 'card' && ['failed', 'expired', 'refunded'].includes(order.status) && order.terminal && !order.complete);
    const checkoutUrl = safeCheckoutUrl(order.checkoutUrl);
    const showCheckoutLink = order.method === 'card' && sendable && checkoutUrl;
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
    el.missingPaymentActions.hidden = !referenceUnresolvable();
    renderDismissControl(order);
    // The rejected/recovery section covers terminal card problems; this entry
    // covers every other card dead end so the payer always sees the crypto path
    // here, without hunting through help or switching methods first.
    el.statusGuideSection.hidden = !(order.method === 'card' && !order.complete && el.cardRecovery.hidden
      && (order.status === 'rejected' || STALE_GUIDE_STATUSES.includes(order.status)));
    renderResume();
    renderContinue();
    renderStatusButton();
    if (el.paymentDialog.open) fitReadonlyFields(el.paymentDialog);
    renderGuideEntries();
  }

  function showOrderLoading() {
    el.paymentStatusLabel.textContent = 'Checking status';
    el.paymentTitle.textContent = 'Finding your payment';
    el.paymentDescription.textContent = 'Retrieving the latest payment details. A return from checkout does not, by itself, confirm a payment.';
    el.paymentStatusIcon.dataset.tone = 'pending';
    el.paymentStatusGlyph.className = 'icon icon-arrow-clockwise';
    el.cryptoPayment.hidden = true;
    el.cardPayment.hidden = true;
    el.cardRecovery.hidden = true;
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
    el.stalePaymentActions.hidden = true;
    el.statusGuideSection.hidden = true;
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
        // A dismissed payment stays dismissed, including in other tabs.
        if (dismissedTokens().includes(saved.token)) return null;
        return { token: saved.token, timestamp: saved.timestamp };
      }
    } catch { /* Storage can be blocked. Checkout still works within this tab. */ }
    return null;
  }

  function readPreviousPayment() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREVIOUS_KEY) || 'null');
      if (validToken(saved?.token) && Number.isFinite(Date.parse(saved.abandonedAt))) return saved;
    } catch { /* The status link is optional. */ }
    return null;
  }

  function rememberReleasedPayment(order) {
    if (!dismissedTokens().includes(order.token)) rememberDismissedToken(order.token);
    const prior = readPreviousPayment() || state.previousPayment;
    if (prior && Date.parse(prior.abandonedAt) >= Date.parse(order.abandonedAt)) {
      state.previousPayment = prior;
      return;
    }
    state.previousPayment = { token: order.token, abandonedAt: order.abandonedAt };
    try { localStorage.setItem(PREVIOUS_KEY, JSON.stringify(state.previousPayment)); }
    catch { /* The original remains checkable in this tab. */ }
  }

  function rememberPayment(token, recover = false) {
    const dismissed = dismissedTokens();
    if (dismissed.includes(token) && !recover) return false;
    const timestamp = state.saved?.token === token ? state.saved.timestamp : Date.now();
    state.saved = { token, timestamp };
    try {
      // Only a server-confirmed active order can restore an earlier local dismissal.
      if (recover && dismissed.includes(token)) localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed.filter(item => item !== token)));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, timestamp }));
      state.storageFailed = false;
    } catch { state.storageFailed = true; }
    el.storageNote.hidden = !state.storageFailed;
    return true;
  }

  function renderResume() {
    const token = activePaymentToken();
    const order = state.order?.token === token ? state.order : null;
    const pendingPreset = state.presetPending;
    el.previousPaymentNotice.hidden = !state.previousPayment;
    el.presetNotice.hidden = !pendingPreset;
    if (pendingPreset) {
      const forLabel = pendingPreset.reference ? ` · for ${pendingPreset.reference}` : '';
      el.presetNoticeTitle.textContent = `This payment link is for ${formatMoney(pendingPreset.amount, pendingPreset.currency)}${forLabel}`;
      const blocked = hasUnresolvedPayment();
      el.presetNoticeText.textContent = blocked
        ? 'Review the earlier payment first. The linked amount can be used once that checkout is finished or released.'
        : 'Apply the linked amount to continue with this link’s payment.';
      el.applyPresetButton.disabled = state.checkoutBusy || state.abandonBusy;
      el.applyPresetButton.setAttribute('aria-disabled', String(el.applyPresetButton.disabled));
    }
    el.resumeNotice.hidden = !token;
    if (!token) return;
    el.dismissNoticeButton.hidden = !canDismissSaved() || needsDismissConfirmation(order);
    el.dismissNoticeButton.disabled = state.checkoutBusy || state.abandonBusy;
    el.resumeTitle.textContent = order ? statusPresentation(order).title : 'Your previous payment';
    el.resumeDescription.textContent = order?.complete ? 'Your receipt is available to review.'
      : needsDismissConfirmation(order) ? 'If you haven’t sent funds, open this payment to start over.'
        : settledOrder(order) ? 'Review the provider’s latest status and order reference.'
          : 'Check this payment before starting another.';
  }

  function adoptOrder(order) {
    if (state.guide && (state.guide.source.kind !== 'terminal_card' || state.guide.source.orderId !== order.orderId
      || !validGuideCardSource(order))) {
      state.guidePaymentChanged = true;
      state.rejectedRetryApproved = false;
      state.guideMessage = 'The original payment status changed. Check it before making another payment.';
    }
    if (state.token !== order.token) {
      stopPollingRequest();
      state.token = order.token;
      state.pollDeadline = Date.now() + POLL_WINDOW;
      state.expiryCheckedFor = null;
      resetDismissConfirmation();
      clearCopyFallback();
    }
    if (order.abandonedAt) {
      rememberReleasedPayment(order);
      if (state.saved?.token === order.token || !state.saved) {
        const stored = readSavedPayment();
        state.saved = stored?.token === order.token ? null : stored;
      }
      state.viewingHistory = true;
    }
    state.order = order;
    state.paymentDetailsStale = order.statusStale === true;
    renderHeading();
    if (!state.viewingHistory && settledOrder(order)) state.idempotencyKey = null;
    state.lookupMissing = false;
    state.pollStopped = order.terminal || order.complete;
    renderOrder();
    el.statusCheckMessage.textContent = state.pollStopped
      ? 'Showing the latest status from the payment provider.'
      : 'Status updates automatically while this page is open.';
    if (state.pollStopped) window.clearTimeout(state.pollTimer);
    const applied = maybeApplyPendingPreset();
    if (applied) announcePendingPreset(applied);
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
    if (!state.token || state.pollBusy || document.hidden) return false;
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (manual) {
      state.pollDeadline = Date.now() + POLL_WINDOW;
      state.pollStopped = false;
      state.pollErrors = 0;
    }
    if (!manual && (state.pollStopped || Date.now() >= state.pollDeadline)) {
      schedulePoll();
      return false;
    }
    if (navigator.onLine === false) {
      el.statusCheckMessage.textContent = 'You’re offline. Status checks will resume when you reconnect. Don’t send another payment while the result is unknown.';
      state.pollErrors += 1;
      schedulePoll(Math.min(POLL_INTERVAL * (2 ** Math.min(state.pollErrors, 4)), 60000));
      return false;
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
      if (generation !== state.pollGeneration || token !== state.token) return false;
      const order = normalizeOrder(data, token);
      state.pollErrors = 0;
      state.unverifiableChecks = 0;
      adoptOrder(order);
      if (manual) announce(order.statusStale ? 'The latest status is unavailable.' : `Status checked. ${statusPresentation(order).label}.`);
      if (el.paymentDialog.open) startExpiryClock();
      return !order.statusStale;
    } catch (error) {
      if (generation !== state.pollGeneration || error.name === 'AbortError') return false;
      state.paymentDetailsStale = true;
      state.pollErrors += 1;
      delay = Math.min(POLL_INTERVAL * (2 ** Math.min(state.pollErrors, 4)), 60000);
      state.lookupMissing = error instanceof ApiError && [404, 410].includes(error.status);
      // The provider rejecting the reference itself (403) is definitive; a run of
      // these means the saved link is unusable and removal should be offered.
      state.unverifiableChecks = error instanceof ApiError && error.status === 403
        ? state.unverifiableChecks + 1 : 0;
      if (state.lookupMissing) {
        state.pollStopped = true;
        el.statusCheckMessage.textContent = 'This payment reference could not be retrieved. Contact the merchant if you sent funds or see a charge. Removing the saved link does not cancel a payment.';
      } else if (referenceUnresolvable()) {
        state.pollStopped = true;
        el.statusCheckMessage.textContent = 'This payment reference could not be verified. You can remove the saved link. If you sent funds, contact the merchant first.';
      } else {
        el.statusCheckMessage.textContent = `The latest status couldn’t be retrieved. Retrying in ${Math.round(delay / 1000)} seconds. Don’t send another payment while the result is unknown.`;
      }
      if (!state.order) {
        el.paymentStatusLabel.textContent = 'Status unavailable';
        el.paymentTitle.textContent = state.lookupMissing ? 'Payment reference unavailable' : 'We couldn’t check your payment';
        el.paymentDescription.textContent = 'There is no verified result to show. Keep any order reference you have and contact the merchant if you need help.';
      } else {
        renderOrder();
      }
      el.missingPaymentActions.hidden = !referenceUnresolvable();
      renderResume();
      return false;
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

  function resumePayment(token, open = true, historical = false) {
    if (!validToken(token)) return;
    state.viewingHistory = historical || state.previousPayment?.token === token
      || Boolean(state.saved?.token && state.saved.token !== token);
    resetDismissConfirmation();
    clearCopyFallback();
    if (state.token !== token) {
      stopPollingRequest();
      state.order = null;
      state.token = token;
      state.lookupMissing = false;
      state.unverifiableChecks = 0;
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
      const expiryKey = `${order.token}|${order.payment.expiresAt}`;
      if (state.expiryCheckedFor !== expiryKey) {
        state.expiryCheckedFor = expiryKey;
        renderOrder();
        // A clock is not an authoritative payment status. Ask the server instead.
        if (!state.pollBusy && !order.terminal && !isOffline()) schedulePoll(1);
      }
      el.paymentExpiry.hidden = true;
      return;
    }
    if (el.cryptoPayment.hidden) {
      el.paymentExpiry.hidden = true;
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
    const order = state.order;
    const valid = () => state.order?.token === order.token && (field === 'order' || canSendPayment(state.order));
    if (!valid()) return;
    const value = field === 'order' ? order.orderId
      : field === 'amount' ? order.payment?.amount
        : field === 'address' ? order.payment?.address : order.payment?.memo;
    if (value == null) return;
    const label = field === 'order' ? 'Order reference' : field === 'memo' ? 'Memo'
      : field === 'amount' ? 'Exact amount' : 'Address';
    clearCopyFallback();
    el.copyFallback.dataset.field = field;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
      await navigator.clipboard.writeText(value);
      if (!valid()) return;
      el.copyFeedback.textContent = `${label} copied.`;
      const copyLabel = button.querySelector('.copy-label');
      if (copyLabel) {
        copyLabel.textContent = 'Copied';
        window.setTimeout(() => { copyLabel.textContent = 'Copy'; }, 1800);
      }
    } catch {
      if (!valid()) return;
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
    state.paymentDetailsStale = true;
    invalidateQuote();
    if (state.order) renderOrder();
    else renderContinue();
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

  function syncPaymentStorage(key) {
    if (key === PREVIOUS_KEY) {
      state.previousPayment = readPreviousPayment();
      renderResume();
      return;
    }
    if (key !== STORAGE_KEY && key !== DISMISS_KEY) return;
    const active = activePaymentToken();
    if (key === DISMISS_KEY && active && dismissedTokens().includes(active)) {
      const applied = dropDismissedLocalPayment(active);
      if (applied) announcePendingPreset(applied);
      else announce('The saved payment changed in another tab.');
    }
    const saved = readSavedPayment();
    if (!saved || saved.token === state.saved?.token) return;
    state.saved = saved;
    if (state.token && state.token !== saved.token) {
      state.viewingHistory = true;
      resetDismissConfirmation();
    }
    state.rejectedRetryApproved = false;
    if (!state.checkoutBusy && !state.recoveryRequest) state.idempotencyKey = null;
    invalidateQuote();
    if (state.guide) {
      state.guidePaymentChanged = true;
      state.guideMessage = 'A payment changed in another tab. Check it before making another payment.';
      renderGuide();
    }
    if (state.order) renderOrder();
    else {
      renderResume();
      renderContinue();
    }
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
    el.payerEmailInput.addEventListener('input', () => {
      el.payerEmailError.hidden = true;
      state.payerEmail = '';
      paymentDetailsChanged();
    });
    el.receiptConsent.addEventListener('change', () => {
      state.receiptConsent = el.receiptConsent.checked;
      el.payerEmailError.hidden = true;
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
      if (state.guideChoosingAsset && state.guide) {
        state.guide.asset = button.dataset.assetCode;
        state.guide.walletReady = false;
        state.guide.networkConfirmed = false;
        state.guide.fundsReady = false;
        state.guideQuote = null;
        state.guideMessage = '';
        el.assetDialog.close();
        saveGuide();
        renderGuide();
        const asset = guideAsset();
        announce(`${asset.name} selected for the buying guide. Network: ${asset.network}.`);
        void refreshGuideQuote();
        return;
      }
      state.asset = button.dataset.assetCode;
      el.assetDialog.close();
      paymentDetailsChanged();
      const asset = selectedAsset();
      announce(`${asset.name} selected. Network: ${asset.network}.`);
    });
    el.retryAssets.addEventListener('click', () => { void loadAssets(); });
    el.retryConfig.addEventListener('click', () => { void loadConfig(); });
    el.retryEstimate.addEventListener('click', () => queueQuote(0));
    el.resumeButton.addEventListener('click', () => resumePayment(activePaymentToken()));
    el.previousPaymentButton.addEventListener('click', () => resumePayment(state.previousPayment?.token, true, true));
    el.applyPresetButton.addEventListener('click', applyPresetFromLink);
    el.checkStatusButton.addEventListener('click', () => { void checkStatus(true); });
    [el.cryptoGuideButton, el.fiatGuideButton, el.helpGuideButton, el.rejectedCardGuideButton, el.resumeGuideButton, el.statusGuideButton]
      .forEach((button) => button.addEventListener('click', openGuide));
    el.cancelGuideButton.addEventListener('click', () => leaveGuide());
    el.cardGuideCancel.addEventListener('click', () => leaveGuide());
    el.cardGuideChooseAsset.addEventListener('click', openGuideAssetPicker);
    el.cardGuideRefreshQuote.addEventListener('click', () => { void refreshGuideQuote(); });
    el.cardGuideBack.addEventListener('click', previousGuideStep);
    el.cardGuideNext.addEventListener('click', nextGuideStep);
    el.cardGuideFinish.addEventListener('click', () => { void finishGuide(); });
    el.cardGuideNoCharge.addEventListener('change', () => {
      if (!state.guide) return;
      state.guide.noCharge = el.cardGuideNoCharge.checked;
      state.guideMessage = '';
      renderGuide();
    });
    el.cardGuideWalletReady.addEventListener('change', () => {
      if (!state.guide) return;
      state.guide.walletReady = el.cardGuideWalletReady.checked;
      state.guideMessage = '';
      renderGuide();
    });
    el.cardGuideNetworkConfirm.addEventListener('change', () => {
      if (!state.guide) return;
      state.guide.networkConfirmed = el.cardGuideNetworkConfirm.checked;
      state.guideMessage = '';
      renderGuide();
    });
    el.cardGuideFundsReady.addEventListener('change', () => {
      if (!state.guide) return;
      state.guide.fundsReady = el.cardGuideFundsReady.checked;
      state.guideMessage = '';
      renderGuide();
    });
    el.cardGuideProvider.addEventListener('click', (event) => {
      if (el.cardGuideProvider.getAttribute('aria-disabled') === 'true'
        || el.cardGuideProvider.getAttribute('href') !== GUIDE_PROVIDER_URL
        || !guideQuoteFresh() || guideBlockReason()) {
        event.preventDefault();
        if (!guideQuoteFresh()) void refreshGuideQuote();
        return;
      }
      window.setTimeout(() => {
        if (!state.guide || state.guide.step !== 2) return;
        state.guide.step = 3;
        state.guideMessage = 'Finish the purchase into your wallet, then return here. Buying crypto does not pay Erraza.';
        saveGuide();
        renderGuide();
      }, 0);
    });
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
    el.assetDialog.addEventListener('close', resumeGuideAfterAssetPicker);
    el.paymentDialog.addEventListener('close', () => {
      window.clearTimeout(state.expiryTimer);
      clearCopyFallback();
      resetDismissConfirmation();
      if (state.viewingHistory) {
        stopPollingRequest();
        state.viewingHistory = false;
        state.order = null;
        state.token = null;
        renderHeading();
      }
      renderResume();
      renderContinue();
      // Closing a dialog never releases or cancels the payment.
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
    el.dismissConfirm.addEventListener('change', () => {
      state.confirmedToken = el.dismissConfirm.checked ? state.order?.token : null;
      showDismissError();
      if (state.order) renderDismissControl(state.order);
    });
    el.dismissNoticeButton.addEventListener('click', dismissPayment);
    el.dismissPaymentButton.addEventListener('click', dismissPayment);
    el.forgetPaymentButton.addEventListener('click', () => {
      if (!referenceUnresolvable() || state.abandonBusy) return;
      const token = state.token;
      let applied;
      if (state.viewingHistory) {
        if (state.previousPayment?.token === token) {
          state.previousPayment = null;
          try { if (readPreviousPayment()?.token === token) localStorage.removeItem(PREVIOUS_KEY); } catch { /* Optional history link. */ }
        }
        el.paymentDialog.close();
      } else {
        rememberDismissedToken(token);
        applied = clearLocalPayment(token);
      }
      showCheckoutError('Saved link removed from this browser. This did not cancel a payment. Contact the merchant if you already sent funds.');
      if (applied) announcePendingPreset(applied);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPollingRequest();
        window.clearTimeout(state.expiryTimer);
        invalidateQuote();
        renderContinue();
      } else {
        if (state.guide) {
          if (state.guide.source.kind === 'terminal_card') state.guide.noCharge = false;
          state.guide.fundsReady = false;
          if (state.guide.step !== 3) {
            state.guide.walletReady = false;
            state.guide.networkConfirmed = false;
            state.guideQuote = null;
          }
          state.guideMessage = state.guide.step === 3
            ? 'Welcome back. Confirm that the crypto has arrived in your wallet before returning to Erraza checkout.'
            : 'Review the selected network and refresh the estimate before continuing.';
          saveGuide();
          renderGuide();
        }
        queueQuote(0);
        startExpiryClock();
        refreshOnReturn();
        renderStatusButton();
      }
    });
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('storage', event => syncPaymentStorage(event.key));
    window.addEventListener('pagehide', () => {
      stopPollingRequest();
      window.clearTimeout(state.expiryTimer);
      invalidateQuote();
    });
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      if (state.guide) {
        if (state.guide.source.kind === 'terminal_card') state.guide.noCharge = false;
        state.guide.fundsReady = false;
        if (state.guide.step !== 3) {
          state.guide.walletReady = false;
          state.guide.networkConfirmed = false;
          state.guideQuote = null;
        }
        state.guideMessage = state.guide.step === 3
          ? 'Confirm that the crypto has arrived in your wallet before returning to Erraza checkout.'
          : 'Review the wallet, network, and fresh estimate before continuing.';
        saveGuide();
        renderGuide();
      }
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
    state.previousPayment = readPreviousPayment();
    restoreAttempt();
    restoreGuide();
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
    renderGuideEntries();
    consumeReturnLink();
    void loadConfig();
  }

  boot();
})();
