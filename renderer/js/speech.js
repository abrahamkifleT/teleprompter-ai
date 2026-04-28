// ─── speech.js — Speech recognition with dual audio source ──────────────
// Supports two modes:
//   'mic'    — Web Speech API (captures microphone audio)
//   'system' — getDisplayMedia + Web Speech API (captures system/tab audio)

export class SpeechCapture {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this._onInterim  = null;
    this._onFinal    = null;
    this._onError    = null;
    this._silenceTimer = null;
    this._silenceMs    = 3000; // auto-submit after 3s silence
    this._transcript   = '';
    this._audioSource  = 'mic'; // 'mic' or 'system'
    this._systemStream = null;
  }

  setAudioSource(source) {
    this._audioSource = source === 'system' ? 'system' : 'mic';
  }

  start(onInterim, onFinal, onError) {
    if (this.isListening) this.stop();

    this._onInterim = onInterim;
    this._onFinal   = onFinal;
    this._onError   = onError;
    this._transcript = '';

    // Both modes use Web Speech API for transcription
    // 'system' mode additionally captures system audio to pipe through
    this._startRecognition();
  }

  _startRecognition() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      if (this._onError) {
        this._onError('Web Speech API not supported in this environment.');
      }
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous          = true;
    rec.interimResults      = true;
    rec.lang                = 'en-US';
    rec.maxAlternatives     = 1;

    rec.onstart = () => {
      this.isListening = true;
    };

    rec.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript   = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        this._transcript += ' ' + finalTranscript;
        this._transcript = this._transcript.trim();
      }

      const display = (this._transcript + ' ' + interimTranscript).trim();
      if (this._onInterim && display) this._onInterim(display);

      // Reset silence timer whenever we hear speech
      this._resetSilenceTimer();
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech') {
        // Timeout — submit what we have
        if (this._transcript) {
          this._submit();
        }
        return;
      }
      if (event.error === 'aborted') {
        // Normal stop — don't report as error
        return;
      }
      this.isListening = false;
      if (this._onError) this._onError(event.error);
    };

    rec.onend = () => {
      // If still supposed to be listening, restart (Chrome stops after ~60s)
      if (this.isListening && this._transcript === '') {
        try {
          rec.start();
        } catch (e) {
          this.isListening = false;
          clearTimeout(this._silenceTimer);
        }
        return;
      }
      this.isListening = false;
      clearTimeout(this._silenceTimer);
    };

    this.recognition = rec;
    this.isListening = true;

    try {
      rec.start();
    } catch (e) {
      if (this._onError) this._onError('Failed to start speech recognition: ' + e.message);
      return;
    }

    this._resetSilenceTimer();
  }

  _resetSilenceTimer() {
    clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => {
      if (this._transcript) {
        this._submit();
      }
    }, this._silenceMs);
  }

  _submit() {
    const text = this._transcript.trim();
    this._transcript = '';
    this.stop();
    if (text && this._onFinal) {
      this._onFinal(text);
    }
  }

  stop() {
    clearTimeout(this._silenceTimer);
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {
        // Ignore errors during abort
      }
      this.recognition = null;
    }
    if (this._systemStream) {
      this._systemStream.getTracks().forEach(t => t.stop());
      this._systemStream = null;
    }
    this.isListening = false;
  }

  setSilenceTimeout(ms) {
    this._silenceMs = Math.max(1000, Math.min(15000, ms));
  }

  // Force-submit whatever has been captured so far
  forceSubmit() {
    if (this._transcript) {
      this._submit();
    }
  }
}
