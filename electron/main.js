'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { registerDatabaseIpc, manager: databaseManager } = require('./database.js');
const { buildDatabase } = require('./db-build.js');

let dbBuildToken = null;
let dbBuildRunning = false;

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const IS_DEV = process.argv.includes('--dev');
const IS_TEST = process.argv.includes('--screenshots') || process.argv.includes('--test') || process.argv.includes('--persist-test');
const IS_PERSIST_TEST = process.argv.includes('--persist-test');
const IS_HEADLESS_TEST = process.argv.includes('--headless-test');
if (IS_HEADLESS_TEST) {
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'local') return new Response('Not found', { status: 404 });
      let relative = decodeURIComponent(url.pathname);
      if (!relative || relative === '/') relative = '/index.html';
      const filePath = path.normalize(path.join(SRC, relative));
      const relativeCheck = path.relative(SRC, filePath);
      if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
        return new Response('Forbidden', { status: 403 });
      }
      const data = await fsp.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': IS_DEV || !app.isPackaged ? 'no-cache' : 'max-age=3600',
        },
      });
    } catch (error) {
      if (error && error.code === 'ENOENT') return new Response('Not found', { status: 404 });
      return new Response('Internal error', { status: 500 });
    }
  });
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Number.isFinite(raw.width) && Number.isFinite(raw.height)) return raw;
  } catch {
    /* first run */
  }
  return { width: 1560, height: 960, maximized: false };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  fs.promises
    .writeFile(stateFile(), JSON.stringify({ ...bounds, maximized }, null, 2), 'utf8')
    .catch(() => {});
}

let mainWindow = null;

function createWindow() {
  const saved = readWindowState();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    minWidth: 1180,
    minHeight: 720,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    show: false,
    backgroundColor: '#080d12',
    title: 'NeoGrid',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#080d12',
      symbolColor: '#dbe4ee',
      height: 36,
    },
    icon: path.join(ROOT, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  mainWindow = win;

  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV && !IS_TEST) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('close', () => saveWindowState(win));
  win.on('closed', () => {
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://local/')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (input.type === 'keyDown' && key === 'f12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && key === 'i') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (IS_DEV && input.type === 'keyDown' && (input.control || input.meta) && key === 'r') {
      win.webContents.reload();
      event.preventDefault();
    }
  });

  const suffix = IS_TEST ? '?test=1' : '';
  win.loadURL(`app://local/index.html${suffix}`);

  if (IS_PERSIST_TEST) {
    console.log('[persist-test] runner starting…');
    const persistTest = path.join(__dirname, 'persistence-test.js');
    if (fs.existsSync(persistTest)) {
      const runner = require(persistTest);
      runner(win).catch((error) => {
        console.error('[persist-test]', error);
        setTimeout(() => app.quit(), 1000);
      });
    } else {
      console.error('[persist-test] arquivo persistence-test.js não encontrado');
    }
  } else if (IS_TEST) {
    const mode = process.argv.includes('--domcheck') ? 'domcheck-mode.js' : 'screenshot-mode.js';
    const runnerPath = path.join(__dirname, mode);
    if (fs.existsSync(runnerPath)) {
      const runner = require(runnerPath);
      runner(win, { root: ROOT, isDev: IS_DEV }).catch((error) => {
        console.error('[screenshot]', error);
        setTimeout(() => app.quit(), 1000);
      });
    }
  }

  return win;
}

// ── Persistência local do conjunto de dados (snapshot comprimido .neogrid) ──
const projectDir = () => path.join(app.getPath('userData'), 'projects');
const autosavePath = () => path.join(projectDir(), 'autosave.neogrid');
const autosaveMetaPath = () => path.join(projectDir(), 'autosave.meta.json');

async function ensureProjectDir() {
  await fsp.mkdir(projectDir(), { recursive: true });
}

async function atomicWriteFile(targetPath, buffer) {
  await ensureProjectDir();
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmpPath, buffer);
  await fsp.rename(tmpPath, targetPath);
}

function toBuffer(input) {
  if (!input) return Buffer.alloc(0);
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (Array.isArray(input)) return Buffer.from(input);
  throw new Error('Buffer de projeto inválido.');
}

async function readProjectMeta() {
  try {
    const raw = await fsp.readFile(autosaveMetaPath(), 'utf8');
    const meta = JSON.parse(raw);
    if (meta && typeof meta === 'object') return meta;
  } catch {
    /* sem metadados */
  }
  return null;
}

ipcMain.handle('project:status', async () => {
  try {
    await ensureProjectDir();
    let file = null;
    try {
      const stat = await fsp.stat(autosavePath());
      file = { exists: true, size: stat.size, mtime: stat.mtimeMs };
    } catch {
      file = { exists: false, size: 0, mtime: 0 };
    }
    const meta = await readProjectMeta();
    return { supported: true, dir: projectDir(), autosavePath: autosavePath(), file, meta };
  } catch (error) {
    return { supported: false, error: error.message };
  }
});

ipcMain.handle('project:write-autosave', async (_event, payload = {}) => {
  try {
    const buffer = toBuffer(payload.buffer);
    if (!buffer.length) throw new Error('Snapshot vazio.');
    if (buffer.length > 1024 * 1024 * 1024) throw new Error('Snapshot excede 1 GB.');
    await atomicWriteFile(autosavePath(), buffer);
    if (payload.meta && typeof payload.meta === 'object') {
      await fsp.writeFile(autosaveMetaPath(), JSON.stringify({ ...payload.meta, compressedBytes: buffer.length }), 'utf8');
    }
    return { saved: true, path: autosavePath(), bytes: buffer.length };
  } catch (error) {
    return { saved: false, error: error.message };
  }
});

ipcMain.handle('project:read-autosave', async () => {
  try {
    const buffer = await fsp.readFile(autosavePath());
    const meta = await readProjectMeta();
    return {
      found: true,
      base64: buffer.toString('base64'),
      meta,
      path: autosavePath(),
      bytes: buffer.length,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { found: false };
    return { found: false, error: error.message };
  }
});

ipcMain.handle('project:clear-autosave', async () => {
  try {
    await fsp.rm(autosavePath(), { force: true });
    await fsp.rm(autosaveMetaPath(), { force: true });
    return { cleared: true };
  } catch (error) {
    return { cleared: false, error: error.message };
  }
});

ipcMain.handle('project:save-as', async (event, payload = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const suggested = String(payload.suggestedName || 'neogrid_projeto.neogrid').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: 'Salvar projeto NeoGrid',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [
      { name: 'Projeto NeoGrid', extensions: ['neogrid'] },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { saved: false };
  try {
    const buffer = toBuffer(payload.buffer);
    if (!buffer.length) throw new Error('Snapshot vazio.');
    await fsp.writeFile(filePath, buffer);
    return { saved: true, path: filePath, bytes: buffer.length };
  } catch (error) {
    return { saved: false, error: error.message };
  }
});

ipcMain.handle('project:open-file', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: 'Abrir projeto NeoGrid',
    defaultPath: app.getPath('documents'),
    filters: [
      { name: 'Projeto NeoGrid', extensions: ['neogrid'] },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.length) return { canceled: true };
  try {
    const filePath = filePaths[0];
    const buffer = await fsp.readFile(filePath);
    return {
      canceled: false,
      base64: buffer.toString('base64'),
      path: filePath,
      name: path.basename(filePath),
      bytes: buffer.length,
    };
  } catch (error) {
    return { canceled: false, error: error.message };
  }
});

ipcMain.handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  userData: app.getPath('userData'),
  packaged: app.isPackaged,
}));

ipcMain.handle('net:fetch-text', async (_event, payload = {}) => {
  const url = String(payload.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, error: 'URL inválida' };
  const headers = payload.headers && typeof payload.headers === 'object' ? { ...payload.headers } : {};
  headers['User-Agent'] = 'NeoGrid/2.0 (arruamento)';
  // O Overpass costuma levar 20-60s em áreas densas; o chamador informa o limite.
  const timeoutMs = Math.max(5000, Math.min(120000, Number(payload.timeoutMs) || 30000));
  try {
    const response = await net.fetch(url, {
      method: payload.body == null ? 'GET' : 'POST',
      headers,
      body: payload.body == null ? undefined : String(payload.body),
      signal: AbortSignal.timeout(timeoutMs),
      bypassCustomProtocolHandlers: true,
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
});

ipcMain.handle('file:save', async (event, payload = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const suggested = String(payload.defaultName || 'exportacao.txt').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: payload.title || 'Salvar arquivo',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: Array.isArray(payload.filters) ? payload.filters : [{ name: 'Todos os arquivos', extensions: ['*'] }],
  });
  if (canceled || !filePath) return { saved: false };
  try {
    await fsp.writeFile(filePath, payload.content ?? '', 'utf8');
    return { saved: true, path: filePath };
  } catch (error) {
    return { saved: false, error: error.message };
  }
});

ipcMain.handle('file:reveal', async (_event, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('window:overlay-theme', (event, theme = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  try {
    win.setTitleBarOverlay({
      color: theme.color || '#080d12',
      symbolColor: theme.symbolColor || '#dbe4ee',
      height: 36,
    });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('app:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// ── Conversor CSV → SQLite embutido ──────────────────────────────
ipcMain.handle('db:pick-folder', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || null;
  const result = await dialog.showOpenDialog(owner, {
    title: 'Pasta com os CSVs da extração',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.length) return { cancelled: true };
  return { cancelled: false, path: result.filePaths[0] };
});

ipcMain.handle('db:pick-output', async (event, suggestedName = 'neogrid_base.sqlite') => {
  const owner = BrowserWindow.fromWebContents(event.sender) || null;
  const safe = String(suggestedName || 'neogrid_base.sqlite').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  const result = await dialog.showSaveDialog(owner, {
    title: 'Salvar base SQLite',
    defaultPath: path.join(app.getPath('documents'), safe),
    filters: [
      { name: 'Base NeoGrid', extensions: ['sqlite'] },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  return { cancelled: false, path: result.filePath };
});

ipcMain.handle('db:build-start', async (event, payload = {}) => {
  if (dbBuildRunning) return { started: false, error: 'Já existe uma conversão em andamento.' };
  const source = String(payload.source || '');
  const output = String(payload.output || '');
  if (!source || !output) return { started: false, error: 'Origem e destino são obrigatórios.' };
  dbBuildRunning = true;
  dbBuildToken = { cancelled: false };
  const token = dbBuildToken;
  const sender = event.sender;
  const send = (message) => {
    try {
      if (!sender.isDestroyed()) sender.send('db:build-progress', message);
    } catch { /* janela fechada */ }
  };
  try {
    const result = await buildDatabase({
      source,
      output,
      manifestoOut: payload.manifestoOut || `${output}.manifesto.json`,
      manifestoBase: payload.manifestoBase || null,
      rejectLimit: Number(payload.rejectLimit) || 0.005,
      token,
      onProgress: send,
    });
    send({ type: 'done', manifest: result.manifest, output: result.output });
    return { started: true, finished: true, manifest: result.manifest, output: result.output };
  } catch (error) {
    if (error?.code === 'BUILD_CANCELLED') {
      send({ type: 'cancelled' });
      return { started: true, finished: false, cancelled: true };
    }
    send({ type: 'error', error: error.message });
    return { started: true, finished: false, error: error.message };
  } finally {
    dbBuildRunning = false;
    if (dbBuildToken === token) dbBuildToken = null;
  }
});

ipcMain.handle('db:build-cancel', async () => {
  if (dbBuildToken) dbBuildToken.cancelled = true;
  return { cancelling: Boolean(dbBuildToken) };
});

ipcMain.handle('db:build-busy', async () => ({ busy: dbBuildRunning }));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('br.com.neogrid.desktop');
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    registerDatabaseIpc(ipcMain, dialog);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
