/* ============================================================
   VECMOCON LEAK TESTER — SCANNER WIRING LAYER (v1.4.0)
   ============================================================
   Bridges ChargerScanner (scanner.js) to the existing PWA UI.

   v1.4.0 — SINGLE-SHOT ARCHITECTURE (the permanent duplicate fix):
     - NO warm keep-alive. One scan = camera fully OFF. Every
       close() is a hard stop; every open() is a fresh start.
       The v1.2/1.3 warm-stream window (resume onto a frame that
       often still showed the previous label) was the root cause
       of every recurring duplicate — it no longer exists.
     - SINGLE DELIVERY PATH: onScan calls the onResult callback
       if one is registered, otherwise dispatches the
       'leakscan:result' event — never both.

   FULLY AUTOMATIC:
     - Watches #screenScanner for the 'is-active' class: camera
       starts when the scanner screen shows, hard-stops when it
       hides. script.js never touches the camera.
     - Wires btnTorch, cameraSelect, btnCancelScan.
     - Shows a diagnostic line (engine/resolution/zoom/lens)
       under the scanner hint for field debugging.

   script.js integration (unchanged):
       LeakScanner.onResult = (code) => handleScanResult(code);
       LeakScanner.close(true)   // on visibilitychange hidden
   ============================================================ */
'use strict';

const LeakScanner = (() => {
  let scanner  = null;
  let resultCb = null;
  let stopTimer = null;

  // v1.4.0: KEEP-ALIVE REMOVED. The warm-stream window (7 s in
  // v1.2/1.3) was the root of every recurring duplicate: SCAN NEXT
  // within the window resumed detection onto a frame that often still
  // showed the previous label. One scan = camera fully OFF. SCAN NEXT
  // does a clean ~1 s restart — slower by a blink, duplicate-proof
  // by construction.
  const KEEP_ALIVE_MS = 0;

  const $ = id => document.getElementById(id);

  function ensureVideo() {
    let v = $('scan-video');
    if (v) return v;
    v = document.createElement('video');
    v.id = 'scan-video';
    v.className = 'scan-video';
    v.setAttribute('playsinline', '');
    const frame = document.querySelector('.scanner-frame');
    if (frame) {
      const target = frame.querySelector('.scanner-target');
      frame.insertBefore(v, target || null);
    } else {
      ($('screenScanner') || document.body).appendChild(v);
    }
    return v;
  }

  function showError(msg) {
    console.warn('[scan]', msg);
    const err = $('errMessage');
    if (err) err.textContent = msg;
  }

  function buildScanner() {
    scanner = new ChargerScanner({
      videoEl: ensureVideo(),
      onScan: (code) => {
        // v1.3.0: ONE delivery path, not two. If script.js registered
        // onResult, that's the path; the event exists only as a
        // fallback for pages that never set the callback.
        if (resultCb) {
          resultCb(code);
        } else {
          document.dispatchEvent(new CustomEvent('leakscan:result', { detail: { code } }));
        }
      },
      onError: showError,
    });
  }

  function populateCameras() {
    const sel = $('cameraSelect');
    if (!sel || !scanner) return;
    sel.innerHTML = '';
    scanner.backCameras.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = c.label || `CAMERA ${i + 1}`;
      if (i === scanner.camIndex) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function wireControls() {
    const torch = $('btnTorch');
    if (torch && !torch._wired) {
      torch._wired = true;
      torch.addEventListener('click', async () => {
        const on = await scanner.toggleTorch();
        torch.classList.toggle('is-on', !!on);    // existing CSS class
        torch.classList.toggle('active', !!on);
      });
    }
    const sel = $('cameraSelect');
    if (sel && !sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', async (e) => {
        const idx = parseInt(e.target.value, 10);
        if (!scanner || idx === scanner.camIndex) return;
        scanner.stop();
        scanner.camIndex = idx;
        scanner.running = true;
        scanner.locked = false;
        try {
          await scanner._openCamera();
          scanner.qrDetector ? scanner._nativeLoop() : scanner._startFallback();
          showDiagnostics();
        } catch (err) { showError('Could not switch camera.'); }
      });
    }
    // btnCancelScan: script.js navigates home; we hard-stop the camera
    // (operator explicitly left — no keep-alive).
    const cancel = $('btnCancelScan');
    if (cancel && !cancel._cameraWired) {
      cancel._cameraWired = true;
      cancel.addEventListener('click', () => close(true));
    }
  }

  function showDiagnostics() {
    if (!scanner || !scanner.getDiagnostics) return;
    let d = document.getElementById('scanDiag');
    if (!d) {
      d = document.createElement('p');
      d.id = 'scanDiag';
      d.style.cssText = 'text-align:center;font-size:0.68rem;color:#8B98A5;' +
                        'font-family:monospace;letter-spacing:0;word-break:break-all;';
      const hint = document.querySelector('.scanner-hint');
      if (hint) hint.after(d);
      else $('screenScanner')?.appendChild(d);
    }
    const g = scanner.getDiagnostics();
    d.textContent = g.engine + ' · ' + g.resolution + ' · ' + g.zoom + ' · ' + g.camera;
  }

  /* ---------- public API ---------- */

  async function open() {
    // v1.4.0: always a fresh start — the camera was fully stopped on
    // close, so there is no warm path and no resume-onto-old-frame.
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    try {
      if (!scanner) buildScanner();
      await scanner.start();
      populateCameras();
      wireControls();
      showDiagnostics();
    } catch (err) {
      // start() already routed a friendly message to onError.
    }
  }

  /**
   * close()      -> SOFT: detection pauses NOW (v1.3.0 — this is the
   *                 duplicate fix), stream stays warm for KEEP_ALIVE_MS
   *                 (used when navigating to success/duplicate screens)
   * close(true)  -> IMMEDIATE: stop the camera now
   *                 (used on CANCEL and when the app is backgrounded)
   */
  function close(immediate = false) {
    // v1.4.0: every close is a HARD close. No warm window, no paused
    // detector waiting to resume onto a stale frame. Leaving the
    // scanner screen for ANY reason fully releases the camera.
    if (!scanner) return;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    scanner.stop();
  }

  /* ---------- auto start/stop on screen switching ---------- */
  function autoBind() {
    const screen = $('screenScanner');
    if (!screen) return;
    const sync = () => {
      screen.classList.contains('is-active') ? open() : close();
    };
    new MutationObserver(sync)
      .observe(screen, { attributes: true, attributeFilter: ['class'] });
    sync();   // handle the case where it's already active
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBind);
  } else {
    autoBind();
  }

  return {
    open,
    close,
    set onResult(fn) { resultCb = typeof fn === 'function' ? fn : null; },
    get instance() { return scanner; },
  };
})();

window.LeakScanner = LeakScanner;
