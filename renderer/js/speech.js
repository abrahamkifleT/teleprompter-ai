// ─── speech.js — Audio capture → OpenAI Whisper transcription ───────────────
//
// Replaces the Web Speech API (which throws "network" errors in Electron
// because it requires a live connection to Google's speech servers).
//
// New flow:
//   1. getUserMedia (mic) or getDisplayMedia (system/PC audio)
//   2. MediaRecorder collects audio chunks
//   3. AudioContext analyser detects silence
//   4. After configurable silence threshold → POST to Whisper API
//   5. Return transcript via onFinal callback

export class SpeechCapture {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isListening = false;

    this._onInterim = null;
    this._onFinal = null;
    this._onError = null;
    this._onAudioLevel = null; // callback(rms: number 0-100) — real-time level

    this._silenceMs = 3000;   // ms of silence before auto-submit
    this._audioContext = null;
    this._analyser = null;
    this._silenceCheckInt = null;
    this._stream = null;
    this._apiKey = null;
    this._hasSpeech = false;  // true once any sound above threshold heard
    this._submitting = false;
    this._audioSource = 'mic';  // 'mic' | 'system'
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  /** Pass in the OpenAI API key before calling start() */
  setApiKey(key) { this._apiKey = (key || '').trim(); }

  /** 'mic' = microphone, 'system' = PC / system audio (getDisplayMedia) */
  setAudioSource(src) { this._audioSource = src === 'system' ? 'system' : 'mic'; }

  /** Auto-submit silence timeout in ms (clamped 1s – 15s) */
  setSilenceTimeout(ms) {
    this._silenceMs = Math.max(1000, Math.min(15000, parseInt(ms) || 3000));
  }

  // ── Public lifecycle ──────────────────────────────────────────────────────

  async start(onInterim, onFinal, onError, onAudioLevel) {
    if (this.isListening) this.stop();

    this._onInterim = onInterim;
    this._onFinal = onFinal;
    this._onError = onError;
    this._onAudioLevel = onAudioLevel || null;
    this.audioChunks = [];
    this._hasSpeech = false;
    this._submitting = false;

    console.log('[Speech] Starting audio capture…');

    try {
      await this._acquireStream();
      console.log('[Speech] Stream acquired — tracks:', this._stream.getTracks().map(t => `${t.kind}:${t.label}`).join(', '));

      // AudioContext for silence detection
      this._audioContext = new AudioContext();
      const source = this._audioContext.createMediaStreamSource(this._stream);
      this._analyser = this._audioContext.createAnalyser();
      this._analyser.fftSize = 512;
      source.connect(this._analyser);

      // MediaRecorder for audio capture
      const mimeType = this._bestMimeType();
      console.log('[Speech] Using MIME type:', mimeType || '(browser default)');
      this.mediaRecorder = new MediaRecorder(
        this._stream,
        mimeType ? { mimeType } : {}
      );

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.audioChunks.push(e.data);
          console.log(`[Speech] Chunk received: ${e.data.size} bytes (total chunks: ${this.audioChunks.length})`);
        }
      };

      this.mediaRecorder.onerror = (e) => {
        console.error('[Speech] MediaRecorder error:', e.error || e);
        if (this._onError) this._onError('Recording error: ' + (e.error || e));
      };

      this.mediaRecorder.start(250); // collect a chunk every 250 ms
      this.isListening = true;
      console.log('[Speech] ✅ MediaRecorder started — state:', this.mediaRecorder.state);

      if (this._onInterim) this._onInterim('🎙 Listening — speak now…');
      this._startSilenceDetection();

    } catch (err) {
      this.isListening = false;
      console.error('[Speech] ❌ Failed to start:', err.name, err.message);
      const friendly =
        err.name === 'NotAllowedError'
          ? 'Microphone permission denied — please allow microphone access in system settings.'
          : err.name === 'NotFoundError'
            ? 'No microphone found. Please connect a microphone and try again.'
            : err.message || String(err);
      if (onError) onError(friendly);
    }
  }

  stop() {
    clearInterval(this._silenceCheckInt);
    this._silenceCheckInt = null;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch { }
    }
    this.mediaRecorder = null;

    if (this._audioContext) {
      try { this._audioContext.close(); } catch { }
      this._audioContext = null;
      this._analyser = null;
    }

    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }

    this.isListening = false;
    this._submitting = false;
  }

  /** Force-submit whatever audio has been captured so far */
  forceSubmit() {
    if (this.isListening) this._submit();
  }

  // ── Stream acquisition ────────────────────────────────────────────────────

  async _acquireStream() {
    if (this._audioSource === 'system') {
      try {
        // Capture whatever audio is playing on the PC (Zoom, browser, etc.)
        this._stream = await navigator.mediaDevices.getDisplayMedia({
          video: false,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 44100,
          },
        });
        return;
      } catch (err) {
        // User cancelled screen-share or no system audio available → fall through to mic
        console.warn('[Speech] System audio unavailable, falling back to mic:', err.message);
      }
    }

    // Default: microphone
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
      video: false,
    });
  }

  // ── Silence detection ─────────────────────────────────────────────────────

  _startSilenceDetection() {
    const bufLen = this._analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufLen);
    let silenceStart = null;

    this._silenceCheckInt = setInterval(() => {
      if (!this._analyser || !this.isListening) return;

      this._analyser.getByteFrequencyData(dataArray);
      // RMS of frequency data as proxy for loudness
      const rms = Math.sqrt(
        dataArray.reduce((s, v) => s + v * v, 0) / bufLen
      );

      // Normalize to 0-100 and emit to UI for live visualizer
      const level = Math.min(100, Math.round(rms / 1.28 * 1));
      if (this._onAudioLevel) this._onAudioLevel(level, rms);

      if (rms > 8) {
        // Sound above threshold → reset silence clock
        if (!this._hasSpeech) console.log('[Speech] 🎤 Speech detected! RMS:', rms.toFixed(1));
        this._hasSpeech = true;
        silenceStart = null;
        if (this._onInterim) this._onInterim('🎙 Hearing you…');
      } else if (this._hasSpeech) {
        // Below threshold after speech → count down to submit
        if (!silenceStart) {
          silenceStart = Date.now();
          console.log('[Speech] Silence detected, starting countdown…');
        }
        const elapsed = Date.now() - silenceStart;
        const remaining = Math.max(0, Math.ceil((this._silenceMs - elapsed) / 1000));
        if (this._onInterim) this._onInterim(`🤫 Done speaking? Sending in ${remaining}s…`);
        if (elapsed >= this._silenceMs) this._submit();
      }
    }, 150);
  }

  // ── Submit audio to Whisper ───────────────────────────────────────────────

  async _submit() {
    if (this._submitting || !this.isListening) return;
    if (this.audioChunks.length === 0) { this.stop(); return; }

    this._submitting = true;
    const chunks = [...this.audioChunks];
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    this.stop(); // release mic/system audio immediately

    if (!this._apiKey) {
      if (this._onError)
        this._onError('No OpenAI API key — add it in Settings (Ctrl+,) then try again.');
      return;
    }

    try {
      if (this._onInterim) this._onInterim('⏳ Transcribing with Whisper…');
      const transcript = await this._whisperTranscribe(chunks, mimeType);
      const text = (transcript || '').trim();
      if (text) {
        if (this._onFinal) this._onFinal(text);
      } else {
        if (this._onError) this._onError('No speech detected — try speaking louder or closer to the mic.');
      }
    } catch (err) {
      if (this._onError)
        this._onError('Transcription failed: ' + (err.message || err));
    }
  }

  async _whisperTranscribe(chunks, mimeType) {
    // Map MIME type to a file extension Whisper accepts
    let ext = 'webm';
    if (mimeType.includes('ogg')) ext = 'ogg';
    else if (mimeType.includes('mp4')) ext = 'mp4';
    else if (mimeType.includes('wav')) ext = 'wav';

    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    const formData = new FormData();
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this._apiKey}` },
      body: formData,
    });

    if (!resp.ok) {
      let msg = `Whisper API error (HTTP ${resp.status})`;
      try {
        const j = await resp.json();
        msg = j.error?.message || msg;
      } catch { }
      throw new Error(msg);
    }

    const data = await resp.json();
    return data.text || '';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _bestMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }
}