(() => {
  'use strict';

  const supported = window.isSecureContext === true && typeof navigator.serviceWorker?.register === 'function';
  const displayMode = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIOSBrowser = isIOS && /Safari|CriOS|FxiOS|EdgiOS/.test(navigator.userAgent || '');
  let deferredPrompt = null;
  let installed = false;
  let prompting = false;

  function standalone() {
    return navigator.standalone === true || displayMode?.matches === true;
  }

  function installDialog() {
    const dialog = document.getElementById('installDialog');
    return typeof dialog?.showModal === 'function' ? dialog : null;
  }

  function render() {
    document.documentElement?.setAttribute('data-standalone', String(standalone()));
    const available = supported && !installed && !standalone() && !prompting
      && (deferredPrompt !== null || (isIOSBrowser && installDialog() !== null));
    document.querySelectorAll('[data-install-app]').forEach((button) => {
      button.hidden = !available;
      button.disabled = prompting;
    });
  }

  async function install(event) {
    event.preventDefault();
    if (!event.isTrusted || !supported || installed || standalone() || prompting) return;

    if (deferredPrompt) {
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      prompting = true;
      render();
      try {
        // Called in the click's user activation, never on load or reconnect.
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } catch {
        // Installation is optional. Dismissal or browser policy cannot break checkout.
      } finally {
        prompting = false;
        render();
      }
      return;
    }

    if (!isIOSBrowser) return;
    const dialog = installDialog();
    if (!dialog) return;
    try {
      if (!dialog.open) dialog.showModal();
      const heading = dialog.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
      // The page's existing data-close handler owns the native dialog's Close control.
    } catch {
      // A missing, detached, or unsupported helper must not affect payments.
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    if (!supported || installed || standalone() || typeof event.prompt !== 'function') return;
    event.preventDefault();
    deferredPrompt = event;
    render();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    render();
  });
  window.addEventListener('pageshow', render);
  if (typeof displayMode?.addEventListener === 'function') displayMode.addEventListener('change', render);
  else if (typeof displayMode?.addListener === 'function') displayMode.addListener(render);

  function bindControls() {
    document.querySelectorAll('[data-install-app]').forEach((button) => button.addEventListener('click', install));
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindControls, { once: true });
  else bindControls();

  function register() {
    if (!supported) return;
    try {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
    } catch {
      // Private browsing and browser policy may disable workers even in HTTPS.
    }
  }
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
