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
const statusBadge       = $('status-badge');
const aiPanel           = $('ai-panel');
const aiAnswer          = $('ai-answer');
const aiQuestion        = $('ai-question');
const aiListeningBadge  = $('ai-listening-badge');
const aiThinkingBadge   = $('ai-thinking-badge');
const cameraPanel       = $('camera-panel');
const hotkeyHint        = $('hotkey-hint');
const btnAutoscroll     = $('btn-autoscroll');
const btnListen         = $('btn-listen');
const speedLabel        = $('speed-label');
const btnCameraPreview  = $('btn-camera-preview');
const gazeToggle        = $('gaze-toggle');
const clickThroughBanner = $('click-through-banner');

// ─── Load persisted settings ──────────────────────────────────────────────
async function loadSettings() {
  const settings = await api.storeGetAll();
  state.apiKey       = settings.apiKey || '';
  state.model        = settings.model || 'gpt-4o';
  state.systemPrompt = settings.systemPrompt || state.systemPrompt;

  const savedScript = settings.script;
  if (savedScript) {
    $('teleprompter-text').innerHTML = savedScript;
  }

  const savedSpeed = settings.scrollSpeed;
  if (savedSpeed) teleprompter.setSpeed(savedSpeed);

  const savedFontSize = settings.fontSize;
  if (savedFontSize) teleprompter.setFontSize(savedFontSize);

  if (settings.silenceMs) speech.setSilenceTimeout(settings.silenceMs);

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
    // Update both the AI panel and the teleprompter
    aiAnswer.textContent = buffer;
    aiAnswer.scrollTop = aiAnswer.scrollHeight;
    if (streamEl) {
      streamEl.textContent = buffer;
    }
  });

  api.onStreamDone((fullContent) => {
    aiAnswer.classList.remove('typing-cursor');
    if (streamEl) streamEl.classList.remove('typing-cursor');
    aiThinkingBadge.classList.add('hidden');
    setStatus('READY', 'ready');

    // Add to conversation history
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
  btnListen.innerHTML = '🔴 LISTENING...';
  aiPanel.classList.remove('hidden');
  aiAnswer.textContent = 'Listening for question...';
  aiQuestion.classList.add('hidden');
  aiListeningBadge.classList.remove('hidden');
  setStatus('LISTENING', 'listening');

  speech.start(
    (transcript) => {
      // Interim — show live transcription
      aiAnswer.textContent = `🎤 "${transcript}"`;
    },
    async (finalTranscript) => {
      // Final — send to AI
      stopListening();
      await answerQuestion(finalTranscript);
    },
    (err) => {
      stopListening();
      showNotification(`❌ Speech error: ${err}`);
    }
  );
}

function stopListening() {
  if (!state.isListening) return;
  state.isListening = false;
  btnListen.classList.remove('active');
  btnListen.innerHTML = '🎤 LISTEN';
  aiListeningBadge.classList.add('hidden');
  speech.stop();
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
    await gaze.initCamera();
    // Auto-enable gaze correction
    gaze.setCorrection(true);
    gazeToggle.checked = true;
  } else {
    cameraPanel.classList.add('hidden');
    btnCameraPreview.style.color = '';
    gaze.stopCamera();
  }
}

// Start gaze correction automatically on launch
async function autoStartGazeCorrection() {
  try {
    await gaze.initCamera();
    gaze.setCorrection(true);
    gazeToggle.checked = true;
    state.showCamera = true;
    // Keep camera panel hidden by default — gaze correction runs in background
    // User can press Ctrl+G to see the preview
    console.log('[GazeCorrector] Auto-started — eye contact correction active');
  } catch (err) {
    console.warn('[GazeCorrector] Auto-start failed:', err);
  }
}

// ─── Global Shortcuts from Main Process ──────────────────────────────────
api.onGlobalToggleListen(() => {
  toggleListening();
});

api.onGlobalClickThroughChanged((isGhost) => {
  state.isClickThrough = isGhost;
  clickThroughBanner.classList.toggle('hidden', !isGhost);
  if (isGhost) {
    setStatus('GHOST', 'ghost');
  } else {
    setStatus('IDLE', 'idle');
  }
});

api.onGlobalToggleOpacity(() => {
  state.opacityFull = !state.opacityFull;
  const val = state.opacityFull ? 0.92 : 0.45;
  api.setOpacity(val);
  $('opacity-slider').value = Math.round(val * 100);
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't capture keys when editing the teleprompter text
  if ($('teleprompter-text').contentEditable === 'true' && !e.ctrlKey && !e.metaKey) {
    return;
  }

  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;

  // Ctrl combos
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
      setStatus(teleprompter.isScrolling ? 'SCROLLING' : 'IDLE', teleprompter.isScrolling ? 'scrolling' : 'idle');
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
$('btn-close').addEventListener('click',    () => api.close());
$('btn-minimize').addEventListener('click', () => api.minimize());
$('btn-settings').addEventListener('click', () => api.openSettings());
$('btn-camera-preview').addEventListener('click', toggleCameraPanel);

$('btn-autoscroll').addEventListener('click', () => {
  teleprompter.toggleScroll();
  btnAutoscroll.classList.toggle('active', teleprompter.isScrolling);
  btnAutoscroll.textContent = teleprompter.isScrolling ? '⏸' : '▶';
});

$('btn-scroll-up').addEventListener('click',   () => teleprompter.scrollBy(-80));
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

$('btn-font-up').addEventListener('click',   () => { teleprompter.changeFontSize(2); api.storeSet('fontSize', teleprompter.fontSize); });
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

// Auto-start gaze correction for real-time eye contact fix
autoStartGazeCorrection();

// Listen for settings updates from settings window
window.addEventListener('message', (event) => {
  if (event.data?.type === 'settings-saved') {
    const s = event.data.settings;
    state.apiKey       = s.apiKey;
    state.model        = s.model;
    state.systemPrompt = s.systemPrompt;
    if (s.silenceMs) speech.setSilenceTimeout(s.silenceMs);
  }
});
