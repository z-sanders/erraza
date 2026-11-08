'use strict';

// Offline structural/syntax checks only. No credentials, handlers, server,
// provider API, test suite, or payment-generating code is executed here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ICONS, FONT_LICENSES } = require('./build');
const { SECURITY_HEADERS } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
const fail = message => failures.push(message);
const API_NAMES = ['config', 'currencies', 'estimate', 'min-amount', 'checkout', 'status', 'ipn', 'reconcile'];

async function exists(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function walk(directory, publicFiles = false) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    // Never read credential files, customer data, dependency trees, or links.
    if (entry.name.startsWith('.') || /^(?:orders|customers?)(?:\.|$)/i.test(entry.name)
      || /\.(?:pem|key|p12|pfx|map|log)$/i.test(entry.name) || /^(?:node_modules|\.git|\.vercel)$/.test(entry.name)) {
      if (publicFiles) fail(`Private/build-only path found in public: ${path.relative(ROOT, filename)}`);
      continue;
    }
    if (entry.isSymbolicLink()) { fail(`Symbolic link is not allowed in app assets/source: ${path.relative(ROOT, filename)}`); continue; }
    if (entry.isDirectory()) output.push(...await walk(filename, publicFiles));
    else if (entry.isFile()) output.push(filename);
  }
  return output;
}

async function requireAsset(relative) {
  const stat = await exists(path.join(ROOT, relative));
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0) fail(`Missing regular asset: ${relative}; run npm run build first.`);
}

async function check() {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('Use Node.js 24.x.');
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.engines?.node !== '24.x') fail('package.json must pin engines.node to 24.x.');
  const expectedScripts = {
    start: 'node server.js', dev: 'node --watch server.js', build: 'node scripts/build.js',
    test: 'node --test test/*.test.js', check: 'node scripts/check.js',
  };
  for (const [name, command] of Object.entries(expectedScripts)) if (pkg.scripts?.[name] !== command) fail(`Unexpected package script: ${name}`);

  const vercel = JSON.parse(await fs.readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
  if (vercel.framework !== null || vercel.outputDirectory !== 'public' || vercel.buildCommand !== 'npm run build') fail('Vercel must build the plain public directory.');
  if (vercel.functions?.['api/*.js']?.maxDuration !== 60) fail('Vercel API maxDuration must be 60 seconds.');
  if (vercel.rewrites?.length || vercel.routes?.length) fail('Do not introduce SPA catch-all rewrites/routes.');
  const headers = new Map((vercel.headers?.find(rule => rule.source === '/(.*)')?.headers || []).map(header => [header.key, header.value]));
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (headers.get(name) !== value) fail(`Local/Vercel security header mismatch: ${name}`);
  const apiCache = vercel.headers?.find(rule => rule.source === '/api/(.*)')?.headers?.find(header => header.key === 'Cache-Control');
  if (!apiCache?.value.includes('no-store')) fail('API responses must not be cached.');
  for (const route of ['/', '/index.html', '/create-link.html']) {
    const cache = vercel.headers?.find(rule => rule.source === route)?.headers?.find(header => header.key === 'Cache-Control');
    if (!cache?.value.includes('no-store')) fail(`Payment documents must not be cached: ${route}`);
  }
  const workerCache = vercel.headers?.find(rule => rule.source === '/sw.js')?.headers?.find(header => header.key === 'Cache-Control');
  if (!workerCache?.value.includes('must-revalidate')) fail('The service worker must be revalidated.');

  for (const name of API_NAMES) {
    const stat = await exists(path.join(ROOT, 'api', `${name}.js`));
    if (!stat?.isFile() || stat.isSymbolicLink()) fail(`Missing regular API handler: ${name}.js`);
  }

  // Import deployed CommonJS modules in a guarded child without invoking handlers.
  // This catches initialization/export failures while forbidding env-file reads,
  // outbound network calls, and listeners during the smoke gate.
  const smokeSource = `
    'use strict';
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.argv[1];
    const apiNames = JSON.parse(process.argv[2]);
    const blocked = action => () => { throw new Error('Module-load smoke attempted to ' + action); };
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
      const normalized = Buffer.isBuffer(filename) ? filename.toString() : filename instanceof URL ? filename.pathname : filename;
      if (typeof normalized === 'string' && /^\.env(?:\.|$)/.test(path.basename(normalized))) blocked('read an environment file')();
      return originalReadFileSync.call(this, filename, ...args);
    };
    const originalOpenSync = fs.openSync;
    fs.openSync = function (filename, ...args) {
      const normalized = Buffer.isBuffer(filename) ? filename.toString() : filename instanceof URL ? filename.pathname : filename;
      if (typeof normalized === 'string' && /^\.env(?:\.|$)/.test(path.basename(normalized))) blocked('read an environment file')();
      return originalOpenSync.call(this, filename, ...args);
    };
    process.loadEnvFile = blocked('read an environment file');
    globalThis.fetch = blocked('contact the network');
    const net = require('node:net');
    net.connect = blocked('contact the network');
    net.createConnection = blocked('contact the network');
    net.Server.prototype.listen = blocked('open a listener');
    for (const protocol of ['node:http', 'node:https']) {
      const client = require(protocol);
      client.request = blocked('contact the network');
      client.get = blocked('contact the network');
    }
    const handlers = require(path.join(root, 'lib', 'handlers.js'));
    for (const name of ['createHandlers', 'handler', 'clientIp']) {
      if (typeof handlers[name] !== 'function') throw new TypeError('lib/handlers.js export is not a function: ' + name);
    }
    for (const name of apiNames) {
      const entry = require(path.join(root, 'api', name + '.js'));
      if (typeof entry !== 'function') throw new TypeError('API entrypoint export is not a function: ' + name);
    }
  `;
  const smoke = spawnSync(process.execPath, ['-e', smokeSource, ROOT, JSON.stringify(API_NAMES)], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec },
  });
  const moduleCount = API_NAMES.length + 1;
  if (smoke.status !== 0) fail(`CommonJS module-load smoke failed:\n${smoke.stderr || smoke.stdout || smoke.error?.message || 'Unknown failure'}`);

  const files = [path.join(ROOT, 'server.js')];
  for (const directory of ['api', 'lib', 'scripts', 'public', 'test']) {
    if (await exists(path.join(ROOT, directory))) files.push(...await walk(path.join(ROOT, directory), directory === 'public'));
  }
  let syntaxCount = 0;
  for (const filename of files.filter(file => /\.(?:js|cjs|mjs)$/.test(file))) {
    const result = spawnSync(process.execPath, ['--check', filename], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) fail(`Syntax check failed: ${path.relative(ROOT, filename)}\n${result.stderr || result.error?.message || ''}`);
    syntaxCount++;
  }

  for (const filename of ['index.html', 'app.js', 'styles.css', 'favicon.svg', 'payment-links.js', 'create-link.html', 'create-link.js', 'mobile.js', 'pwa.js', 'sw.js', 'manifest.webmanifest', 'offline.html', 'offline.css', 'offline.js']) await requireAsset(`public/${filename}`);
  for (const name of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png']) await requireAsset(`public/pwa-icons/${name}`);
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
  if (manifest.id !== '/' || manifest.start_url !== '/' || manifest.scope !== '/' || manifest.display !== 'standalone') fail('PWA launch URL must be clean, same-site and standalone.');
  for (const name of ICONS) await requireAsset(`public/icons/${name}.svg`);
  await requireAsset('public/icons/LICENSE.txt');
  for (const name of ['inter-var.woff2', 'space-grotesk-var.woff2']) await requireAsset(`public/fonts/${name}`);
  for (const name of [...Object.keys(FONT_LICENSES), 'SOURCES.txt']) await requireAsset(`public/fonts/licenses/${name}`);

  for (const filename of files.filter(file => file.startsWith(path.join(ROOT, 'public') + path.sep) && /\.(?:html|css)$/.test(file))) {
    const source = await fs.readFile(filename, 'utf8');
    if (/fonts\.(?:googleapis|gstatic)\.com/i.test(source)) fail(`External font dependency violates self-only CSP: ${path.relative(ROOT, filename)}`);
    if (/\.html$/.test(filename)) {
      if (/<iframe\b/i.test(source)) fail('Provider iframes are intentionally unsupported.');
      if (/<style\b|\sstyle\s*=|\son[a-z]+\s*=/i.test(source)) fail(`Inline styles/handlers conflict with CSP: ${path.relative(ROOT, filename)}`);
      for (const script of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (!/\bsrc\s*=/.test(script[1]) && script[2].trim()) fail(`Inline script conflicts with CSP: ${path.relative(ROOT, filename)}`);
      }
    }
  }
  if (failures.length) {
    for (const message of failures) console.error(`[check] ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`Offline checks passed: ${syntaxCount} JavaScript files, ${moduleCount} CommonJS modules loaded and export-checked, Vercel/header configuration, and required public assets.`);
    console.log('This does not run tests or certify Supabase, provider accounts, browser behavior, or live payments.');
  }
}

if (require.main === module) {
  check().catch(error => {
    console.error('[check]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { check };
