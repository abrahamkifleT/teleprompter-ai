// ─── speech.js — Audio capture → OpenAI Whisper transcription ───────────────
//
// Supports three capture modes:
//   'mic'    — microphone only (default)
//   'system' — internal/system audio only (meeting apps, browser tabs, etc.)
//   'both'   — mic + system audio merged into one stream (best for interviews:
//              captures interviewer via system audio + your replies via mic)
//
// Flow: stream → MediaRecorder → silence detection → Whisper API → transcript

export class SpeechCapture {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isListening = false;

    this._onInterim = null;
    this._onFinal = null;
    this._onError = null;
    this._onAudioLevel = null;
    this._onLiveTranscript = null;  // real-time word display callback

    this._silenceMs = 1500;   // default 1.5 s — balanced for interview use
    this._sentenceEndMs = 400; // after punctuation detected, wait this long before firing
    this._audioContext = null;
    this._analyser = null;
    this._silenceCheckInt = null;

    // All acquired streams — kept so we can stop them individually on cleanup
    this._streams = [];
    this._apiKey = null;
    this._hasSpeech = false;
    this._submitting = false;

    // 'mic' | 'system' | 'both'
    this._audioSource = 'mic';

    // ── Live SpeechRecognition (browser-native, runs in parallel with Whisper)
    this._liveRecognition = null;
    this._liveTranscript = '';      // accumulated live words
    this._liveInterimText = '';     // current interim (unfinished) phrase
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  setApiKey(key) { this._apiKey = (key || '').trim(); }

  /**
   * Set the audio capture mode.
   * @param {'mic'|'system'|'both'} src
   */
  setAudioSource(src) {
    if (['mic', 'system', 'both'].includes(src)) this._audioSource = src;
  }

  getAudioSource() { return this._audioSource; }

  setSilenceTimeout(ms) {
    // Minimum 400 ms — fast enough for interview use without cutting off mid-word
    this._silenceMs = Math.max(400, Math.min(15000, parseInt(ms) || 1500));
  }

  // ── Public lifecycle ──────────────────────────────────────────────────────

  async start(onInterim, onFinal, onError, onAudioLevel, onLiveTranscript) {
    if (this.isListening) this.stop();

    this._onInterim = onInterim;
    this._onFinal = onFinal;
    this._onError = onError;
    this._onAudioLevel = onAudioLevel || null;
    this._onLiveTranscript = onLiveTranscript || null;
    this.audioChunks = [];
    this._hasSpeech = false;
    this._submitting = false;
    this._streams = [];
    this._liveTranscript = '';
    this._liveInterimText = '';

    console.log(`[Speech] Starting in mode: ${this._audioSource}`);
    console.log('[Speech] navigator.mediaDevices available:', !!navigator.mediaDevices);
    console.log('[Speech] getUserMedia available:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));

    try {
      const recordingStream = await this._buildRecordingStream();

      // AudioContext for silence detection — analyser taps the merged stream
      this._audioContext = new AudioContext();

      // CRITICAL: AudioContext starts suspended in Chromium. Must resume explicitly.
      // Without this, the analyser returns all zeros even if the mic is working.
      if (this._audioContext.state === 'suspended') {
        console.log('[Speech] AudioContext is suspended — resuming...');
        await this._audioContext.resume();
      }
      console.log('[Speech] AudioContext state:', this._audioContext.state, '| sampleRate:', this._audioContext.sampleRate);

      const source = this._audioContext.createMediaStreamSource(recordingStream);
      this._analyser = this._audioContext.createAnalyser();
      this._analyser.fftSize = 512;
      source.connect(this._analyser);

      const mimeType = this._bestMimeType();
      console.log('[Speech] MIME type:', mimeType || '(browser default)');
      this.mediaRecorder = new MediaRecorder(
        recordingStream,
        {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 128000
        }
      );

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.onerror = (e) => {
        console.error('[Speech] Recorder error:', e.error || e);
        if (this._onError) this._onError('Recording error: ' + (e.error || e));
      };

      this.mediaRecorder.start(250);
      this.isListening = true;
      console.log('[Speech] ✅ Recording started');

      if (this._onInterim) this._onInterim('🎙 Listening — speak now…');
      this._startSilenceDetection();

      // Start browser-native live transcription (runs in parallel)
      this._startLiveRecognition();

    } catch (err) {
      this.isListening = false;
      this._releaseStreams();
      console.error('[Speech] ❌ Failed to start:', err.name, err.message);

      let msg = err.message || String(err);
      if (err.name === 'NotAllowedError')
        msg = 'Permission denied — allow microphone access in system settings.';
      else if (err.name === 'NotFoundError')
        msg = 'No microphone found. Connect a microphone and try again.';
      else if (err.name === 'AbortError' || msg.toLowerCase().includes('cancel'))
        msg = 'Screen share cancelled — click "Share" and enable "Share system audio" to capture internal audio.';

      if (onError) onError(msg);
    }
  }

  stop() {
    clearInterval(this._silenceCheckInt);
    this._silenceCheckInt = null;

    clearInterval(this._whisperPollInt);
    this._whisperPollInt = null;
    this._isPollingWhisper = false;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch { }
    }
    this.mediaRecorder = null;

    if (this._audioContext) {
      try { this._audioContext.close(); } catch { }
      this._audioContext = null;
      this._analyser = null;
    }

    this._stopLiveRecognition();
    this._releaseStreams();
    this.isListening = false;
    this._submitting = false;
  }

  forceSubmit() {
    if (this.isListening) this._submit();
  }

  // ── Stream building ───────────────────────────────────────────────────────

  /**
   * Returns a single MediaStream to record from, based on _audioSource.
   *
   * 'mic'    → getUserMedia
   * 'system' → getDisplayMedia (audio-only, requires user picks screen + ticks
   *            "Share system audio" / "Share audio" in the browser dialog)
   * 'both'   → merge mic + system via Web Audio API into one destination stream
   */
  async _buildRecordingStream() {
    switch (this._audioSource) {
      case 'system':
        return await this._getSystemStream();

      case 'both': {
        // Acquire both; if system fails gracefully fall back to mic-only
        const micStream = await this._getMicStream();
        let sysStream = null;
        try {
          sysStream = await this._getSystemStream();
        } catch (err) {
          console.warn('[Speech] System audio unavailable, using mic only:', err.message);
          return micStream;
        }
        return this._mergeStreams(micStream, sysStream);
      }

      case 'mic':
      default:
        return await this._getMicStream();
    }
  }

  async _getMicStream() {
    console.log('[Speech] Requesting mic stream via getUserMedia...');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('navigator.mediaDevices.getUserMedia is not available.');
    }

    let devices = [];
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      devices = allDevices.filter(d => d.kind === 'audioinput');
      console.log('[Speech] Available audio input devices:', devices.length);
      devices.forEach((d, i) => console.log(`  [${i}] ${d.label || '(unnamed)'} — ${d.deviceId.slice(0,8)}...`));
    } catch (e) {
      console.warn('[Speech] Could not enumerate devices:', e.message);
    }

    // Array of deviceIds to try. Try 'undefined' (system default) first.
    // Then try the specific hardware device IDs.
    const deviceIdsToTry = [undefined, ...devices.map(d => d.deviceId).filter(id => id && id !== 'default' && id !== 'communications')];
    
    let lastError = null;

    for (let i = 0; i < deviceIdsToTry.length; i++) {
      const deviceId = deviceIdsToTry[i];
      try {
        console.log(`\n[Speech] 🔄 Trying microphone ${i+1}/${deviceIdsToTry.length} (deviceId: ${deviceId || 'system default'})`);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true, // Re-enabled to filter out background static
            autoGainControl: true,  // Re-enabled to normalize mic volume
            ...(deviceId ? { deviceId: { exact: deviceId } } : {})
          },
          video: false,
        });

        const tracks = stream.getAudioTracks();
        tracks.forEach(t => t.enabled = true); // Force enable

        // Sanity test: read a few samples to verify it's not a muted virtual device
        const testCtx = new AudioContext();
        if (testCtx.state === 'suspended') await testCtx.resume();
        const testSource = testCtx.createMediaStreamSource(stream);
        const testAnalyser = testCtx.createAnalyser();
        testAnalyser.fftSize = 256;
        testSource.connect(testAnalyser);
        const testData = new Uint8Array(testAnalyser.frequencyBinCount);
        
        // Wait 400ms for audio buffers to fill
        await new Promise(r => setTimeout(r, 400));
        testAnalyser.getByteFrequencyData(testData);
        const testRms = Math.sqrt(testData.reduce((s, v) => s + v * v, 0) / testData.length);
        
        console.log(`[Speech] 🔍 Audio test for this mic — RMS: ${testRms.toFixed(2)}`);
        
        testSource.disconnect();
        testCtx.close();

        if (testRms >= 0.5) {
           console.log(`[Speech] ✅ Found working microphone! Using: ${tracks[0]?.label}`);
           this._streams.push(stream);
           return stream; // SUCCESS!
        } else {
           console.warn(`[Speech] ⚠️ Microphone captured silence (RMS=0). Skipping broken/virtual device...`);
           stream.getTracks().forEach(t => t.stop()); // Clean up the silent stream
           lastError = new Error('Microphone is capturing silence (RMS=0).');
        }
      } catch (err) {
        console.warn(`[Speech] ⚠️ Failed to open microphone: ${err.message}`);
        lastError = err;
      }
    }

    // If we get here, EVERY microphone failed or returned silence
    throw new Error(
      'Could not find a working microphone. ' +
      (lastError ? lastError.message : '') + 
      ' Check Windows Settings -> Privacy & Security -> Microphone and ensure "Let desktop apps access your microphone" is ON.'
    );
  }

  async _getSystemStream() {
    // getDisplayMedia returns a stream containing system/tab/app audio.
    // The user MUST tick "Share audio" / "Share system audio" in the picker.
    // video:false alone is not always honoured by browsers; we request a
    // minimal video track and discard it after stream creation to maximise
    // browser compatibility while keeping the audio track alive.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 }, // minimal; discarded below
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
      },
    });

    // Stop the video track immediately — we only want audio
    stream.getVideoTracks().forEach(t => t.stop());

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error(
        'No audio track in screen share. In the share dialog, make sure to tick "Share system audio" or "Share audio".'
      );
    }

    this._streams.push(stream);
    console.log('[Speech] System audio stream acquired:', audioTracks.map(t => t.label).join(', '));
    return stream;
  }

  /**
   * Merge mic + system audio streams into a single MediaStream using
   * the Web Audio API (both play through the same AudioContext destination).
   */
  _mergeStreams(micStream, sysStream) {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();

    const micSrc = ctx.createMediaStreamSource(micStream);
    const sysSrc = ctx.createMediaStreamSource(sysStream);

    // Optional: slight boost on mic so your voice doesn't get drowned out
    const micGain = ctx.createGain();
    micGain.gain.value = 1.2;
    micSrc.connect(micGain);
    micGain.connect(dest);

    const sysGain = ctx.createGain();
    sysGain.gain.value = 1.0;
    sysSrc.connect(sysGain);
    sysGain.connect(dest);

    // Keep a reference so we can close it during stop()
    this._mergeContext = ctx;

    const merged = dest.stream;
    console.log('[Speech] Mixed stream created (mic + system)');
    return merged;
  }

  _releaseStreams() {
    this._streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    this._streams = [];
    if (this._mergeContext) {
      try { this._mergeContext.close(); } catch { }
      this._mergeContext = null;
    }
  }

  // ── Silence detection ─────────────────────────────────────────────────────

  _startSilenceDetection() {
    const bufLen = this._analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufLen);
    let silenceStart = null;
    let sentenceEndDetected = false;   // true once punctuation seen in live transcript
    let sentenceEndStart = null;       // timestamp when sentence-end punctuation first seen

    // Helper: does the current live transcript look like a finished sentence?
    const looksFinished = () => {
      const t = (this._liveTranscript + this._liveInterimText).trim();
      return t.length > 8 && /[.?!]\s*$/.test(t);
    };

    this._silenceCheckInt = setInterval(() => {
      if (!this._analyser || !this.isListening) return;

      this._analyser.getByteFrequencyData(dataArray);
      const rms = Math.sqrt(dataArray.reduce((s, v) => s + v * v, 0) / bufLen);
      const level = Math.min(100, Math.round(rms / 1.28));
      if (this._onAudioLevel) this._onAudioLevel(level, rms);

      if (rms > 8) {
        // Active speech — reset silence timer but keep sentence-end flag if punctuation seen
        if (!this._hasSpeech) console.log('[Speech] 🎤 Sound detected! RMS:', rms.toFixed(1));
        this._hasSpeech = true;
        silenceStart = null;
        // Reset sentence-end gate when new speech resumes after punctuation
        if (sentenceEndDetected) {
          sentenceEndDetected = false;
          sentenceEndStart = null;
        }
        if (this._onInterim) this._onInterim('🎙 Hearing you…');

      } else if (this._hasSpeech) {
        // ── Silence phase ──────────────────────────────────────────────────
        if (!silenceStart) silenceStart = Date.now();
        const silenceElapsed = Date.now() - silenceStart;

        // Check if the live transcript ends with sentence-ending punctuation
        if (!sentenceEndDetected && looksFinished()) {
          sentenceEndDetected = true;
          sentenceEndStart = Date.now();
          console.log('[Speech] ✅ Sentence-end punctuation detected — fast-submitting in', this._sentenceEndMs, 'ms');
        }

        // Fast path: punctuation + short pause → submit quickly
        if (sentenceEndDetected) {
          const sentenceElapsed = Date.now() - sentenceEndStart;
          if (sentenceElapsed >= this._sentenceEndMs) {
            console.log('[Speech] ⚡ Sentence complete — submitting now');
            this._submit();
            return;
          }
          if (this._onInterim) this._onInterim('✅ Sentence complete — sending…');
          return;
        }

        // Slow path: no punctuation → wait for full silence timeout
        const remaining = Math.max(0, Math.ceil((this._silenceMs - silenceElapsed) / 1000));
        if (this._onInterim) {
          this._onInterim(remaining > 0
            ? `🤫 Done speaking? Sending in ${remaining}s…`
            : '⏳ Sending…'
          );
        }
        if (silenceElapsed >= this._silenceMs) this._submit();
      }
    }, 100);  // poll every 100 ms for snappier response

    // ── Whisper Polling for Live Transcript ──
    // Polls Whisper every 1.5 s to update the live transcript (used for
    // sentence-boundary detection above as well as on-screen display).
    this._whisperPollInt = setInterval(async () => {
      if (!this.isListening || !this._hasSpeech || this.audioChunks.length === 0 || this._isPollingWhisper) return;
      this._isPollingWhisper = true;
      try {
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const transcript = await this._whisperTranscribe([...this.audioChunks], mimeType);
        if (this.isListening && transcript) {
           this._liveTranscript = transcript.trim();
           if (this._onLiveTranscript) this._onLiveTranscript(this._liveTranscript, true);
        }
      } catch (e) {
        // Ignore polling errors to not interrupt the main flow
      }
      this._isPollingWhisper = false;
    }, 1500);
  }

  // ── Whisper transcription ─────────────────────────────────────────────────

  async _submit() {
    if (this._submitting || !this.isListening) return;

    this._submitting = true;

    // Flush remaining audio buffer to ensure the final word isn't chopped off
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.requestData(); } catch(e) {}
    }
    // Wait briefly for the dataavailable event to append the last chunk
    await new Promise(r => setTimeout(r, 60));

    if (this.audioChunks.length === 0) { this.stop(); return; }

    const chunks = [...this.audioChunks];
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    this.stop();

    if (!this._apiKey) {
      if (this._onError) this._onError('No OpenAI API key — add it in Settings (Ctrl+,).');
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
      if (this._onError) this._onError('Transcription failed: ' + (err.message || err));
    }
  }

  async _whisperTranscribe(chunks, mimeType) {
    let ext = 'webm';
    if (mimeType.includes('ogg')) ext = 'ogg';
    if (mimeType.includes('mp4')) ext = 'mp4';
    if (mimeType.includes('wav')) ext = 'wav';

    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    const formData = new FormData();
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('temperature', '0');  // deterministic — avoids hallucinations
    // Explicit English forces Whisper into the right language model, which
    // dramatically improves accuracy for non-native English accents because
    // Whisper won't waste probability mass considering other languages.
    formData.append('language', 'en');
    // The prompt primes Whisper's vocabulary and speaking style so it recognises
    // interview terminology and proper nouns correctly even with an accent.
    // Whisper uses this as a prior — it doesn't have to be a literal transcript.
    formData.append('prompt',
      'Professional job interview. The speaker has a clear accent and is asking or answering ' +
      'questions about their experience, skills, background, and career. ' +
      'Common words: experience, background, team, project, leadership, management, ' +
      'technology, development, strategy, responsible, collaborate, achieve, result, ' +
      'challenge, solution, company, role, position, opportunity. ' +
      'Transcribe every word exactly as spoken, including sentence-ending punctuation.');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this._apiKey}` },
      body: formData,
    });

    if (!resp.ok) {
      let msg = `Whisper API error (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = j.error?.message || msg; } catch { }
      throw new Error(msg);
    }

    return (await resp.json()).text || '';
  }

  // ── Live SpeechRecognition (browser-native, for real-time word display) ──

  /**
   * Starts the browser's built-in SpeechRecognition engine in parallel.
   * This does NOT replace Whisper — it runs alongside it so the user can
   * see their words appear on-screen in real time (proving the app hears them).
   * The final transcription is still handled by Whisper for accuracy.
   */
  _startLiveRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    // In Electron, SpeechRecognition exists but fails with a "network" error
    // because the open-source Chromium build lacks Google's proprietary API keys.
    const isElectron = !!(window.electronAPI);

    if (!SpeechRecognition || isElectron) {
      // Live transcript will not work, but Whisper transcription still does.
      console.warn('[Speech] webkitSpeechRecognition not available or running in Electron — live transcript disabled.');
      console.warn('[Speech] (This is normal. Whisper will handle transcription after you finish speaking.)');
      if (this._onLiveTranscript) {
        this._onLiveTranscript('(Live preview not available in Electron — Whisper will transcribe after you finish speaking)', false);
      }
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        let interim = '';
        let finalChunk = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalChunk += transcript + ' ';
          } else {
            interim += transcript;
          }
        }

        if (finalChunk) {
          this._liveTranscript += finalChunk;
        }
        this._liveInterimText = interim;

        const display = (this._liveTranscript + interim).trim();
        if (display && this._onLiveTranscript) {
          this._onLiveTranscript(display, !!interim);
        }
      };

      recognition.onerror = (e) => {
        // 'no-speech' and 'aborted' are expected — don't treat as fatal
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        console.warn('[Speech] Live recognition error:', e.error);
      };

      recognition.onend = () => {
        // Restart if still listening (recognition auto-stops periodically)
        if (this.isListening && this._liveRecognition) {
          try { this._liveRecognition.start(); } catch { }
        }
      };

      recognition.start();
      this._liveRecognition = recognition;
      console.log('[Speech] ✅ Live recognition started (real-time word display)');
    } catch (err) {
      console.warn('[Speech] Could not start live recognition:', err.message);
    }
  }

  _stopLiveRecognition() {
    if (this._liveRecognition) {
      try { this._liveRecognition.abort(); } catch { }
      this._liveRecognition = null;
    }
    this._liveTranscript = '';
    this._liveInterimText = '';
  }

  /** Returns the current live transcript text */
  getLiveTranscript() {
    return (this._liveTranscript + this._liveInterimText).trim();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _bestMimeType() {
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }
}