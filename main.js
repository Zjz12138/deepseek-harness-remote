'use strict';

/**
 * DeepSeek Harness — desktop shell (Electron).
 *
 * Boots the `dsh web` server (or attaches to one already running on the port),
 * shows the web UI in a resizable high-DPI window, and adds:
 *   - font size (zoom):  Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+滚轮
 *   - font family:       View → 字体
 *   - wide layout:       View → 宽屏模式（行宽随窗口）
 *   - fullscreen:        F11
 *   - close choice:      关闭时可选“后台运行”（隐藏到托盘，dsh 服务继续跑，
 *                        下次打开秒开）或“彻底关闭”（退出并关掉 dsh 服务）
 *   - mobile access:      侧边栏“手机访问”按钮：扫码配对，手机 App 直接操作本机 dsh
 *                        手机在同一 WiFi 下访问本机 dsh（agent 仍在电脑上执行）
 * All preferences persist in ./config.json next to this file.
 */

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, Tray, nativeImage, clipboard } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const QRCode = require('qrcode');
const mobile = require('./mobile');
const tunnel = require('./tunnel');

const APP_DIR = __dirname;

// Diagnostic isolation: run with --user-data-dir <dir> so a test instance uses
// its own single-instance lock and does not collide with a running app window.
{
  const idx = process.argv.indexOf('--user-data-dir');
  if (idx >= 0 && process.argv[idx + 1]) {
    app.setPath('userData', path.resolve(process.argv[idx + 1]));
  }
}

// Packaged builds live under Program Files (read-only), so writable state
// (config / log / dsh workspace) moves to the per-user data dir. Dev builds
// keep using the folder layout next to the app (e.g. D:\deepseekHarness).
const IS_PACKAGED = app.isPackaged;
const WRITABLE_DIR = IS_PACKAGED
  ? path.join(app.getPath('userData'), 'DeepSeekHarness')
  : APP_DIR;
const WORKSPACE_DIR = IS_PACKAGED
  ? path.join(WRITABLE_DIR, 'workspace')
  : path.resolve(APP_DIR, '..'); // e.g. D:\deepseekHarness
const CONFIG_PATH = path.join(WRITABLE_DIR, 'config.json');
const SERVER_LOG_PATH = path.join(WRITABLE_DIR, 'server.log');
const ICON_PATH = path.join(APP_DIR, 'icon.ico');
const LOADING_PATH = path.join(APP_DIR, 'loading.html');
const PRELOAD_PATH = path.join(APP_DIR, 'preload.js');

const WEB_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
const PORT = Number(new URL(WEB_URL).port) || 3080;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;

const DUMP_DOM = process.argv.includes('--dump-dom');
const SMOKE_TEST = process.argv.includes('--smoke-test');
const SCREENSHOT = process.argv.includes('--screenshot');

let config = loadConfig();
let mainWindow = null;
let serverChild = null; // set only when *we* spawned the server
let weStartedServer = false;
let isQuitting = false; // true once a real quit is underway (bypasses close dialog)
let tray = null;
let mobilePanel = null; // 手机访问控制面板窗口
let tunnelRestarts = 0; // 隧道意外退出后的连续重启次数（防止死循环）

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function loadConfig() {
  const defaults = {
    zoom: 1,
    fontFamily: '',
    wideMode: true,
    window: null,
    onboarded: false,
    mobile: { enabled: false, port: 3081, mode: 'pair', password: '', devices: [], tunnelOn: false },
  };
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaults, ...saved, mobile: { ...defaults.mobile, ...(saved.mobile || {}) } };
  } catch {
    return defaults;
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(WRITABLE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('saveConfig failed:', err.message);
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(WRITABLE_DIR, { recursive: true });
    fs.appendFileSync(SERVER_LOG_PATH, line);
  } catch {}
  console.log(line.trimEnd());
}

// ---------------------------------------------------------------------------
// server: probe / spawn / wait / kill
// ---------------------------------------------------------------------------

function isPortUp(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(WEB_URL, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isPortUp(250)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Find how to launch `dsh web`:
 *  0. the copy of @deepseek-ai/dsh bundled inside this app's node_modules
 *     (packaged builds; runs with Electron's own Node via ELECTRON_RUN_AS_NODE)
 *  1. the newest copy of @deepseek-ai/dsh inside the npm npx cache
 *     (C:\Users\<you>\AppData\Local\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh)
 *  2. fall back to `npx --yes @deepseek-ai/dsh web`
 * Returns { kind: 'bundled', bin } | { kind: 'node', bin } | { kind: 'npx' } | null
 */
function resolveDshCommand() {
  const bundled = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(bundled)) return { kind: 'bundled', bin: bundled };
  try {
    const npmCache = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
      : path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
    if (fs.existsSync(npmCache)) {
      const bins = fs
        .readdirSync(npmCache, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(npmCache, d.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (bins.length > 0) return { kind: 'node', bin: bins[0] };
    }
  } catch (err) {
    log('resolveDshCommand cache scan failed: ' + err.message);
  }
  return { kind: 'npx' };
}

function startServer() {
  const resolved = resolveDshCommand();
  if (resolved === null) return null;
  log('starting dsh web ... (via ' + resolved.kind + ')');
  try {
    if (resolved.kind === 'bundled') {
      // Use Electron's own Node runtime so end users don't need Node installed.
      // --expose-internals: required by dsh's HMR service (cordis-plugin-hmr).
      serverChild = spawn(process.execPath, ['--expose-internals', resolved.bin, 'web', '--port', String(PORT)], {
        cwd: WORKSPACE_DIR,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else if (resolved.kind === 'node') {
      serverChild = spawn('node', [resolved.bin, 'web', '--port', String(PORT)], {
        cwd: WORKSPACE_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      serverChild = spawn(
        'cmd.exe',
        ['/d', '/s', '/c', `npx --yes @deepseek-ai/dsh web --port ${PORT}`],
        { cwd: WORKSPACE_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
  } catch (err) {
    log('failed to spawn server: ' + err.message);
    return null;
  }
  weStartedServer = true;
  serverChild.stdout.on('data', (d) => log('server: ' + String(d).trimEnd()));
  serverChild.stderr.on('data', (d) => log('server err: ' + String(d).trimEnd()));
  serverChild.on('exit', (code, signal) => {
    log(`server exited (code=${code} signal=${signal})`);
    serverChild = null;
  });
  return serverChild;
}

function killServerTree() {
  if (serverChild && serverChild.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(serverChild.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      try {
        serverChild.kill();
      } catch {}
    }
    serverChild = null;
  }
}

// ---------------------------------------------------------------------------
// close choice: background (tray) vs full quit
// ---------------------------------------------------------------------------

/** Real quit: skip the close dialog and tear everything down. */
function quitApp() {
  isQuitting = true;
  app.quit();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(ICON_PATH);
    tray = new Tray(icon.isEmpty() ? undefined : icon);
    tray.setToolTip('DeepSeek Harness');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: showMainWindow },
        { type: 'separator' },
        { label: '后台运行（隐藏到托盘）', click: () => mainWindow && mainWindow.hide() },
        { type: 'separator' },
        { label: '彻底退出（同时关闭 dsh 服务）', click: quitApp },
      ])
    );
    tray.on('double-click', showMainWindow);
  } catch (err) {
    log('tray creation failed: ' + err.message);
  }
}

/** Close (X / Alt+F4 / Ctrl+Q 之外的退出入口) → 让用户选择关闭方式。 */
async function askCloseChoice() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let response = 2;
  try {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '关闭 DeepSeek Harness',
      message: '关闭后 dsh 服务如何处理？',
      detail:
        '后台运行：窗口隐藏到托盘，dsh web 服务继续运行，' +
        '下次从桌面快捷方式打开是秒开（会话、端口都保留）。\n\n' +
        '彻底关闭：退出应用；若服务由本应用启动，会一并关闭。',
      buttons: ['后台运行', '彻底关闭', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    response = res.response;
  } catch {}
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (response === 0) {
    log('close: 后台运行（隐藏到托盘，服务继续运行）');
    mainWindow.hide();
    if (tray) tray.setToolTip('DeepSeek Harness（后台运行中）');
  } else if (response === 1) {
    quitApp();
  }
}

// ---------------------------------------------------------------------------
// mobile access (局域网手机访问 + 远程隧道)
// ---------------------------------------------------------------------------

async function startMobileAccess() {
  config.mobile = config.mobile || { enabled: false, port: 3081, mode: 'pair', password: '', devices: [], tunnelOn: false };
  // 密码模式已废弃：历史配置里的 mode/password 一律重置为扫码配对
  config.mobile.mode = 'pair';
  if (config.mobile.password) {
    config.mobile.password = '';
    saveConfig();
  }
  try {
    await mobile.start({
      targetUrl: WEB_URL,
      port: config.mobile.port,
      mode: 'pair',
      password: '',
      devices: config.mobile.devices,
      saveConfig,
      log,
      pairConfirmHandler: pairConfirm,
      tunnelStatus: () => (tunnel.isRunning() && tunnel.getUrl() ? { url: tunnel.getUrl(), ready: tunnel.isReady() } : null),
      onTunnelTraffic: () => {
        // 手机经隧道地址真实连上本机 → 这是最可靠的“隧道可用”证据
        if (tunnel.isRunning() && !tunnel.isReady()) tunnel.markVerified();
      },
    });
    config.mobile.enabled = true;
    saveConfig();
    // 启动即生成配对二维码：重启/重新打开后二维码立即可用（无需先关再开）
    mobile.createPendingPair();
    if (config.mobile.tunnelOn && tunnel.isAvailable()) {
      tunnel
        .start(mobile.getPort())
        .then((r) => {
          tunnelRestarts = 0;
          log(`tunnel ready url=${r && r.url} verified=${r && r.ready}`);
        })
        .catch((err) => log('tunnel auto-start failed: ' + err.message));
    }
    return true;
  } catch (err) {
    log('mobile start failed: ' + err.message);
    config.mobile.enabled = false;
    saveConfig();
    return false;
  }
}

function stopMobileAccess() {
  tunnel.stop();
  mobile.stop();
  config.mobile.enabled = false;
  saveConfig();
}

/** 手机配对确认：弹出电脑端确认框。返回 'active' | 'view' | 'reject'。 */
async function pairConfirm(deviceName, code) {
  if (!mainWindow || mainWindow.isDestroyed()) return 'reject';
  if (!mainWindow.isVisible()) showMainWindow();
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '手机配对请求',
      message: `“${deviceName}” 请求连接到本机`,
      detail:
        `配对码：${code}\n\n` +
        '允许后，该设备可在手机端查看/操作电脑上的 DeepSeek Harness（agent 仍在电脑上执行）。\n' +
        '同一时间只有一个控制设备；“设为当前设备”会停用现有的控制设备。',
      buttons: ['允许并设为当前设备', '仅允许查看', '拒绝'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) return 'active';
    if (response === 1) return 'view';
    return 'reject';
  } catch {
    return 'reject';
  }
}

function openMobilePanel() {
  if (mobilePanel && !mobilePanel.isDestroyed()) {
    mobilePanel.focus();
    return;
  }
  mobilePanel = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 360,
    minHeight: 520,
    parent: mainWindow || undefined,
    frame: false,
    show: false,
    backgroundColor: '#0f1115',
    title: '手机访问',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(APP_DIR, 'mobile-panel-preload.js'),
    },
  });
  mobilePanel.loadFile(path.join(APP_DIR, 'mobile-panel.html'));
  mobilePanel.once('ready-to-show', () => mobilePanel.show());
  mobilePanel.on('closed', () => {
    mobilePanel = null;
  });
}

/** 生成配对/隧道二维码（data URL）。 */
async function qrDataUrl(text) {
  try {
    return await QRCode.toDataURL(text, {
      margin: 1,
      width: 460,
      color: { dark: '#111418', light: '#ffffff' },
    });
  } catch {
    return '';
  }
}

/**
 * 配对二维码列表：每个可用地址（局域网 IP + 远程隧道）一个 dsh:// 深链二维码。
 * 手机 App 扫码 → 自动设置电脑地址并提交配对码 → 电脑端确认 → 完成，无需任何输入。
 */
async function pairQrEntries(code) {
  const make = async (url, label) => ({
    label,
    url,
    qr: await qrDataUrl(`dsh://pair?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`),
  });
  const entries = [];
  const seen = new Set();
  for (const u of mobile.urls()) {
    if (seen.has(u)) continue;
    seen.add(u);
    entries.push(await make(u, u));
  }
  const turl = tunnel.isRunning() && tunnel.getUrl();
  if (turl) {
    entries.push(await make(turl, '远程 · ' + turl));
  }
  if (entries.length === 0) {
    const u = `http://127.0.0.1:${config.mobile.port}`;
    entries.push(await make(u, u));
  }
  return entries;
}

/** 手机访问面板的 IPC（启动时注册一次）。 */
function registerMobileIpc() {
  // 隧道守护：cloudflared 意外退出（崩溃/网络断开）→ 自动重启并刷新面板二维码
  tunnel.setOnExit((code) => {
    log(`tunnel exited unexpectedly (code=${code}); auto-restarting`);
    if (isQuitting || !config.mobile || !config.mobile.tunnelOn || !mobile.isRunning()) return;
    tunnelRestarts += 1;
    if (tunnelRestarts > 6) {
      log('tunnel restart limit reached (6), giving up');
      return;
    }
    setTimeout(() => {
      if (isQuitting || !config.mobile.tunnelOn || !mobile.isRunning()) return;
      tunnel
        .start(mobile.getPort())
        .then((r) => {
          tunnelRestarts = 0;
          log(`tunnel restarted url=${r && r.url} verified=${r && r.ready}`);
          try {
            if (mobilePanel && !mobilePanel.isDestroyed()) mobilePanel.webContents.send('tunnel-updated', r && r.url);
          } catch {}
        })
        .catch((err) => log('tunnel restart failed: ' + err.message));
    }, 5000);
  });

  ipcMain.handle('mobile:get', async () => {
    // 配对码过期（10 分钟）后自动换一个新的，避免面板一直显示过期二维码
    const cur = mobile.getState();
    if (cur.pairPending && cur.pairPending.expiresAt < Date.now()) {
      mobile.createPendingPair();
    }
    const state = mobile.getState();
    state.urls = mobile.urls();
    state.tunnel = {
      available: tunnel.isAvailable(),
      running: tunnel.isRunning(),
      ready: tunnel.isReady(),
      verifyFailed: tunnel.isVerifyFailed(),
      url: tunnel.getUrl(),
    };
    state.pairQrs = state.pairPending ? await pairQrEntries(state.pairPending.code) : [];
    return state;
  });

  ipcMain.handle('mobile:set-enabled', async (_e, enabled) => {
    if (enabled) {
      const ok = await startMobileAccess();
      if (!ok) throw new Error(`手机访问启动失败（端口 ${config.mobile.port} 可能被占用），请查看 server.log`);
      bestEffortFirewallRule();
    } else {
      stopMobileAccess();
    }
    return mobile.getState();
  });

  ipcMain.handle('mobile:pair-start', async () => {
    if (!mobile.isRunning()) throw new Error('请先启用手机访问');
    const p = mobile.createPendingPair();
    const qrs = await pairQrEntries(p.code);
    return { code: p.code, expiresAt: p.expiresAt, urls: qrs.map((e) => e.url), qrs };
  });

  ipcMain.handle('mobile:pair-cancel', () => {
    mobile.cancelPendingPair();
  });

  ipcMain.handle('mobile:set-mode', async (_e, _mode) => {
    // 密码模式已废弃：一律为扫码配对（历史 setMode 调用不再生效）
    config.mobile.mode = 'pair';
    saveConfig();
    return mobile.getState();
  });

  ipcMain.handle('mobile:regenerate', async () => {
    config.mobile.password = mobile.generatePassword();
    saveConfig();
    if (mobile.isRunning()) {
      mobile.stop();
      await startMobileAccess();
    }
    return mobile.getState();
  });

  ipcMain.handle('mobile:set-port', async (_e, p) => {
    const port = Number(p);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需在 1024-65535 之间');
    const wasRunning = mobile.isRunning();
    if (wasRunning) mobile.stop();
    config.mobile.port = port;
    saveConfig();
    if (wasRunning) {
      const ok = await startMobileAccess();
      if (!ok) throw new Error(`端口 ${port} 无法监听，请查看 server.log`);
    }
    return mobile.getState();
  });

  ipcMain.handle('mobile:set-active-device', (_e, id) => {
    const ok = mobile.setActiveDevice(String(id));
    return { ok };
  });

  ipcMain.handle('mobile:remove-device', (_e, id) => {
    mobile.removeDevice(String(id));
    return { ok: true };
  });

  ipcMain.handle('mobile:tunnel-set', async (_e, on) => {
    if (on) {
      if (!tunnel.isAvailable()) throw new Error('缺少 vendor/cloudflared.exe（远程隧道组件）');
      if (!mobile.isRunning()) throw new Error('请先启用手机访问');
      const r = await tunnel.start(mobile.getPort());
      config.mobile.tunnelOn = true;
      saveConfig();
      return { url: r && r.url, ready: !!(r && r.ready), verifyFailed: !!(r && r.verifyFailed) };
    }
    tunnel.stop();
    config.mobile.tunnelOn = false;
    saveConfig();
    return { url: null };
  });

  ipcMain.handle('mobile:tunnel-status', () => ({
    available: tunnel.isAvailable(),
    running: tunnel.isRunning(),
    ready: tunnel.isReady(),
    verifyFailed: tunnel.isVerifyFailed(),
    url: tunnel.getUrl(),
  }));

  ipcMain.handle('mobile:open-url', (_e, url) => {
    shell.openExternal(String(url));
  });

  ipcMain.handle('mobile:copy', (_e, text) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle('mobile:firewall', async () => {
    try {
      await bestEffortFirewallRule(true);
      return { ok: true, message: '已添加防火墙规则（专用网络入站放行）' };
    } catch (err) {
      return {
        ok: false,
        message: '自动添加失败（' + (err.message || '') + '）。请手动允许：Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙，勾选“专用网络”。',
      };
    }
  });

  ipcMain.handle('mobile:close-panel', () => {
    if (mobilePanel && !mobilePanel.isDestroyed()) mobilePanel.close();
  });

  // 侧边栏“手机访问”按钮（preload.js 注入）→ 打开控制面板
  ipcMain.on('open-mobile-panel', () => {
    openMobilePanel();
  });
}

/** 尽力而为地添加 Windows 防火墙入站规则（需要管理员权限时静默失败）。 */
function bestEffortFirewallRule(throwOnError = false) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    const exe = process.execPath;
    execFile(
      'netsh',
      [
        'advfirewall',
        'firewall',
        'add',
        'rule',
        'name=DeepSeek Harness Mobile Access',
        'dir=in',
        'action=allow',
        'program=' + exe,
        'enable=yes',
        'profile=private',
      ],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          if (throwOnError) reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
          else {
            log('firewall rule add skipped: ' + String(stderr || err.message).trim().split('\n')[0]);
            resolve(false);
          }
        } else {
          log('firewall rule added for ' + exe);
          resolve(true);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// overrides: wide layout + font family (injected CSS)
// ---------------------------------------------------------------------------

let injectedKeys = [];

async function applyOverrides() {
  const wc = mainWindow ? mainWindow.webContents : null;
  if (!wc || wc.isDestroyed()) return;
  for (const key of injectedKeys) {
    try {
      wc.removeInsertedCSS(key);
    } catch {}
  }
  injectedKeys = [];
  try {
    injectedKeys.push(await wc.insertCSS(wideCss()));
  } catch {}
  try {
    injectedKeys.push(await wc.insertCSS(fontCss()));
  } catch {}
  try {
    injectedKeys.push(await wc.insertCSS(TITLEBAR_CSS));
  } catch {}
}

function wideCss() {
  if (!config.wideMode) return '';
  return `/* dsh-desktop: wide layout */
${WIDE_CSS_BODY}`;
}

function fontCss() {
  const f = (config.fontFamily || '').trim();
  if (!f) return '';
  return `/* dsh-desktop: font family override */
:root {
  --dsw-font-family: '${f}', 'Segoe UI', 'Microsoft YaHei', sans-serif !important;
  --ds-font-family-code: '${f}', Consolas, 'Microsoft YaHei', monospace !important;
}`;
}

// The GUI caps the conversation column with --dsh-chat-content-width (748px,
// declared on .wSkVaW_root). Wide mode overrides that variable on every
// element so the column follows the window (capped at 1600px for readability
// on ultra-wide screens).
const WIDE_CSS_BODY = `* {
  --dsh-chat-content-width: min(100vw - 48px, 1600px) !important;
  --dsh-composer-card-max-width: calc(min(100vw - 48px, 1600px) + 32px) !important;
}`;

// Custom title bar (injected by preload.js as #dsh-titlebar) + layout shift so
// the GUI content starts below it. The window is frameless (frame: false).
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_CSS = `/* dsh-desktop: custom title bar */
#dsh-titlebar {
  position: fixed; top: 0; left: 0; right: 0;
  height: ${TITLEBAR_HEIGHT}px;
  z-index: 2147483647;
  display: flex; align-items: center;
  background: #111418;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  -webkit-app-region: drag;
  user-select: none;
  -webkit-user-select: none;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
#dsh-titlebar .dsh-tb-title {
  color: #9aa0a6; font-size: 12px; font-weight: 600;
  padding: 0 14px; letter-spacing: 0.4px; white-space: nowrap;
}
#dsh-titlebar .dsh-tb-menus { display: flex; align-items: center; }
#dsh-titlebar .dsh-tb-menu {
  -webkit-app-region: no-drag;
  appearance: none; border: none; background: transparent; color: #c9cdd3;
  font-size: 13px; padding: 5px 12px; border-radius: 6px;
  cursor: pointer; line-height: 1; font-family: inherit;
}
#dsh-titlebar .dsh-tb-menu:hover { background: rgba(255, 255, 255, 0.09); color: #ffffff; }
#dsh-titlebar .dsh-tb-spacer { flex: 1; }
#dsh-titlebar .dsh-tb-wins { display: flex; align-items: center; }
#dsh-titlebar .dsh-tb-win {
  -webkit-app-region: no-drag;
  width: 46px; height: ${TITLEBAR_HEIGHT}px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: #c9cdd3;
  font-size: 11px; cursor: pointer; font-family: inherit; line-height: 1;
}
#dsh-titlebar .dsh-tb-win:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
#dsh-titlebar .dsh-tb-win.dsh-tb-close:hover { background: #e5484d; color: #ffffff; }
#dsh-titlebar .dsh-tb-glyph { font-style: normal; }
/* push the GUI content below the title bar */
html { height: 100% !important; }
body {
  padding-top: ${TITLEBAR_HEIGHT}px !important;
  box-sizing: border-box !important;
  height: 100% !important;
  margin: 0 !important;
}`;

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function applyZoom() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(config.zoom);
  }
}

function setZoom(value) {
  config.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))));
  saveConfig();
  applyZoom();
}

function zoomBy(delta) {
  setZoom((config.zoom || 1) + delta);
}

function sendWinState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('win-state', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    });
  }
}

function setWideMode(enabled) {
  config.wideMode = !!enabled;
  saveConfig();
  applyOverrides();
}

function setFontFamily(family) {
  config.fontFamily = family || '';
  saveConfig();
  applyOverrides();
  buildMenu();
}

function setLoadingState(state, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => {
        const el = document.getElementById('app-status');
        if (el) el.textContent = ${JSON.stringify(message || '')};
        document.body.dataset.state = ${JSON.stringify(state)};
      })()`
    )
    .catch(() => {});
}

function createWindow() {
  const winState = config.window || {};
  mainWindow = new BrowserWindow({
    width: winState.width || 1280,
    height: winState.height || 860,
    x: winState.x,
    y: winState.y,
    minWidth: 640,
    minHeight: 480,
    show: false,
    frame: false, // custom title bar with menu + window controls (preload.js)
    backgroundColor: '#0f1115',
    title: 'DeepSeek Harness',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: PRELOAD_PATH,
    },
  });

  // 立即显示窗口"框"：不等 ready-to-show（首次绘制完成）。冷启动时渲染
  // 进程/GPU 初始化可能耗时数秒，若等首次绘制，窗口会迟迟不出现。这里先
  // 恢复最大化、立即 show（backgroundColor 与 loading.html 背景一致，显示
  // 纯色框不会白屏闪烁），骨架屏内容随后异步渲染出来。
  if (winState.maximized) mainWindow.maximize();
  mainWindow.show();
  mainWindow.loadFile(LOADING_PATH);
  mainWindow.once('ready-to-show', () => {
    sendWinState();
  });

  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      config.window = { ...config.window, ...mainWindow.getBounds() };
      saveConfig();
    }
  });
  mainWindow.on('move', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      config.window = { ...config.window, ...mainWindow.getBounds() };
      saveConfig();
    }
  });
  mainWindow.on('maximize', () => {
    config.window = { ...(config.window || {}), maximized: true };
    saveConfig();
    sendWinState();
  });
  mainWindow.on('unmaximize', () => {
    config.window = { ...(config.window || {}), maximized: false };
    saveConfig();
    sendWinState();
  });
  mainWindow.on('enter-full-screen', sendWinState);
  mainWindow.on('leave-full-screen', sendWinState);

  // Ctrl+= / Ctrl+- / Ctrl+0 / F11 / Ctrl+Q — reliable even with no menu bar.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return;
    }
    if (input.control && String(input.key).toLowerCase() === 'q') {
      event.preventDefault();
      quitApp();
      return;
    }
    if (!input.control && !input.meta) return;
    const key = String(input.key).toLowerCase();
    if (key === '=' || key === '+') {
      event.preventDefault();
      zoomBy(+ZOOM_STEP);
    } else if (key === '-') {
      event.preventDefault();
      zoomBy(-ZOOM_STEP);
    } else if (key === '0') {
      event.preventDefault();
      setZoom(1);
    }
  });

  // Ctrl+wheel zoom (sent from preload.js) — one step per ~60px of wheel.
  ipcMain.on('ui-zoom', (_event, dir) => {
    zoomBy(dir > 0 ? +ZOOM_STEP : -ZOOM_STEP);
  });

  // Custom title bar: popup a native menu under the clicked menu button.
  ipcMain.on('menu-popup', (_event, { menu, x, y }) => {
    popupMenu(menu, x, y);
  });

  // Custom title bar: window controls.
  ipcMain.on('win-control', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (action === 'min') mainWindow.minimize();
    else if (action === 'max') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') mainWindow.close();
  });

  // 会话三点菜单“打开会话目录”（preload.js 收到页面事件后转发）：
  // 用系统资源管理器打开该会话的工作目录。
  ipcMain.on('open-session-dir', (_event, path) => {
    if (typeof path !== 'string' || !path.trim()) return;
    shell.openPath(path.trim()).catch(() => {});
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 右键菜单：输入框内提供 撤销/剪切/复制/粘贴/全选，选中文本处提供 复制/全选。
  // （应用菜单是自定义的、没有编辑项，若不注册这里，右键就不会出现复制粘贴菜单。）
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const tpl = [];
    if (params.isEditable) {
      // 可编辑区域（输入框/文本域）始终弹菜单：即使没有选中文本/没有可粘贴内容，
      // 也显示全部编辑项（用 enabled 控制可用性），避免空输入框右键毫无反应。
      const add = (label, role, ok) => { tpl.push({ label, role, enabled: !!ok }); };
      add('撤销', 'undo', params.editFlags.canUndo);
      add('重做', 'redo', params.editFlags.canRedo);
      tpl.push({ type: 'separator' });
      add('剪切', 'cut', params.editFlags.canCut);
      add('复制', 'copy', params.editFlags.canCopy);
      add('粘贴', 'paste', params.editFlags.canPaste);
      tpl.push({ type: 'separator' });
      add('全选', 'selectAll', params.editFlags.canSelectAll);
    } else if (params.selectionText && params.selectionText.trim()) {
      tpl.push({ label: '复制', role: 'copy' });
      tpl.push({ label: '全选', role: 'selectAll' });
    }
    if (!tpl.length) return;
    Menu.buildFromTemplate(tpl).popup({ window: mainWindow });
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(WEB_URL);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.origin !== target.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    applyZoom();
    applyOverrides();
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    setLoadingState('error', `页面加载失败（${code} ${desc}）`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Close (X / Alt+F4) → ask 后台运行 / 彻底关闭 / 取消. Real quits set
  // isQuitting so this handler lets the close through.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    askCloseChoice();
  });
}

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

const FONTS = [
  ['默认（跟随系统）', ''],
  ['微软雅黑', 'Microsoft YaHei'],
  ['等线', 'DengXian'],
  ['思源黑体', 'Source Han Sans SC'],
  ['宋体', 'SimSun'],
  ['黑体', 'SimHei'],
  ['楷体', 'KaiTi'],
  ['仿宋', 'FangSong'],
  ['等宽 Consolas', 'Consolas'],
  ['Georgia', 'Georgia'],
  ['Times New Roman', 'Times New Roman'],
];

/** Menu templates shared by the (invisible) application menu and the popups
 * opened from the custom title bar buttons. */
function menuTemplates() {
  const fileMenu = [
    { label: '在系统浏览器中打开', click: () => shell.openExternal(WEB_URL) },
    { type: 'separator' },
    { label: '后台运行（隐藏到托盘）', click: () => mainWindow && mainWindow.hide() },
    { type: 'separator' },
    { label: '退出', accelerator: 'Ctrl+Q', click: quitApp },
  ];
  const viewMenu = [
    { label: '放大字号', accelerator: 'CommandOrControl+=', click: () => zoomBy(+ZOOM_STEP) },
    { label: '缩小字号', accelerator: 'CommandOrControl+-', click: () => zoomBy(-ZOOM_STEP) },
    { label: '重置字号（100%）', accelerator: 'CommandOrControl+0', click: () => setZoom(1) },
    { type: 'separator' },
    {
      label: '宽屏模式（行宽随窗口）',
      type: 'checkbox',
      checked: !!config.wideMode,
      click: (item) => setWideMode(item.checked),
    },
    { type: 'separator' },
    {
      label: '字体',
      submenu: FONTS.map(([label, value]) => ({
        label,
        type: 'radio',
        checked: (config.fontFamily || '') === value,
        click: () => setFontFamily(value),
      })),
    },
    { type: 'separator' },
    { label: '全屏', accelerator: 'F11', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
    { label: '重新加载', role: 'reload' },
    { label: '开发者工具', role: 'toggleDevTools' },
  ];
  const helpMenu = [
    { label: '快捷键与使用说明', click: () => showHelp() },
    { label: '优化启动速度（Windows Defender 排除，需管理员）', click: () => optimizeStartupSpeed() },
    { type: 'separator' },
    { label: '关于 DeepSeek Harness 桌面版', click: () => showAbout() },
  ];
  return { fileMenu, viewMenu, helpMenu };
}

/** Set the application menu (keeps accelerators working; bar is not drawn
 * because the window is frameless). */
function buildMenu() {
  const { fileMenu, viewMenu, helpMenu } = menuTemplates();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: '文件', submenu: fileMenu },
      { label: '视图', submenu: viewMenu },
      { label: '帮助', submenu: helpMenu },
    ])
  );
}

/** Popup a native menu under a title-bar button (renderer coords -> screen). */
function popupMenu(menuName, rendererX, rendererY) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { fileMenu, viewMenu, helpMenu } = menuTemplates();
  const map = { file: fileMenu, view: viewMenu, help: helpMenu };
  const template = map[menuName];
  if (!template) return;
  const zoom = mainWindow.webContents.getZoomFactor() || 1;
  const [wx, wy] = mainWindow.getPosition();
  Menu.buildFromTemplate(template).popup({
    window: mainWindow,
    x: Math.round(wx + rendererX * zoom),
    y: Math.round(wy + rendererY * zoom),
  });
}

/** 优化启动速度：把应用目录与数据目录加入 Windows Defender 排除列表
 * （需要管理员，会弹 UAC；用户拒绝则静默失败，不影响使用）。
 * 冷启动慢的一大原因是 Defender 实时扫描应用内的上万个小文件
 * （dsh 的 node_modules），排除后每次启动会明显变快。 */
function optimizeStartupSpeed() {
  const esc = (s) => String(s).replace(/'/g, "''");
  const script =
    `Add-MpPreference -ExclusionPath '${esc(APP_DIR)}' -ErrorAction SilentlyContinue; ` +
    `Add-MpPreference -ExclusionPath '${esc(WRITABLE_DIR)}' -ErrorAction SilentlyContinue`;
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-WindowStyle','Hidden','-EncodedCommand','${b64}' -Wait`,
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  ps.on('exit', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '优化启动速度',
      message: '已请求添加 Windows Defender 排除。',
      detail:
        `排除目录：\n${APP_DIR}\n${WRITABLE_DIR}\n\n` +
        '如果刚才弹出了“用户账户控制”确认框并点了“是”，排除已生效，下次启动会明显变快。\n' +
        '若没有生效（拒绝了管理员确认或系统策略限制），也不影响使用，只是启动稍慢。',
    });
  });
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于',
    message: 'DeepSeek Harness 桌面版',
    detail:
      `版本：${app.getVersion()}\n` +
      `界面：${WEB_URL}\n` +
      `工作目录：${WORKSPACE_DIR}\n` +
      `配置文件：${CONFIG_PATH}\n\n` +
      '· Ctrl + 滚轮 / Ctrl+= / Ctrl+- / Ctrl+0：调整字号\n' +
      '· 视图 → 字体：切换字体\n' +
      '· 视图 → 宽屏模式：行宽随窗口拉伸\n' +
      '· F11：全屏\n' +
      '· 关闭时可选“后台运行”（托盘）或“彻底关闭”',
  });
}

function showHelp() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '快捷键与使用说明',
    message: '使用说明',
    detail:
      '· 启动：双击桌面快捷方式即可，无需命令行。\n' +
      '· 服务：应用会自动启动 dsh web（端口 3080）；\n' +
      '   若该端口已有 dsh 服务在运行，则直接复用，\n' +
      '   关闭窗口时不会关掉你已启动的服务。\n' +
      '· 关闭：点右上角 ✕ 可选择“后台运行”（隐藏到托盘，\n' +
      '   服务继续跑，下次秒开）或“彻底关闭”（同时关服务）。\n' +
      '· 手机：侧边栏“手机访问”按钮，\n' +
      '   手机 App 扫码配对（需电脑端确认，agent 仍在电脑上执行）。\n' +
      '· 字号：Ctrl + 滚轮，或 Ctrl + 加号 / Ctrl + 减号 / Ctrl + 0。\n' +
      '· 字体：标题栏 视图 → 字体。\n' +
      '· 宽屏：标题栏 视图 → “宽屏模式（行宽随窗口）”。\n' +
      '· 全屏：F11。\n' +
      '· 设置保存在 config.json，日志在 server.log。\n',
  });
}

// ---------------------------------------------------------------------------
// 自研 client 插件注入（侧边栏"打开文件夹"）
// ---------------------------------------------------------------------------

/** 解析 dsh home（尊重 $DSH_HOME，默认 ~/.dsh）。 */
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh');
}

/**
 * 把自研插件（dsh-client-ui-open-dir）接入 dsh：
 * 1) 链接/拷贝到 $DSH_HOME/profiles/node_modules/，让 dsh 从 profile 解析到该包；
 * 2) 把插件 bundle 幂等地加进 web profile 的 dsh.profile.bundles。
 * 任意一步失败只记日志，不阻塞启动（attach 已运行实例时本次不生效，下次 dsh 重启生效）。
 */
function ensureOpenDirPluginInjected() {
  try {
    const home = resolveDshHome();
    const src = path.join(APP_DIR, 'node_modules', 'dsh-client-ui-open-dir');
    if (!fs.existsSync(path.join(src, 'package.json'))) {
      log('open-dir plugin not bundled (missing node_modules/dsh-client-ui-open-dir)');
      return;
    }
    const profilesNodeModules = path.join(home, 'profiles', 'node_modules');
    fs.mkdirSync(profilesNodeModules, { recursive: true });
    const link = path.join(profilesNodeModules, 'dsh-client-ui-open-dir');
    // 总是重建（junction 只删链接本身，不跟目标）：应用升级后自动指向新安装目录。
    fs.rmSync(link, { recursive: true, force: true });
    try {
      fs.symlinkSync(src, link, 'junction');
      log('open-dir plugin linked: ' + link);
    } catch {
      fs.cpSync(src, link, { recursive: true });
      log('open-dir plugin copied: ' + link);
    }
    const manifestPath = path.join(home, 'profiles', 'web', 'package.json');
    if (!fs.existsSync(manifestPath)) return;
    const raw = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
    const manifest = JSON.parse(raw);
    const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
    if (!bundles.includes('dsh-client-ui-open-dir')) {
      manifest.dsh = manifest.dsh || {};
      manifest.dsh.profile = manifest.dsh.profile || {};
      manifest.dsh.profile.bundles = [...bundles, 'dsh-client-ui-open-dir'];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      log('open-dir plugin bundle added to web profile');
    }
  } catch (err) {
    log('open-dir plugin inject failed (non-fatal): ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  const bootT0 = Date.now();

  // 1) 第一步就建窗口并立即显示"框"（骨架屏内容异步渲染），把磁盘初始化 /
  //    菜单 / 端口探测都放到窗口显示之后，让首帧出现时间最短。
  createWindow();
  log(`boot: window shown in ${Date.now() - bootT0}ms`);

  // 自研 client 插件注入（幂等）：在探测/启动 dsh 之前完成，spawn 场景本次生效。
  ensureOpenDirPluginInjected();

  try {
    fs.mkdirSync(WRITABLE_DIR, { recursive: true });
    if (IS_PACKAGED) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(SERVER_LOG_PATH, ''); // truncate log each launch
  } catch {}

  buildMenu();
  createTray();
  setLoadingState('loading', '正在检测 dsh 服务…');

  // 端口探测与窗口显示并行：先发起探测（不 await），窗口秒显示骨架屏，
  // 探测结果回来时窗口已经可见，省去串行等待。
  const probe = isPortUp(1500);

  // Fast path: if a dsh server is already up (e.g. left running in the
  // background from a previous session), we attach — near-instant boot.
  const up = await probe;
  log(`boot: port ${PORT} ${up ? 'up → attach' : 'down → spawn'} (${Date.now() - bootT0}ms)`);

  // Spawn the server while the loading page is showing; the window then
  // loads the GUI the moment the port responds.
  if (!up) {
    setLoadingState('loading', '正在启动 dsh 服务（首次冷启动可能需要 10~30 秒）…');
    startServer();
  } else {
    setLoadingState('loading', '正在连接 dsh 服务…');
  }

  if (!up) {
    if (!serverChild) {
      setLoadingState('error', '无法启动 dsh 服务，请确认已安装 @deepseek-ai/dsh（npx --yes @deepseek-ai/dsh web）');
      return;
    }
    const t0 = Date.now();
    // 等待期间每秒刷新加载页上的“已等待 N 秒”，避免看起来像卡死。
    const ticker = setInterval(() => {
      setLoadingState('loading', `正在启动 dsh 服务…（已等待 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
    }, 1000);
    const ok = await waitForServer(120000);
    clearInterval(ticker);
    log(`boot: dsh web ready in ${Date.now() - t0}ms`);
    if (!ok) {
      setLoadingState('error', 'dsh 服务启动超时，请查看 server.log');
      return;
    }
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;
  setLoadingState('loading', '正在加载界面…');
  const t1 = Date.now();
  await mainWindow.loadURL(WEB_URL);
  log(`boot: GUI loaded in ${Date.now() - t1}ms (total ${Date.now() - bootT0}ms)`);

  // 手机访问：默认关闭。只有在面板里手动点“启动”才会开启（彻底关闭后下次启动也不会自动恢复）。
  if (config.mobile && config.mobile.enabled) {
    // 历史版本遗留：enabled 残留 true 时也保持关闭，并回写配置（从零打开默认关闭）
    config.mobile.enabled = false;
    saveConfig();
  }

  if (!config.onboarded) {
    config.onboarded = true;
    saveConfig();
    setTimeout(() => showHelp(), 2500);
  }

  if (DUMP_DOM) await dumpDom();
  else if (SMOKE_TEST) await smokeTest();
  else if (SCREENSHOT) await screenshot();
}

/** Compare the widest capped element with wide mode on vs off, and verify the
 * custom title bar / layout. A watchdog guarantees the diagnostic always
 * exits. */
async function smokeTest() {
  const watchdog = setTimeout(() => {
    console.log('SMOKE_TIMEOUT (force exit)');
    isQuitting = true;
    app.exit(0);
  }, 60000);
  try {
    console.log('SMOKE: waiting for GUI boot');
    await new Promise((r) => setTimeout(r, 9000));
    console.log('SMOKE: measuring wide');
    const measure = async () => {
      const res = await mainWindow.webContents.executeJavaScript(`(() => {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--dsh-chat-content-width').trim();
        let best = null;
        document.querySelectorAll('*').forEach((e) => {
          const cs = getComputedStyle(e);
          if (cs.maxWidth !== 'none' && parseFloat(cs.maxWidth) > 700 && e.clientWidth > 200) {
            if (!best || e.clientWidth > best.clientW) {
              best = { cls: String(e.className).slice(0, 90), maxW: cs.maxWidth, clientW: e.clientWidth };
            }
          }
        });
        const tb = document.getElementById('dsh-titlebar');
        const sb = document.getElementById('dsh-sidebar-mobile');
        const nsAll = [...document.querySelectorAll('[aria-label="新建会话"]')];
        const realNs = nsAll.find((el) => !/brand/i.test(el.className || '')) || null;
        return {
          varValue: v,
          vw: window.innerWidth,
          vh: window.innerHeight,
          best,
          titlebar: tb ? {
            exists: true,
            height: tb.getBoundingClientRect().height,
            menus: tb.querySelectorAll('.dsh-tb-menu').length,
            wins: tb.querySelectorAll('.dsh-tb-win').length,
          } : { exists: false },
          sidebarBtn: sb ? {
            exists: true,
            height: sb.getBoundingClientRect().height,
            bg: getComputedStyle(sb).backgroundColor,
            sameStyle: realNs
              ? getComputedStyle(sb).backgroundColor === getComputedStyle(realNs).backgroundColor &&
                sb.getBoundingClientRect().height === realNs.getBoundingClientRect().height
              : false,
          } : { exists: false },
          bodyPadTop: getComputedStyle(document.body).paddingTop,
          overflowY: document.documentElement.scrollHeight > window.innerHeight,
          docH: document.documentElement.scrollHeight,
        };
      })()`);
      return res;
    };
    const wide = await measure();
    console.log('SMOKE: measuring narrow');
    config.wideMode = false;
    saveConfig();
    await applyOverrides();
    await new Promise((r) => setTimeout(r, 400));
    const narrow = await measure();
    config.wideMode = true;
    saveConfig();
    await applyOverrides();
    console.log('SMOKE_RESULT ' + JSON.stringify({ wide, narrow }));
  } catch (err) {
    console.error('SMOKE_ERROR ' + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(watchdog);
    quitApp();
  }
}

/** Capture the window to a PNG (verifies crisp high-DPI rendering). */
async function screenshot() {
  const watchdog = setTimeout(() => {
    isQuitting = true;
    app.exit(0);
  }, 60000);
  const idx = process.argv.indexOf('--screenshot');
  const file = (idx >= 0 && process.argv[idx + 1]) || path.join(APP_DIR, 'screenshot.png');
  await new Promise((r) => setTimeout(r, 10000));
  try {
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    console.log('SCREENSHOT_SAVED ' + file);
  } catch (err) {
    console.error('screenshot failed: ' + err.message);
  }
  clearTimeout(watchdog);
  quitApp();
}

async function dumpDom() {
  // Wait for the plugin-driven UI to finish booting, then capture layout info.
  const watchdog = setTimeout(() => {
    isQuitting = true;
    app.exit(0);
  }, 60000);
  await new Promise((r) => setTimeout(r, 9000));
  try {
    const info = await mainWindow.webContents.executeJavaScript(`(() => {
      const out = { url: location.href, title: document.title };
      const text = (el) => {
        if (!el) return '';
        return (typeof el.className === 'string' ? el.className : '').slice(0, 160);
      };
      const wide = [];
      document.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el);
        const mw = parseFloat(cs.maxWidth);
        if (isFinite(mw) && mw >= 300 && el.clientWidth > 0) {
          wide.push({ tag: el.tagName, cls: text(el), maxW: cs.maxWidth, clientW: el.clientWidth, parent: el.parentElement ? el.parentElement.tagName + '.' + text(el.parentElement) : '' });
        }
      });
      out.candidates = wide.slice(0, 80);
      out.bodyFont = getComputedStyle(document.body).fontFamily;
      out.roots = [];
      document.querySelectorAll('body > *').forEach((el) => out.roots.push({ tag: el.tagName, cls: text(el), w: el.clientWidth }));
      return out;
    })()`);
    fs.writeFileSync(path.join(APP_DIR, 'dump.json'), JSON.stringify(info, null, 2), 'utf8');
    console.log('DUMP_SAVED ' + path.join(APP_DIR, 'dump.json'));
  } catch (err) {
    console.error('dump failed: ' + err.message);
  }
  quitApp();
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('DeepSeek Harness');
  app.setAppUserModelId('DeepSeekHarness.Desktop');

  app.on('second-instance', () => {
    // Shortcut clicked again while the app is hidden in the tray → show it.
    showMainWindow();
  });

  app.whenReady().then(() => {
    registerMobileIpc();
    return boot();
  });

  app.on('window-all-closed', () => {
    quitApp();
  });

  app.on('before-quit', () => {
    // 彻底关闭：手机访问一并关掉，并把状态持久化为关闭（下次从 0 打开默认关闭）
    if (config.mobile) {
      config.mobile.enabled = false;
      config.mobile.mode = 'pair';
      saveConfig();
    }
    tunnel.stop();
    mobile.stop();
    if (weStartedServer) {
      killServerTree();
      weStartedServer = false;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
