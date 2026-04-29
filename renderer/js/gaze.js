// ─── gaze.js — Eye gaze correction using MediaPipe FaceMesh ──────────────
//
// Algorithm (ported from eyealign_upload.html — proven to work):
//   1. Capture webcam via getUserMedia
//   2. Run MediaPipe FaceMesh (refineLandmarks: true) to get 478 landmarks
//      incl. iris landmarks 468–477
//   3. For each eye: get iris center + radius, get eye-socket bounding-box center
//   4. Shift vector = (eyeCenter – irisCenter) * strength  +  cameraOffset
//   5. Inverse-mapped liquify warp pushes iris pixels toward the target
//   6. Output corrected frame to canvas → MJPEG broadcast for OBS virtual cam

export class GazeCorrector {
  constructor(videoEl, outputCanvas, frameCanvas) {
    this.videoEl = videoEl;
    this.outputCanvas = outputCanvas;
    // willReadFrequently is critical for getImageData performance
    this.outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true });
    this.frameCanvas = frameCanvas;
    this.frameCtx = frameCanvas.getContext('2d');

    this.faceMesh = null;
    this.cameraUtil = null;
    this.stream = null;
    this.isRunning = false;
    this.correctionOn = false;

    // Tunable — updated from Settings
    this.correctionStrength = 0.70; // 0–1
    this.blendFactor = 0.40; // iris-warp feather width
    this.cameraOffsetY = -0.15; // -1..0  (negative = camera above screen)

    this.frameCount = 0;

    // ── MediaPipe iris landmark indices (requires refineLandmarks: true) ──
    this.LEFT_IRIS = { center: 468, boundary: [469, 470, 471, 472] };
    this.RIGHT_IRIS = { center: 473, boundary: [474, 475, 476, 477] };

    // Eye-socket boundary landmarks for computing the natural gaze centre
    this.LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
    this.RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Call from Settings after loading gazeStrength (0–100) */
  setCorrectionStrength(val) {
    this.correctionStrength = Math.max(0, Math.min(1, parseFloat(val)));
  }

  /** val is -50..0 from Settings slider — converts to fraction */
  setCameraOffsetY(val) {
    this.cameraOffsetY = Math.max(-1, Math.min(0, parseInt(val) / 100));
  }

  setBlendFactor(val) {
    this.blendFactor = Math.max(0.1, Math.min(1, parseFloat(val)));
  }

  setCorrection(on) { this.correctionOn = !!on; }

  // ── Initialization ────────────────────────────────────────────────────────

  async initCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;

      await new Promise((res) => { this.videoEl.onloadedmetadata = res; });
      await new Promise((res, rej) => {
        const t = setTimeout(rej, 5000);
        this.videoEl.onloadeddata = () => { clearTimeout(t); res(); };
      });

      this.outputCanvas.width = this.videoEl.videoWidth || 640;
      this.outputCanvas.height = this.videoEl.videoHeight || 480;

      await this._initFaceMesh();
      this.isRunning = true;
    } catch (err) {
      console.error('[GazeCorrector] Camera init failed:', err);
      throw err;
    }
  }

  async _initFaceMesh() {
    if (typeof FaceMesh === 'undefined') {
      console.warn('[GazeCorrector] MediaPipe FaceMesh not loaded — running passthrough');
      this._startPassthrough();
      return;
    }

    this.faceMesh = new FaceMesh({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });

    this.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,          // ← required for iris landmarks 468-477
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    this.faceMesh.onResults(this._onResults.bind(this));

    if (typeof Camera !== 'undefined') {
      // Use MediaPipe Camera utility (preferred — drives the loop)
      this.cameraUtil = new Camera(this.videoEl, {
        onFrame: async () => {
          if (this.faceMesh && this.isRunning) {
            await this.faceMesh.send({ image: this.videoEl });
          }
        },
        width: 640,
        height: 480,
      });
      await this.cameraUtil.start();
    } else {
      // Fallback: requestAnimationFrame loop
      this._startManualLoop();
    }
  }

  _startManualLoop() {
    const loop = async () => {
      if (!this.isRunning) return;
      if (this.faceMesh && !this.videoEl.paused && !this.videoEl.ended) {
        try { await this.faceMesh.send({ image: this.videoEl }); } catch { }
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  _startPassthrough() {
    const loop = () => {
      if (!this.isRunning) return;
      const w = this.outputCanvas.width;
      const h = this.outputCanvas.height;
      this.outputCtx.drawImage(this.videoEl, 0, 0, w, h);
      this._broadcastFrame();
      requestAnimationFrame(loop);
    };
    loop();
  }

  // ── Results callback ──────────────────────────────────────────────────────

  _onResults(results) {
    const ctx = this.outputCtx;
    const w = this.outputCanvas.width;
    const h = this.outputCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(results.image, 0, 0, w, h);

    if (
      this.correctionOn &&
      results.multiFaceLandmarks &&
      results.multiFaceLandmarks.length > 0 &&
      results.multiFaceLandmarks[0].length > 477
    ) {
      this._applyGazeCorrection(ctx, results.multiFaceLandmarks[0], w, h);
    }

    // Throttle MJPEG broadcast to ~15 fps to keep IPC light
    this.frameCount++;
    if (this.frameCount % 2 === 0) this._broadcastFrame();
  }

  // ── Core correction pipeline (same algorithm as eyealign_upload.html) ─────

  /**
   * Get eye-socket centre as the midpoint of the landmark bounding box.
   * Matches the eyealign_upload.html getEyeCenter() function exactly.
   */
  _getEyeCenter(lm, indices, w, h) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const i of indices) {
      const x = lm[i].x * w, y = lm[i].y * h;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  /**
   * Get iris centre pixel coords + average boundary radius.
   * Matches eyealign_upload.html getIrisInfo().
   */
  _getIrisInfo(lm, spec, w, h) {
    const c = lm[spec.center];
    const cx = c.x * w;
    const cy = c.y * h;
    let totalR = 0;
    for (const bi of spec.boundary) {
      const b = lm[bi];
      totalR += Math.hypot(b.x * w - cx, b.y * h - cy);
    }
    return { cx, cy, radius: totalR / spec.boundary.length };
  }

  _applyGazeCorrection(ctx, lm, w, h) {
    const str = this.correctionStrength;
    const blend = this.blendFactor;

    // ── Left eye ────────────────────────────────────────────────────────
    const li = this._getIrisInfo(lm, this.LEFT_IRIS, w, h);
    const lc = this._getEyeCenter(lm, this.LEFT_EYE, w, h);

    // Camera offset: shift the target upward (negative cameraOffsetY moves up)
    // Multiplier of 3× iris-radius gives perceptually natural shift range
    const lcTarget = {
      x: lc.x,
      y: lc.y + this.cameraOffsetY * li.radius * 3,
    };
    this._warpIris(ctx, li, lcTarget, w, h, str, blend);

    // ── Right eye ───────────────────────────────────────────────────────
    const ri = this._getIrisInfo(lm, this.RIGHT_IRIS, w, h);
    const rc = this._getEyeCenter(lm, this.RIGHT_EYE, w, h);
    const rcTarget = {
      x: rc.x,
      y: rc.y + this.cameraOffsetY * ri.radius * 3,
    };
    this._warpIris(ctx, ri, rcTarget, w, h, str, blend);
  }

  /**
   * Liquify-style inverse-mapped warp (same as eyealign_upload.html warpIris).
   *
   * For every destination pixel inside the iris region we back-project to
   * find its source sample, applying a smoothstep falloff so the warp
   * blends seamlessly with the surrounding skin.
   */
  _warpIris(ctx, iris, eyeCenter, w, h, str, blend) {
    const dx = (eyeCenter.x - iris.cx) * str;
    const dy = (eyeCenter.y - iris.cy) * str;

    if (Math.hypot(dx, dy) < 0.5) return; // nothing to do

    const r = iris.radius;
    const outerR = r * (1 + blend);
    const margin = Math.ceil(outerR + 2);

    // Clamp bounding box to canvas
    const x0 = Math.max(0, Math.floor(iris.cx - margin));
    const y0 = Math.max(0, Math.floor(iris.cy - margin));
    const x1 = Math.min(w, Math.ceil(iris.cx + margin));
    const y1 = Math.min(h, Math.ceil(iris.cy + margin));
    const pw = x1 - x0;
    const ph = y1 - y0;
    if (pw <= 0 || ph <= 0) return;

    const src = ctx.getImageData(x0, y0, pw, ph);
    const dst = new ImageData(pw, ph);

    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const ex = (x0 + px) - iris.cx;
        const ey = (y0 + py) - iris.cy;
        const dist = Math.sqrt(ex * ex + ey * ey);

        // Warp weight: 1 inside iris, smoothstep falloff in blend ring, 0 outside
        let wf = 0;
        if (dist <= r) {
          wf = 1;
        } else if (dist <= outerR) {
          const t = (dist - r) / (outerR - r);
          wf = 1 - t * t * (3 - 2 * t); // smoothstep
        }

        const di = (py * pw + px) * 4;

        if (wf > 0) {
          // Inverse-map: sample from the position BEFORE the warp
          const sx = Math.max(0, Math.min(pw - 1.001, px - dx * wf));
          const sy = Math.max(0, Math.min(ph - 1.001, py - dy * wf));

          // Bilinear interpolation
          const sx0 = Math.floor(sx), sy0 = Math.floor(sy);
          const sx1 = Math.min(pw - 1, sx0 + 1);
          const sy1 = Math.min(ph - 1, sy0 + 1);
          const fx = sx - sx0, fy = sy - sy0;

          const i00 = (sy0 * pw + sx0) * 4;
          const i10 = (sy0 * pw + sx1) * 4;
          const i01 = (sy1 * pw + sx0) * 4;
          const i11 = (sy1 * pw + sx1) * 4;

          for (let c = 0; c < 4; c++) {
            dst.data[di + c] =
              src.data[i00 + c] * (1 - fx) * (1 - fy) +
              src.data[i10 + c] * fx * (1 - fy) +
              src.data[i01 + c] * (1 - fx) * fy +
              src.data[i11 + c] * fx * fy;
          }
        } else {
          // Outside warp zone — copy original pixel
          dst.data[di] = src.data[di];
          dst.data[di + 1] = src.data[di + 1];
          dst.data[di + 2] = src.data[di + 2];
          dst.data[di + 3] = src.data[di + 3];
        }
      }
    }

    ctx.putImageData(dst, x0, y0);
  }

  // ── MJPEG broadcast ───────────────────────────────────────────────────────

  _broadcastFrame() {
    if (!window.electronAPI) return;
    const fc = this.frameCanvas;
    const fCtx = this.frameCtx;
    fCtx.drawImage(this.outputCanvas, 0, 0, fc.width, fc.height);
    fc.toBlob(
      (blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => {
          window.electronAPI.sendCameraFrame(buf);
        });
      },
      'image/jpeg',
      0.82
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  stopCamera() {
    this.isRunning = false;
    if (this.cameraUtil) { try { this.cameraUtil.stop(); } catch { } }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.faceMesh) {
      try { this.faceMesh.close(); } catch { }
      this.faceMesh = null;
    }
  }
}