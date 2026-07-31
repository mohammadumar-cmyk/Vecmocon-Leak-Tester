/* ============================================================
   VECMOCON LEAK TESTER — SERVICE WORKER
   ============================================================
   Strategy:
     - App shell (HTML/CSS/JS/icons/scanner library) is
       pre-cached on install so the app opens with no internet.
     - Static assets: cache-first, updated in the background.
     - Google Apps Script requests are NEVER cached — live data
       must always hit the network (offline scans are handled
       by the IndexedDB queue in script.js, not by the SW).
   Bump CACHE_VERSION whenever any shell file changes.
   ============================================================ */

'use strict';

const CACHE_VERSION = 'vm-leak-scanner-v2';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

/* ---------------- INSTALL: pre-cache the shell ---------------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ---------------- ACTIVATE: purge old caches ---------------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------------- FETCH ---------------- */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept the data API — Apps Script must stay live.
  if (url.includes('script.google.com') || url.includes('script.googleusercontent.com')) {
    return;
  }

  // Only handle GET; POSTs pass straight through.
  if (event.request.method !== 'GET') return;

  // Cache-first with background refresh (stale-while-revalidate)
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          // Cache successful same-origin/CDN responses for next time
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache

      return cached || networkFetch;
    })
  );
});
