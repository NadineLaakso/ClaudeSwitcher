const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths & persistence
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(app.getPath('userData'), 'SwitchlyData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SWAP_STATE = path.join(DATA_DIR, 'swap.json');
// Per-instance Claude profiles MUST live directly under %APPDATA% as
// Claude-<slug>: Claude's Cowork VM service resolves its image from
// %APPDATA%\<dir> and ignores arbitrary --user-data-dir locations.
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DEFAULT_PROFILE = path.join(APPDATA, 'Claude');        // the main/default login
const BACKUP_PROFILE = path.join(APPDATA, 'Claude.switchly-bak');

function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

const LOG_PATH = path.join(DATA_DIR, 'switchly.log');
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

function sleep(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy wait, short */ } }

// Kill every Claude.exe and wait (up to ~8s) for the processes to clear so file
// locks on the profile folders are released.
function closeAllClaude() {
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
    sleep(200);
  }
  log('closeAllClaude: STILL RUNNING after 8s');
  return !claudeRunning();
}

// ---------------------------------------------------------------------------
// Profile swap  (the heart of quiet-login)
//   begin:  move default aside, move the target instance into the default slot,
//           launch stock Claude so the user signs in there.
//   finish: move the freshly-signed-in default back to the instance, restore the
//           real default.
// A swap.json marker lets us recover if Switchly is closed mid-login.
// ---------------------------------------------------------------------------
function readSwap() {
  try { return JSON.parse(fs.readFileSync(SWAP_STATE, 'utf8')); } catch { return null; }
}
function writeSwap(obj) { ensureDirs(); fs.writeFileSync(SWAP_STATE, JSON.stringify(obj, null, 2), 'utf8'); }
function clearSwap() { try { fs.rmSync(SWAP_STATE, { force: true }); } catch { /* ignore */ } }

function moveWithRetry(from, to) {
  if (!fs.existsSync(from)) return;
  let lastErr;
  for (let i = 0; i < 15; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { lastErr = e; sleep(200); }
  }
  throw lastErr || new Error(`Could not move ${from} -> ${to}`);
}

// Put profiles back no matter what state a half-finished swap left behind.
// Invariant: BACKUP_PROFILE existing means a swap is in effect — the default slot
// currently holds the instance's fresh-login data. With NO backup, nothing was
// displaced, so we must leave the real default alone and only clear the marker.
function restoreSwap(targetDir) {
  if (fs.existsSync(BACKUP_PROFILE)) {
    // A swap is live: the default slot holds the just-signed-in instance data.
    // Tuck it into the instance folder (if that slot is free) ...
    if (targetDir && fs.existsSync(DEFAULT_PROFILE) && !fs.existsSync(targetDir)) {
      try { moveWithRetry(DEFAULT_PROFILE, targetDir); } catch { /* ignore */ }
    }
    // ... then put the real default back.
    if (!fs.existsSync(DEFAULT_PROFILE)) {
      try { moveWithRetry(BACKUP_PROFILE, DEFAULT_PROFILE); } catch { /* ignore */ }
    }
  }
  clearSwap();
}

function recoverInterruptedSwap() {
  const s = readSwap();
  if (!s) return;
  // Switchly died mid-login — make the data folders whole again.
  closeAllClaude();
  restoreSwap(s.targetDir);
}

// First-time login, the way the community tools do it: close every Claude, open
// ONLY this instance (its own --user-data-dir), so the claude:// sign-in callback
// has exactly one window to land in. No folder swapping.
function quietLoginBegin(instance) {
  log('loginBegin: instance=' + instance.name + ' slug=' + instance.slug);
  if (!closeAllClaude()) {
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
function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 980, height: 660, minWidth: 720, minHeight: 480, show,
    backgroundColor: '#17181b', title: 'Switchly', icon: trayIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');
  // Closing the window just hides it to the tray; Quit lives in the tray menu.
  mainWindow.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWindow.hide(); } });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
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
            if (!r.ok) dialog.showErrorBox('Switchly', r.error || 'Could not launch.');
          } }
    ];
    if (!inst.isDefault) sub.push({ label: 'Log in / switch account…', click: () => openLoginFromTray(inst.id) });
    return { label: `${run ? '● ' : '○ '}${inst.name}${inst.account ? ' — ' + inst.account : ''}`, submenu: sub };
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: 'New instance…', click: () => { newInstance(); showWindow(); } },
    { label: 'Open Switchly', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings({ args: loginArgs() }).openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, args: loginArgs() }) },
    { label: 'Quit Switchly', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.setToolTip(`Switchly — ${running.size} running`);
}

// Unpackaged, Windows must start electron.exe *with this app's folder*.
function loginArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', showWindow);
  refreshTray();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-state', () => {
  const cfg = loadConfig();
  return {
    claudeFound: !!resolveClaudeExe(),
    swapInProgress: !!readSwap(),
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

ipcMain.handle('open-profile-folder', (_e, id) => {
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === id);
  if (!inst || inst.isDefault) return { ok: false };
  const dir = profileDirFor(inst);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// One Switchly at a time; starting it again just shows the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    recoverInterruptedSwap(); // heal a login that was interrupted last time
    createTray();
    // Lives in the tray; the window only opens when asked (not on autostart).
    createWindow({ show: !process.argv.includes('--hidden') });
  });
}
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay in the tray */ });
