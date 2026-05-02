// ─── app.js — Main coordinator ─────────────────────────────────────────────
import { Teleprompter } from './teleprompter.js';
import { GazeCorrector } from './gaze.js';
import { SpeechCapture } from './speech.js';
import { AIService } from './ai.js';

const api = window.electronAPI;

// ─── State ────────────────────────────────────────────────────────────────
const state = {
  isListening: false,
  showCamera: false,
  showHelp: false,
  isClickThrough: false,
  opacityFull: true,
  apiKey: '',
  model: 'gpt-4o',
  systemPrompt: `You are an expert assistant helping someone during a live interview or meeting.
The user is reading your answers on a teleprompter.
Keep answers concise, confident, and natural-sounding (under 120 words unless the question requires more).
Speak in first person. Avoid bullet points — use flowing sentences that are easy to read aloud.
Be direct and sound knowledgeable.`,
  lastQuestion: '',
  audioSource: 'mic', // 'mic' | 'system' | 'both'
};

// ─── Module instances ─────────────────────────────────────────────────────
const teleprompter = new Teleprompter(
  document.getElementById('teleprompter-container'),
  document.getElementById('teleprompter-text')
);

const gaze = new GazeCorrector(
  document.getElementById('source-video'),
  document.getElementById('gaze-canvas'),
  document.getElementById('frame-canvas')
);

const speech = new SpeechCapture();
const aiService = new AIService();

// ─── DOM refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusBadge = $('status-badge');
const aiPanel = $('ai-panel');
const aiAnswer = $('ai-answer');
const aiQuestion = $('ai-question');
const aiListeningBadge = $('ai-listening-badge');
const aiThinkingBadge = $('ai-thinking-badge');
const cameraPanel = $('camera-panel');
const hotkeyHint = $('hotkey-hint');
const btnAutoscroll = $('btn-autoscroll');
const btnListen = $('btn-listen');
const speedLabel = $('speed-label');
const btnCameraPreview = $('btn-camera-preview');
const gazeToggle = $('gaze-toggle');
const clickThroughBanner = $('click-through-banner');
const audioLevelContainer = $('audio-level-container');
const audioLevelBar = $('audio-level-bar');
const audioRmsValue = $('audio-rms-value');
const audioStatusText = $('audio-status-text');
const audioSourceSelect = $('audio-source-select');
const liveTranscriptContainer = $('live-transcript-container');
const liveTranscriptText = $('live-transcript-text');

// ─── Load persisted settings ──────────────────────────────────────────────
async function loadSettings() {
  const settings = await api.storeGetAll();
  state.apiKey = settings.apiKey || '';
  state.model = settings.model || 'gpt-4o';
  state.systemPrompt = settings.systemPrompt || state.systemPrompt;

  const savedScript = settings.script;
  if (savedScript) $('teleprompter-text').innerHTML = savedScript;

  if (settings.scrollSpeed) teleprompter.setSpeed(settings.scrollSpeed);
  if (settings.fontSize) teleprompter.setFontSize(settings.fontSize);
  if (settings.silenceMs) speech.setSilenceTimeout(settings.silenceMs);

  // Restore audio source mode
  if (settings.audioSource) {
    state.audioSource = settings.audioSource;
    speech.setAudioSource(state.audioSource);
    if (audioSourceSelect) audioSourceSelect.value = state.audioSource;
    updateAudioSourceUI(state.audioSource);
  }

  // Gaze defaults — strong for top-of-monitor camera
  const savedStrength = settings.gazeStrength;
  const savedOffset = settings.cameraOffsetY;
  const gazeStrength = (!savedStrength || savedStrength < 80) ? 88 : savedStrength;
  const camOffsetY = (!savedOffset || savedOffset > -25) ? -45 : savedOffset;
  gaze.setCorrectionStrength(gazeStrength / 100);
  gaze.setCameraOffsetY(camOffsetY);

  speech.setApiKey(state.apiKey);
  updateSpeedLabel();
}

// ─── Status badge helper ──────────────────────────────────────────────────
function setStatus(text, type) {
  statusBadge.textContent = text;
  statusBadge.className = `badge badge-${type}`;
}

// ─── Audio source toggle ──────────────────────────────────────────────────

/**
 * Update the listen button label and the source-select styling to reflect
 * the chosen capture mode so users always know what's being recorded.
 */
function updateAudioSourceUI(src) {
  const labels = {
    mic: '🎤 LISTEN',
    system: '🖥️ LISTEN',
    both: '🎙️+🖥️ LISTEN',
  };
  if (!state.isListening) {
    btnListen.innerHTML = labels[src] || '🎤 LISTEN';
  }

  // Highlight the active option in the selector
  if (audioSourceSelect) audioSourceSelect.value = src;
}

if (audioSourceSelect) {
  audioSourceSelect.addEventListener('change', () => {
    state.audioSource = audioSourceSelect.value;
    speech.setAudioSource(state.audioSource);
    updateAudioSourceUI(state.audioSource);
    api.storeSet('audioSource', state.audioSource);
  });
}

// ─── AI Interaction ───────────────────────────────────────────────────────
async function answerQuestion(question) {
  if (!state.apiKey) {
    showNotification('⚠️ Set your OpenAI API key in Settings (Ctrl+,)');
    return;
  }

  state.lastQuestion = question;

  aiPanel.classList.remove('hidden');
  aiQuestion.textContent = question;
  aiQuestion.classList.remove('hidden');
  aiAnswer.textContent = '';
  aiAnswer.classList.add('typing-cursor');
  aiThinkingBadge.classList.remove('hidden');
  setStatus('THINKING', 'thinking');

  const streamEl = teleprompter.startStreamingAnswer(question);
  const messages = aiService.buildMessages(question, state.systemPrompt);

  api.removeStreamListeners();

  let buffer = '';
  api.onStreamChunk((chunk) => {
    buffer += chunk;
    aiAnswer.textContent = buffer;
    aiAnswer.scrollTop = aiAnswer.scrollHeight;
    if (streamEl) streamEl.textContent = buffer;
  });

  api.onStreamDone((fullContent) => {
    aiAnswer.classList.remove('typing-cursor');
    if (streamEl) streamEl.classList.remove('typing-cursor');
    aiThinkingBadge.classList.add('hidden');
    setStatus('READY', 'ready');
    aiService.addToHistory(question, fullContent);
  });

  api.onStreamError((err) => {
    const errMsg = `❌ Error: ${err}`;
    aiAnswer.textContent = errMsg;
    if (streamEl) streamEl.textContent = errMsg;
    aiAnswer.classList.remove('typing-cursor');
    if (streamEl) streamEl.classList.remove('typing-cursor');
    aiThinkingBadge.classList.add('hidden');
    setStatus('IDLE', 'idle');
  });

  await api.aiStream({ messages, apiKey: state.apiKey, model: state.model });
}

function showNotification(text) {
  aiPanel.classList.remove('hidden');
  aiAnswer.textContent = text;
  aiAnswer.classList.remove('typing-cursor');
}

function clearAI() {
  aiPanel.classList.add('hidden');
  aiAnswer.textContent = '';
  aiQuestion.textContent = '';
  aiQuestion.classList.add('hidden');
  aiThinkingBadge.classList.add('hidden');
  aiListeningBadge.classList.add('hidden');
  audioLevelContainer.classList.add('hidden');
  setStatus('IDLE', 'idle');
}

// ─── Speech Recognition / Listen Mode ────────────────────────────────────
function startListening() {
  if (state.isListening) return;
  state.isListening = true;

  const srcLabels = { mic: '🎤', system: '🖥️', both: '🎙️+🖥️' };
  btnListen.classList.add('active');
  btnListen.innerHTML = `${srcLabels[state.audioSource] || '🔴'} LISTENING…`;

  aiPanel.classList.remove('hidden');
  aiAnswer.textContent = getListeningHint();
  aiQuestion.classList.add('hidden');
  aiListeningBadge.classList.remove('hidden');
  setStatus('LISTENING', 'listening');

  // Show audio level indicator
  audioLevelContainer.classList.remove('hidden');
  audioLevelBar.style.width = '0%';
  audioStatusText.textContent = 'Waiting for sound…';
  audioStatusText.classList.remove('active');

  // Show live transcript area
  liveTranscriptContainer.classList.remove('hidden');
  liveTranscriptText.textContent = '';

  speech.setApiKey(state.apiKey);
  speech.setAudioSource(state.audioSource);

  speech.start(
    // interim
    (transcript) => { aiAnswer.textContent = transcript; },
    // final
    async (finalTranscript) => {
      stopListening(false);
      await answerQuestion(finalTranscript);
    },
    // error
    (err) => {
      stopListening(false);
      showNotification(`❌ ${err}`);
    },
    // audio level
    (level, rms) => {
      audioLevelBar.style.width = `${level}%`;
      audioRmsValue.textContent = `RMS: ${rms.toFixed(1)}`;

      audioLevelBar.classList.remove('level-low', 'level-mid', 'level-high');
      if (level > 50) audioLevelBar.classList.add('level-high');
      else if (level > 15) audioLevelBar.classList.add('level-mid');
      else audioLevelBar.classList.add('level-low');

      if (rms > 8) {
        audioStatusText.textContent = `✅ Sound detected! Level: ${level}%`;
        audioStatusText.classList.add('active');
      } else {
        audioStatusText.textContent = level > 2
          ? `Low audio — speak louder or move closer (${level}%)`
          : 'Waiting for sound…';
        audioStatusText.classList.remove('active');
      }
    },
    // live transcript (real-time word-by-word display)
    (text, isInterim) => {
      liveTranscriptText.textContent = text;
      liveTranscriptText.classList.toggle('interim', isInterim);
      // Auto-scroll the transcript area
      liveTranscriptText.scrollTop = liveTranscriptText.scrollHeight;
    }
  );
}

/**
 * Returns a contextual hint message shown in the AI panel while listening,
 * so users know what audio source is active.
 */
function getListeningHint() {
  switch (state.audioSource) {
    case 'system':
      return '🖥️ Listening to internal audio — speak in your meeting app…';
    case 'both':
      return '🎙️+🖥️ Capturing mic + internal audio (interviewer + you)…';
    default:
      return '🎤 Listening — speak your question…';
  }
}

function stopListening(alsoStopSpeech = true) {
  if (!state.isListening) return;
  state.isListening = false;
  btnListen.classList.remove('active');
  updateAudioSourceUI(state.audioSource);
  aiListeningBadge.classList.add('hidden');
  audioLevelContainer.classList.add('hidden');
  liveTranscriptContainer.classList.add('hidden');
  if (alsoStopSpeech) speech.stop();
}

function toggleListening() {
  if (state.isListening) stopListening();
  else startListening();
}

// ─── Camera Panel ─────────────────────────────────────────────────────────
async function toggleCameraPanel() {
  state.showCamera = !state.showCamera;
  if (state.showCamera) {
    cameraPanel.classList.remove('hidden');
    btnCameraPreview.style.color = 'var(--accent)';
    try {
      if (!gaze.isRunning) await gaze.initCamera();
      gaze.setCorrection(true);
      gazeToggle.checked = true;
    } catch (err) {
      console.error('[Camera] init failed:', err);
      state.showCamera = false;
      cameraPanel.classList.add('hidden');
      btnCameraPreview.style.color = '';
      showNotification('⚠️ Camera could not be started. Check permissions and ensure a webcam is connected.');
    }
  } else {
    cameraPanel.classList.add('hidden');
    btnCameraPreview.style.color = '';
    gaze.stopCamera();
    gaze.setCorrection(false);
    gazeToggle.checked = false;
    state.showCamera = false;
  }
}

// ─── Global Shortcuts from Main Process ──────────────────────────────────
api.onGlobalToggleListen(() => toggleListening());

api.onGlobalClickThroughChanged((isGhost) => {
  state.isClickThrough = isGhost;
  clickThroughBanner.classList.toggle('hidden', !isGhost);
  setStatus(isGhost ? 'GHOST' : 'IDLE', isGhost ? 'ghost' : 'idle');
});

api.onGlobalToggleOpacity(() => {
  state.opacityFull = !state.opacityFull;
  const val = state.opacityFull ? 0.92 : 0.45;
  api.setOpacity(val);
  $('opacity-slider').value = Math.round(val * 100);
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ($('teleprompter-text').contentEditable === 'true' && !e.ctrlKey && !e.metaKey) return;

  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl) {
    if (key === ',') { e.preventDefault(); api.openSettings(); return; }
    if (key === 'g') { e.preventDefault(); toggleCameraPanel(); return; }
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      teleprompter.toggleScroll();
      btnAutoscroll.classList.toggle('active', teleprompter.isScrolling);
      btnAutoscroll.textContent = teleprompter.isScrolling ? '⏸' : '▶';
      setStatus(teleprompter.isScrolling ? 'SCROLLING' : 'IDLE',
        teleprompter.isScrolling ? 'scrolling' : 'idle');
      break;
    case 'ArrowUp': e.preventDefault(); teleprompter.scrollBy(-80); break;
    case 'ArrowDown': e.preventDefault(); teleprompter.scrollBy(80); break;
    case '+': case '=':
      e.preventDefault();
      teleprompter.changeSpeed(0.1);
      updateSpeedLabel();
      api.storeSet('scrollSpeed', teleprompter.speed);
      break;
    case '-': case '_':
      e.preventDefault();
      teleprompter.changeSpeed(-0.1);
      updateSpeedLabel();
      api.storeSet('scrollSpeed', teleprompter.speed);
      break;
    case '[': e.preventDefault(); teleprompter.changeFontSize(-2); api.storeSet('fontSize', teleprompter.fontSize); break;
    case ']': e.preventDefault(); teleprompter.changeFontSize(2); api.storeSet('fontSize', teleprompter.fontSize); break;
    case 'l': case 'L': e.preventDefault(); toggleListening(); break;
    case 'Escape': stopListening(); clearAI(); break;
    case '?':
      e.preventDefault();
      state.showHelp = !state.showHelp;
      hotkeyHint.classList.toggle('hidden', !state.showHelp);
      break;
  }
});

// ─── Button Listeners ─────────────────────────────────────────────────────
$('btn-close').addEventListener('click', () => api.close());
$('btn-minimize').addEventListener('click', () => api.minimize());
$('btn-settings').addEventListener('click', () => api.openSettings());
$('btn-camera-preview').addEventListener('click', toggleCameraPanel);

$('btn-autoscroll').addEventListener('click', () => {
  teleprompter.toggleScroll();
  btnAutoscroll.classList.toggle('active', teleprompter.isScrolling);
  btnAutoscroll.textContent = teleprompter.isScrolling ? '⏸' : '▶';
});

$('btn-scroll-up').addEventListener('click', () => teleprompter.scrollBy(-80));
$('btn-scroll-down').addEventListener('click', () => teleprompter.scrollBy(80));

$('btn-speed-up').addEventListener('click', () => {
  teleprompter.changeSpeed(0.1); updateSpeedLabel(); api.storeSet('scrollSpeed', teleprompter.speed);
});
$('btn-speed-down').addEventListener('click', () => {
  teleprompter.changeSpeed(-0.1); updateSpeedLabel(); api.storeSet('scrollSpeed', teleprompter.speed);
});

$('btn-font-up').addEventListener('click', () => { teleprompter.changeFontSize(2); api.storeSet('fontSize', teleprompter.fontSize); });
$('btn-font-down').addEventListener('click', () => { teleprompter.changeFontSize(-2); api.storeSet('fontSize', teleprompter.fontSize); });

$('btn-reset').addEventListener('click', () => teleprompter.resetScroll());

$('btn-edit').addEventListener('click', () => {
  const el = $('teleprompter-text');
  const editing = el.contentEditable === 'true';
  if (editing) {
    el.contentEditable = 'false';
    $('btn-edit').textContent = '✏️';
    $('btn-edit').title = 'Edit script';
    api.storeSet('script', el.innerHTML);
  } else {
    el.contentEditable = 'true';
    el.focus();
    $('btn-edit').textContent = '💾';
    $('btn-edit').title = 'Save & exit edit';
  }
});

$('btn-listen').addEventListener('click', toggleListening);
$('btn-clear-ai').addEventListener('click', clearAI);
$('btn-open-camera-browser').addEventListener('click', () => api.openCameraInBrowser());

$('opacity-slider').addEventListener('input', (e) => api.setOpacity(e.target.value / 100));
gazeToggle.addEventListener('change', (e) => gaze.setCorrection(e.target.checked));

// ─── Helper ───────────────────────────────────────────────────────────────
function updateSpeedLabel() {
  speedLabel.textContent = `${teleprompter.speed.toFixed(1)}×`;
}

// ─── Init ─────────────────────────────────────────────────────────────────
loadSettings();
setStatus('IDLE', 'idle');

// ── Settings update from Settings window ──────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'settings-saved') return;
  const s = event.data.settings;

  state.apiKey = s.apiKey || state.apiKey;
  state.model = s.model || state.model;
  state.systemPrompt = s.systemPrompt || state.systemPrompt;

  if (s.silenceMs) speech.setSilenceTimeout(s.silenceMs);
  speech.setApiKey(state.apiKey);

  if (s.gazeStrength !== undefined) gaze.setCorrectionStrength(s.gazeStrength / 100);
  if (s.cameraOffsetY !== undefined) gaze.setCameraOffsetY(s.cameraOffsetY);
});