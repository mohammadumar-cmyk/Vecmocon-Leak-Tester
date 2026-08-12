/* ============================================================
   VECMOCON LEAK TESTER SCAN STATION — SERVICE WORKER (v7)
   ============================================================
   v7 / app v1.4.0 — THE "STALE PHONE" FIX, PERMANENTLY.

   Until v6 the app shell was served CACHE-FIRST: a phone kept
   running old JS for days after a fix was deployed, so solved
   bugs kept "coming back". v7 is NETWORK-FIRST for the app
   shell: every launch with internet fetches the newest files
   (2.5 s budget), falling back to cache only when offline.
   A phone with internet can no longer be out of date.
   ============================================================ */
'use strict';

const CACHE_VERSION = 'vm-leak-scanner-v7';

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

/* Network with a time budget: resolves with the response if the
   network answers within `ms`, otherwise rejects so the caller
   falls back to cache. Slow factory Wi-Fi never blocks app open. */
function fetchWithBudget(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('slow')), ms);
    fetch(req).then((res) => { clearTimeout(timer); resolve(res); },
                    (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET. POSTs (scan uploads) go straight to the network.
  if (req.method !== 'GET') return;

  // Never touch Apps Script calls (ping/stats) — live data only.
  if (req.url.indexOf('script.google.com') !== -1 ||
      req.url.indexOf('googleusercontent.com') !== -1) {
    return;
  }

  // APP SHELL: NETWORK-FIRST (v7). Fresh files whenever the phone has
  // internet; cache is the offline fallback, not the default.
  event.respondWith(
    fetchWithBudget(req, 2500).then((res) => {
      if (res && res.ok && req.url.indexOf('http') === 0) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then((cached) =>
        cached || caches.match('./index.html')
      )
    )
  );
});
