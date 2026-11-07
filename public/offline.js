(() => {
  'use strict';

  function bindReconnect() {
    const button = document.getElementById('reconnectButton');
    if (!button) return;
    button.hidden = false;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.isTrusted) window.location.reload();
    });
  }

  // Never poll, react to the online event, read payment data, or initiate a payment.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindReconnect, { once: true });
  else bindReconnect();
})();
