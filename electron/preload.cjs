const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  togglePin: () => ipcRenderer.invoke('window:toggle-pin'),
  toggleCaptureHidden: () => ipcRenderer.invoke('window:toggle-capture-hidden'),
  captureHidden: () => ipcRenderer.invoke('window:capture-hidden'),

  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    setHideFromDock: (v) => ipcRenderer.invoke('prefs:hide-from-dock', v),
  },

  sessions: {
    exportToFile: (payload) => ipcRenderer.invoke('sessions:export', payload),
    reveal: (filePath) => ipcRenderer.invoke('sessions:reveal', filePath),
  },

  screens: {
    list: () => ipcRenderer.invoke('screens:list'),
    capture: (sourceId, sourceName) => ipcRenderer.invoke('screens:capture', sourceId, sourceName),
    captureRegion: (sourceId, sourceName) => ipcRenderer.invoke('screens:capture-region', sourceId, sourceName),
  },

  region: {
    onImage: (cb) => ipcRenderer.on('region:image', (_e, data) => cb(data)),
    submit: (payload) => ipcRenderer.send('region:result', payload),
  },

  overlay: {
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    close: () => ipcRenderer.invoke('overlay:close'),
    isOpen: () => ipcRenderer.invoke('overlay:is-open'),
    setOpacity: (v) => ipcRenderer.invoke('overlay:set-opacity', v),
    toggleClickThrough: () => ipcRenderer.invoke('overlay:toggle-click-through'),
    toggleProtection: () => ipcRenderer.invoke('overlay:toggle-protection'),
    onProtection: (cb) => ipcRenderer.on('overlay:protection', (_e, on) => cb(on)),
    // Overlay -> main window
    ask: (text) => ipcRenderer.send('overlay:ask', text),
    onAsk: (cb) => ipcRenderer.on('overlay:ask', (_e, text) => cb(text)),
    control: (payload) => ipcRenderer.send('overlay:control', payload),
    onControl: (cb) => ipcRenderer.on('overlay:control', (_e, payload) => cb(payload)),
    // Main window -> overlay
    push: (state) => ipcRenderer.send('overlay:state', state),
    // Overlay <- main window
    onState: (cb) => ipcRenderer.on('overlay:state', (_e, state) => cb(state)),
    onClosed: (cb) => ipcRenderer.on('overlay:closed', () => cb()),
  },
});
