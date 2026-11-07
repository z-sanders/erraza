'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function mobileUi() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, textContent: '', setAttribute() {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const statusChecks = [];
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const instrumented = source.replace(/  boot\(\);\s*\}\)\(\);\s*$/, '  globalThis.ui = { state, refreshOnReturn, openDialog, fitReadonlyFields, setStatusCheck: fn => { checkStatus = fn; } };\n})();');
  const document = { getElementById: element, hidden: false };
  const context = vm.createContext({ document, window: { PaymentLinks: require('../public/payment-links') }, getComputedStyle: () => ({ lineHeight: '24px', paddingTop: '11px', paddingBottom: '11px' }) });
  vm.runInContext(instrumented, context);
  const ui = context.ui;
  ui.setStatusCheck(manual => statusChecks.push(manual));
  return { ui, document, statusChecks };
}

test('returning to an unresolved payment refreshes even after bounded polling stopped', () => {
  const { ui, statusChecks } = mobileUi();
  Object.assign(ui.state, { token: 'saved-payment', order: { complete: false }, pollStopped: true, pollDeadline: Date.now() - 3600000 });
  ui.refreshOnReturn();
  assert.deepEqual(statusChecks, [true]);
  ui.refreshOnReturn();
  assert.deepEqual(statusChecks, [true], 'Back-to-back visibility and pageshow events do not duplicate checks.');
});

test('foreground refresh skips hidden, already-checking and complete payments', () => {
  for (const scenario of ['hidden', 'busy', 'complete', 'no-token']) {
    const { ui, document, statusChecks } = mobileUi();
    Object.assign(ui.state, { token: scenario === 'no-token' ? null : 'saved', order: { complete: scenario === 'complete' }, pollBusy: scenario === 'busy' });
    document.hidden = scenario === 'hidden';
    ui.refreshOnReturn();
    assert.equal(statusChecks.length, 0, scenario);
  }
});

test('dialog opening resets stale scroll position and does not force an input keyboard', () => {
  const { ui } = mobileUi();
  const dialog = { open: false, scrollTop: 500, showModal() { this.open = true; }, querySelectorAll: () => [] };
  const heading = { focus(options) { this.focusOptions = options; } };
  ui.openDialog(dialog, heading);
  assert.equal(dialog.scrollTop, 0);
  assert.equal(heading.focusOptions.preventScroll, true);
  dialog.scrollTop = 125;
  ui.openDialog(dialog, heading);
  assert.equal(dialog.scrollTop, 125, 'An already open dialog retains its deliberate scroll position.');
});

test('long payment addresses are expanded without resizing on every poll', () => {
  const { ui } = mobileUi();
  const field = { clientWidth: 260, scrollHeight: 142, rows: 2, dataset: {}, value: 'long-payment-address' };
  ui.fitReadonlyFields({ querySelectorAll: () => [field] });
  assert.equal(field.rows, 5);
  field.scrollHeight = 22;
  ui.fitReadonlyFields({ querySelectorAll: () => [field] });
  assert.equal(field.rows, 5, 'Identical values and widths are not resized repeatedly.');
});

test('mobile markup puts address and required memo before expandable QR', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('id="paymentAddress"') < html.indexOf('id="paymentQrWrap"'));
  assert.ok(html.indexOf('id="paymentMemo"') < html.indexOf('id="paymentQrWrap"'));
  assert.match(html, /<details\b[^>]*id="paymentQrWrap"/);
  assert.match(html, /enterkeyhint="done"/);
  assert.match(html, /src="\/mobile.js"/);
});
