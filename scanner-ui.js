/* ============================================================
   VECMOCON LEAK TESTER — SCANNER WIRING LAYER (v1.2.0)
   ============================================================
   Bridges ChargerScanner (scanner.js) to the existing PWA UI.

   FULLY AUTOMATIC:
     - Watches #screenScanner for the 'is-active' class: camera
       starts when the scanner screen shows and stops when it
       hides. script.js never touches the camera.
     - WARM STREAM: leaving the scanner screen does a SOFT close —
       the stream stays alive for KEEP_ALIVE_MS so SCAN NEXT
       resumes instantly (this is the biggest part of matching
       the stock camera app's feel). Backgrounding the app or
       tapping CANCEL stops the camera immediately.
     - Wires btnTorch, cameraSelect, btnCancelScan.
     - Shows a diagnostic line (engine/resolution/zoom/lens)
       under the scanner hint for field debugging.

   script.js integration (already done in v1.1.x):
       LeakScanner.onResult = (code) => handleScanResult(code);
       LeakScanner.close(true)   // on visibilitychange hidden
   ============================================================ */
'use strict';

const LeakScanner = (() => {
  let scanner  = null;
  let resultCb = null;
  let stopTimer = null;

  // How long the camera stays warm after leaving the scanner screen.
  // Within this window, SCAN NEXT is instant (no camera restart).
  const KEEP_ALIVE_MS = 7000;

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
        if (resultCb) resultCb(code);
        document.dispatchEvent(new CustomEvent('leakscan:result', { detail: { code } }));
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
    // Returning within the keep-alive window: cancel the pending stop
    // and just re-arm — this is the instant SCAN NEXT path.
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    try {
      if (!scanner) buildScanner();
      if (scanner.running) { scanner.resume(); return; }
      await scanner.start();
      populateCameras();
      wireControls();
      showDiagnostics();
    } catch (err) {
      // start() already routed a friendly message to onError.
    }
  }

  /**
   * close()      -> SOFT: keep the stream warm for KEEP_ALIVE_MS
   *                 (used when navigating to success/duplicate screens)
   * close(true)  -> IMMEDIATE: stop the camera now
   *                 (used on CANCEL and when the app is backgrounded)
   */
  function close(immediate = false) {
    if (!scanner) return;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (immediate) { scanner.stop(); return; }
    stopTimer = setTimeout(() => {
      stopTimer = null;
      scanner.stop();
    }, KEEP_ALIVE_MS);
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
