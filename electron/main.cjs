// Hand Poser desktop app: window, custom title bar and auto-update (GitHub Releases via electron-updater).
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
let win = null;

// one window only: a second launch focuses the first
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// ───────── window size / position memory ─────────
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const visible = screen.getAllDisplays().some(d => b.x < d.workArea.x + d.workArea.width - 80 && b.x + b.width > d.workArea.x + 80 && b.y >= d.workArea.y - 20 && b.y < d.workArea.y + d.workArea.height - 80);
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch (e) { return { width: 1440, height: 900 }; }
}
function saveBounds() {
  if (!win) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch (e) { }
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width || 1440, height: b.height || 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#09090b', title: 'Hand Poser', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // custom title bar: the app bar is the drag area, Windows draws its own min / max / close over it
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#0c0c0f', symbolColor: '#a1a1aa', height: 56 },
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  // links open in the real browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

// ───────── auto-update ─────────
let updater = null, updateState = { status: isDev ? 'dev' : 'idle' };
function sendUpdate(s) { updateState = { ...updateState, ...s }; if (win && !win.isDestroyed()) win.webContents.send('update', updateState); }
function setupUpdater() {
  if (isDev) return;                                     // only installed builds update themselves
  try { updater = require('electron-updater').autoUpdater; } catch (e) { sendUpdate({ status: 'error', message: 'Updater unavailable' }); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  updater.on('update-available', i => sendUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => sendUpdate({ status: 'latest', checkedAt: Date.now() }));
  updater.on('download-progress', p => sendUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', i => sendUpdate({ status: 'ready', version: i.version }));
  updater.on('error', err => sendUpdate({ status: 'error', message: String(err?.message || err).split('\n')[0] }));
  const check = () => updater.checkForUpdates().catch(() => { });
  setTimeout(check, 4000);
  setInterval(check, 4 * 60 * 60 * 1000);               // and every 4 hours while it stays open
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dev: isDev, update: updateState }));
ipcMain.handle('update:check', async () => {
  if (!updater) return updateState;
  try { await updater.checkForUpdates(); } catch (e) { sendUpdate({ status: 'error', message: String(e?.message || e).split('\n')[0] }); }
  return updateState;
});
ipcMain.handle('update:install', () => { if (updater && updateState.status === 'ready') setImmediate(() => updater.quitAndInstall(false, true)); });
ipcMain.handle('app:zoom', (e, f) => { const z = Math.min(1.5, Math.max(0.8, +f || 1)); e.sender.setZoomFactor(z); return z; });
ipcMain.handle('app:open', (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
  createWindow();
  setupUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
