/* ============================================================
   VECMOCON LEAK TESTER SCAN STATION — SERVICE WORKER
   ============================================================
   CACHE_VERSION bump is what forces installed phones to fetch
   the new app files. v6 = v1.3.1 (scan latch + eventId sync).
   ============================================================ */
'use strict';

const CACHE_VERSION = 'vm-leak-scanner-v6';   // bumped: v1.3.1 (duplicate fixes)

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './scanner.js',
  './scanner-ui.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET. POSTs (scan uploads to Apps Script) must always
  // go straight to the network — never cached, never intercepted.
  if (req.method !== 'GET') return;

  // Never cache Apps Script calls (ping/stats) — live data only.
  if (req.url.indexOf('script.google.com') !== -1 ||
      req.url.indexOf('googleusercontent.com') !== -1) {
    return;
  }

  // App shell: cache-first with network fallback + background refresh.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok && req.url.indexOf('http') === 0) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
