(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = Object.fromEntries([
    'adminEmail', 'logoutButton', 'loginCard', 'loginForm', 'adminEmailInput', 'adminPasswordInput',
    'loginButton', 'loginError', 'dashboardCard', 'receiptsCard', 'receiptsDescription', 'receiptsToggle',
    'receiptsConfigNote', 'attemptsList', 'alertsList', 'runsList', 'announcer',
  ].map((id) => [id, $(id)]));

  let receiptsEnabled = false;

  function announce(message) {
    el.announcer.textContent = '';
    window.setTimeout(() => { el.announcer.textContent = message; }, 30);
  }

  function setSignedIn(signedIn, email = '') {
    el.loginCard.hidden = signedIn;
    el.dashboardCard.hidden = !signedIn;
    el.logoutButton.hidden = !signedIn;
    el.adminEmail.hidden = !email;
    el.adminEmail.textContent = email;
  }

  function renderReceipts(receipts) {
    receiptsEnabled = receipts.enabled === true;
    el.receiptsToggle.textContent = receiptsEnabled ? 'Turn off' : 'Turn on';
    el.receiptsDescription.textContent = receiptsEnabled
      ? 'Receipt collection is ON — the checkout form offers an optional email, and settled payments with a collected address receive a receipt.'
      : 'Receipt collection is OFF — the checkout form never asks for an email.';
    el.receiptsToggle.disabled = !receipts.configured;
    el.receiptsConfigNote.hidden = receipts.configured;
    el.receiptsCard.style.opacity = receipts.configured ? '' : '0.7';
  }

  function renderSnapshot(snapshot) {
    const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : [];
    const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
    const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
    el.attemptsList.replaceChildren(...(attempts.length ? attempts.map((attempt) => {
      const li = document.createElement('li');
      const id = document.createElement('span');
      id.className = 'admin-value';
      id.textContent = `${attempt.order_id} — ${attempt.amount} ${attempt.currency} · ${attempt.status}`;
      li.append(id);
      return li;
    }) : [document.createTextNode('None.')]));
    el.alertsList.replaceChildren(...(alerts.length ? alerts.map((alert) => {
      const li = document.createElement('li');
      li.textContent = `${alert.severity || 'warning'} · ${alert.category} · ${alert.order_id || alert.key}`;
      return li;
    }) : [document.createTextNode('None.')]));
    el.runsList.replaceChildren(...(runs.length ? runs.slice(0, 5).map((run) => {
      const li = document.createElement('li');
      li.textContent = `${run.finished_at || ''} — ${run.outcome} (${run.claimed} claimed, ${run.transitions} transitions)`;
      return li;
    }) : [document.createTextNode('None.')]));
  }

  async function loadOverview() {
    const response = await fetch('/api/admin/overview', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 403) { setSignedIn(false); return; }
    if (!response.ok) throw new Error(`Overview failed (${response.status}).`);
    const body = await response.json();
    setSignedIn(true, body.email || '');
    renderReceipts(body.receipts || { enabled: false, configured: false });
    renderSnapshot(body.snapshot || {});
  }

  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    el.loginError.hidden = true;
    el.loginButton.disabled = true;
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: el.adminEmailInput.value.trim(), password: el.adminPasswordInput.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        el.loginError.textContent = body.message || 'Sign-in failed.';
        el.loginError.hidden = false;
        return;
      }
      el.adminPasswordInput.value = '';
      await loadOverview();
      announce('Signed in.');
    } catch {
      el.loginError.textContent = 'Sign-in could not be completed. Check your connection.';
      el.loginError.hidden = false;
    } finally {
      el.loginButton.disabled = false;
    }
  });

  el.logoutButton.addEventListener('click', async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* Cookie is cleared server-side regardless. */ }
    setSignedIn(false);
    announce('Signed out.');
  });

  el.receiptsToggle.addEventListener('click', async () => {
    el.receiptsToggle.disabled = true;
    try {
      const response = await fetch('/api/admin/receipts-toggle', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !receiptsEnabled }),
      });
      if (response.status === 403) { setSignedIn(false); return; }
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.receipts) {
        renderReceipts(body.receipts);
        announce(body.receipts.enabled ? 'Receipt collection is on.' : 'Receipt collection is off.');
      }
    } catch { /* The toggle keeps its previous state on failure. */ }
    el.receiptsToggle.disabled = false;
  });

  async function boot() {
    try { await loadOverview(); }
    catch { setSignedIn(false); }
  }

  boot();
})();
