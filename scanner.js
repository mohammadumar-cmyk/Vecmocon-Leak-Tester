/* ============================================================
   VECMOCON LEAK TESTER — SCAN STATION SCANNER (v2)
   ============================================================
   Fixes the "have to open torch / switch to camera 0 / retry a lot"
   problem on Android by:

     1. Selecting the MAIN back camera explicitly (not facingMode,
        which often lands on the ultrawide/macro lens that can't
        focus on a close barcode).
     2. Requesting HIGH RESOLUTION + CONTINUOUS AUTOFOCUS so the
        frame is sharp enough to decode on the first try.
     3. Using the phone's NATIVE BarcodeDetector when available
        (Android Chrome) — far faster & more robust than the
        html5-qrcode WASM decoder. Falls back to html5-qrcode
        only when BarcodeDetector is missing (e.g. some iOS).
     4. Torch toggle that PERSISTS across scans, and tap-to-refocus.

   Usage:
     const scanner = new ChargerScanner({
       videoEl: document.getElementById('scan-video'),
       onScan:  (text) => { ... },      // fires once per lock
       onError: (msg)  => { ... },      // optional
     });
     await scanner.start();
     scanner.toggleTorch();             // returns new on/off state
     scanner.switchCamera();            // cycle back cameras
     scanner.resume();                  // re-arm after handling a scan
     scanner.stop();
   ============================================================ */

const SCAN_FORMATS = [
  'qr_code', 'code_128', 'ean_13', 'ean_8',
  'upc_a', 'upc_e', 'code_39'
];

class ChargerScanner {
  constructor({ videoEl, onScan, onError = () => {} }) {
    this.video = videoEl;
    this.onScan = onScan;
    this.onError = onError;

    this.stream = null;
    this.track = null;
    this.detector = null;
    this.backCameras = [];       // [{ deviceId, label }]
    this.camIndex = 0;
    this.torchOn = false;
    this.running = false;
    this.locked = false;         // prevents duplicate fires
    this.rafId = null;
    this.fallback = null;        // Html5Qrcode instance if used

    // Remember the operator's last-good camera choice on this phone.
    this._prefKey = 'leakscan.cameraId';

    this.video.setAttribute('playsinline', '');   // iOS: no fullscreen takeover
    this.video.muted = true;
    // Tap the preview to force a refocus if it drifts.
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
    try {
      // 1) One-time permission prompt + label unlock via a throwaway stream.
      const probe = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      probe.getTracks().forEach(t => t.stop());

      // 2) Enumerate real back cameras now that labels are available.
      await this._enumerateBackCameras();

      // 3) Restore last preferred camera on this device if we have one.
      const pref = localStorage.getItem(this._prefKey);
      const prefIdx = this.backCameras.findIndex(c => c.deviceId === pref);
      if (prefIdx >= 0) this.camIndex = prefIdx;

      // 4) Native detector if the browser has it.
      if ('BarcodeDetector' in window) {
        const supported = await BarcodeDetector.getSupportedFormats();
        const formats = SCAN_FORMATS.filter(f => supported.includes(f));
        if (formats.length) this.detector = new BarcodeDetector({ formats });
      }

      await this._openCamera();
      this.running = true;
      this.locked = false;   // fresh session -> always re-armed

      if (this.detector) this._nativeLoop();
      else await this._startFallback();

    } catch (err) {
      this.onError(this._friendly(err));
      throw err;
    }
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.fallback) {
      this.fallback.stop().catch(() => {});
      this.fallback = null;
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = this.track = null;
  }

  /** Call after you've handled an onScan result to accept the next code. */
  resume() { this.locked = false; }

  /* ---------- camera handling ---------- */

  async _enumerateBackCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
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

  async _openCamera() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());

    const cam = this.backCameras[this.camIndex];
    const constraints = {
      video: {
        deviceId: cam.deviceId ? { exact: cam.deviceId } : undefined,
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
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
    const caps = this.track?.getCapabilities?.() || {};
    if (!caps.zoom) return;                         // no zoom support
    const saved = parseFloat(localStorage.getItem('leakscan.zoom'));
    const target = !isNaN(saved)
      ? saved
      : Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2.5));
    await this.setZoom(target);
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

  /** Public: { min, max, step, current } for building a zoom slider, or null. */
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
    if (this.detector) this._nativeLoop();
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
    const tick = async () => {
      if (!this.running) return;
      if (!this.locked && this.video.readyState >= 2) {
        try {
          const codes = await this.detector.detect(this.video);
          if (codes.length) this._hit(codes[0].rawValue);
        } catch { /* transient detect errors are normal; keep going */ }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  async _startFallback() {
    // Only reached when BarcodeDetector is unavailable.
    if (typeof Html5Qrcode === 'undefined') {
      this.onError('Scanner library unavailable.');
      return;
    }
    // html5-qrcode needs its own element; hide the raw <video> and let it draw.
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
        // WIDE box — critical for 1D barcodes; square boxes kill EAN/Code128.
        qrbox: (vw, vh) => {
          const w = Math.floor(Math.min(vw, 640) * 0.9);
          const h = Math.floor(w * 0.55);
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
    // Maps our lowercase names to Html5QrcodeSupportedFormats enum, if loaded.
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
    this.locked = true;                 // one fire until resume()
    if (navigator.vibrate) navigator.vibrate(60);
    this.onScan(String(text).trim());
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
