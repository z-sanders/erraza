#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PUBLIC_DIRECTORY = path.join(__dirname, 'public');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
});
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});

// The exact same CommonJS handlers are deployed as Vercel functions.
// Nothing is loaded from a user-controlled path; no duplicate payment backend.
function loadRoutes() {
  return new Map([
    ['/api/config', require('./api/config.js')],
    ['/api/currencies', require('./api/currencies.js')],
    ['/api/estimate', require('./api/estimate.js')],
    ['/api/min-amount', require('./api/min-amount.js')],
    ['/api/checkout', require('./api/checkout.js')],
    ['/api/status', require('./api/status.js')],
    ['/api/ipn', require('./api/ipn.js')],
    ['/api/reconcile', require('./api/reconcile.js')],
  ]);
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function reply(req, res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(JSON.stringify({ error: message }));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function requestPath(target) {
  if (typeof target !== 'string' || target.length > 8192 || !target.startsWith('/') || target.startsWith('//')
    || /[\x00-\x20\x7f#]/.test(target) || /%(?![0-9a-f]{2})/i.test(target)) return null;
  const rawPath = target.split('?')[0];
  if (/%2f|%5c/i.test(rawPath)) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (/[\x00-\x1f\x7f\\:%]/.test(decoded)) return null;
  return decoded;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(req, res, 405, 'method_not_allowed');
  }
  const segments = (pathname === '/' ? '/index.html' : pathname).slice(1).split('/');
  if (segments.some(segment => !segment || segment.startsWith('.'))) return reply(req, res, 404, 'not_found');
  const filename = path.resolve(PUBLIC_DIRECTORY, ...segments);
  const type = MIME[path.extname(filename).toLowerCase()];
  if (!type || !contains(PUBLIC_DIRECTORY, filename)) return reply(req, res, 404, 'not_found');

  let file;
  try {
    const root = await fs.realpath(PUBLIC_DIRECTORY);
    const real = await fs.realpath(filename);
    if (!contains(root, real)) return reply(req, res, 404, 'not_found');
    file = await fs.open(real, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return reply(req, res, 404, 'not_found');
    const body = req.method === 'HEAD' ? undefined : await file.readFile();
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body ? body.length : stat.size,
      'Cache-Control': pathname === '/' || (pathname.endsWith('.html') && pathname !== '/offline.html')
        ? 'no-store, max-age=0'
        : pathname === '/sw.js' ? 'no-cache, max-age=0, must-revalidate' : 'no-cache',
    });
    res.end(body);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return reply(req, res, 404, 'not_found');
    throw error;
  } finally {
    if (file) await file.close();
  }
}

function createServer({ handlers } = {}) {
  // Dependency injection is explicit and only for tests; the CLI never supplies it.
  const routes = handlers === undefined ? loadRoutes()
    : handlers instanceof Map ? new Map(handlers) : new Map(Object.entries(handlers));
  const allowedRoutes = new Set(['/api/config', '/api/currencies', '/api/estimate', '/api/min-amount', '/api/checkout', '/api/status', '/api/ipn', '/api/reconcile']);
  if (routes.size !== allowedRoutes.size || [...routes].some(([route, handler]) => !allowedRoutes.has(route) || typeof handler !== 'function')) {
    throw new TypeError('Supply exactly the eight API route handlers.');
  }
  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const pathname = requestPath(req.url);
      if (pathname === null) return reply(req, res, 400, 'bad_url');
      const handler = routes.get(pathname);
      if (handler) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return await handler(req, res);
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) return reply(req, res, 404, 'not_found');
      return await serveStatic(req, res, pathname);
    } catch (error) {
      // Do not log request URLs, bodies, credentials, or receipt tokens.
      console.error('[local] request failed', error?.name || 'Error');
      reply(req, res, 500, 'internal_error');
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

function main() {
  try { process.loadEnvFile(path.join(__dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rawPort = process.env.PORT || '3000';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const port = Number(rawPort);
  const server = createServer();
  server.on('error', error => {
    console.error('[local] server failed', error.code || error.name);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Checkout available at http://localhost:${port} (loopback only).`);
    console.log('The shared API fails closed until its backend configuration is complete.');
  });
}

module.exports = { createServer, SECURITY_HEADERS };

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error('[local] startup failed', error.code || error.name);
    process.exitCode = 1;
  }
}
