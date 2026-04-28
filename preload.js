const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // AI
  aiComplete: (opts) => ipcRenderer.invoke('ai:complete', opts),
  aiStream: (opts) => ipcRenderer.invoke('ai:stream', opts),
  onStreamChunk: (cb) => ipcRenderer.on('ai:stream-chunk', (_, d) => cb(d)),
  onStreamDone: (cb) => ipcRenderer.on('ai:stream-done', (_, d) => cb(d)),
  onStreamError: (cb) => ipcRenderer.on('ai:stream-error', (_, d) => cb(d)),
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('ai:stream-chunk');
    ipcRenderer.removeAllListeners('ai:stream-done');
    ipcRenderer.removeAllListeners('ai:stream-error');
  },

  // Conversation history
  historyAdd: (entry) => ipcRenderer.invoke('history:add', entry),
  historyGet: () => ipcRenderer.invoke('history:get'),
  historyClear: () => ipcRenderer.invoke('history:clear'),

  // Camera frames (gaze-corrected MJPEG broadcast)
  sendCameraFrame: (buffer) => ipcRenderer.send('camera:frame', buffer),

  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  setOpacity: (v) => ipcRenderer.invoke('window:setOpacity', v),
  setClickThrough: (v) => ipcRenderer.invoke('window:setIgnoreMouseEvents', v),

  // Settings
  openSettings: () => ipcRenderer.invoke('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  openCameraInBrowser: () => ipcRenderer.invoke('shell:openCamera'),

  // Persistent storage
  storeGet: (key, def) => ipcRenderer.invoke('store:get', key, def),
  storeSet: (key, val) => ipcRenderer.invoke('store:set', key, val),
  storeGetAll: () => ipcRenderer.invoke('store:getAll'),

  // Global shortcut events (from main process → renderer)
  onGlobalToggleListen: (cb) => ipcRenderer.on('global:toggle-listen', () => cb()),
  onGlobalClickThroughChanged: (cb) => ipcRenderer.on('global:click-through-changed', (_, v) => cb(v)),
  onGlobalToggleOpacity: (cb) => ipcRenderer.on('global:toggle-opacity', () => cb()),
});
