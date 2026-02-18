const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  onSettingsUpdate: (callback) => ipcRenderer.on('settings:update', (_event, data) => callback(data)),
  onLyricsUpdate: (callback) => ipcRenderer.on('lyrics:update', (_event, data) => callback(data))
});
