const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths & persistence
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(app.getPath('userData'), 'ClaudeSwitcherData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
// Per-instance Claude profiles MUST live directly under %APPDATA% as
// Claude-<slug>: Claude's Cowork VM service resolves its image from
// %APPDATA%\<dir> and ignores arbitrary --user-data-dir locations.
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

const LOG_PATH = path.join(DATA_DIR, 'claude-switcher.log');

// One-time migration: this app was formerly "switchly-clone", which put its
// instance list under a different userData folder. Pull that config forward so a
// rename never silently drops the user's instances. Guarded by a marker so it
// runs exactly once and can never overwrite settings the user changes later.
// (The per-instance Claude-<slug> profile folders live under %APPDATA% directly,
// so they are unaffected by the rename — only this list needed to move.)
const LEGACY_CONFIG = path.join(APPDATA, 'switchly-clone', 'SwitchlyData', 'config.json');
const MIGRATED_MARK = path.join(DATA_DIR, '.migrated');
function migrateLegacyConfig() {
  try {
    if (fs.existsSync(MIGRATED_MARK)) return;
    ensureDirs();
    if (fs.existsSync(LEGACY_CONFIG)) {
      fs.copyFileSync(LEGACY_CONFIG, CONFIG_PATH);
      log('migrated instance list from legacy switchly-clone config');
    }
    fs.writeFileSync(MIGRATED_MARK, new Date().toISOString(), 'utf8');
  } catch (e) { log('migrateLegacyConfig error: ' + (e.message || e)); }
}
function log(msg) {
  try { ensureDirs(); fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

function profileDirFor(instance) {
  return path.join(APPDATA, `Claude-${instance.slug}`);
}

function makeSlug(name, id) {
  const base = (name || 'instance').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `${base || 'instance'}-${id.slice(0, 6)}`;
}

function defaultConfig() {
  return {
    instances: [
      {
        id: crypto.randomUUID(),
        name: 'Original Claude Desktop',
        account: '',
        color: '#9ca3af',
        isDefault: true,          // launches the normal profile (your main account)
        slug: null
      }
    ]
  };
}

function loadConfig() {
  ensureDirs();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  if (!Array.isArray(cfg.instances)) cfg.instances = [];
  for (const i of cfg.instances) {
    if (typeof i.account !== 'string') i.account = '';
    if (!i.isDefault && !i.slug) i.slug = makeSlug(i.name, i.id);
  }
  return cfg;
}

function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  if (typeof refreshTray === 'function') refreshTray(); // names/accounts show in the tray menu
}

// ---------------------------------------------------------------------------
// Claude executable resolution (survives app updates via Get-AppxPackage)
// ---------------------------------------------------------------------------
let cachedExe = null;
function resolveClaudeExe() {
  if (cachedExe && fileReadable(cachedExe)) return cachedExe;
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$p=Get-AppxPackage *Claude* | Select-Object -First 1; if($p){ Join-Path $p.InstallLocation 'app\\Claude.exe' }"
    ], { encoding: 'utf8', timeout: 15000 }).trim();
    if (out && fileReadable(out)) { cachedExe = out; return out; }
  } catch { /* ignore */ }
  // Fallback: the user-local execution alias (runs in-container, but works).
  const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'claude-desktop.exe');
  if (fileReadable(alias) || aliasPresent(alias)) { cachedExe = alias; return alias; }
  return '';
}

function fileReadable(p) {
  try { return !!(p && fs.statSync(p)); } catch { return false; }
}
// App-execution aliases are reparse points that statSync can't follow.
function aliasPresent(p) {
  try {
    const base = path.basename(p).toLowerCase();
    return fs.readdirSync(path.dirname(p)).some(n => n.toLowerCase() === base);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Closing Claude  (quiet-login needs every Claude process gone so the profile
// folders can be moved and so the OAuth callback has one place to land)
// ---------------------------------------------------------------------------
function claudeRunning() {
  try {
    const out = execFileSync('tasklist.exe', ['/fi', 'imagename eq Claude.exe', '/nh'], { encoding: 'utf8' });
    return /Claude\.exe/i.test(out);
  } catch (e) { log('claudeRunning tasklist error: ' + (e.message || e)); return false; }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Kill every Claude.exe and wait (up to ~8s) for the processes to clear so file
// locks on the profile folders are released. Async so the panel UI stays responsive.
async function closeAllClaude() {
  log('closeAllClaude: start; claudeRunning=' + claudeRunning());
  // drop our own tracked handles first
  for (const [, child] of running) { try { child.kill(); } catch { /* ignore */ } }
  running.clear();
  try {
    const out = execFileSync('taskkill.exe', ['/f', '/t', '/im', 'Claude.exe'], { encoding: 'utf8' });
    log('taskkill ok: ' + out.trim());
  } catch (e) {
    log('taskkill error: code=' + e.status + ' msg=' + (e.message || e) + ' stderr=' + (e.stderr ? e.stderr.toString().trim() : ''));
  }
  for (let i = 0; i < 40; i++) {
    if (!claudeRunning()) { log('closeAllClaude: cleared after ' + i + ' polls'); return true; }
    await sleep(200);
  }
  log('closeAllClaude: STILL RUNNING after 8s');
  return !claudeRunning();
}

// ---------------------------------------------------------------------------
// Quiet-login (first-time sign-in for a new instance)
//   Close every Claude, open ONLY this instance (its own --user-data-dir), so
//   the claude:// sign-in callback has exactly one window to land in. The
//   login-watcher reroutes the callback process into the instance's profile.
// ---------------------------------------------------------------------------
async function quietLoginBegin(instance) {
  log('loginBegin: instance=' + instance.name + ' slug=' + instance.slug);
  if (!(await closeAllClaude())) {
    return { ok: false, error: 'Could not close the running Claude windows. Quit Claude from the tray and try again.' };
  }
  const targetDir = profileDirFor(instance);
  // Start from a clean profile so a leftover/contaminated folder can't pre-sign it in.
  try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
  const res = spawnClaude(instance);
  log('loginBegin: launched instance -> ' + JSON.stringify(res));
  if (res.ok) startWatcher(targetDir);
  return res;
}

// The sign-in callback arrives as a NEW Claude.exe without --user-data-dir (it
// would open the main profile). The watcher reroutes it into this instance.
let watcher = null;
function startWatcher(dir) {
  stopWatcher();
  const script = path.join(__dirname, 'login-watcher.ps1');
  watcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', script, '-Exe', resolveClaudeExe(), '-Dir', dir, '-Log', LOG_PATH], { stdio: 'ignore', windowsHide: true });
  watcher.on('exit', () => { watcher = null; });
}
function stopWatcher() {
  if (watcher) { try { watcher.kill(); } catch { /* ignore */ } watcher = null; }
}

function quietLoginFinish(instance) {
  stopWatcher();
  // Signed in — bring the main Claude back alongside it.
  const cfg = loadConfig();
  const def = cfg.instances.find(i => i.isDefault);
  if (def && !running.has(def.id)) spawnClaude(def);
  if (!running.has(instance.id)) spawnClaude(instance);
  log('loginFinish: relaunched default + instance');
  return { ok: true, seeded: true };
}

function quietLoginCancel(instance) {
  stopWatcher();
  const cfg = loadConfig();
  const def = cfg.instances.find(i => i.isDefault);
  if (def && !running.has(def.id)) spawnClaude(def);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Running process tracking
// ---------------------------------------------------------------------------
const running = new Map(); // instanceId -> ChildProcess

function broadcastStatus(id, status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('instance-status', { id, status });
  }
  refreshTray();
}

function isSeeded(instance) {
  if (instance.isDefault) return true; // default profile is already your login
  try { return fs.existsSync(path.join(profileDirFor(instance), 'Local Storage')); }
  catch { return false; }
}

function accountAlreadyRunning(instance) {
  const acct = (instance.account || '').trim().toLowerCase();
  if (!acct) return null;
  const cfg = loadConfig();
  for (const other of cfg.instances) {
    if (other.id === instance.id) continue;
    if ((other.account || '').trim().toLowerCase() === acct && running.has(other.id)) return other;
  }
  return null;
}

function spawnClaude(instance) {
  const exe = resolveClaudeExe();
  if (!exe) return { ok: false, error: 'Claude Desktop was not found. Is it installed from the Microsoft Store?' };

  const args = [];
  if (!instance.isDefault) {
    const dir = profileDirFor(instance);
    fs.mkdirSync(dir, { recursive: true });
    args.push(`--user-data-dir=${dir}`);
  }
  const child = spawn(exe, args, { detached: false, stdio: 'ignore' });
  running.set(instance.id, child);
  broadcastStatus(instance.id, 'Running');
  child.on('exit', () => { running.delete(instance.id); broadcastStatus(instance.id, 'Stopped'); });
  child.on('error', () => { running.delete(instance.id); broadcastStatus(instance.id, 'Stopped'); });
  return { ok: true };
}

function launchInstance(instance) {
  if (running.has(instance.id)) return { ok: true, already: true };
  const clash = accountAlreadyRunning(instance);
  if (clash) {
    return { ok: false, error: `Account "${instance.account}" is already running in "${clash.name}". ` +
      `The same account can't run in two instances at once.` };
  }
  return spawnClaude(instance);
}

function stopInstance(id) {
  const child = running.get(id);
  if (!child) return { ok: true, already: true };
  try { child.kill(); } catch { /* ignore */ }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;
let quitting = false;
// A compact panel that pops up above the tray icon — no taskbar button.
const PANEL_W = 460, PANEL_H = 540;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    backgroundColor: '#17181b', title: 'ClaudeSwitcher', icon: trayIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile('index.html');
  // Click away → tuck back into the tray. Never really closes; Quit is in the tray menu.
  mainWindow.on('blur', () => { if (!mainWindow.webContents.isDevToolsOpened()) mainWindow.hide(); });
  mainWindow.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWindow.hide(); } });
}

// Place the panel just above (or beside) the tray icon, inside the work area.
function positionPanel() {
  const { screen } = require('electron');
  const t = tray.getBounds();
  const area = screen.getDisplayMatching(t).workArea;
  let x = Math.round(t.x + t.width / 2 - PANEL_W / 2);
  let y = t.y > area.y + area.height / 2 ? t.y - PANEL_H - 8 : t.y + t.height + 8;
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - PANEL_W - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - PANEL_H - 8);
  mainWindow.setPosition(x, y, false);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  positionPanel();
  mainWindow.show();
  mainWindow.focus();
}

function togglePanel() {
  if (mainWindow && mainWindow.isVisible()) mainWindow.hide(); else showWindow();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
let tray = null;

// 16x16 accent-colored dot, drawn in code so no icon file is needed.
function trayIcon() {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  const c = size / 2 - 0.5, r = size / 2 - 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c), a = Math.max(0, Math.min(1, r - d + 0.5));
    const i = (y * size + x) * 4;
    buf[i] = 0x5c; buf[i + 1] = 0x8a; buf[i + 2] = 0xe0; buf[i + 3] = Math.round(a * 255); // BGRA #e08a5c
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function openLoginFromTray(id) {
  showWindow();
  const send = () => mainWindow.webContents.send('open-login', id);
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send); else send();
}

function refreshTray() {
  if (!tray) return;
  const cfg = loadConfig();
  const items = cfg.instances.map(inst => {
    const run = running.has(inst.id);
    const sub = [
      run
        ? { label: 'Stop', click: () => stopInstance(inst.id) }
        : { label: 'Launch', click: () => {
            const r = launchInstance(inst);
            if (!r.ok) dialog.showErrorBox('ClaudeSwitcher', r.error || 'Could not launch.');
          } }
    ];
    if (!inst.isDefault) sub.push({ label: 'Log in / switch account…', click: () => openLoginFromTray(inst.id) });
    return { label: `${run ? '● ' : '○ '}${inst.name}${inst.account ? ' — ' + inst.account : ''}`, submenu: sub };
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: 'New instance…', click: () => { newInstance(); showWindow(); } },
    { label: 'Open ClaudeSwitcher', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings({ args: loginArgs() }).openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, args: loginArgs() }) },
    { label: 'Quit ClaudeSwitcher', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.setToolTip(`ClaudeSwitcher — ${running.size} running`);
}

// Unpackaged, Windows must start electron.exe *with this app's folder*.
function loginArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', togglePanel);          // left-click: the panel
  tray.on('right-click', () => tray.popUpContextMenu()); // right-click: quick menu
  refreshTray();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-state', () => {
  const cfg = loadConfig();
  return {
    claudeFound: !!resolveClaudeExe(),
    instances: cfg.instances.map(i => ({
      ...i,
      status: running.has(i.id) ? 'Running' : 'Stopped',
      seeded: isSeeded(i)
    }))
  };
});

ipcMain.handle('save-instances', (_e, instances) => {
  const cfg = loadConfig();
  // keep slug stable once assigned
  const prev = new Map(cfg.instances.map(i => [i.id, i]));
  cfg.instances = instances.map(i => {
    const old = prev.get(i.id);
    const slug = i.isDefault ? null : (old && old.slug ? old.slug : makeSlug(i.name, i.id));
    return { ...i, slug };
  });
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('launch', (_e, id) => {
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === id);
  if (!inst) return { ok: false, error: 'Instance not found' };
  return launchInstance(inst);
});

// Quiet-login (profile swap). Two steps around the user's manual sign-in.
ipcMain.handle('login-begin', (_e, id) => {
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === id);
  if (!inst) return { ok: false, error: 'Instance not found' };
  if (inst.isDefault) return { ok: false, error: 'The default instance already uses your main login.' };
  return quietLoginBegin(inst);
});

ipcMain.handle('login-finish', (_e, id) => {
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === id);
  if (!inst) return { ok: false, error: 'Instance not found' };
  return quietLoginFinish(inst);
});

ipcMain.handle('login-cancel', (_e, id) => {
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === id);
  if (!inst) return { ok: false, error: 'Instance not found' };
  return quietLoginCancel(inst);
});

ipcMain.handle('stop', (_e, id) => stopInstance(id));

ipcMain.handle('new-instance', () => newInstance());

function newInstance() {
  const cfg = loadConfig();
  const palette = ['#6366f1', '#22c55e', '#ec4899', '#f59e0b', '#06b6d4', '#a855f7'];
  const id = crypto.randomUUID();
  const name = `Instance ${cfg.instances.length + 1}`;
  const inst = { id, name, account: '', color: palette[cfg.instances.length % palette.length], isDefault: false, slug: makeSlug(name, id) };
  cfg.instances.push(inst);
  saveConfig(cfg);
  return inst;
}

ipcMain.handle('delete-instance', (_e, id) => {
  stopInstance(id);
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === id);
  cfg.instances = cfg.instances.filter(i => i.id !== id);
  saveConfig(cfg);
  if (inst && !inst.isDefault) {
    try { fs.rmSync(profileDirFor(inst), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { ok: true };
});

ipcMain.handle('account-conflict', (_e, { id, account }) => {
  const acct = (account || '').trim().toLowerCase();
  if (!acct) return { conflict: false };
  const cfg = loadConfig();
  const other = cfg.instances.find(i => i.id !== id && (i.account || '').trim().toLowerCase() === acct);
  return { conflict: !!other, name: other ? other.name : null };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// One ClaudeSwitcher at a time; starting it again just shows the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    migrateLegacyConfig(); // restore instances carried over from the old app name
    createTray();
    // Lives in the tray; the panel only opens when the tray icon is clicked.
    createWindow();
  });
}
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay in the tray */ });
