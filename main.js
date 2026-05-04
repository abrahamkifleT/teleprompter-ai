const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog, Tray, Menu, nativeImage, session, desktopCapturer } = require('electron');
const path = require('path');
const http = require('http');
const { OpenAI } = require('openai');

// ─── Chromium Flags for Media Access ─────────────────────────────────────────
// These MUST be set before app.whenReady(). They fix getUserMedia() on file://
// protocol which Chromium otherwise treats as an insecure origin.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('allow-file-access-from-files');        // allow file:// to access media APIs
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'file://');  // treat file:// as secure context

let mainWindow;
let settingsWindow;
let tray;
let openaiClient = null;
let mjpegClients = new Set();
let latestFrameBuffer = null;
let isClickThrough = false;
let isWindowHidden = false;

// ─── Conversation history (rolling context for smarter AI answers) ───────────
let conversationHistory = [];
const MAX_HISTORY = 10; // keep last 10 Q&A pairs

// ─── MJPEG Virtual Camera Server ────────────────────────────────────────────
// Serves gaze-corrected webcam frames on http://localhost:8765
// Use OBS Browser Source → Start Virtual Camera to route into Zoom/Meet
const streamServer = http.createServer((req, res) => {
  if (req.url !== '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="margin:0;background:#000">
        <img src="/stream" style="width:100%;height:100vh;object-fit:cover">
      </body></html>
    `);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  mjpegClients.add(res);

  req.on('close', () => {
    mjpegClients.delete(res);
  });
});

function broadcastFrame(jpegBuffer) {
  const boundary = '--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpegBuffer.length + '\r\n\r\n';
  for (const client of mjpegClients) {
    try {
      // THE FIX: If the TCP socket is full, drop the frame to guarantee 0 latency!
      if (client.writableNeedDrain) continue;
      
      client.write(boundary);
      client.write(jpegBuffer);
      client.write('\r\n');
    } catch (e) {
      mjpegClients.delete(client);
    }
  }
}

streamServer.listen(8765, '127.0.0.1', () => {
  console.log('📹 MJPEG camera server: http://localhost:8765/stream');
});

// ─── Window Creation ─────────────────────────────────────────────────────────
function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 540,
    height: 780,
    x: 20,
    y: 20,
    minWidth: 380,
    minHeight: 400,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // needed for MediaPipe CDN + webcam
      backgroundThrottling: false, // KEEP CAMERA STREAM ACTIVE WHEN WINDOW IS HIDDEN
    },
  });

  // ⚡ KEY FEATURE: Invisible to screen capture (Zoom, Meet, Loom, OBS window capture)
  // macOS: Uses CGWindowSharingReadOnly → excluded from screenshots/recordings
  // Windows: Uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
  mainWindow.setContentProtection(true);

  // Float above all windows including full-screen video calls
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  mainWindow.loadFile('renderer/index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Dev tools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 620,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.setContentProtection(true);
  settingsWindow.loadFile('renderer/settings.html');

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ─── System Tray ─────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('AI Teleprompter');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { label: 'Settings', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Open Camera Feed (OBS)', click: () => shell.openExternal('http://localhost:8765') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ─── Global Shortcuts ────────────────────────────────────────────────────────
function registerGlobalShortcuts() {
  // Toggle listening mode — works even when Zoom/Meet is focused
  globalShortcut.register('F2', () => {
    if (mainWindow) {
      mainWindow.webContents.send('global:toggle-listen');
    }
  });

  // Toggle window visibility — F3 to hide/show teleprompter instantly
  globalShortcut.register('F3', () => {
    if (mainWindow) {
      isWindowHidden = !isWindowHidden;
      if (isWindowHidden) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.setContentProtection(true);
      }
    }
  });

  // Toggle click-through mode — makes window not intercept mouse events
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (mainWindow) {
      isClickThrough = !isClickThrough;
      mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
      mainWindow.webContents.send('global:click-through-changed', isClickThrough);
    }
  });

  // Quick opacity toggle — make semi-transparent or fully visible
  globalShortcut.register('CommandOrControl+Shift+O', () => {
    if (mainWindow) {
      mainWindow.webContents.send('global:toggle-opacity');
    }
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('ai:complete', async (event, { messages, apiKey, model }) => {
  try {
    if (!openaiClient || openaiClient.apiKey !== apiKey) {
      openaiClient = new OpenAI({ apiKey });
    }

    const response = await openaiClient.chat.completions.create({
      model: model || 'gpt-4o',
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    return { success: true, content: response.choices[0].message.content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ai:stream', async (event, { messages, apiKey, model }) => {
  try {
    if (!openaiClient || openaiClient.apiKey !== apiKey) {
      openaiClient = new OpenAI({ apiKey });
    }

    const stream = await openaiClient.chat.completions.create({
      model: model || 'gpt-4o',
      messages,
      max_tokens: 1024,
      stream: true,
    });

    let fullContent = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        event.sender.send('ai:stream-chunk', delta);
      }
    }
    event.sender.send('ai:stream-done', fullContent);
    return { success: true };
  } catch (err) {
    event.sender.send('ai:stream-error', err.message);
    return { success: false, error: err.message };
  }
});

// Conversation history management
ipcMain.handle('history:add', (event, { question, answer }) => {
  conversationHistory.push({ role: 'user', content: question });
  conversationHistory.push({ role: 'assistant', content: answer });
  // Trim to max history
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
    conversationHistory.shift();
  }
  return { success: true };
});

ipcMain.handle('history:get', () => {
  return conversationHistory;
});

ipcMain.handle('history:clear', () => {
  conversationHistory = [];
  return { success: true };
});

// Receive gaze-corrected frames from renderer and broadcast via MJPEG
ipcMain.on('camera:frame', (event, frameData) => {
  // frameData is a base64 string. Convert to raw JPEG buffer for MJPEG.
  const buffer = Buffer.from(frameData, 'base64');
  latestFrameBuffer = buffer;
  broadcastFrame(buffer);
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:setOpacity', (event, opacity) => mainWindow?.setOpacity(opacity));
ipcMain.handle('window:setIgnoreMouseEvents', (event, ignore) => {
  isClickThrough = ignore;
  mainWindow?.setIgnoreMouseEvents(ignore, { forward: true });
});
ipcMain.handle('settings:open', () => createSettingsWindow());
ipcMain.handle('settings:close', () => settingsWindow?.close());
ipcMain.handle('shell:openCamera', () => shell.openExternal('http://localhost:8765'));

// Forward renderer console logs to terminal for debugging
ipcMain.on('renderer:log', (event, ...args) => {
  console.log('[Renderer]', ...args);
});

// Storage via electron store (simple JSON in userData)
const Store = (() => {
  const fs = require('fs');
  const storePath = path.join(app.getPath('userData'), 'settings.json');
  return {
    get: (key, def) => {
      try {
        const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        return data[key] ?? def;
      } catch { return def; }
    },
    set: (key, val) => {
      let data = {};
      try { data = JSON.parse(require('fs').readFileSync(storePath, 'utf8')); } catch {}
      data[key] = val;
      fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
    },
    getAll: () => {
      try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return {}; }
    }
  };
})();

ipcMain.handle('store:get', (e, key, def) => Store.get(key, def));
ipcMain.handle('store:set', (e, key, val) => Store.set(key, val));
ipcMain.handle('store:getAll', () => Store.getAll());

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // ── Grant ALL permissions automatically ────────────────────────────────────
  // Electron uses open-source Chromium which requires explicit permission
  // grants. Without this, getUserMedia() silently fails on Windows.
  // We grant everything since this is a trusted desktop app.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // Always grant — this is a local trusted app, not a website
    console.log('[Permission] Requested:', permission, '→ GRANTED');
    callback(true);
  });

  // Handle permission-check requests (Chromium 96+)
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return true;  // Always allow
  });

  // ── Device-level permission grant (Electron 17+) ──────────────────────────
  // Required for getUserMedia to access specific audio/video devices.
  // Without this, some Electron versions silently block device enumeration.
  session.defaultSession.setDevicePermissionHandler((details) => {
    console.log('[DevicePermission] Requested:', details.deviceType, '→ GRANTED');
    return true;
  });

  // ── Handle getDisplayMedia() for System Audio Capture ───────────────────
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      // Return the first screen. The critical part is audio: 'loopback'
      // which allows Electron to capture system audio on Windows.
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(err => {
      console.error('[DisplayMedia] Error getting sources:', err);
      // fallback
      callback({ video: null, audio: null });
    });
  });

  createMainWindow();
  registerGlobalShortcuts();
  // createTray(); // uncomment for tray icon support

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  streamServer.close();
  if (process.platform !== 'darwin') app.quit();
});
