/* ============================================================
   VECMOCON LEAK TESTER — SCAN STATION SCANNER ENGINE (v1.3.0)
   ============================================================
   v1.3.0 — DUPLICATE-SCAN FIX on top of the v1.2.0 speed engine.

   What changed vs v1.2.0 (everything else identical):
     A. pause() — stops DETECTION but keeps the stream warm.
        In v1.2.0 the detect loop kept running through the
        7 s keep-alive window; on SCAN NEXT resume() cleared
        the lock while the previous label was often still in
        frame -> instant re-decode -> duplicate records.
        The wiring layer now pauses detection on soft close
        and resume() restarts it.
     B. SAME-CODE COOLDOWN — the engine remembers the last
        decoded value; the identical code is ignored for
        SAME_CODE_COOLDOWN_MS even across resume(). A
        DIFFERENT charger scans with zero delay.
     C. resume() now fully re-arms: unlocks AND restarts the
        detect loop if it was paused.

   Speed features carried over from v1.2.0 unchanged:
     one-time cached init · main-lens selection · 1440p ·
     continuous AF + tap-to-refocus · hw zoom 2.5x default +
     pinch · digital-crop fallback · multi-scale detection at
     ~25/sec · QR-only fast detector on crop passes · warm
     stream keep-alive (wiring layer) · diagnostics line.

   Fallback: browsers without BarcodeDetector use html5-qrcode.
   ============================================================ */
'use strict';

const SCAN_FORMATS = [
  'qr_code', 'code_128', 'ean_13', 'ean_8',
  'upc_a', 'upc_e', 'code_39'
];

// Ignore a re-decode of the SAME value for this long (ms). Long enough
// to cover show-result -> SCAN NEXT with the phone still on the label;
// short enough that a deliberate rescan of the same charger (rare but
// legitimate) works after a few seconds.
const SAME_CODE_COOLDOWN_MS = 4000;

class ChargerScanner {
  constructor({ videoEl, onScan, onError = () => {} }) {
    this.video = videoEl;
    this.onScan = onScan;
    this.onError = onError;

    this.stream = null;
    this.track = null;
    this.qrDetector = null;      // QR-only: fastest, used on crop passes
    this.allDetector = null;     // all formats: used on full-frame passes
    this.backCameras = [];       // [{ deviceId, label }]
    this.camIndex = 0;
    this.torchOn = false;
    this.running = false;        // detect loop active?
    this.locked = false;         // one-fire latch within a scan session
    this.lastCode = null;        // v1.3.0: same-code cooldown memory
    this.lastCodeAt = 0;
    this.rafId = null;
    this.fallback = null;        // Html5Qrcode instance if used
    this._initialized = false;   // one-time init done?
    this._starting = null;       // in-flight start() promise (race guard)
    this._zoomApplied = false;

    this._prefKey = 'leakscan.cameraId';

    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.addEventListener('click', () => this._refocus());

    // Pinch-to-zoom on the preview (small charger labels need zoom).
    this._pinchDist = 0;
    this.video.addEventListener('touchstart', e => {
      if (e.touches.length === 2) this._pinchDist = this._dist(e.touches);
    }, { passive: true });
    this.video.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && this._pinchDist) {
        const d = this._dist(e.touches);
        const caps = this.track?.getCapabilities?.() || {};
        if (caps.zoom) {
          const cur = this.track.getSettings().zoom || caps.zoom.min;
          const next = Math.min(caps.zoom.max,
                       Math.max(caps.zoom.min, cur + (d - this._pinchDist) * 0.02));
          this.setZoom(next);
        }
        this._pinchDist = d;
      }
    }, { passive: true });
  }

  _dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }

  /* ---------- lifecycle ---------- */

  async start() {
    // Race guard: a second open() while start() is in flight must not
    // create a second camera stream.
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    try {
      await this._initOnce();     // no-op after the first call
      await this._openCamera();
      this.running = true;
      this.locked = false;        // fresh session -> always re-armed

      if (this.qrDetector) this._nativeLoop();
      else await this._startFallback();
    } catch (err) {
      this.onError(this._friendly(err));
      throw err;
    }
  }

  /** Everything that only needs to happen once per page life. */
  async _initOnce() {
    if (this._initialized) return;

    // Permission probe is only needed when device labels are hidden
    // (i.e. permission not yet granted). Skip it when we can.
    let devices = await navigator.mediaDevices.enumerateDevices();
    const labelsVisible = devices.some(d => d.kind === 'videoinput' && d.label);
    if (!labelsVisible) {
      const probe = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      probe.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    this._buildCameraList(devices);

    // Restore last preferred camera on this device if we have one.
    const pref = localStorage.getItem(this._prefKey);
    const prefIdx = this.backCameras.findIndex(c => c.deviceId === pref);
    if (prefIdx >= 0) this.camIndex = prefIdx;

    // Native detectors if the browser has them. Two instances:
    // QR-only is measurably faster per detect() call on ML Kit.
    if ('BarcodeDetector' in window) {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (supported.includes('qr_code')) {
        this.qrDetector = new BarcodeDetector({ formats: ['qr_code'] });
      }
      const all = SCAN_FORMATS.filter(f => supported.includes(f));
      if (all.length) {
        this.allDetector = new BarcodeDetector({ formats: all });
        if (!this.qrDetector) this.qrDetector = this.allDetector;
      }
    }

    this._initialized = true;
  }

  _buildCameraList(devices) {
    const cams = devices.filter(d => d.kind === 'videoinput');

    // Prefer explicitly back/rear-facing cameras.
    let back = cams.filter(c => /back|rear|environment/i.test(c.label));
    if (!back.length) back = cams;   // labels hidden -> keep all

    // De-prioritise lenses that can't focus on a close barcode.
    const isBadLens = c => /ultra|wide-?angle|tele|depth|macro|mono/i.test(c.label);
    back.sort((a, b) => (isBadLens(a) - isBadLens(b)));

    this.backCameras = back.map(c => ({ deviceId: c.deviceId, label: c.label }));
    if (!this.backCameras.length) throw new Error('NO_CAMERA');
  }

  /** HARD stop: detection off AND camera released. */
  stop() {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.fallback) {
      this.fallback.stop().catch(() => {});
      this.fallback = null;
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = this.track = null;
  }

  /**
   * v1.3.0 SOFT stop: detection OFF, stream stays WARM.
   * Used during the keep-alive window between scans so the previous
   * label cannot be re-decoded while a result screen is showing —
   * this was the duplicate-scan bug in v1.2.0.
   */
  pause() {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.fallback && typeof this.fallback.pause === 'function') {
      try { this.fallback.pause(true); } catch { /* not started yet */ }
    }
    // stream/track intentionally left alive.
  }

  /**
   * Re-arm for the next scan. v1.3.0: also restarts the detect loop
   * if it was paused (the warm SCAN NEXT path). The same-code
   * cooldown persists across resume() — that's the point of it.
   */
  resume() {
    this.locked = false;
    if (this.running) return;                 // loop already live
    if (this.fallback) {
      this.running = true;
      try { this.fallback.resume(); } catch { /* ignore */ }
      return;
    }
    if (this.stream && this.qrDetector) {     // warm stream: relight loop
      this.running = true;
      this._nativeLoop();
    }
  }

  /* ---------- camera handling ---------- */

  async _openCamera() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());

    const cam = this.backCameras[this.camIndex];
    const constraints = {
      video: {
        deviceId: cam.deviceId ? { exact: cam.deviceId } : undefined,
        width:  { ideal: 2560 },      // more pixels on a small code
        height: { ideal: 1440 },      // (device clamps to its best mode)
        frameRate: { ideal: 30 },
        // Not all UAs honour these but they help a lot where supported:
        focusMode: 'continuous',
        advanced: [{ focusMode: 'continuous' }]
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    await this.video.play();

    if (cam.deviceId) localStorage.setItem(this._prefKey, cam.deviceId);

    // Re-apply torch state if the operator had it on.
    if (this.torchOn) await this._applyTorch(true);

    // SMALL-QR FIX: default to ~2.5x zoom so the operator can hold the
    // phone at a distance the lens can actually focus at (>= ~8-10 cm)
    // while the small label still fills a big part of the frame.
    await this._applyDefaultZoom();
  }

  async _applyDefaultZoom() {
    this._zoomApplied = false;
    const caps = this.track?.getCapabilities?.() || {};
    if (!caps.zoom) return;                         // no zoom support
    const saved = parseFloat(localStorage.getItem('leakscan.zoom'));
    const target = !isNaN(saved)
      ? saved
      : Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2.5));
    const z = await this.setZoom(target);
    this._zoomApplied = (z !== null && z > 1);
  }

  /** Public: set zoom level (clamped). Persists as the operator's preference. */
  async setZoom(level) {
    const caps = this.track?.getCapabilities?.() || {};
    if (!caps.zoom) return null;
    const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, level));
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: z }] });
      localStorage.setItem('leakscan.zoom', String(z));
      return z;
    } catch { return null; }
  }

  /** Public: { min, max, step, current } for a zoom slider, or null. */
  getZoomRange() {
    const caps = this.track?.getCapabilities?.() || {};
    if (!caps.zoom) return null;
    return {
      min: caps.zoom.min, max: caps.zoom.max,
      step: caps.zoom.step || 0.1,
      current: this.track.getSettings().zoom || caps.zoom.min
    };
  }

  async switchCamera() {
    if (this.backCameras.length < 2) return this.backCameras[0]?.label;
    this.stop();
    this.camIndex = (this.camIndex + 1) % this.backCameras.length;
    this.running = true;
    this.locked = false;
    await this._openCamera();
    if (this.qrDetector) this._nativeLoop();
    else await this._startFallback();
    return this.backCameras[this.camIndex].label;
  }

  async toggleTorch() {
    const caps = this.track?.getCapabilities?.() || {};
    if (!caps.torch) { this.onError('Torch not available on this camera.'); return this.torchOn; }
    this.torchOn = !this.torchOn;
    await this._applyTorch(this.torchOn);
    return this.torchOn;
  }

  async _applyTorch(on) {
    try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); }
    catch { /* ignore */ }
  }

  async _refocus() {
    if (!this.track) return;
    const caps = this.track.getCapabilities?.() || {};
    try {
      if (caps.focusMode?.includes('single-shot')) {
        await this.track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
        setTimeout(() => this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 400);
      }
    } catch { /* ignore */ }
  }

  /* ---------- decoding ---------- */

  _nativeLoop() {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._cctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }
    let lastTs = 0;
    let pass = 0;

    // Multi-scale crop fractions. With hardware zoom the frame is
    // already magnified, so crops are looser; without it, tighter.
    const scales = () => this._zoomApplied ? [0.6, 0.8] : [0.4, 0.65];

    const tick = async (ts) => {
      if (!this.running) return;
      // ~25 detections/sec. detect() itself takes 10-30 ms on a cropped
      // frame; pushing past this rate adds heat, not speed.
      if (!this.locked && this.video.readyState >= 2 && ts - lastTs >= 40) {
        lastTs = ts;
        pass++;
        try {
          const phase = pass % 3;   // 1: tight crop, 2: medium crop, 0: full
          let source = this.video;
          let detector = this.allDetector || this.qrDetector;

          if (phase !== 0) {
            const vw = this.video.videoWidth, vh = this.video.videoHeight;
            if (vw && vh) {
              const crop = scales()[phase - 1];
              const cw = Math.floor(vw * crop), ch = Math.floor(vh * crop);
              const cx = (vw - cw) >> 1, cy = (vh - ch) >> 1;
              this._canvas.width = cw;
              this._canvas.height = ch;
              this._cctx.drawImage(this.video, cx, cy, cw, ch, 0, 0, cw, ch);
              source = this._canvas;
              detector = this.qrDetector;   // QR-only: fastest per call
            }
          }

          const codes = await detector.detect(source);
          if (codes.length) this._hit(codes[0].rawValue);
        } catch { /* transient detect errors are normal; keep going */ }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Public: one-line status of what the engine is actually doing on
      this phone — surfaced on the scanner screen for field debugging. */
  getDiagnostics() {
    const s = this.track?.getSettings?.() || {};
    const caps = this.track?.getCapabilities?.() || {};
    return {
      engine: this.qrDetector ? 'NATIVE' : 'FALLBACK(h5q)',
      camera: this.backCameras[this.camIndex]?.label || 'unknown',
      resolution: (s.width || '?') + 'x' + (s.height || '?'),
      zoom: caps.zoom
        ? 'hw-zoom ' + (s.zoom || 1) + 'x/max' + caps.zoom.max
        : 'no-hw-zoom→crop',
      focus: s.focusMode || 'default'
    };
  }

  async _startFallback() {
    // Only reached when BarcodeDetector is unavailable.
    if (typeof Html5Qrcode === 'undefined') {
      this.onError('Scanner library unavailable.');
      return;
    }
    const holderId = 'h5q-fallback';
    let holder = document.getElementById(holderId);
    if (!holder) {
      holder = document.createElement('div');
      holder.id = holderId;
      this.video.parentNode.insertBefore(holder, this.video);
    }
    this.video.style.display = 'none';

    this.fallback = new Html5Qrcode(holderId, {
      formatsToSupport: SCAN_FORMATS.map(f => this._h5qFormat(f)).filter(Boolean),
      verbose: false
    });

    const cam = this.backCameras[this.camIndex];
    await this.fallback.start(
      cam.deviceId ? { deviceId: { exact: cam.deviceId } } : { facingMode: 'environment' },
      {
        fps: 15,
        qrbox: (vw, vh) => {
          const w = Math.floor(Math.min(vw, 640) * 0.9);
          const h = Math.floor(w * 0.75);
          return { width: w, height: h };
        },
        aspectRatio: 1.777,
        videoConstraints: {
          width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: 'continuous'
        }
      },
      (text) => this._hit(text),
      () => {}   // per-frame decode failure: ignore
    );
  }

  _h5qFormat(f) {
    if (typeof Html5QrcodeSupportedFormats === 'undefined') return null;
    const map = {
      qr_code: Html5QrcodeSupportedFormats.QR_CODE,
      code_128: Html5QrcodeSupportedFormats.CODE_128,
      ean_13: Html5QrcodeSupportedFormats.EAN_13,
      ean_8: Html5QrcodeSupportedFormats.EAN_8,
      upc_a: Html5QrcodeSupportedFormats.UPC_A,
      upc_e: Html5QrcodeSupportedFormats.UPC_E,
      code_39: Html5QrcodeSupportedFormats.CODE_39
    };
    return map[f];
  }

  _hit(text) {
    if (this.locked || !text) return;
    const code = String(text).trim();
    if (!code) return;

    // v1.3.0 SAME-CODE COOLDOWN: the identical value within the window
    // is the previous scan still in frame — not a new charger. A
    // different value fires immediately (production line speed intact).
    const now = Date.now();
    if (code === this.lastCode && now - this.lastCodeAt < SAME_CODE_COOLDOWN_MS) {
      return;
    }
    this.lastCode = code;
    this.lastCodeAt = now;

    this.locked = true;                 // one fire until resume()
    if (navigator.vibrate) navigator.vibrate(60);
    this.onScan(code);
  }

  /* ---------- misc ---------- */

  _friendly(err) {
    const n = err?.name || '';
    if (n === 'NotAllowedError') return 'Camera permission denied — allow it in browser settings.';
    if (n === 'NotFoundError' || err?.message === 'NO_CAMERA') return 'No camera found on this device.';
    if (n === 'NotReadableError') return 'Camera is busy — close other apps using it and retry.';
    return 'Could not start the camera. Reload and try again.';
  }
}

// Export for module bundlers; also attach to window for plain-script PWAs.
if (typeof module !== 'undefined' && module.exports) module.exports = { ChargerScanner };
if (typeof window !== 'undefined') window.ChargerScanner = ChargerScanner;
