import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from 'electron';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDashboardUrl, isExternalWebUrl, startOwnedServer, workspaceDataDir, workspaceServerPath } from './host.mjs';

const desktopDir = dirname(fileURLToPath(import.meta.url));

export function createDesktop({ dataDir, serverPath } = {}) {
  let window;
  let tray;
  let backend;
  let starting;
  let quitting = false;
  let stopped = false;

  const report = error => {
    console.error('[desktop]', error);
    dialog.showErrorBox('Esquie Local', error.message || String(error));
  };
  const show = () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const openExternal = url => {
    if (isExternalWebUrl(url)) shell.openExternal(url).catch(report);
  };

  function makeMenus() {
    const login = () => app.isPackaged && app.getLoginItemSettings().openAtLogin;
    const menu = () => Menu.buildFromTemplate([
      { label: 'Open Esquie Local', click: show },
      { label: 'Start when I sign in', type: 'checkbox', enabled: app.isPackaged,
        checked: login(), click: item => {
          try {
            app.setLoginItemSettings({ openAtLogin: item.checked });
            makeMenus();
          } catch (error) { report(error); }
        } },
      { type: 'separator' },
      { label: 'Quit Esquie Local', click: () => app.quit() }
    ]);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Esquie Local', submenu: menu() },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
    ]));
    if (!tray) {
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 60; pixels[i + 1] = 100; pixels[i + 2] = 95; pixels[i + 3] = 255;
      }
      tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
      tray.setToolTip('Esquie Local');
      tray.on('double-click', show);
    }
    tray.setContextMenu(menu());
  }

  async function start() {
    const location = serverPath || workspaceServerPath({
      isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopDir
    });
    backend = await startOwnedServer({
      serverPath: location,
      dataDir: workspaceDataDir({ dataDir, userDataDir: app.getPath('userData') })
    });
    if (quitting) return;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    window = new BrowserWindow({
      title: 'Esquie Local', width: 1440, height: 960, minWidth: 800, minHeight: 600,
      backgroundColor: '#f3eee5', show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    });
    const origin = new URL(backend.url).origin;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!isDashboardUrl(url, origin)) openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-frame-navigate', event => {
      if (!isDashboardUrl(event.url, origin)) {
        event.preventDefault();
        if (event.isMainFrame) openExternal(event.url);
      }
    });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', (_event, details) =>
      report(new Error(`The workspace window stopped (${details.reason}). Use View > Reload.`)));
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); window.hide(); }
    });
    makeMenus();
    try {
      await window.loadURL(backend.launchUrl);
    } catch {
      throw new Error('The local dashboard could not be loaded.');
    }
    show();
  }

  function register() {
    if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
    app.on('second-instance', show);
    app.on('activate', show);
    app.on('window-all-closed', () => {});
    app.on('before-quit', event => {
      if (stopped) return;
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      Promise.resolve(starting).catch(() => {}).then(async () => {
        if (backend) await backend.close();
        stopped = true;
        tray?.destroy();
        app.quit();
      }).catch(error => { quitting = false; report(error); });
    });
    starting = app.whenReady().then(start);
    starting.catch(error => { report(error); app.quit(); });
    return true;
  }

  return { register, getWindow: () => window, getBackend: () => backend, ready: () => starting, show };
}
