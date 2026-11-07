(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const form = $('linkForm'), amount = $('linkAmount'), currency = $('linkCurrency'), reference = $('linkReference');
  const error = $('linkError'), notice = $('linkNotice'), noticeBox = $('linkNoticeBox');
  const result = $('linkResult'), output = $('generatedLink'), preview = $('previewLink'), feedback = $('linkFeedback');
  let config = null;
  let loading = false;
  let generated = '';
  let copiedGeneration = 0;

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let manualTheme = false;
  function theme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('creatorTheme').setAttribute('aria-pressed', String(dark));
    $('creatorTheme').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
    $('creatorThemeIcon').className = `icon icon-${dark ? 'moon' : 'sun'}`;
    $('creatorThemeLabel').textContent = dark ? 'Dark' : 'Light';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#111b1e' : '#f1f4f4');
  }
  theme(media.matches);
  media.addEventListener('change', event => { if (!manualTheme) theme(event.matches); });
  $('creatorTheme').addEventListener('click', () => { manualTheme = true; theme(document.documentElement.dataset.theme !== 'dark'); });

  function invalidate() {
    generated = '';
    copiedGeneration++;
    output.value = '';
    preview.removeAttribute('href');
    result.hidden = true;
    feedback.textContent = '';
    error.textContent = '';
    error.hidden = true;
    amount.setAttribute('aria-invalid', 'false');
    reference.setAttribute('aria-invalid', 'false');
    $('referenceError').hidden = true;
    $('referenceError').textContent = '';
    $('linkAmountControl').classList.remove('is-invalid');
    const meta = config?.currencies.find(item => item.code === currency.value);
    $('linkSymbol').textContent = meta?.symbol || '';
  }

  async function load() {
    if (loading) return;
    loading = true;
    $('generateLink').disabled = true;
    $('linkRetry').hidden = true;
    noticeBox.hidden = false;
    notice.textContent = 'Loading currencies…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('configuration');
      const data = await response.json();
      if (!Array.isArray(data.currencies) || !data.currencies.length || !data.currencies.every(item => item && /^[a-z]{3}$/.test(item.code)
        && typeof item.label === 'string' && typeof item.symbol === 'string' && Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 2)
        || typeof data.minAmount !== 'string' || typeof data.maxAmount !== 'string') throw new Error('configuration');
      const oldCurrency = currency.value;
      config = data;
      currency.replaceChildren(...data.currencies.map(item => {
        const option = document.createElement('option');
        option.value = item.code; option.textContent = item.label;
        return option;
      }));
      if (data.currencies.some(item => item.code === oldCurrency)) currency.value = oldCurrency;
      currency.disabled = false;
      if (typeof data.brand === 'string') {
        $('creatorBrand').textContent = data.brand;
        $('creatorFooterBrand').textContent = data.brand;
        $('linkMerchant').textContent = data.brand;
        $('creatorBrandLink').setAttribute('aria-label', `${data.brand} checkout`);
        document.title = `${data.brand} | Create payment link`;
      }
      invalidate();
      noticeBox.hidden = data.configured === true;
      notice.textContent = data.configured ? '' : 'You can prepare links now. Finish checkout configuration before sharing them with payers.';
      $('generateLink').disabled = false;
    } catch {
      config = null;
      currency.disabled = true;
      notice.textContent = 'Couldn’t load payment settings. Please try again.';
      $('linkRetry').hidden = false;
    } finally { clearTimeout(timeout); loading = false; }
  }

  amount.addEventListener('input', invalidate);
  reference.addEventListener('input', invalidate);
  currency.addEventListener('change', invalidate);
  $('linkRetry').addEventListener('click', () => { void load(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!config || loading) return;
    invalidate();
    let label;
    try { label = window.PaymentLinks.reference(reference.value); }
    catch (failure) {
      $('referenceError').textContent = failure.message;
      $('referenceError').hidden = false;
      reference.setAttribute('aria-invalid', 'true');
      reference.focus();
      return;
    }
    try {
      generated = window.PaymentLinks.create(window.location.origin, window.PaymentLinks.normalizeInput(amount.value), currency.value, config, label);
      output.value = generated;
      preview.href = generated;
      result.hidden = false;
      $('localLinkNote').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
      feedback.textContent = 'Link created.';
      $('linkResultTitle').focus({ preventScroll: true });
      result.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      amount.setAttribute('aria-invalid', 'true');
      $('linkAmountControl').classList.add('is-invalid');
      amount.focus();
    }
  });
  $('copyLink').addEventListener('click', async () => {
    if (!generated) return;
    const value = generated, generation = copiedGeneration;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard');
      await navigator.clipboard.writeText(value);
      if (generation === copiedGeneration) feedback.textContent = 'Link copied. Ready to share.';
    } catch {
      if (generation !== copiedGeneration) return;
      output.focus();
      output.select();
      feedback.textContent = 'Copy the selected link manually.';
    }
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  void load();
})();
