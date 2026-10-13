import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell, systemPreferences } from 'electron';
import dotenv from 'dotenv';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(dirname, '..');

// In a packaged .app the project folder is read-only, so the user's keys live
// in ~/Library/Application Support/Call Copilot/.env . In dev, the repo .env wins.
const envCandidates = [
  path.join(projectRoot, '.env'),
  path.join(app.getPath('userData'), '.env'),
];
for (const file of envCandidates) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const SUMMON_SHORTCUT = 'Control+Alt+C';
let appUrl = '';
let prefs = { hideFromDock: false };
let mainWindow = null;
let overlayWindow = null;
let prefsPath = '';
let hiddenFromCapture = true;
let overlayClickThrough = false;

/**
 * Bring a window to the user, even when they are inside a fullscreen app.
 *
 * macOS keeps fullscreen apps in their own Space and will not move a normal
 * window into one, so show()/focus() alone leaves the window stranded on
 * another Space looking like it never opened. Briefly marking it visible on
 * all workspaces drags it onto the active Space; we drop the flag straight
 * after so it behaves like an ordinary window from then on.
 */
function surfaceWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });
    win.show();
    win.focus();
    app.focus({ steal: true });
    setTimeout(() => {
      if (!win.isDestroyed()) win.setVisibleOnAllWorkspaces(false);
    }, 400);
  } else {
    win.show();
    win.focus();
  }
}

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    title: 'Call Copilot',
    backgroundColor: '#0d1017',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The whole point of the overlay is that this window is hidden behind
      // the meeting. Chromium throttles hidden windows to about 1Hz, which
      // starves the overlay of the very updates it exists to show.
      backgroundThrottling: false,
    },
  });

  // Keep the assistant out of screen shares and recordings by default — the
  // whole point is that only the user sees it.
  mainWindow.setContentProtection(hiddenFromCapture);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(url);

  surfaceWindow(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * A frameless, always-on-top window that floats over whatever the user is
 * actually looking at — the meeting, the browser, a fullscreen app. The main
 * window keeps the settings; this one only shows answers.
 */
function createOverlay(url) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return overlayWindow;
  }

  const display = screen.getPrimaryDisplay().workArea;
  const width = 460;
  const height = 520;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(display.x + display.width - width - 24),
    y: Math.round(display.y + 24),
    minWidth: 280,
    minHeight: 180,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    fullscreenable: false,
    // Keep it out of the app switcher and off the Dock's radar.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the only level that reliably floats above a fullscreen
  // meeting window on macOS.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });
  overlayWindow.setContentProtection(hiddenFromCapture);

  overlayWindow.loadURL(`${url}overlay.html`);
  overlayWindow.webContents.on('did-finish-load', () => {
    // Re-assert after load: this is the window most likely to leak into a
    // screen share, so it must never be left unprotected by a race.
    overlayWindow.setContentProtection(hiddenFromCapture);
    overlayWindow.webContents.send('overlay:protection', hiddenFromCapture);
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    mainWindow?.webContents.send('overlay:closed');
  });

  return overlayWindow;
}

function wireMediaPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'display-capture'].includes(permission));
  });

  // getDisplayMedia() in the renderer lands here. `audio: 'loopback'` captures
  // what the Mac is playing (Zoom, Meet, Teams) with no virtual audio device.
  // Requires macOS 13+.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) return callback({});
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    // No system picker: we only want the audio tap, and making the user pick a
    // screen every time they press Start is friction for nothing.
    { useSystemPicker: false },
  );
}

/**
 * Main-process preferences. Kept here rather than in the renderer's
 * localStorage because the Dock icon has to be hidden before the first window
 * exists — otherwise it flashes into the Dock on every launch.
 */
function loadPrefs() {
  prefsPath = path.join(app.getPath('userData'), 'prefs.json');
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsPath, 'utf8')) };
  } catch {
    /* first run */
  }
}

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
  } catch {
    /* a failed write only costs the setting next launch */
  }
}

function applyDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (prefs.hideFromDock) app.dock.hide();
  else app.dock.show();
}

/** With no Dock icon this is the only way back to the window. */
function registerSummonShortcut() {
  globalShortcut.unregister(SUMMON_SHORTCUT);
  return globalShortcut.register(SUMMON_SHORTCUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (appUrl) createWindow(`${appUrl}?desktop=1`);
      return;
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else surfaceWindow(mainWindow);
  });
}

async function bootstrap() {
  await app.whenReady();
  loadPrefs();
  applyDockVisibility();
  registerSummonShortcut();
  wireMediaPermissions();

  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      /* the renderer surfaces the denial inline */
    }
  }

  const { setStorePath } = await import('../server/keys.js');
  // Keys entered in the app live beside the app's own data, not in the bundle.
  setStorePath(path.join(app.getPath('userData'), 'keys.json'));

  const { setSessionDir } = await import('../server/sessions.js');
  setSessionDir(path.join(app.getPath('userData'), 'sessions'));

  const { listen } = await import('../server/app.js');
  // A stable port keeps the renderer's origin stable, which is what makes
  // localStorage settings survive a restart.
  const { port } = await listen();
  appUrl = `http://127.0.0.1:${port}/`;
  await createWindow(`${appUrl}?desktop=1`);
}

ipcMain.handle('window:toggle-pin', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next, 'floating');
  return next;
});

ipcMain.handle('window:toggle-capture-hidden', () => {
  if (!mainWindow) return hiddenFromCapture;
  hiddenFromCapture = !hiddenFromCapture;
  mainWindow.setContentProtection(hiddenFromCapture);
  // The overlay is the window most likely to be caught in a screen share.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setContentProtection(hiddenFromCapture);
    overlayWindow.webContents.send('overlay:protection', hiddenFromCapture);
  }
  return hiddenFromCapture;
});

ipcMain.handle('window:capture-hidden', () => hiddenFromCapture);

/* ---------- screen reading ---------- */

/**
 * Everything the user could point the reader at: each physical display, and
 * each open window. Thumbnails are small — they are only for the picker.
 */
ipcMain.handle('screens:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });
  return sources
    .filter((s) => s.name && s.name !== 'Call Copilot' && s.name !== 'Call Copilot — Overlay')
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    }));
});

/**
 * Grab one source at a size big enough to read small text, then downscale to
 * keep the upload (and the token bill) sane. Our own windows are content
 * protected, so the assistant never captures its own answers.
 */
ipcMain.handle('screens:capture', async (_event, sourceId, sourceName) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 2560, height: 1600 },
  });

  // Window ids are not stable across restarts (display ids are), so fall back
  // to the remembered name before telling the user to pick again.
  let match = sources.find((s) => s.id === sourceId);
  if (!match && sourceName) match = sources.find((s) => s.name === sourceName);

  if (!match || match.thumbnail.isEmpty()) {
    return {
      ok: false,
      error: `"${sourceName || sourceId}" is not open any more. Pick a screen or window again.`,
    };
  }

  let image = match.thumbnail;
  const size = image.getSize();
  if (size.width > 1920) image = image.resize({ width: 1920, quality: 'good' });

  // JPEG rather than PNG: a full-screen PNG runs past 1MB, and quality 90 stays
  // comfortably readable for on-screen text while cutting the payload ~4x.
  const jpeg = image.toJPEG(90);

  return {
    ok: true,
    id: match.id,
    name: match.name,
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: image.getSize().width,
    height: image.getSize().height,
    bytes: jpeg.length,
  };
});

let regionResolver = null;
let regionWindow = null;

/**
 * Freeze the chosen source, put it fullscreen on the display it came from, and
 * let the user drag a rectangle over it. Freezing matters: the interviewer's
 * screen keeps moving, and you should crop what you saw, not what arrived
 * half a second later.
 */
ipcMain.handle('screens:capture-region', async (_event, sourceId, sourceName) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 3200, height: 2000 },
  });

  let match = sources.find((s) => s.id === sourceId);
  if (!match && sourceName) match = sources.find((s) => s.name === sourceName);
  if (!match || match.thumbnail.isEmpty()) {
    return { ok: false, error: `"${sourceName || sourceId}" is not open any more. Pick a screen or window again.` };
  }

  const full = match.thumbnail;
  const fullSize = full.getSize();

  // Put the selector on the display the capture came from, so a screen source
  // lines up 1:1 with what the user is looking at.
  const displays = screen.getAllDisplays();
  const displayId = match.display_id ? String(match.display_id) : null;
  const target =
    (displayId && displays.find((d) => String(d.id) === displayId)) || screen.getPrimaryDisplay();
  const area = target.bounds;

  if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close();

  regionWindow = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    movable: false,
    resizable: false,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  regionWindow.setAlwaysOnTop(true, 'screen-saver');
  regionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });
  regionWindow.setContentProtection(hiddenFromCapture);

  const result = new Promise((resolve) => {
    regionResolver = resolve;
  });

  regionWindow.loadURL(`${appUrl}region.html`);
  regionWindow.webContents.on('did-finish-load', () => {
    regionWindow.webContents.send('region:image', {
      dataUrl: full.toDataURL(),
      name: match.name,
    });
    regionWindow.focus();
  });
  regionWindow.on('closed', () => {
    regionWindow = null;
    if (regionResolver) {
      regionResolver({ ok: false, cancelled: true });
      regionResolver = null;
    }
  });

  const picked = await result;
  if (!picked.ok) return picked;

  // The selector reports a normalised rect, so no scaling assumptions travel
  // between the two processes.
  const x = Math.round(picked.rect.x * fullSize.width);
  const y = Math.round(picked.rect.y * fullSize.height);
  const width = Math.max(8, Math.round(picked.rect.width * fullSize.width));
  const height = Math.max(8, Math.round(picked.rect.height * fullSize.height));

  let cropped = full.crop({
    x: Math.max(0, Math.min(x, fullSize.width - 8)),
    y: Math.max(0, Math.min(y, fullSize.height - 8)),
    width: Math.min(width, fullSize.width - x),
    height: Math.min(height, fullSize.height - y),
  });

  // Upscale tiny crops a little — small text reads better for the model.
  const cropSize = cropped.getSize();
  if (cropSize.width < 700 && cropSize.width > 0) {
    cropped = cropped.resize({ width: Math.min(1400, cropSize.width * 2), quality: 'best' });
  } else if (cropSize.width > 1920) {
    cropped = cropped.resize({ width: 1920, quality: 'good' });
  }

  const jpeg = cropped.toJPEG(92);
  return {
    ok: true,
    id: match.id,
    name: match.name,
    note: picked.note || '',
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: cropped.getSize().width,
    height: cropped.getSize().height,
    bytes: jpeg.length,
  };
});

ipcMain.on('region:result', (_event, payload) => {
  if (regionResolver) {
    regionResolver(payload);
    regionResolver = null;
  }
  if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close();
});

ipcMain.handle('overlay:toggle', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    return false;
  }
  createOverlay(appUrl);
  return true;
});

// The overlay has no state and no provider access; a reply typed there is
// handed to the main window, which owns the session and does the asking.
ipcMain.on('overlay:ask', (_event, text) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:ask', text);
});

// Same principle as replies: the overlay asks, the main window decides.
ipcMain.on('overlay:control', (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('overlay:control', payload);

  // The screen picker is a dialog in the main window, which is normally buried
  // behind the meeting — bring it forward or the click looks like a no-op.
  if (payload?.action === 'pick-screen') surfaceWindow(mainWindow);
});

// The main window owns the session state; the overlay is a pure view of it.
ipcMain.on('overlay:state', (_event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:state', payload);
  }
});

/**
 * Save an interview to a file the user picks. The renderer cannot write to
 * disk, so it hands over the rendered content and the main process runs the
 * native save sheet — the extension the user chooses decides the format.
 */
ipcMain.handle('sessions:export', async (_event, { slug, markdown, json }) => {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow;
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: 'Save interview',
    defaultPath: path.join(app.getPath('downloads'), `${slug || 'interview'}.md`),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Plain text', extensions: ['txt'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  try {
    const body = filePath.toLowerCase().endsWith('.json') ? json : markdown;
    fs.writeFileSync(filePath, body, 'utf8');
    return { ok: true, filePath, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:reveal', (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('prefs:get', () => ({
  ...prefs,
  summonShortcut: '⌃⌥C',
  summonRegistered: globalShortcut.isRegistered(SUMMON_SHORTCUT),
}));

ipcMain.handle('prefs:hide-from-dock', (_event, value) => {
  const want = Boolean(value);

  // Refuse to hide the Dock icon unless there is a working way back to the
  // window, otherwise the app becomes unreachable.
  if (want && !globalShortcut.isRegistered(SUMMON_SHORTCUT) && !registerSummonShortcut()) {
    return { ok: false, hideFromDock: prefs.hideFromDock, error: `${SUMMON_SHORTCUT} is taken by another app, so there would be no way to reopen the window. Free that shortcut and try again.` };
  }

  prefs.hideFromDock = want;
  savePrefs();
  applyDockVisibility();
  return { ok: true, hideFromDock: prefs.hideFromDock };
});

ipcMain.handle('overlay:is-open', () => Boolean(overlayWindow && !overlayWindow.isDestroyed()));

ipcMain.handle('overlay:close', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  return false;
});

ipcMain.handle('overlay:set-opacity', (_event, value) => {
  const clamped = Math.min(1, Math.max(0.25, Number(value) || 1));
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setOpacity(clamped);
  return clamped;
});

/** Click-through lets the overlay sit over the meeting without eating clicks. */
ipcMain.handle('overlay:toggle-protection', () => {
  hiddenFromCapture = !hiddenFromCapture;
  mainWindow?.setContentProtection(hiddenFromCapture);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setContentProtection(hiddenFromCapture);
  }
  mainWindow?.webContents.send('overlay:protection', hiddenFromCapture);
  return hiddenFromCapture;
});

ipcMain.handle('overlay:toggle-click-through', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  overlayClickThrough = !overlayClickThrough;
  overlayWindow.setIgnoreMouseEvents(overlayClickThrough, { forward: true });
  return overlayClickThrough;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('activate', () => {
  // Re-open the window against the server that is already running. Calling
  // bootstrap() again would start a second listener on the next free port,
  // which changes the page's origin and silently wipes saved settings.
  if (!mainWindow && appUrl) createWindow(`${appUrl}?desktop=1`);
  else if (!mainWindow) bootstrap();
  else surfaceWindow(mainWindow);
});

bootstrap().catch((err) => {
  console.error('Failed to start Call Copilot:', err);
  app.quit();
});
