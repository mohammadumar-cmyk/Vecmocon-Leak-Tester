/* ============================================================
   VECMOCON — INDUSTRIAL LEAK TESTER : SCAN STATION
   ============================================================
   Responsibilities of this file:
     1. Operator / Tester selection (persisted between sessions)
     2. Scan results (camera handled by scanner.js + scanner-ui.js)
     3. Upload each scan to Google Apps Script -> Google Sheets
     4. Client-side duplicate blocking (30 s window)
     5. Offline mode: queue scans in IndexedDB, auto-sync later
     6. Feedback: success beep, vibration, result screens

   v1.5.0 — PER-TESTER BACKEND:
     - Single SCRIPT_URL replaced by TESTER_URLS {tester: url}.
       Tester 1 -> original LeakTester sheet, Tester 2 -> LeakTester_2.
       Ping/stats follow the selected tester; every upload (live or
       from the offline queue) goes to the URL of the tester the scan
       was made on.

   v1.3.1 — LOST-ACK DUPLICATE FIX + honest offline detection:
     - Every scan gets a unique eventId AT SCAN TIME. It is stored
       with the queued record and sent on EVERY upload attempt, so
       the server (apps_script.gs with the eventId patch) writes
       each scan at most once — even when a POST succeeded but its
       response was lost on factory Wi-Fi and the client retried.
       This was the root cause of "goes offline then pushes
       multiple scans".
     - FETCH_TIMEOUT_MS raised 15 s -> 25 s: Apps Script cold
       starts regularly take 5-10 s; a slow server is not offline.
     - After an upload failure flips us to offline, a quick ping
       retry (5 s) restores ONLINE promptly instead of waiting for
       the 60 s ping loop — fixes the lingering false OFFLINE pill.
     - Returning to the app (visibilitychange) pings + syncs.

   v1.2.0: camera engine (scanner.js/scanner-ui.js), native
   BarcodeDetector, warm stream. This file receives codes via
   LeakScanner.onResult; the camera starts/stops automatically
   when #screenScanner gains/loses 'is-active'.
   ============================================================ */

'use strict';

/* ============================================================
   CONFIGURATION — every tunable value lives in this block.
   Edit here; nothing below needs to change.
   ============================================================ */
const CONFIG = {
  // v1.5.0: ONE Apps Script Web App URL PER TESTER. Each tester
  // uploads to its own Google Sheet. The dropdown is built from the
  // keys of this object, in this order. Add a tester = add a line.
  TESTER_URLS: {
    'Tester 1': 'https://script.google.com/macros/s/AKfycbxEZMEzwbDZwwO95445o1gDCMamqxrAE4kHNylMZypyAeau9tRA_boeBcq7J-Fz7JpT/exec',
    'Tester 2': 'https://script.google.com/macros/s/AKfycbxHo9svhhUXF-VTLjpqLxEEldiOQdOpCfkFEaVWMqKJZa-aHKHt9uobU1mzWGiwFG3Ang/exec'
  },

  // People who operate this scan station. Edit freely.
  OPERATORS: ['Umar', 'raj', 'line_man'],

  // Same Charger ID scanned again inside this window = duplicate.
  // v1.4.0: raised from 30 s to 10 MINUTES and made PERSISTENT
  // (survives app restarts via localStorage) — "no repeat on memory".
  // A genuine re-test (EC reseat etc.) uses the SCAN ANYWAY override
  // button on the duplicate screen.
  DUPLICATE_WINDOW_MS: 10 * 60 * 1000,

  // Charger ID format. Anything the camera decodes that does not
  // match is ignored as a fake/foreign code (also enforced inside
  // the scan engine itself).
  VALID_CODE_RE: /^VSC\d{10,20}$/i,

  // How often queued offline scans are retried (ms).
  SYNC_INTERVAL_MS: 15 * 1000,

  // How often the connection to Apps Script is verified (ms).
  PING_INTERVAL_MS: 60 * 1000,

  // Quick re-ping after an upload failure flips us offline (ms).
  // Restores the ONLINE pill fast when the blip was momentary.
  OFFLINE_RECHECK_MS: 5 * 1000,

  // Network timeout for each upload attempt (ms).
  // v1.3.1: 25 s — Apps Script COLD STARTS routinely take 5-10 s.
  // The old 15 s timeout made a slow (but working) server look
  // offline, which queued the scan and later re-sent it.
  FETCH_TIMEOUT_MS: 25 * 1000,

  APP_VERSION: 'v1.5.0'
};

// Derived: tester names for the dropdown (do not edit — edit TESTER_URLS).
CONFIG.TESTERS = Object.keys(CONFIG.TESTER_URLS);

/* Apps Script URL for a tester. With no argument -> the tester currently
   selected on screen. Queued offline scans carry their own `tester`
   field, so a scan made on Tester 2 always lands in Tester 2's sheet
   even if the dropdown was changed before the queue drained. */
function scriptUrl(tester) {
  const t = tester || (el.testerSelect && el.testerSelect.value) || CONFIG.TESTERS[0];
  return CONFIG.TESTER_URLS[t] || CONFIG.TESTER_URLS[CONFIG.TESTERS[0]];
}

// Engine-level validation uses the same regex (scanner.js reads this).
window.VM_VALID_CODE_RE = CONFIG.VALID_CODE_RE;

/* ============================================================
   v1.4.0 PERSISTENT SCAN MEMORY — chargerId -> last scan time,
   stored in localStorage so the duplicate block survives app
   restarts, reloads and updates. Pruned to 24 h / 300 entries.
   ============================================================ */
const SCAN_MEM_KEY = 'vm_scan_memory_v1';
function loadScanMemory() {
  try {
    const obj = JSON.parse(localStorage.getItem(SCAN_MEM_KEY) || '{}');
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const m = new Map();
    for (const [id, ts] of Object.entries(obj)) {
      if (typeof ts === 'number' && ts > cutoff) m.set(id, ts);
    }
    return m;
  } catch (_) { return new Map(); }
}
function persistScanMemory(map) {
  try {
    let entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
    localStorage.setItem(SCAN_MEM_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (_) { /* storage full/blocked — in-memory map still works */ }
}
function markScanned(chargerId) {
  state.recentScans.set(chargerId, Date.now());
  persistScanMemory(state.recentScans);
}

/* ============================================================
   DOM REFERENCES
   ============================================================ */
const el = {
  connBadge: document.getElementById('connBadge'),
  connText: document.getElementById('connText'),
  operatorSelect: document.getElementById('operatorSelect'),
  testerSelect: document.getElementById('testerSelect'),
  btnScan: document.getElementById('btnScan'),
  statPending: document.getElementById('statPending'),
  statToday: document.getElementById('statToday'),
  syncNote: document.getElementById('syncNote'),
  cameraSelect: document.getElementById('cameraSelect'),
  btnTorch: document.getElementById('btnTorch'),
  btnCancelScan: document.getElementById('btnCancelScan'),
  resTestId: document.getElementById('resTestId'),
  resTimestamp: document.getElementById('resTimestamp'),
  resChargerId: document.getElementById('resChargerId'),
  resQueuedNote: document.getElementById('resQueuedNote'),
  btnScanNext: document.getElementById('btnScanNext'),
  dupChargerId: document.getElementById('dupChargerId'),
  btnDupScanNext: document.getElementById('btnDupScanNext'),
  errMessage: document.getElementById('errMessage'),
  btnErrHome: document.getElementById('btnErrHome'),
  appVersion: document.getElementById('appVersion'),
  screens: {
    home: document.getElementById('screenHome'),
    scanner: document.getElementById('screenScanner'),
    success: document.getElementById('screenSuccess'),
    duplicate: document.getElementById('screenDuplicate'),
    error: document.getElementById('screenError')
  }
};

/* ============================================================
   APP STATE
   ============================================================ */
const state = {
  processingScan: false,  // guards against double-fired scan callbacks
  online: navigator.onLine,
  recentScans: loadScanMemory(), // v1.4.0: persistent — survives restarts
  todayCount: 0,
  syncing: false,         // prevents overlapping sync runs
  wakeLock: null,         // keeps the screen on while scanning
  offlineRecheck: null    // pending quick re-ping timer
};

/* ============================================================
   EVENT ID — idempotency key, minted ONCE per scan.
   The same id is sent on every retry of that scan, so the server
   can write the row at most once no matter how many times the
   client re-sends after a lost response.
   ============================================================ */
function makeEventId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Older WebView fallback: time + randomness is unique enough here.
  return 'pwa-' + Date.now().toString(36) + '-' +
         Math.random().toString(36).slice(2, 10);
}

/* ============================================================
   INDEXEDDB — offline scan queue
   ============================================================ */
const DB_NAME = 'vecmocon-leak-scanner';
const DB_VERSION = 1;
const STORE_QUEUE = 'scanQueue';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function queueAdd(record) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    tx.objectStore(STORE_QUEUE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function queueGetAll() {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readonly');
    const req = tx.objectStore(STORE_QUEUE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function queueDelete(id) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    tx.objectStore(STORE_QUEUE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function queueCount() {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readonly');
    const req = tx.objectStore(STORE_QUEUE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/* ============================================================
   SCREEN NAVIGATION
   ============================================================
   NOTE: scanner-ui.js observes #screenScanner's 'is-active'
   class, so switching screens here automatically starts/stops
   the camera. The wake lock follows the same navigation.
   ============================================================ */
function showScreen(name) {
  Object.values(el.screens).forEach(s => s.classList.remove('is-active'));
  el.screens[name].classList.add('is-active');

  // Keep the display on while the operator aims; release otherwise.
  if (name === 'scanner') acquireWakeLock();
  else releaseWakeLock();
}

/* ============================================================
   CONNECTION STATUS
   ============================================================ */
function setConnState(stateName) {
  el.connBadge.dataset.state = stateName;
  el.connText.textContent = stateName.toUpperCase();
}

/** Flip to offline AND schedule a quick recheck so a momentary blip
    doesn't leave the pill stuck on OFFLINE until the 60 s ping loop. */
function goOffline() {
  state.online = false;
  setConnState('offline');
  if (!state.offlineRecheck) {
    state.offlineRecheck = setTimeout(() => {
      state.offlineRecheck = null;
      pingServer().then(ok => { if (ok) syncQueue(); });
    }, CONFIG.OFFLINE_RECHECK_MS);
  }
}

async function pingServer() {
  if (!navigator.onLine) {
    state.online = false;
    setConnState('offline');
    return false;
  }
  try {
    const res = await fetchWithTimeout(scriptUrl() + '?action=ping', { method: 'GET' });
    const data = await res.json();
    state.online = !!data.ok;
  } catch (_) {
    state.online = false;
  }
  setConnState(state.online ? 'online' : 'offline');
  return state.online;
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, {
    signal: controller.signal,
    redirect: 'follow'
  })).finally(() => clearTimeout(timer));
}

/* ============================================================
   FEEDBACK — sound + vibration
   ============================================================ */
let audioCtx = null;

// Android Chrome suspends AudioContext unless it is created/resumed
// inside a user gesture. unlockAudio() is called from every button
// tap so the success beep is guaranteed to be audible later.
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { /* audio is best-effort */ }
}

function playTone(freq, durationMs, type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  } catch (_) { /* audio is best-effort */ }
}

function feedbackSuccess() {
  playTone(1200, 120);
  setTimeout(() => playTone(1800, 160), 130);
  if (navigator.vibrate) navigator.vibrate(150);
}

function feedbackWarn() {
  playTone(500, 250, 'sawtooth');
  if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
}

function feedbackError() {
  playTone(220, 400, 'sawtooth');
  if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
}

/* ============================================================
   OPERATOR / TESTER DROPDOWNS (persisted in localStorage)
   ============================================================ */
function populateDropdowns() {
  const fill = (select, items, storageKey) => {
    select.innerHTML = '';
    items.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    const saved = localStorage.getItem(storageKey);
    if (saved && items.includes(saved)) select.value = saved;
    select.addEventListener('change', () => localStorage.setItem(storageKey, select.value));
  };
  fill(el.operatorSelect, CONFIG.OPERATORS, 'vm_operator');
  fill(el.testerSelect, CONFIG.TESTERS, 'vm_tester');
  // v1.5.0: switching tester switches backend — re-check it right away
  el.testerSelect.addEventListener('change', () => { pingServer().then(refreshStats); });
}

/* ============================================================
   STATS — pending queue count + today's total
   ============================================================ */
async function refreshStats() {
  // Pending scans waiting in the offline queue
  try {
    const pending = await queueCount();
    el.statPending.textContent = String(pending);
    el.syncNote.hidden = pending === 0;
  } catch (_) { /* stats are non-critical */ }

  // Today's count: local counter, corrected by the server when online
  el.statToday.textContent = String(state.todayCount);

  if (state.online) {
    try {
      const res = await fetchWithTimeout(scriptUrl() + '?action=stats', { method: 'GET' });
      const data = await res.json();
      if (data.ok) {
        state.todayCount = data.todayCount;
        el.statToday.textContent = String(data.todayCount);
      }
    } catch (_) { /* keep the local number */ }
  }
}

/* ============================================================
   SCANNER — navigation only.
   The camera itself lives in scanner.js / scanner-ui.js.
   ============================================================ */
function openScanner() {
  state.processingScan = false;
  showScreen('scanner');   // scanner-ui.js observer starts the camera

  // Android back button should close the scanner, not exit the app
  if (!history.state || history.state.screen !== 'scanner') {
    history.pushState({ screen: 'scanner' }, '');
  }
}

/* Screen Wake Lock — stops Android from dimming/locking mid-scan.
   Best-effort: older devices without the API just behave as before. */
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (_) { /* denied on low battery etc. — not critical */ }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

/* ============================================================
   SCAN RESULT HANDLING
   ============================================================ */
async function handleScanResult(decodedText) {
  // ChargerScanner locks itself after each hit, but keep this guard
  // too — belt and braces against double delivery via the event path.
  if (state.processingScan) return;
  state.processingScan = true;

  const chargerId = String(decodedText).trim();

  // ---------- v1.4.0 format validation (defense in depth; the scan
  // engine already refuses non-matching codes) ----------
  if (!CONFIG.VALID_CODE_RE.test(chargerId)) {
    feedbackWarn();
    showError('Not a charger barcode: "' + chargerId.slice(0, 40) +
              '" — point the camera at the charger label only.');
    return;
  }

  // ---------- Client-side duplicate window (persistent, 10 min) ----------
  const last = state.recentScans.get(chargerId);
  if (last && Date.now() - last < CONFIG.DUPLICATE_WINDOW_MS) {
    feedbackWarn();
    state.lastBlockedCode = chargerId;   // for the SCAN ANYWAY override
    el.dupChargerId.textContent = chargerId;
    showScreen('duplicate');   // leaving the scanner screen stops the camera
    return;
  }

  const record = {
    action: 'scan',
    chargerId: chargerId,
    operator: el.operatorSelect.value,
    tester: el.testerSelect.value,
    scannedAt: new Date().toISOString(),
    // v1.3.1: idempotency key — minted ONCE here, reused on every
    // retry of this scan (immediate upload OR queued sync). The
    // server writes each eventId at most once.
    eventId: makeEventId()
  };

  // v1.4.0 CONNECTION FIX: ALWAYS attempt the upload, regardless of
  // what the ping-based online flag believes. The flag was wrong often
  // enough ("poor connection even on good internet") that scans were
  // being queued while the server was perfectly reachable. uploadScan
  // already falls back to the offline queue on real failure — the
  // pill is now cosmetic and can never block or misroute a scan.
  await uploadScan(record);
}

async function uploadScan(record) {
  try {
    const res = await fetchWithTimeout(scriptUrl(record.tester), {
      method: 'POST',
      // text/plain keeps this a CORS "simple request" — required
      // for Google Apps Script; do NOT change to application/json.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(record)
    });
    const data = await res.json();

    if (data.ok) {
      markScanned(record.chargerId);
      state.todayCount += 1;
      feedbackSuccess();
      el.resTestId.textContent = data.testId;
      el.resTimestamp.textContent = data.timestamp;
      el.resChargerId.textContent = data.chargerId;
      el.resQueuedNote.hidden = true;
      showScreen('success');
      refreshStats();
      return;
    }

    if (data.duplicate) {
      // Server saw this charger recently (e.g. scanned from another phone)
      markScanned(record.chargerId);
      feedbackWarn();
      el.dupChargerId.textContent = record.chargerId;
      showScreen('duplicate');
      return;
    }

    showError(data.error || 'Server rejected the scan.');
  } catch (_) {
    // Network died / timed out mid-upload. The write MAY have landed
    // server-side with the response lost — queueing is SAFE because
    // the retry carries the same eventId and cannot double-write.
    goOffline();               // also schedules a quick re-ping
    await saveOffline(record);
  }
}

async function saveOffline(record) {
  try {
    await queueAdd(record);
    markScanned(record.chargerId);
    feedbackSuccess();
    el.resTestId.textContent = 'ASSIGNED ON UPLOAD';
    // Show LOCAL time to the operator (record.scannedAt is UTC ISO,
    // which would display several hours off on the factory floor)
    el.resTimestamp.textContent = formatLocalTime(new Date(record.scannedAt));
    el.resChargerId.textContent = record.chargerId;
    el.resQueuedNote.hidden = false;
    showScreen('success');
    refreshStats();
  } catch (err) {
    feedbackError();
    showError('Could not save scan locally: ' + (err.message || err));
  }
}

/* ============================================================
   OFFLINE SYNC — retries queued scans when internet returns.
   Records queued by v1.3.1 carry their eventId, so a re-send of
   a scan whose first attempt actually landed is a no-op server-
   side (the server answers ok with the original testId).
   ============================================================ */
async function syncQueue() {
  if (state.syncing || !navigator.onLine) return;
  state.syncing = true;

  try {
    const items = await queueGetAll();
    if (items.length === 0) return;

    // Verify the server is actually reachable before draining
    if (!(await pingServer())) return;

    for (const item of items) {
      const record = Object.assign({}, item);
      delete record.id;
      try {
        const res = await fetchWithTimeout(scriptUrl(record.tester), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(record)
        });
        const data = await res.json();
        // Uploaded, deduped by eventId, or charger-window duplicate:
        // either way this record is DONE — remove from queue.
        if (data.ok || data.duplicate) {
          await queueDelete(item.id);
        } else {
          // Server rejected THIS record (validation) — skip it and keep
          // draining the rest; it is retained and retried next cycle.
          // Using `break` here would let one bad record freeze every
          // scan queued behind it forever.
          continue;
        }
      } catch (_) {
        break; // network dropped — stop, retry the whole batch next cycle
      }
    }
    refreshStats();
  } finally {
    state.syncing = false;
  }
}

/* ============================================================
   ERROR SCREEN
   ============================================================ */
function showError(message) {
  feedbackError();
  el.errMessage.textContent = message;
  showScreen('error');
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
/* Formats a Date as "YYYY-MM-DD HH:MM:SS" in the phone's local time */
function formatLocalTime(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* v1.4.0: a REAL retest (EC reseat, water recheck) must stay possible
   despite the 10-minute duplicate memory. The duplicate screen gets a
   SCAN ANYWAY button (injected here — no index.html change needed)
   that submits the blocked charger deliberately, with a fresh eventId. */
function injectScanAnywayButton() {
  const nextBtn = el.btnDupScanNext;
  if (!nextBtn || document.getElementById('btnDupOverride')) return;
  const b = document.createElement('button');
  b.id = 'btnDupOverride';
  b.textContent = 'SCAN THIS CHARGER ANYWAY';
  b.className = nextBtn.className;          // reuse existing button styling
  b.style.marginTop = '10px';
  b.style.opacity = '0.85';
  nextBtn.after(b);
  b.addEventListener('click', async () => {
    const chargerId = state.lastBlockedCode;
    if (!chargerId) { showScreen('home'); return; }
    state.lastBlockedCode = null;
    state.processingScan = true;
    const record = {
      action: 'scan',
      chargerId: chargerId,
      operator: el.operatorSelect.value,
      tester: el.testerSelect.value,
      scannedAt: new Date().toISOString(),
      eventId: makeEventId()
    };
    await uploadScan(record);
  });
}

function wireEvents() {
  injectScanAnywayButton();
  // Decoded codes arrive here from scanner.js (via scanner-ui.js)
  LeakScanner.onResult = handleScanResult;

  el.btnScan.addEventListener('click', () => {
    unlockAudio(); // gesture-bound: guarantees the beep works later
    if (!scriptUrl() || scriptUrl().indexOf('PASTE_YOUR') === 0) {
      showError('No Apps Script URL for ' + el.testerSelect.value + '. Open script.js and add it to CONFIG.TESTER_URLS.');
      return;
    }
    openScanner();
  });

  // btnTorch and cameraSelect are wired by scanner-ui.js.
  // btnCancelScan: scanner-ui stops the camera; we do the navigation.
  el.btnCancelScan.addEventListener('click', () => showScreen('home'));

  el.btnScanNext.addEventListener('click', () => { unlockAudio(); openScanner(); });
  el.btnDupScanNext.addEventListener('click', () => { unlockAudio(); openScanner(); });
  el.btnErrHome.addEventListener('click', () => showScreen('home'));

  // Android hardware/gesture BACK: close the scanner instead of
  // exiting the app (history state is pushed in openScanner)
  window.addEventListener('popstate', () => {
    if (el.screens.scanner.classList.contains('is-active')) {
      showScreen('home');   // observer stops the camera
    }
  });

  window.addEventListener('online', () => { pingServer().then(syncQueue); });
  window.addEventListener('offline', () => { state.online = false; setConnState('offline'); });

  // Release the camera when backgrounded; restart it when the operator
  // returns with the scanner screen still open. v1.3.1: returning also
  // re-checks the server and drains the queue — the common "walked
  // through a Wi-Fi dead spot" recovery path.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      LeakScanner.close(true);   // hard stop: release the camera when backgrounded
    } else {
      pingServer().then(ok => { if (ok) syncQueue(); });
      if (el.screens.scanner.classList.contains('is-active') && !state.processingScan) {
        LeakScanner.open();
      }
    }
  });
}

/* ============================================================
   SERVICE WORKER REGISTRATION (PWA / offline shell)
   ============================================================ */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {
      /* SW is an enhancement — the app still works without it */
    });
  }
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  el.appVersion.textContent = CONFIG.APP_VERSION;
  populateDropdowns();
  wireEvents();
  registerServiceWorker();

  await pingServer();
  await refreshStats();
  await syncQueue();

  // Background loops
  setInterval(pingServer, CONFIG.PING_INTERVAL_MS);
  setInterval(syncQueue, CONFIG.SYNC_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
