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
    // ⚠️ These defaults are tuned for a top-of-monitor camera while the user
    //    looks DOWN at a teleprompter.  Strength 88% + big upward offset (-0.45)
    //    gives a clearly visible iris redirect toward the camera lens.
    this.correctionStrength = 0.88; // 0–1
    this.blendFactor = 0.30;        // iris-warp feather width (tighter = sharper)
    this.cameraOffsetY = -0.45;     // -1..0  (negative = camera above screen)

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

    // Broadcast every frame to ensure smooth video (typically 30 fps)
    this.frameCount++;
    this._broadcastFrame();
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

  /**
   * Returns the eye-socket bounding ellipse (halfW / halfH) from landmarks.
   * This defines the full eye area that will be warped — much larger than
   * the iris alone, covering the whites and eyelids too.
   */
  _getEyeBox(lm, indices, w, h) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const i of indices) {
      const x = lm[i].x * w, y = lm[i].y * h;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      halfW: (maxX - minX) / 2 * 1.5,  // covers full eye white + lash line
      halfH: (maxY - minY) / 2 * 2.4,  // tall: upper + lower eyelid skin
    };
  }

  _applyGazeCorrection(ctx, lm, w, h) {
    const str = this.correctionStrength;

    // ── Left eye ────────────────────────────────────────────────────────
    const li = this._getIrisInfo(lm, this.LEFT_IRIS, w, h);
    const lbox = this._getEyeBox(lm, this.LEFT_EYE, w, h);
    // Target = eye-socket centre shifted upward toward the camera lens
    const lcTarget = {
      x: lbox.cx,
      y: lbox.cy + this.cameraOffsetY * li.radius * 4,
    };
    this._warpEye(ctx, li, lbox, lcTarget, w, h, str);

    // ── Right eye ───────────────────────────────────────────────────────
    const ri = this._getIrisInfo(lm, this.RIGHT_IRIS, w, h);
    const rbox = this._getEyeBox(lm, this.RIGHT_EYE, w, h);
    const rcTarget = {
      x: rbox.cx,
      y: rbox.cy + this.cameraOffsetY * ri.radius * 4,
    };
    this._warpEye(ctx, ri, rbox, rcTarget, w, h, str);
  }

  /**
   * CapCut-style full-eye warp.
   *
   * Warps the ENTIRE eye region — iris + sclera (whites) + eyelids — as
   * one unit so the output looks like a genuine gaze rotation, not just
   * a nudged iris dot.
   *
   * Key differences from the old _warpIris:
   *   • Warp zone  = eye-socket ellipse (~halfW 35-40px) not iris circle (~15px)
   *   • Falloff    = elliptical (matches the actual eye shape)
   *   • Patch size = covers source + destination so inverse-map never clamps
   */
  _warpEye(ctx, iris, eyeBox, target, w, h, str) {
    const dx = (target.x - iris.cx) * str;
    const dy = (target.y - iris.cy) * str;

    if (Math.hypot(dx, dy) < 0.5) return;

    const { halfW, halfH } = eyeBox;

    // ── KEY FIX: center the warp at the IRIS, not the eye socket ──
    // This ensures wf = 1.0 exactly at the iris (full displacement),
    // and fades to 0 at the socket edge. The old socket-centered approach
    // gave the iris only ~80% displacement when looking down.
    const wcx = iris.cx;
    const wcy = iris.cy;

    const pad = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) + 4;
    const margin = Math.ceil(Math.max(halfW, halfH)) + pad;

    const x0 = Math.max(0, Math.floor(wcx - margin));
    const y0 = Math.max(0, Math.floor(wcy - margin));
    const x1 = Math.min(w, Math.ceil(wcx + margin));
    const y1 = Math.min(h, Math.ceil(wcy + margin));
    const pw = x1 - x0;
    const ph = y1 - y0;
    if (pw <= 0 || ph <= 0) return;

    const src = ctx.getImageData(x0, y0, pw, ph);
    const dst = new ImageData(pw, ph);

    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const canvasX = x0 + px;
        const canvasY = y0 + py;

        // Elliptical distance from IRIS CENTER (0=iris, 1=socket edge, >1=outside)
        const ex = (canvasX - wcx) / halfW;
        const ey = (canvasY - wcy) / halfH;
        const eDist = Math.sqrt(ex * ex + ey * ey);

        const di = (py * pw + px) * 4;

        if (eDist < 1.0) {
          // Smoothstep: wf=1.0 at iris center, 0 at socket rim
          const wf = 1.0 - eDist * eDist * (3.0 - 2.0 * eDist);
          const srcX = (canvasX - dx * wf) - x0;
          const srcY = (canvasY - dy * wf) - y0;

          const sx = Math.max(0, Math.min(pw - 1.001, srcX));
          const sy = Math.max(0, Math.min(ph - 1.001, srcY));

          const sx0f = Math.floor(sx), sy0f = Math.floor(sy);
          const sx1f = Math.min(pw - 1, sx0f + 1);
          const sy1f = Math.min(ph - 1, sy0f + 1);
          const fx = sx - sx0f, fy = sy - sy0f;

          const i00 = (sy0f * pw + sx0f) * 4;
          const i10 = (sy0f * pw + sx1f) * 4;
          const i01 = (sy1f * pw + sx0f) * 4;
          const i11 = (sy1f * pw + sx1f) * 4;

          for (let c = 0; c < 4; c++) {
            dst.data[di + c] =
              src.data[i00 + c] * (1 - fx) * (1 - fy) +
              src.data[i10 + c] * fx * (1 - fy) +
              src.data[i01 + c] * (1 - fx) * fy +
              src.data[i11 + c] * fx * fy;
          }
        } else {
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

    // Force lower resolution for the broadcast to massively reduce lag
    if (fc.width !== 480) {
      fc.width = 480;
      fc.height = 360;
    }

    fCtx.drawImage(this.outputCanvas, 0, 0, fc.width, fc.height);

    // toBlob is asynchronous and creates massive queue lag when running at 30fps.
    // toDataURL with WebP is drastically faster than JPEG in Chromium,
    // solving the root cause of the encoding lag.
    const dataUrl = fc.toDataURL('image/webp', 0.50);
    const base64Data = dataUrl.split(',')[1];
    
    window.electronAPI.sendCameraFrame(base64Data);
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