'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PNG } = require('pngjs');

const publicDir = path.join(__dirname, '../public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');
const origin = 'https://checkout.test';
const allowed = ['/offline.html', '/offline.css', '/offline.js', '/pwa-icons/icon-192.png',
  '/pwa-icons/icon-512.png', '/pwa-icons/maskable-512.png', '/pwa-icons/apple-touch-icon.png'];
const key = (request) => typeof request === 'string' ? request : request.url;

function assetResponse(request, overrides = {}) {
  const url = key(request);
  const pathname = new URL(url).pathname;
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
  const response = new Response(pathname === '/offline.html' ? read('offline.html') : 'fixture', {
    headers: { 'content-type': types[path.extname(pathname)] || 'text/plain' },
  });
  Object.defineProperties(response, Object.fromEntries(Object.entries({ url, type: 'basic', redirected: false, ...overrides })
    .map(([name, value]) => [name, { value, configurable: true }])));
  return response;
}

function worker({ stores = new Map(), version = '1' } = {}) {
  const listeners = new Map();
  const calls = [];
  const writes = [];
  const matches = [];
  const deleted = [];
  let takeovers = 0;
  let fetchImpl = assetResponse;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return { async put(request, response) {
        writes.push(key(request));
        stores.get(name).set(key(request), response.clone());
      } };
    },
    async match(request, options) {
      matches.push({ url: key(request), cacheName: options.cacheName });
      return stores.get(options.cacheName)?.get(key(request))?.clone();
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  vm.runInNewContext(read('sw.js').replace('erraza-offline-v1', `erraza-offline-v${version}`), {
    URL, Request, Response, caches,
    self: {
      location: { origin },
      addEventListener(name, callback) { listeners.set(name, callback); },
      skipWaiting() { takeovers += 1; },
      clients: { claim() { takeovers += 1; } },
    },
    fetch(request, options) {
      calls.push({ request, options });
      return Promise.resolve().then(() => fetchImpl(request, options));
    },
  });
  return {
    stores, calls, writes, matches, deleted, listeners,
    get takeovers() { return takeovers; },
    setFetch(implementation) { fetchImpl = implementation; },
    offline() { fetchImpl = () => { throw new TypeError('Network unavailable'); }; },
    async lifecycle(name) {
      let work;
      listeners.get(name)({ waitUntil(promise) { work = promise; } });
      await work;
    },
    request(url, { navigate = false, ...options } = {}) {
      const request = new Request(new URL(url, origin), options);
      if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      let response;
      listeners.get('fetch')({ request, respondWith(value) { response = Promise.resolve(value); } });
      return response;
    },
  };
}

function eventTarget(target = {}) {
  const listeners = new Map();
  target.addEventListener = (name, callback, options) => {
    const entries = listeners.get(name) || [];
    entries.push({ callback, options });
    listeners.set(name, entries);
  };
  target.dispatch = (name, event = {}) => Promise.all((listeners.get(name) || []).map(({ callback, options }) => {
    if (options?.once) listeners.set(name, listeners.get(name).filter((entry) => entry.callback !== callback));
    return callback(event);
  }));
  target.listeners = listeners;
  return target;
}

function installer(options = {}) {
  const registrations = [];
  const attributes = {};
  const button = eventTarget({ hidden: true, disabled: false });
  const heading = { setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; } };
  const dialog = {
    open: false, shows: 0,
    showModal() { this.open = true; this.shows += 1; },
    querySelector() { return heading; },
  };
  const display = eventTarget({ matches: options.displayStandalone || false });
  const window = eventTarget({ isSecureContext: options.secure !== false, matchMedia: () => display });
  const document = eventTarget({
    readyState: options.readyState || 'complete',
    documentElement: { setAttribute(name, value) { attributes[name] = value; } },
    querySelectorAll() { return options.noButton ? [] : [button]; },
    getElementById() { return options.noDialog ? null : dialog; },
  });
  const navigator = {
    userAgent: options.userAgent || 'Desktop browser', platform: options.platform || '',
    maxTouchPoints: options.maxTouchPoints || 0, standalone: options.standalone || false,
  };
  if (options.supported !== false) navigator.serviceWorker = { register(url, settings) {
    registrations.push({ url, ...settings });
    return options.register ? options.register() : Promise.resolve({});
  } };
  vm.runInNewContext(read('pwa.js'), { window, document, navigator });
  return { window, document, navigator, button, heading, dialog, display, registrations, attributes };
}

const click = (isTrusted = true) => ({ isTrusted, preventDefault() {} });
const offerInstall = () => ({
  prevented: false, prompts: 0,
  preventDefault() { this.prevented = true; },
  prompt() { this.prompts += 1; return Promise.resolve(); },
  userChoice: Promise.resolve({ outcome: 'dismissed' }),
});

test('manifest has clean root launch and real regular, maskable and Apple PNG icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Erraza');
  for (const property of ['id', 'scope', 'start_url']) assert.equal(manifest[property], '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#111b1e');
  assert.equal(manifest.theme_color, '#83cfb6');
  assert.deepEqual(manifest.icons.map(({ sizes, purpose }) => [sizes, purpose]),
    [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]);
  for (const icon of [...manifest.icons, { src: '/pwa-icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]) {
    assert.equal(icon.type, 'image/png');
    assert.ok(allowed.includes(icon.src));
    const bytes = fs.readFileSync(path.join(publicDir, icon.src));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const image = PNG.sync.read(bytes);
    assert.equal(`${image.width}x${image.height}`, icon.sizes);
    let markPixels = 0;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        assert.equal(image.data[offset + 3], 255);
        if (image.data[offset] === 0x11 && image.data[offset + 1] === 0x1b && image.data[offset + 2] === 0x1e) continue;
        markPixels += 1;
        if (icon.purpose === 'maskable') {
          assert.ok(Math.hypot(x + .5 - image.width / 2, y + .5 - image.height / 2) < image.width * .4,
            'Every maskable logo pixel must be inside the safe circle');
        }
      }
    }
    assert.ok(markPixels > image.width * image.height * .1, 'Icon must contain an actual mark');
  }
});

test('install writes only the fixed offline allowlist without cookies, redirects or HTTP caching', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  assert.deepEqual(sw.writes.sort(), allowed.map((url) => origin + url).sort());
  assert.equal(sw.calls.length, allowed.length);
  for (const { request } of sw.calls) {
    assert.equal(request.method, 'GET');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.equal(new URL(request.url).search, '');
  }
  assert.equal(sw.takeovers, 0);
});

test('unsafe asset responses abort install before any cache writes', async () => {
  for (const overrides of [
    { redirected: true }, { url: origin + '/?token=private' }, { type: 'opaque' }, { status: 500 },
    { headers: new Headers({ 'content-type': 'text/html' }) },
  ]) {
    const sw = worker();
    sw.setFetch((request) => assetResponse(request, new URL(request.url).pathname === '/offline.css' ? overrides : {}));
    await assert.rejects(sw.lifecycle('install'), /safely cached/);
    assert.equal(sw.writes.length, 0);
  }
  const sw = worker();
  sw.offline();
  await assert.rejects(sw.lifecycle('install'), /Network unavailable/);
  assert.equal(sw.writes.length, 0);
});

test('worker never handles API, mutations, cross-origin or non-allowlisted resource requests', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  sw.calls.length = 0;
  const paths = ['/', '/index.html', '/app.js', '/styles.css', '/pwa.js', '/sw.js', '/manifest.webmanifest',
    '/api', '/api/config', '/api/checkout', '/api/payment?token=secret', '/receipt/private',
    '/pay/private-token', '/payment-address/bc1qfixture', '/create-link.html', '/payment-links.js',
    '/offline.css?token=private', '/offline.js?', '/pwa-icons/icon-192.png?amount=20', '/offline.html#secret',
    '/pwa-icons/other.png', 'https://provider.test/offline.css'];
  for (const url of paths) assert.equal(sw.request(url), undefined, url);
  for (const url of ['/api', '/api/config', '/API/status', '/%61pi/status', '/api%2Fpayment?token=secret', 'https://provider.test/']) {
    assert.equal(sw.request(url, { navigate: true }), undefined, url);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
    assert.equal(sw.request('/offline.html', { method, navigate: true }), undefined, method);
  }
  for (const headers of [{ Authorization: 'Bearer fixture' }, { Range: 'bytes=0-10' }]) {
    assert.equal(sw.request('/offline.css', { headers }), undefined);
  }
  assert.equal(sw.calls.length, 0);
  assert.equal(sw.writes.length, allowed.length);
});

test('navigations use no-store network, preserve HTTP errors, and never persist checkout data', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  for (const status of [200, 400, 500]) {
    sw.setFetch(() => new Response('private checkout response', { status }));
    const response = await sw.request('/?amount=125&token=private', { navigate: true });
    assert.equal(response.status, status);
    assert.equal(await response.text(), 'private checkout response');
    assert.equal(sw.calls.at(-1).options.cache, 'no-store');
  }
  assert.equal(sw.writes.length, allowed.length);
  assert.equal(sw.matches.length, 0);
});

test('offline navigation uses the same generic fallback, never the requested URL as a cache key', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  sw.offline();
  for (const url of ['/', '/?amount=125&token=private', '/receipt/private-token', '/pay/personalized-link']) {
    const response = await sw.request(url, { navigate: true });
    assert.equal(await response.text(), read('offline.html'));
    assert.equal(sw.calls.at(-1).options.cache, 'no-store');
    assert.deepEqual(sw.matches.at(-1), { url: origin + '/offline.html', cacheName: 'erraza-offline-v1' });
  }
  for (const url of allowed) assert.ok(await sw.request(url), url);
  assert.equal(sw.writes.length, allowed.length);
});

test('missing offline cache fails closed and missing static assets never create runtime cache writes', async () => {
  const sw = worker();
  sw.stores.set('unrelated-app', new Map([[origin + '/offline.html', new Response('untrusted offline page')]]));
  sw.offline();
  const response = await sw.request('/', { navigate: true });
  assert.equal(response.type, 'error');
  sw.setFetch(assetResponse);
  await sw.request('/offline.css');
  assert.equal(sw.calls.at(-1).options.cache, 'no-store');
  assert.equal(sw.writes.length, 0);
});

test('updates wait conservatively and activation removes only obsolete Erraza offline caches', async () => {
  const first = worker();
  await first.lifecycle('install');
  for (const name of ['other-app-v1', 'erraza-settings', 'erraza-offline', 'checkout-history']) first.stores.set(name, new Map());
  const update = worker({ stores: first.stores, version: '2' });
  await update.lifecycle('install');
  assert.ok(update.stores.has('erraza-offline-v1'), 'Installation must leave the active cache intact');
  assert.ok(update.stores.has('erraza-offline-v2'));
  assert.equal(update.takeovers, 0);
  assert.equal(update.listeners.has('message'), false);
  await update.lifecycle('activate');
  assert.deepEqual(update.deleted, ['erraza-offline-v1']);
  assert.equal(update.takeovers, 0);
  for (const name of ['other-app-v1', 'erraza-settings', 'erraza-offline', 'checkout-history', 'erraza-offline-v2']) assert.ok(update.stores.has(name));
  const failedUpdate = worker({ stores: update.stores, version: '3' });
  failedUpdate.offline();
  await assert.rejects(failedUpdate.lifecycle('install'));
  assert.ok(failedUpdate.stores.has('erraza-offline-v2'));
  assert.equal(failedUpdate.stores.has('erraza-offline-v3'), false);
});

test('installer registers after load with updateViaCache none and no required helper DOM', async () => {
  const ui = installer({ readyState: 'loading', noButton: true, noDialog: true });
  assert.equal(ui.registrations.length, 0);
  await ui.document.dispatch('DOMContentLoaded');
  assert.equal(ui.registrations.length, 0);
  await ui.window.dispatch('load');
  assert.deepEqual(ui.registrations, [{ url: '/sw.js', scope: '/', updateViaCache: 'none' }]);
  await ui.window.dispatch('load');
  assert.equal(ui.registrations.length, 1);
  for (const options of [{ secure: false }, { supported: false }]) {
    const disabled = installer(options);
    const offer = offerInstall();
    await disabled.window.dispatch('beforeinstallprompt', offer);
    assert.equal(disabled.registrations.length, 0);
    assert.equal(disabled.button.hidden, true);
    assert.equal(offer.prevented, false);
  }
  assert.doesNotThrow(() => installer({ register() { throw new Error('Browser policy'); } }));
  installer({ register: () => Promise.reject(new Error('Registration denied')) });
  await new Promise((resolve) => setImmediate(resolve));
});

test('installation prompts only on a trusted click and a consumed or installed prompt stays hidden', async () => {
  const ui = installer();
  assert.equal(ui.button.hidden, true);
  const offer = offerInstall();
  await ui.window.dispatch('beforeinstallprompt', offer);
  assert.equal(offer.prevented, true);
  assert.equal(ui.button.hidden, false);
  assert.equal(offer.prompts, 0);
  await ui.button.dispatch('click', click(false));
  assert.equal(offer.prompts, 0);
  await ui.button.dispatch('click', click());
  assert.equal(offer.prompts, 1);
  assert.equal(ui.button.hidden, true);
  await ui.button.dispatch('click', click());
  assert.equal(offer.prompts, 1);
  const nextOffer = offerInstall();
  await ui.window.dispatch('beforeinstallprompt', nextOffer);
  assert.equal(ui.button.hidden, false);
  await ui.window.dispatch('appinstalled');
  assert.equal(ui.button.hidden, true);
  await ui.button.dispatch('click', click());
  assert.equal(nextOffer.prompts, 0);
});

test('rejected install prompts are contained and standalone display hides install controls', async () => {
  const ui = installer();
  await ui.window.dispatch('beforeinstallprompt', { ...offerInstall(), prompt() { throw new Error('Prompt blocked'); } });
  await ui.button.dispatch('click', click());
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, false);
  const offer = offerInstall();
  await ui.window.dispatch('beforeinstallprompt', offer);
  ui.display.matches = true;
  await ui.display.dispatch('change');
  assert.equal(ui.attributes['data-standalone'], 'true');
  assert.equal(ui.button.hidden, true);
  await ui.button.dispatch('click', click());
  assert.equal(offer.prompts, 0);
});

test('iOS guidance uses only the native dialog and focuses a heading, not in standalone or webviews', async () => {
  for (const options of [
    { userAgent: 'iPhone Version/18.0 Mobile Safari/604.1' },
    { userAgent: 'Macintosh Version/18.0 Safari/605.1', platform: 'MacIntel', maxTouchPoints: 5 },
  ]) {
    const ui = installer(options);
    assert.equal(ui.button.hidden, false);
    assert.equal(ui.dialog.shows, 0);
    await ui.button.dispatch('click', click(false));
    assert.equal(ui.dialog.shows, 0);
    await ui.button.dispatch('click', click());
    assert.equal(ui.dialog.shows, 1);
    assert.equal(ui.heading.focused, true);
    assert.equal(ui.heading.tabindex, '-1');
    for (const variation of [{ standalone: true }, { displayStandalone: true }, { noDialog: true }]) {
      assert.equal(installer({ ...options, ...variation }).button.hidden, true);
    }
  }
  assert.equal(installer({ userAgent: 'iPhone Mobile embedded-webview' }).button.hidden, true);
});

test('offline page is generic, self-contained and CSP-safe with explicit reload only', async () => {
  const html = read('offline.html');
  assert.ok(html.includes('You’re offline. Reconnect to continue. If you already paid, check its status before trying again.'));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'; style-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son\w+=|http-equiv="refresh"|<form\b|unsafe-inline/i);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /src="\/offline.js"/);
  assert.equal(scripts[0][2].trim(), '');
  for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(allowed.includes(url), url);
  assert.doesNotMatch(read('offline.js'), /fetch\(|localStorage|sessionStorage|setInterval|setTimeout|\.search|\.hash/);
  let reloads = 0;
  const button = eventTarget({ hidden: true });
  const window = eventTarget({ location: { reload() { reloads += 1; } } });
  const document = eventTarget({ readyState: 'complete', getElementById: () => button });
  vm.runInNewContext(read('offline.js'), { window, document });
  assert.equal(button.hidden, false);
  assert.equal(reloads, 0);
  await window.dispatch('online');
  assert.equal(reloads, 0);
  await button.dispatch('click', click(false));
  assert.equal(reloads, 0);
  await button.dispatch('click', click());
  assert.equal(reloads, 1);
  assert.doesNotThrow(() => vm.runInNewContext(read('offline.js'), { window, document: { readyState: 'complete', getElementById: () => null } }));
});
