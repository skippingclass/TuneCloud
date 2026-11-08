/* Generated for each production build. Only public app assets enter this cache. */
const CACHE = 'tunecloud-shell-' + __VERSION__;
const ASSETS = __ASSETS__;
const paths = new Set(ASSETS);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    ASSETS.map(url => new Request(url, { cache: 'reload', credentials: 'omit' }))
  )));
  // Wait for all existing windows to close. Never replace a playing app.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('tunecloud-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      /^\/(api|rest)(\/|$)/.test(url.pathname) || request.headers.has('range') ||
      ['audio', 'video'].includes(request.destination)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match('/offline.html'))));
  } else if (!url.search && paths.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
  }
});
