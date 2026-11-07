'use strict';

// Bump this version whenever an offline file changes. Updates wait for old tabs
// to close naturally; a worker update must never interrupt an active payment.
const CACHE_NAME = 'erraza-offline-v1';
const OFFLINE_PATH = '/offline.html';
const OFFLINE_ASSETS = [
  [OFFLINE_PATH, ['text/html']],
  ['/offline.css', ['text/css']],
  ['/offline.js', ['text/javascript', 'application/javascript']],
  ['/pwa-icons/icon-192.png', ['image/png']],
  ['/pwa-icons/icon-512.png', ['image/png']],
  ['/pwa-icons/maskable-512.png', ['image/png']],
  ['/pwa-icons/apple-touch-icon.png', ['image/png']],
];
const offlineUrl = new URL(OFFLINE_PATH, self.location.origin).href;
const assetUrls = new Set(OFFLINE_ASSETS.map(([path]) => new URL(path, self.location.origin).href));

async function installOfflineFiles() {
  // Only literal, public URLs are fetched. No cookies, auth, referrers, redirects,
  // or HTTP-cache reuse can turn a checkout response into our offline document.
  const entries = await Promise.all(OFFLINE_ASSETS.map(async ([path, types]) => {
    const request = new Request(new URL(path, self.location.origin).href, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    const response = await fetch(request);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || response.status !== 200 || response.type !== 'basic'
      || response.redirected || response.url !== request.url || !types.includes(type)) {
      throw new Error('An offline asset could not be safely cached.');
    }
    return [request, response];
  }));
  // Validate every download before writing any response. These are the only
  // cache writes in this worker; there is deliberately no runtime caching.
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(entries.map(([request, response]) => cache.put(request, response)));
}

async function cachedAsset(url) {
  try {
    return await caches.match(url, { cacheName: CACHE_NAME });
  } catch {
    return undefined;
  }
}

async function navigate(request) {
  try {
    // Preserve the real network response, including HTTP errors. Offline UI is
    // used only for a failed connection, not a declined or unavailable payment.
    return await fetch(request, { cache: 'no-store' });
  } catch {
    return (await cachedAsset(offlineUrl)) || Response.error();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installOfflineFiles());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith('erraza-offline-v') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  )));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.username || url.password) return;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return;
  }
  // An API navigation must still fail as an API request, never return HTML.
  if (/^\/api(?:\/|$)/i.test(pathname)) return;

  if (request.mode === 'navigate') {
    // Even personalized navigations may see the same generic offline message,
    // but neither their URL nor their response is ever written to a cache.
    event.respondWith(navigate(request));
    return;
  }

  // Full URL equality excludes queries, fragments, unknown files and paths.
  // Authenticated/partial requests are left to the browser as well.
  if (!assetUrls.has(request.url) || request.headers.has('authorization') || request.headers.has('range')) return;
  event.respondWith(cachedAsset(request.url).then((cached) => cached || fetch(request, { cache: 'no-store' })));
});
