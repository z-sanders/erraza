'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, SECURITY_HEADERS } = require('../server');
const { createHandlers } = require('../lib/handlers');
const { config, memoryStore, providerDouble } = require('./helpers');

async function start(t, configured = false) {
  const settings = { ...config, configured, origin: 'http://localhost:3000' };
  const routes = createHandlers({ config: settings, store: memoryStore(), provider: providerDouble() });
  const server = createServer({ handlers: Object.fromEntries(Object.entries(routes).map(([key, handler]) => [`/api/${key}`, handler])) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, port: server.address().port };
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}

test('normal static server returns current frontend and a fail-closed API', async t => {
  const { port } = await start(t);
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Payment details/);
  assert.equal(page.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy']);
  const boot = await request(port, '/api/config');
  assert.equal(JSON.parse(boot.text).configured, false);
  const wrong = await request(port, '/api/checkout');
  assert.equal(wrong.status, 405);
  assert.equal((await request(port, '/styles.css', 'HEAD')).text, '');
});

test('fiat is first and selected in both the initial page and application state', async t => {
  const { port } = await start(t);
  const page = await request(port, '/');
  const script = await request(port, '/app.js');
  assert.ok(page.text.indexOf('id="methodCard"') < page.text.indexOf('id="methodCrypto"'));
  assert.match(page.text, /<input\b[^>]*id="methodCard"[^>]*\bchecked\b/);
  assert.doesNotMatch(page.text, /<input\b[^>]*id="methodCrypto"[^>]*\bchecked\b/);
  assert.match(page.text, /<div\b[^>]*id="cryptoPanel"[^>]*\bhidden\b/);
  assert.doesNotMatch(page.text + script.text, /cardPanel|card-explanation/);
  const form = page.text.match(/<form\b[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.doesNotMatch(form, /converted to crypto|fiat on-ramp|Your card\. A crypto payment\./);
  assert.match(page.text, /My payment is pending or failed\. What should I do\?/);
  assert.doesNotMatch(page.text, /What is a card-to-crypto payment\?/);
  assert.match(script.text, /method: 'card'/);
  assert.doesNotMatch(page.text + script.text, /awaiting merchant setup|Setup needed|Not enabled|has not been enabled in this checkout’s configuration/);
  assert.match(script.text, /Checkout is temporarily unavailable\. Please try again later\./);
  assert.doesNotMatch(page.text + script.text, /payeeMerchant/);
  assert.doesNotMatch(page.text + script.text, /payeeReferenceRow|payeeReference/);
  assert.doesNotMatch(page.text, /A few details, then you’re on your way/);
  assert.match(page.text, /id="continueAmount" hidden/);
});

test('payment link creator and shared validation assets are served without creating orders', async t => {
  const { port } = await start(t);
  const creator = await request(port, '/create-link.html');
  assert.equal(creator.status, 200);
  assert.match(creator.text, /Create a payment link/);
  assert.match(creator.text, /name="robots" content="noindex, nofollow"/);
  assert.equal((await request(port, '/create-link.js')).status, 200);
  assert.equal((await request(port, '/payment-links.js')).status, 200);
  const payer = await request(port, '/?amount=125.00&currency=eur');
  assert.equal(payer.status, 200);
  assert.doesNotMatch(payer.text, /Create a payment link/);
  assert.match(payer.text, /src="\/payment-links.js"/);
});

test('payer help is practical and privacy opens separately', async t => {
  const { port } = await start(t);
  const page = await request(port, '/');
  const help = page.text.match(/<dialog\b[^>]*id="helpDialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(help);
  assert.match(help, /Will I pay any fees\?/);
  assert.match(help, /My payment is pending or failed/);
  assert.doesNotMatch(help, /fiat on-ramp|payment token|retry key|timestamp|third-party tracking|card-to-crypto/);
  assert.match(page.text, /id="privacyButton"[^>]*aria-controls="privacyDialog"/);
  assert.match(page.text, /<dialog\b[^>]*id="privacyDialog"/);
});

test('PWA assets have correct types while checkout documents and APIs are not cached', async t => {
  const { port } = await start(t);
  for (const path of ['/', '/?amount=100&currency=usd&for=Mina', '/index.html', '/create-link.html', '/api/config']) {
    const response = await request(port, path);
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'], /no-store/);
  }
  const manifest = await request(port, '/manifest.webmanifest');
  assert.equal(manifest.headers['content-type'], 'application/manifest+json');
  assert.equal(JSON.parse(manifest.text).display, 'standalone');
  const worker = await request(port, '/sw.js');
  assert.match(worker.headers['content-type'], /javascript/);
  assert.match(worker.headers['cache-control'], /must-revalidate/);
  assert.equal((await request(port, '/offline.html')).status, 200);
});

test('static routes reject traversal malformed encodings and deployment secrets', async t => {
  const { port } = await start(t);
  for (const path of ['/../.env', '/%2e%2e/server.js', '/%2e%2e/public-private/secret.txt', '/%5c..%5c.env', '/%zz', '/api/%xx', '/server.js', '/package.json', '/orders.json', '/.env', '/not-a-route']) {
    const response = await request(port, path);
    assert.ok([400, 404].includes(response.status), `${path}: ${response.status}`);
    assert.doesNotMatch(response.text, /NOWPAYMENTS_API_KEY|PRIVATE KEY|createHmac/);
  }
  assert.equal((await request(port, '/')).status, 200, 'server survives bad paths');
});
