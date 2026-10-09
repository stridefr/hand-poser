// The only bridge between the page and the desktop shell. The page checks `window.desktop` and works without it
// (in a browser) too.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setZoom: f => ipcRenderer.invoke('app:zoom', f),
  openExternal: url => ipcRenderer.invoke('app:open', url),
  onUpdate: cb => { const h = (e, s) => cb(s); ipcRenderer.on('update', h); return () => ipcRenderer.removeListener('update', h); },
});
