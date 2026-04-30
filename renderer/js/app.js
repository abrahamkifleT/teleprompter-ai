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

  // ── Apply gaze settings to the corrector ─────────────────────────────
  // (These were saved but never applied to the GazeCorrector before)
  if (settings.gazeStrength !== undefined) gaze.setCorrectionStrength(settings.gazeStrength / 100);
  if (settings.cameraOffsetY !== undefined) gaze.setCameraOffsetY(settings.cameraOffsetY);

  // Pass the API key to the speech module so Whisper can use it
  speech.setApiKey(state.apiKey);

  updateSpeedLabel();
}

// ─── Status badge helper ──────────────────────────────────────────────────
function setStatus(text, type) {
  statusBadge.textContent = text;
  statusBadge.className = `badge badge-${type}`;
}

// ─── AI Interaction ───────────────────────────────────────────────────────
async function answerQuestion(question) {
  if (!state.apiKey) {
    showNotification('⚠️ Set your OpenAI API key in Settings (Ctrl+,)');
    return;
  }

  state.lastQuestion = question;

  // Show in bottom AI panel
  aiPanel.classList.remove('hidden');
  aiQuestion.textContent = question;
  aiQuestion.classList.remove('hidden');
  aiAnswer.textContent = '';
  aiAnswer.classList.add('typing-cursor');
  aiThinkingBadge.classList.remove('hidden');
  setStatus('THINKING', 'thinking');

  // Create streaming target in the teleprompter text
  const streamEl = teleprompter.startStreamingAnswer(question);

  // Build messages with conversation history
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
  setStatus('IDLE', 'idle');
}

// ─── Speech Recognition / Listen Mode ────────────────────────────────────
function startListening() {
  if (state.isListening) return;
  state.isListening = true;

  btnListen.classList.add('active');
  btnListen.innerHTML = '🔴 LISTENING…';
  aiPanel.classList.remove('hidden');
  aiAnswer.textContent = '🎙 Listening — speak your question…';
  aiQuestion.classList.add('hidden');
  aiListeningBadge.classList.remove('hidden');
  setStatus('LISTENING', 'listening');

  // ── Always pass the current API key before starting ───────────────────
  speech.setApiKey(state.apiKey);

  speech.start(
    // interim: live progress messages
    (transcript) => {
      aiAnswer.textContent = transcript;
    },
    // final: transcript ready → send to GPT
    async (finalTranscript) => {
      stopListening(false); // don't re-stop speech module (already stopped)
      await answerQuestion(finalTranscript);
    },
    // error
    (err) => {
      stopListening(false);
      showNotification(`❌ ${err}`);
    }
  );
}

function stopListening(alsoStopSpeech = true) {
  if (!state.isListening) return;
  state.isListening = false;
  btnListen.classList.remove('active');
  btnListen.innerHTML = '🎤 LISTEN';
  aiListeningBadge.classList.add('hidden');
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
      // Always (re)initialize if not running — this ensures a fresh start
      // even if a previous silent init attempt failed.
      if (!gaze.isRunning) {
        await gaze.initCamera();
      }
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
    // Stop camera fully when panel closes so it can re-initialize cleanly next time
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
  // Don't steal keys while editing the teleprompter text
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
      setStatus(
        teleprompter.isScrolling ? 'SCROLLING' : 'IDLE',
        teleprompter.isScrolling ? 'scrolling' : 'idle'
      );
      break;
    case 'ArrowUp':
      e.preventDefault();
      teleprompter.scrollBy(-80);
      break;
    case 'ArrowDown':
      e.preventDefault();
      teleprompter.scrollBy(80);
      break;
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
    case '[':
      e.preventDefault();
      teleprompter.changeFontSize(-2);
      api.storeSet('fontSize', teleprompter.fontSize);
      break;
    case ']':
      e.preventDefault();
      teleprompter.changeFontSize(2);
      api.storeSet('fontSize', teleprompter.fontSize);
      break;
    case 'l': case 'L':
      e.preventDefault();
      toggleListening();
      break;
    case 'Escape':
      stopListening();
      clearAI();
      break;
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
  teleprompter.changeSpeed(0.1);
  updateSpeedLabel();
  api.storeSet('scrollSpeed', teleprompter.speed);
});
$('btn-speed-down').addEventListener('click', () => {
  teleprompter.changeSpeed(-0.1);
  updateSpeedLabel();
  api.storeSet('scrollSpeed', teleprompter.speed);
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

$('opacity-slider').addEventListener('input', (e) => {
  api.setOpacity(e.target.value / 100);
});

gazeToggle.addEventListener('change', (e) => {
  gaze.setCorrection(e.target.checked);
});

// ─── Helper ───────────────────────────────────────────────────────────────
function updateSpeedLabel() {
  speedLabel.textContent = `${teleprompter.speed.toFixed(1)}×`;
}

// ─── Init ─────────────────────────────────────────────────────────────────
loadSettings();
setStatus('IDLE', 'idle');
// Camera is started on-demand when user presses Ctrl+G or clicks 👁

// ── Settings update from Settings window ──────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'settings-saved') return;
  const s = event.data.settings;

  state.apiKey = s.apiKey || state.apiKey;
  state.model = s.model || state.model;
  state.systemPrompt = s.systemPrompt || state.systemPrompt;

  if (s.silenceMs) speech.setSilenceTimeout(s.silenceMs);
  speech.setApiKey(state.apiKey); // keep speech module in sync

  // Apply updated gaze parameters immediately (no restart needed)
  if (s.gazeStrength !== undefined) gaze.setCorrectionStrength(s.gazeStrength / 100);
  if (s.cameraOffsetY !== undefined) gaze.setCameraOffsetY(s.cameraOffsetY);
});