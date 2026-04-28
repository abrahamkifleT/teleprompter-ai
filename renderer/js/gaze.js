// ─── gaze.js — Eye gaze correction using MediaPipe FaceMesh ──────────────
//
// Algorithm:
//   1. Capture webcam via getUserMedia
//   2. Run MediaPipe FaceMesh (refineLandmarks: true) to get 478 landmarks
//      incl. iris landmarks 468-477
//   3. Detect iris centers and eye socket centers
//   4. Calculate gaze deviation from camera direction
//   5. Apply inverse-mapped warp (liquify-style) to each iris region
//   6. Output corrected frame to canvas (displayed in UI)
//   7. Encode canvas as JPEG and send to main process → MJPEG server
//      (for use with OBS Browser Source → Virtual Camera)

export class GazeCorrector {
  constructor(videoEl, outputCanvas, frameCanvas) {
    this.videoEl       = videoEl;
    this.outputCanvas  = outputCanvas;
    this.outputCtx     = outputCanvas.getContext('2d');
    this.frameCanvas   = frameCanvas;
    this.frameCtx      = frameCanvas.getContext('2d');

    this.faceMesh      = null;
    this.cameraUtil    = null;
    this.stream        = null;
    this.isRunning     = false;
    this.correctionOn  = false;
    this.correctionStrength = 0.92; // 0 = none, 1 = full — high value for teleprompter reading
    this.frameCount    = 0;

    // Camera position hint (where webcam is relative to screen)
    // Typical: webcam is above screen center → y-offset is negative (look up)
    this.cameraOffsetY = -0.18; // fraction of eye-height to shift iris upward
  }

  // ── Initialization ────────────────────────────────────────────────────
  async initCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await new Promise((res) => this.videoEl.onloadedmetadata = res);

      this.outputCanvas.width  = this.videoEl.videoWidth  || 640;
      this.outputCanvas.height = this.videoEl.videoHeight || 480;

      await this._initFaceMesh();
      this.isRunning = true;
    } catch (err) {
      console.error('[GazeCorrector] Camera init failed:', err);
    }
  }

  async _initFaceMesh() {
    // MediaPipe FaceMesh loaded via CDN in index.html
    if (typeof FaceMesh === 'undefined') {
      console.warn('[GazeCorrector] MediaPipe FaceMesh not available — skipping gaze correction');
      this._startPassthrough();
      return;
    }

    this.faceMesh = new FaceMesh({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });

    this.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,   // ← enables iris landmarks 468-477
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    this.faceMesh.onResults(this._onResults.bind(this));

    // MediaPipe Camera utility drives the processing loop
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
  }

  _startPassthrough() {
    // No FaceMesh — just pass through raw video
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

  // ── Main results handler ──────────────────────────────────────────────
  _onResults(results) {
    const ctx = this.outputCtx;
    const w   = this.outputCanvas.width;
    const h   = this.outputCanvas.height;

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(results.image, 0, 0, w, h);

    if (this.correctionOn &&
        results.multiFaceLandmarks &&
        results.multiFaceLandmarks.length > 0) {
      this._applyGazeCorrection(ctx, results.multiFaceLandmarks[0], w, h);
    }

    ctx.restore();

    // Broadcast to MJPEG server every 2nd frame (throttle to ~15fps for IPC)
    this.frameCount++;
    if (this.frameCount % 2 === 0) {
      this._broadcastFrame();
    }
  }

  // ── Gaze correction pipeline ──────────────────────────────────────────
  _applyGazeCorrection(ctx, landmarks, w, h) {
    // ── MediaPipe iris landmark indices ────────────────────────────────
    // Left eye:  outer=33, inner=133, top=159, bottom=145
    // Right eye: outer=263, inner=362, top=386, bottom=374
    // Left iris:  468 (center), 469, 470, 471, 472
    // Right iris: 473 (center), 474, 475, 476, 477

    const lm = landmarks;

    // Eye corners
    const LE = { outer: 33, inner: 133, top: 159, bottom: 145 };
    const RE = { outer: 263, inner: 362, top: 386, bottom: 374 };

    // Iris landmarks
    const LI = [468, 469, 470, 471, 472];
    const RI = [473, 474, 475, 476, 477];

    // Compute iris centers
    const leftIris  = this._avgLandmarks(lm, LI, w, h);
    const rightIris = this._avgLandmarks(lm, RI, w, h);

    // Compute eye socket centers
    const leftEyeCenter = {
      x: ((lm[LE.outer].x + lm[LE.inner].x) / 2) * w,
      y: ((lm[LE.top].y  + lm[LE.bottom].y) / 2) * h,
    };
    const rightEyeCenter = {
      x: ((lm[RE.outer].x + lm[RE.inner].x) / 2) * w,
      y: ((lm[RE.top].y  + lm[RE.bottom].y) / 2) * h,
    };

    // Eye width (for radius scaling)
    const leftEyeW  = Math.abs(lm[LE.outer].x - lm[LE.inner].x) * w;
    const rightEyeW = Math.abs(lm[RE.outer].x - lm[RE.inner].x) * w;

    // ── Calculate correction vector ────────────────────────────────────
    // Target: iris center at eye socket center (looking straight at camera)
    // Both X and Y correction enabled — critical for teleprompter reading
    // where eyes look significantly off-center
    const leftTarget = {
      x: leftEyeCenter.x  + this.cameraOffsetY * leftEyeW * 0.3,  // slight X offset toward camera
      y: leftEyeCenter.y  + this.cameraOffsetY * leftEyeW,
    };
    const rightTarget = {
      x: rightEyeCenter.x + this.cameraOffsetY * rightEyeW * 0.3,
      y: rightEyeCenter.y + this.cameraOffsetY * rightEyeW,
    };

    // The displacement to apply to iris — full X and Y correction
    const leftDelta = {
      x: (leftTarget.x  - leftIris.x)  * this.correctionStrength,
      y: (leftTarget.y  - leftIris.y)  * this.correctionStrength,
    };
    const rightDelta = {
      x: (rightTarget.x - rightIris.x) * this.correctionStrength,
      y: (rightTarget.y - rightIris.y) * this.correctionStrength,
    };

    // Warp radius — larger for teleprompter use (eyes move more)
    const leftRadius  = leftEyeW  * 0.75;
    const rightRadius = rightEyeW * 0.75;

    // Apply liquify warp to each iris region
    this._warpRegion(ctx, leftIris,  leftDelta,  leftRadius,  w, h);
    this._warpRegion(ctx, rightIris, rightDelta, rightRadius, w, h);
  }

  // ── Inverse-mapped warp (liquify / push pixels) ───────────────────────
  // For each destination pixel, compute where it came from (inverse map)
  // using a radial falloff centered on the iris.
  _warpRegion(ctx, center, delta, radius, canvasW, canvasH) {
    const falloff = radius * 2.2;  // wider influence radius for smoother warp
    const margin  = Math.ceil(falloff) + 2;

    // Bounding box clamped to canvas
    const x0 = Math.max(0, Math.floor(center.x - margin));
    const y0 = Math.max(0, Math.floor(center.y - margin));
    const x1 = Math.min(canvasW,  Math.ceil(center.x + margin));
    const y1 = Math.min(canvasH, Math.ceil(center.y + margin));
    const bw  = x1 - x0;
    const bh  = y1 - y0;
    if (bw <= 0 || bh <= 0) return;

    const src = ctx.getImageData(x0, y0, bw, bh);
    const dst = new Uint8ClampedArray(src.data.length);

    const srcData = src.data;
    const cx = center.x - x0;
    const cy = center.y - y0;
    const dx = delta.x;
    const dy = delta.y;

    for (let py = 0; py < bh; py++) {
      for (let px = 0; px < bw; px++) {
        const wx = px - cx;
        const wy = py - cy;
        const dist = Math.sqrt(wx * wx + wy * wy);

        // Smooth falloff (cosine)
        let t = 0;
        if (dist < falloff) {
          t = 0.5 * (1 + Math.cos(Math.PI * dist / falloff));
          t = t * t; // sharpen falloff
        }

        // Inverse warp: source position = dest - delta * t
        const srcPx = px - dx * t;
        const srcPy = py - dy * t;

        // Bilinear interpolation
        const sx = Math.floor(srcPx);
        const sy = Math.floor(srcPy);
        const fx = srcPx - sx;
        const fy = srcPy - sy;

        const dIdx = (py * bw + px) * 4;

        if (sx >= 0 && sx < bw - 1 && sy >= 0 && sy < bh - 1) {
          for (let c = 0; c < 4; c++) {
            const s00 = srcData[(sy       * bw + sx)     * 4 + c];
            const s10 = srcData[(sy       * bw + sx + 1) * 4 + c];
            const s01 = srcData[((sy + 1) * bw + sx)     * 4 + c];
            const s11 = srcData[((sy + 1) * bw + sx + 1) * 4 + c];
            dst[dIdx + c] = Math.round(
              s00 * (1 - fx) * (1 - fy) +
              s10 * fx       * (1 - fy) +
              s01 * (1 - fx) * fy +
              s11 * fx       * fy
            );
          }
        } else {
          // Out of bounds — copy original
          for (let c = 0; c < 4; c++) {
            const clampX = Math.max(0, Math.min(bw - 1, sx));
            const clampY = Math.max(0, Math.min(bh - 1, sy));
            dst[dIdx + c] = srcData[(clampY * bw + clampX) * 4 + c];
          }
        }
      }
    }

    ctx.putImageData(new ImageData(dst, bw, bh), x0, y0);
  }

  // ── Average landmark positions ────────────────────────────────────────
  _avgLandmarks(lm, indices, w, h) {
    let x = 0, y = 0;
    for (const i of indices) { x += lm[i].x; y += lm[i].y; }
    return { x: (x / indices.length) * w, y: (y / indices.length) * h };
  }

  // ── Broadcast corrected frame to MJPEG server ─────────────────────────
  _broadcastFrame() {
    if (!window.electronAPI) return;
    const fc  = this.frameCanvas;
    const fCtx = this.frameCtx;
    fCtx.drawImage(this.outputCanvas, 0, 0, fc.width, fc.height);

    fc.toBlob((blob) => {
      if (!blob) return;
      blob.arrayBuffer().then((buf) => {
        window.electronAPI.sendCameraFrame(buf);
      });
    }, 'image/jpeg', 0.8);
  }

  // ── Controls ──────────────────────────────────────────────────────────
  setCorrection(on) {
    this.correctionOn = on;
  }

  setCorrectionStrength(val) {
    this.correctionStrength = Math.max(0, Math.min(1, val));
  }

  stopCamera() {
    this.isRunning = false;
    if (this.cameraUtil) this.cameraUtil.stop();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.faceMesh) {
      this.faceMesh.close();
      this.faceMesh = null;
    }
  }
}
