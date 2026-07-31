/* ============================================================
   VECMOCON LEAK TESTER — SCANNER WIRING LAYER (final)
   ============================================================
   Bridges ChargerScanner (scanner.js) to the existing PWA UI.

   FULLY AUTOMATIC:
     - Watches #screenScanner for the 'is-active' class, so the
       camera starts when your existing code shows the scanner
       screen and stops when it hides it. You do NOT need to call
       open()/close() from script.js.
     - Inserts <video id="scan-video"> inside .scanner-frame so
       the green target overlay sits on top of the live preview.
     - Wires btnTorch, cameraSelect, btnCancelScan.

   The ONLY thing script.js must do:
     1) DELETE its old Html5Qrcode init/start/stop block.
     2) Receive scan results via ONE of these (pick either):
          LeakScanner.onResult = (code) => yourExistingHandler(code);
        or listen for the event:
          document.addEventListener('leakscan:result',
              e => yourExistingHandler(e.detail.code));

   Load order in index.html:
       scanner.js -> scanner-ui.js -> script.js
   ============================================================ */
'use strict';

const LeakScanner = (() => {
  let scanner  = null;
  let resultCb = null;

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
      // Put the preview under the .scanner-target overlay.
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
        // Deliver via callback if set, and always via event.
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
        torch.classList.toggle('is-on', !!on);    // your existing CSS class
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
          scanner.detector ? scanner._nativeLoop() : scanner._startFallback();
        } catch (err) { showError('Could not switch camera.'); }
      });
    }
    // btnCancelScan: your script.js already navigates home on this
    // button; we only piggyback to stop the camera.
    const cancel = $('btnCancelScan');
    if (cancel && !cancel._cameraWired) {
      cancel._cameraWired = true;
      cancel.addEventListener('click', () => close());
    }
  }

  /* ---------- public API ---------- */

  async function open() {
    try {
      if (!scanner) buildScanner();
      if (scanner.running) { scanner.resume(); return; }
      await scanner.start();
      populateCameras();
      wireControls();
    } catch (err) {
      // start() already routed a friendly message to onError.
    }
  }

  function close() {
    if (scanner) scanner.stop();
  }

  /* ---------- auto start/stop on screen switching ----------
     script.js toggles the 'is-active' class on screens; observe
     #screenScanner so the camera follows navigation for free.  */
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
