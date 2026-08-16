'use strict';

/* DeepSeek Harness 手机端 — 独立 App（Capacitor 打包）。
 * 与电脑端同一份 dsh 服务通信（经电脑上的手机访问服务），
 * 手机发消息 → agent 在电脑上执行，会话数据完全共享。
 * 连接方式：扫电脑上的 dsh:// 配对二维码 → 自动设置地址并提交配对码 →
 * 电脑端确认 → 完成（无需任何手动输入）。
 */

const $ = (id) => document.getElementById(id);
const LS_TOKEN = 'dshm_token';
const LS_DEVICE = 'dshm_device';
const LS_BASE = 'dshm_base';
const LS_DEVICE_ID = 'dshm_device_id';
const LS_CACHE = 'dshm_cache'; // 会话消息缓存 {sessionId: {msgs, ts}}
const APP_VERSION = '0.0.1';

/** 持久设备标识：同一台手机重新配对时服务端据此识别为同一设备。 */
function deviceId() {
  let id = localStorage.getItem(LS_DEVICE_ID);
  if (!id) {
    id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LS_DEVICE_ID, id);
  }
  return id;
}

// 全局错误兜底：任何 JS 错误都显示在界面上，绝不出现"死页面"
window.addEventListener('error', (e) => {
  showFatalError('脚本错误：' + (e.message || 'unknown'));
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e && e.reason && e.reason.message ? e.reason.message : String((e && e.reason) || '');
  showFatalError('运行错误：' + msg);
});

function showFatalError(msg) {
  try {
    const el = document.getElementById('auth-status');
    if (el) {
      el.textContent = msg + '（版本 v' + APP_VERSION + '）';
      el.className = 'status err';
    }
    const sub = document.getElementById('auth-sub');
    if (sub && sub.textContent === '连接你的电脑') sub.textContent = '出现问题，请查看下方提示';
    reportError('脚本/运行错误', msg);
  } catch {}
}

let base = ''; // 电脑地址（扫码后自动写入）
let token = null;
let device = null;
let mode = 'pair';
let currentView = 'auth';
let pollTimer = null;
let currentSessionId = null;
let currentWsId = null; // 新建会话选中的工作区
let lastSessions = { items: [] };
let pairingInFlight = false;

// 会话操作状态（输入框内的快捷切换按钮）
let currentPerm = ''; // 当前权限模式 id（read-only / workspace-write / danger-full-access）
let currentPresetLabel = ''; // 当前会话的 Agent 预设显示名
let sessionRunning = false; // 当前会话是否在运行（控制停止按钮显隐）

// 会话消息状态（支持上翻增量加载）
let chatMsgs = []; // 当前会话已加载的消息（带 seq，最早在前）
let chatHasMore = false; // 是否还有更早历史可加载
let chatLoadingMore = false; // 正在加载更早历史
let cmdCache = {}; // 斜杠命令缓存 {sessionId: [{name,description,hint}]}
let cmdLoading = {}; // 正在加载命令的会话

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------------
// 错误弹窗：任何报错都弹窗 + 一键复制详情（方便反馈）
// ---------------------------------------------------------------------------

function reportError(title, detail) {
  try {
    const modal = $('err-modal');
    $('err-title').textContent = title || '出错了';
    $('err-detail').textContent =
      String(detail || '') +
      '\n\n版本：v' + APP_VERSION +
      '\n时间：' + new Date().toLocaleString() +
      '\n电脑地址：' + (base || '（未设置）');
    modal.style.display = 'flex';
  } catch {}
}

$('btn-err-close').addEventListener('click', () => {
  $('err-modal').style.display = 'none';
});

$('btn-err-copy').addEventListener('click', async () => {
  const text = $('err-detail').textContent;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {}
  if (!ok) {
    // 兜底：隐藏 textarea + execCommand('copy')
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {}
    document.body.removeChild(ta);
  }
  toast(ok ? '已复制，可直接粘贴给我' : '复制失败，请长按文本手动复制');
});

function saveToken(tok, dev) {
  token = tok;
  device = dev;
  localStorage.setItem(LS_TOKEN, tok);
  localStorage.setItem(LS_DEVICE, JSON.stringify(dev));
}

function clearToken() {
  token = null;
  device = null;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_DEVICE);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(base + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  } catch (e) {
    // 网络层失败（离线/隧道空闲断开/抖动）：自动重试一次，避免"连接上后一段时间不用就超时"。
    // 重试仍失败才报错。
    if (!opts._retried) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        res = await fetch(base + path, { ...opts, _retried: true, headers: { ...headers, ...(opts.headers || {}) } });
      } catch (e2) {
        throw new Error('无法连接电脑（' + (e2.message || e.message) + '）');
      }
    } else {
      throw new Error('无法连接电脑（' + e.message + '）');
    }
  }
  if (res.status === 401) {
    clearToken();
    showView('auth');
    const err = new Error('登录已失效，请重新配对');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data.error || ('HTTP ' + res.status));
    err.code = data.code;
    throw err;
  }
  return data;
}

function showView(name) {
  currentView = name;
  clearInterval(pollTimer);
  pollTimer = null;
  for (const v of ['auth', 'home', 'chat', 'new', 'settings']) {
    $(`view-${v}`).style.display = v === name ? 'flex' : 'none';
  }
  if (name === 'home') startPoll(homePoll, 5000);
  if (name === 'chat') startPoll(chatPoll, 3000);
}

function startPoll(fn, ms) {
  clearInterval(pollTimer);
  pollTimer = setInterval(fn, ms);
}

function fmtTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// 认证 / 配对
// ---------------------------------------------------------------------------

async function boot() {
  const storedBase = localStorage.getItem(LS_BASE);
  if (storedBase) base = storedBase;
  // PWA 同源场景：base 为空 → 直接用当前源
  try {
    await api('/auth/status');
  } catch (e) {
    // 同源 PWA 无需 base；连接失败等配对时再提示
    if (!base && !location.protocol.startsWith('http')) {
      showAuth('请先输入电脑的访问地址');
    }
  }
  token = localStorage.getItem(LS_TOKEN);
  if (token) {
    try {
      const me = await api('/auth/me');
      device = me.device;
      mode = me.mode;
      saveToken(token, device);
      showView('home');
      homePoll();
      return;
    } catch (e) {
      // 只有 401（token 被吊销）才清除并重新配对；
      // 网络错误/离线/隧道抖动时保留 token，给出"重试"而不是强制重新扫码。
      if (e && e.code === 'AUTH_EXPIRED') {
        clearToken();
      } else {
        showAuth('无法连接电脑（' + (e && e.message || e) + '），请检查网络后重试');
        $('btn-retry').style.display = 'block';
        return;
      }
    }
  }
  showAuth('');
}

async function showAuth(msg) {
  showView('auth');
  const ver = document.getElementById('app-version');
  if (ver) ver.textContent = 'v' + APP_VERSION;
  $('auth-status').textContent = msg || '';
  $('auth-status').className = 'status';
  $('btn-retry').style.display = 'none';
  try {
    const st = await api('/auth/status');
    mode = st.mode;
  } catch {}
  const hasCam = canUseCamera();
  // 完全没有相机能力时才需要手动输入电脑地址
  const needBase = !base && !hasCam;
  // 扫码是唯一主入口：只要处于配对模式就显示扫码按钮（不依赖相机探测结果），
  // 点开后若无相机能力会给出明确提示。
  const showPair = mode === 'pair';
  $('base-form').style.display = needBase ? 'block' : 'none';
  // 扫码按钮恒显（唯一主入口），密码模式（旧服务端残留）也显示，扫了会提示去电脑端切换
  $('btn-scan').style.display = 'block';
  $('scan-hint').style.display = 'block';
  $('btn-gallery').style.display = 'block';
  $('pair-form').style.display = 'none'; // 手动输入配对码已移除
  $('pw-form').style.display = 'none'; // 密码模式已废弃；旧服务端残留时给出提示
  $('auth-sub').textContent = showPair
    ? '扫电脑面板上的二维码即可连接'
    : '请在电脑上重新开启“手机访问”后再扫码';
}

// 手动输入折叠切换
// 配对码手动输入已移除（扫码是唯一入口）：此按钮不再使用
if ($('btn-manual')) $('btn-manual').style.display = 'none';

// 重新连接：token 仍在但网络错误时，一键重试（不清 token、不重新扫码）
$('btn-retry').addEventListener('click', () => {
  $('btn-retry').disabled = true;
  $('auth-status').textContent = '正在重新连接…';
  $('auth-status').className = 'status';
  boot()
    .catch((e) => {
      $('auth-status').textContent = '连接失败：' + (e && e.message || e);
      $('auth-status').className = 'status err';
      $('btn-retry').style.display = 'block';
    })
    .finally(() => { $('btn-retry').disabled = false; });
});

// 从相册选择二维码：截图/图片里的配对码也能扫（开发测试和真机都方便）
$('btn-gallery').addEventListener('click', () => {
  $('gallery-input').click();
});

$('gallery-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('正在识别图片…');
  try {
    let url = await decodeQrFromImage(file);
    if (url && handlePairLink(url)) return;
    // 首次失败：可能是选择器关闭瞬间页面过渡，稍候重试一次
    await new Promise((r) => setTimeout(r, 800));
    url = await decodeQrFromImage(file);
    if (url && handlePairLink(url)) return;
    toast('图片中未识别到二维码');
    $('auth-status').textContent = '未识别到二维码，请换一张清晰的图片';
    $('auth-status').className = 'status err';
  } catch (err) {
    toast('识别失败：' + (err && err.message || err));
  }
});

/** 用 jsQR 从图片文件解码二维码，返回内容或 null。 */
function decodeQrFromImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.onload = () => {
        try {
          resolve(tryDecode(img));
        } catch (err) { reject(err); }
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/** 多次尝试解码：原尺寸 → 放大 → 反色，提高小图/模糊图识别率。 */
function tryDecode(img) {
  const attempts = [];
  // 原尺寸
  attempts.push({ w: img.width, h: img.height, inv: 'dontInvert' });
  // 放大 2 倍（小图更容易识别）
  attempts.push({ w: img.width * 2, h: img.height * 2, inv: 'dontInvert' });
  // 反色尝试（黑白反相的二维码）
  attempts.push({ w: img.width, h: img.height, inv: 'attemptBoth' });
  const maxSide = 2000; // 上限，防止过大 canvas 卡顿
  for (const a of attempts) {
    const scale = Math.min(1, maxSide / Math.max(a.w, a.h));
    const w = Math.max(1, Math.round(a.w * scale));
    const h = Math.max(1, Math.round(a.h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const code = window.jsQR
      ? window.jsQR(data.data, data.width, data.height, { inversionAttempts: a.inv })
      : null;
    if (code) return code.data;
  }
  return null;
}

$('btn-base-save').addEventListener('click', () => {
  const v = $('base-input').value.trim();
  if (!/^https?:\/\/\S+$/i.test(v)) {
    $('auth-status').textContent = '地址格式不对，示例：http://192.168.1.5:3081';
    $('auth-status').className = 'status err';
    return;
  }
  try {
    setBase(v);
    showAuth('');
  } catch (e) {
    $('auth-status').textContent = '地址无效：' + e.message;
    $('auth-status').className = 'status err';
  }
});

function canUseCamera() {
  if (nativeScanner()) return true; // APK 原生扫码
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
}

function setBase(url) {
  const u = new URL(url);
  base = u.origin;
  localStorage.setItem(LS_BASE, base);
}

/** 自动设备名（扫码配对时无需手动输入）。 */
function autoDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone/iPad';
  if (/Android/.test(ua)) {
    const m = ua.match(/Android\s+[\d.]+/);
    return 'Android 手机' + (m ? '（' + m[0] + '）' : '');
  }
  return '我的手机';
}

/** 提交配对码并等待电脑端确认。 */
async function requestPair(code, name) {
  if (pairingInFlight) return;
  pairingInFlight = true;
  const btn = $('btn-pair');
  if (btn) btn.disabled = true;
  $('auth-status').textContent = '已请求连接，请在电脑上确认…';
  $('auth-status').className = 'status';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(base + '/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: name, deviceId: deviceId() }),
      signal: ctl.signal,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    saveToken(data.token, data.device);
    mode = data.mode;
    $('auth-status').textContent = '配对成功！';
    $('auth-status').className = 'status ok';
    showView('home');
    homePoll();
    return true;
  } catch (e) {
    const msg = e.name === 'AbortError' ? '电脑端未确认（超时），请重试' : e.message;
    $('auth-status').textContent = msg;
    $('auth-status').className = 'status err';
    if (e.name !== 'AbortError') {
      reportError('连接电脑失败', msg + '\n请求地址：' + base + '/auth/pair');
    }
    return false;
  } finally {
    clearTimeout(timer);
    pairingInFlight = false;
    if (btn) btn.disabled = false;
  }
}

/**
 * 处理 dsh:// 深链 / 扫码结果：dsh://pair?url=<encodeURIComponent(地址)>&code=<配对码>
 * 扫码 → 自动设置电脑地址 → 自动提交配对 → 电脑端确认 → 完成，全程零输入。
 */
function handlePairLink(text) {
  try {
    const u = new URL(text);
    if (u.protocol !== 'dsh:') return false;
    // 兼容两种 URL 解析：标准 scheme 解析（hostname='pair'）与
    // Chromium 对非标准 scheme 的解析（host 为空、pathname='//pair'）
    const host = u.hostname || u.host;
    const path = u.pathname;
    if (host !== 'pair' && path !== '//pair' && path !== '/pair') return false;
    const target = u.searchParams.get('url');
    const code = (u.searchParams.get('code') || '').trim().toUpperCase();
    if (!target || !/^https?:\/\//i.test(target)) throw new Error('二维码缺少电脑地址');
    setBase(target);
    if (code && /^[A-Z2-9]{12,18}$/i.test(code)) {
      $('pair-code').value = code;
      $('pair-name').value = autoDeviceName();
      showAuth('已识别电脑，正在请求连接…');
      requestPair(code, autoDeviceName());
    } else {
      showAuth('二维码缺少配对码，请重新扫描电脑面板上的二维码');
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Capacitor 深链：App 从 dsh:// 链接启动，或 App 运行中收到 dsh:// 打开
// 注意：Capacitor 8 中 addListener 返回的是同步句柄（不是 Promise），不能直接链 .catch
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  const App = window.Capacitor.Plugins.App;
  try {
    const p = App.getLaunchUrl();
    if (p && typeof p.then === 'function') {
      p.then((r) => {
        if (r && r.url && !token) handlePairLink(r.url);
      }).catch(() => {});
    }
  } catch (e) {}
  try {
    const handle = App.addListener('appUrlOpen', (data) => {
      if (data && data.url && !token) handlePairLink(data.url);
    });
    // 兼容两种返回形态：Promise<handle> 或同步 handle
    if (handle && typeof handle.then === 'function') handle.catch(() => {});
  } catch (e) {}
  // Android 返回键/侧滑返回：非首页时回退到上一页（不再直接退出 App）
  try {
    const backHandle = App.addListener('backButton', () => {
      goBack();
    });
    if (backHandle && typeof backHandle.then === 'function') backHandle.catch(() => {});
  } catch (e) {}
}

/** 返回上一页（Android 返回键 / 侧滑返回）。首页时退出 App。 */
function goBack() {
  if (currentView === 'chat') { showView('home'); homePoll(); return true; }
  if (currentView === 'new' || currentView === 'settings') { showView('home'); homePoll(); return true; }
  if (currentView === 'auth') return false; // 认证页不拦截，让系统退出
  return false;
}

$('btn-pair').addEventListener('click', async () => {
  const code = $('pair-code').value.trim().toUpperCase();
  const name = $('pair-name').value.trim() || autoDeviceName();
  if (!/^[A-Z2-9]{12,18}$/i.test(code)) {
    $('auth-status').textContent = '请输入有效的配对码（电脑面板高级设置里可查看）';
    return;
  }
  const onLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!base && !onLocalhost) base = location.origin;
  await requestPair(code, name);
});

$('btn-pw-login').addEventListener('click', async () => {
  const pw = $('pw-input').value;
  const onLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!base && !onLocalhost) base = location.origin;
  const btn = $('btn-pw-login');
  btn.disabled = true;
  $('auth-status').textContent = '登录中…';
  try {
    const data = await api('/auth/password-login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    saveToken(data.token, { id: 'password-session', name: '密码登录', active: true });
    mode = data.mode;
    showView('home');
    homePoll();
  } catch (e) {
    $('auth-status').textContent = e.message;
    $('auth-status').className = 'status err';
  } finally {
    btn.disabled = false;
  }
});

// --- 扫码（APK 用原生扫码插件，浏览器环境用 getUserMedia + jsQR 兜底）---
let cameraStream = null;
let scanLoop = null;

function nativeScanner() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner
    ? window.Capacitor.Plugins.BarcodeScanner
    : null;
}

async function startCamera() {
  const B = nativeScanner();
  if (B) {
    // 原生扫码（ZXing）：权限、相机、取景全部由插件处理，最稳定
    try {
      toast('正在打开扫码…');
      const res = await B.scan();
      if (res && res.result && res.code) {
        handleScannedUrl(res.code);
      } else {
        toast('未识别到二维码');
      }
    } catch (e) {
      toast('扫码失败（请允许相机权限后重试）');
      showManualFallback('相机未开启，请允许权限后重试，或使用“手动输入配对码”');
    }
    return;
  }
  // 兜底：getUserMedia + jsQR
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
    showManualFallback('当前无法调用相机，请使用“手动输入配对码”');
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    const video = $('camera');
    video.srcObject = cameraStream;
    await video.play();
    $('camera-wrap').style.display = 'block';
    $('btn-scan').style.display = 'none';
    scanLoop = setInterval(scanFrame, 300);
  } catch (e) {
    toast('无法打开摄像头：' + e.message);
    showManualFallback('相机无法打开，请检查权限，或使用“手动输入配对码”');
  }
}

/** 展开手动输入兜底（没有地址时先让用户填电脑地址）。 */
function showManualFallback(hint) {
  $('btn-scan').style.display = 'none';
  $('scan-hint').style.display = 'none';
  $('btn-manual').style.display = 'none';
  $('pair-form').style.display = 'block';
  $('pair-name').value = autoDeviceName();
  $('pair-code').focus();
  if (hint) {
    $('auth-status').textContent = hint;
    $('auth-status').className = 'status err';
  }
  if (!base) {
    $('base-form').style.display = 'block';
    $('pair-form').style.display = 'none';
    $('base-input').focus();
  }
}

function stopCamera() {
  clearInterval(scanLoop);
  scanLoop = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  $('camera-wrap').style.display = 'none';
  $('btn-scan').style.display = 'block';
}

function scanFrame() {
  const video = $('camera');
  if (!video || video.readyState < 2) return;
  const canvas = $('camera-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = window.jsQR ? jsQR(img.data, img.width, img.height) : null;
  if (result && result.data) {
    stopCamera();
    handleScannedUrl(result.data);
  }
}

function handleScannedUrl(text) {
  // 新格式 dsh://pair?url=...&code=...：扫码即自动配对
  if (handlePairLink(text)) return;
  // 兼容旧格式 http://ip:port?pair=CODE
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      setBase(url.origin);
      const code = url.searchParams.get('pair');
      if (code) {
        $('pair-code').value = code;
        $('pair-name').value = autoDeviceName();
        toast('已识别电脑，正在请求连接…');
        requestPair(code, autoDeviceName());
      } else {
        showAuth('已识别电脑地址，请点击“＋ 添加手机”后在面板扫码');
      }
    } else {
      toast('未能识别的二维码');
    }
  } catch {
    toast('未能识别的二维码');
  }
}

$('btn-scan').addEventListener('click', startCamera);
$('btn-cancel-scan').addEventListener('click', stopCamera);

// ---------------------------------------------------------------------------
// 首页：会话列表
// ---------------------------------------------------------------------------

async function homePoll() {
  if (currentView !== 'home') return;
  try {
    const data = await api('/m/sessions');
    lastSessions = data;
    renderSessions(data.items);
    const st = await api('/m/status');
    const parts = [];
    if (st.dshUp) parts.push('电脑已连接');
    else parts.push('电脑服务未运行');
    if (st.tunnel && st.tunnel.url) parts.push('远程地址可用');
    $('conn-bar').textContent = parts.join(' · ');
  } catch (e) {
    $('conn-bar').textContent = e.message;
    if (e.message.includes('无法连接')) clearToken(), showAuth('与电脑的连接已断开');
  }
}

function renderSessions(items) {
  const list = $('session-list');
  $('home-empty').style.display = items.length ? 'none' : 'flex';
  list.innerHTML = '';
  const seen = new Set();
  for (const s of items) {
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    const item = document.createElement('div');
    item.className = 'session-item';
    const badges = [];
    if (s.running) badges.push('<span class="badge run">运行中</span>');
    if (s.pendingApprovals || s.pendingQuestions) badges.push('<span class="badge pending">待处理</span>');
    item.innerHTML = `
      <div class="si-main">
        <div class="si-title">${esc(s.title)}</div>
        <div class="si-sub">${esc(s.cwd || '')}</div>
        <div class="si-badges">${badges.join('')}</div>
      </div>
      <div class="si-time">${fmtTime(s.updatedAt)}</div>`;
    item.addEventListener('click', () => openChat(s.sessionId, s.title));
    list.appendChild(item);
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Markdown 渲染（assistant 回复）：marked 解析 + DOMPurify 消毒，输出安全 HTML。
// 仅在两个库都可用时启用；缺失时回退为纯文本（esc）。
// ---------------------------------------------------------------------------

const MD_CACHE = new Map(); // 长文本重复渲染（轮询 3s 一次）时缓存，避免每次全量解析

function renderMarkdown(text) {
  if (!text) return '';
  if (MD_CACHE.has(text)) return MD_CACHE.get(text);
  let html;
  try {
    if (window.marked && window.DOMPurify) {
      const raw = window.marked.parse(text, { breaks: true, gfm: true });
      html = window.DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ['target'],
      });
      // 为外部链接加 target 与安全 rel（DOMPurify 默认去掉 target，这里补回来）
      html = html.replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener noreferrer"');
    } else {
      html = esc(text).replace(/\n/g, '<br/>');
    }
  } catch {
    html = esc(text).replace(/\n/g, '<br/>');
  }
  // 简单 LRU：最多缓存 40 条
  if (MD_CACHE.size > 40) MD_CACHE.clear();
  MD_CACHE.set(text, html);
  return html;
}

$('btn-new').addEventListener('click', openNew);
$('btn-empty-new').addEventListener('click', openNew);
// 设置页入口见下方 settingsPoll 区域（含加载占位）

// ---------------------------------------------------------------------------
// 新建会话：选文件夹（电脑上已配置的工作区）
// ---------------------------------------------------------------------------

async function openNew() {
  showView('new');
  const list = $('workspace-list');
  list.innerHTML = '<div class="empty">加载中…</div>';
  loadPresetOptions();
  try {
    const data = await api('/m/workspaces');
    if (!data.items.length) {
      $('ws-empty').style.display = 'flex';
      list.innerHTML = '';
      return;
    }
    $('ws-empty').style.display = 'none';
    list.innerHTML = '';
    for (const w of data.items) {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.innerHTML = `
        <div class="si-main">
          <div class="si-title">${esc(w.title)}</div>
          <div class="si-sub">${esc(w.path)}</div>
        </div>
        <div class="si-time">${w.sessionCount} 个会话</div>`;
      item.addEventListener('click', () => {
        currentWsId = w.workspaceId;
        currentSessionId = null;
        openChat(null, w.title);
      });
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

$('btn-new-back').addEventListener('click', () => showView('home'));

// ---------------------------------------------------------------------------
// 会话详情
// ---------------------------------------------------------------------------

function openChat(sessionId, title) {
  currentSessionId = sessionId;
  $('chat-title-text').textContent = title || '新会话';
  $('pending-area').innerHTML = '';
  $('composer-input').value = '';
  hideCmdPopup();
  showView('chat');
  chatMsgs = [];
  chatHasMore = true;
  chatLoadingMore = false;
  initComposerTools();
  // 先渲染本地缓存（秒开），再拉取最新增量
  const cached = readCache(sessionId);
  if (cached && cached.msgs && cached.msgs.length) {
    chatMsgs = cached.msgs.slice();
    renderMessages(chatMsgs);
    $('chat-sub').textContent = '同步中…';
  } else {
    $('messages').innerHTML = '<div class="empty" style="padding:48px 0">加载中…</div>';
  }
  $('composer-input').focus();
  chatPoll();
  loadCommands(sessionId);
}

async function chatPoll() {
  if (currentView !== 'chat' || !currentSessionId) return;
  try {
    // 只取最新 200 条消息；更早的历史等用户上翻到顶时由 loadMoreHistory 分批加载
    const data = await api(`/m/session?sessionId=${encodeURIComponent(currentSessionId)}&maxMessages=200`);
    if (data.sessionId !== currentSessionId) return;
    // 合并：增量同步到本地（保留上翻加载的更早消息，按 seq 去重）
    const merged = mergeMessages(chatMsgs, data.messages || []);
    chatMsgs = merged;
    chatHasMore = !!data.hasMore;
    renderMessages(chatMsgs);
    writeCache(currentSessionId, chatMsgs);
    renderPending(data.pendingApprovals || [], data.pendingQuestions || []);
    // 运行状态与输入框快捷按钮：同步一次会话列表（轻量），刷新"停止"按钮与 Agent 预设名
    try {
      const s = await api('/m/sessions');
      lastSessions = s;
    } catch {}
    const info = lastSessions.items.find((s) => s.sessionId === currentSessionId);
    sessionRunning = !!(info && info.running);
    if (info && info.agentPreset) updatePresetChip(info.agentPreset);
    updateStopButton();
    $('chat-sub').textContent = sessionRunning ? '● 运行中' : '';
  } catch (e) {
    // 会话可能刚创建；忽略瞬时错误
  }
}

// --- 会话消息本地缓存：第一次下载到本地，之后打开秒开，仅后台同步差异 ---
function readCache(sessionId) {
  if (!sessionId) return null;
  try {
    const all = JSON.parse(localStorage.getItem(LS_CACHE) || '{}');
    return all[sessionId] || null;
  } catch { return null; }
}

function writeCache(sessionId, msgs) {
  if (!sessionId) return;
  try {
    const all = JSON.parse(localStorage.getItem(LS_CACHE) || '{}');
    all[sessionId] = { msgs: (msgs || []).slice(-200), ts: Date.now() };
    // LRU：最多保留 6 个会话
    const keys = Object.keys(all).sort((a, b) => (all[b].ts || 0) - (all[a].ts || 0));
    for (const k of keys.slice(6)) delete all[k];
    localStorage.setItem(LS_CACHE, JSON.stringify(all));
  } catch {}
}

/** 合并两份消息（按 seq 去重保序）：older 在前，newer 在后。
 * 相同 seq 时 newer 覆盖 older（服务端返回的数据比本地缓存新，修复旧缓存里的脏数据）。 */
function mergeMessages(older, newer) {
  const bySeq = new Map();
  for (const list of [older || [], newer || []]) {
    for (const m of list) {
      if (m && m.seq !== undefined) bySeq.set(m.seq, m); // 后者覆盖前者
    }
  }
  return [...bySeq.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/** 已展开的长消息（按 seq 记忆，避免每次轮询重渲染后又收回去）。 */
const expandedLongMsgs = new Set();

const LONG_MSG_LIMIT = 480; // 超过该长度的 assistant 文本默认折叠，点“展开全部”查看

function renderMessages(messages, opts = {}) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const oldHeight = box.scrollHeight;
  box.innerHTML = '';
  if (!messages || !messages.length) {
    box.innerHTML = '<div class="empty" style="padding:48px 0">还没有消息，发一条试试</div>';
    return;
  }
  let lastToolIdx = -1;
  for (const m of messages) {
    if (m.kind === 'system') {
      // 系统消息（dsh 注入的上下文快照/策略变化等）：居中灰色小字，不冒充用户输入
      const div = document.createElement('div');
      div.className = 'msg system';
      div.innerHTML = `<div class="sys-line">${esc(m.text)}</div>`;
      box.appendChild(div);
    } else if (m.kind === 'user') {
      const div = document.createElement('div');
      div.className = 'msg user';
      div.innerHTML = `<div class="bubble bubble-md">${renderMarkdown(m.text)}</div>`;
      box.appendChild(div);
    } else if (m.kind === 'assistant') {
      const hasReasoning = !!(m.reasoning && m.reasoning.trim());
      const hasText = !!(m.text && m.text.trim());
      if (!hasText && !hasReasoning) continue; // 空消息（生成中）不渲染
      const div = document.createElement('div');
      div.className = 'msg assistant';
      const parts = [];
      if (hasReasoning) {
        const rText = m.reasoning === '…' ? '思考中…' : m.reasoning.slice(0, 40);
        parts.push('<div class="reason">🧠 ' + esc(rText) + '</div>');
      }
      if (hasText) {
        const full = m.text;
        const seqKey = m.seq !== undefined ? m.seq : (m.time || '');
        if (full.length > LONG_MSG_LIMIT && !expandedLongMsgs.has(seqKey)) {
          // 长输出（如压缩命令的完整结果）默认折叠，避免刷屏；点击可展开。
          // 折叠预览用纯文本（截断的 markdown 可能产生残缺 HTML），展开后才是 markdown 渲染。
          parts.push(
            `<div class="bubble">${esc(full.slice(0, LONG_MSG_LIMIT))}…</div>` +
            `<button type="button" class="msg-expand" data-seq="${esc(String(seqKey))}">展开全部（${full.length} 字）</button>`
          );
        } else {
          parts.push(`<div class="bubble bubble-md">${renderMarkdown(full)}</div>`);
        }
      }
      div.innerHTML = parts.join('');
      box.appendChild(div);
    } else if (m.kind === 'tool') {
      const div = document.createElement('div');
      const done = m.status === 'done';
      div.className = 'tool-line' + (done ? ' done' : '');
      if (m.label) {
        // 命令类工具：显示友好动作名（如“压缩命令”），不直接展示原始参数/输出
        div.innerHTML = `<span class="t-icon">${done ? '✅' : '⏳'}</span> <span class="t-name">${esc(m.label)}</span>${done ? ' 完成' : ' 执行中…'}`;
      } else {
        const argPreview = m.args ? m.args.slice(0, 80) : '';
        div.innerHTML = `<span class="t-name">🔧 ${esc(m.name)}</span> ${esc(argPreview)}`;
      }
      box.appendChild(div);
    }
  }
  if (opts.keepPosition) {
    box.scrollTop += box.scrollHeight - oldHeight; // 顶部插入更早消息后保持视觉位置
  } else if (nearBottom) {
    box.scrollTop = box.scrollHeight;
  }
  // 斜杠命令执行中（如 /compact 在电脑端压缩上下文）的临时提示
  if (pendingCmd) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="sys-line">⏳ ${esc(pendingCmd.label)}…</div>`;
    box.appendChild(div);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  updateScrollBottom();
}

// 展开长消息（事件委托：消息列表会反复重渲染）
$('messages').addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.msg-expand');
  if (!btn) return;
  const seq = btn.dataset.seq;
  if (seq !== undefined) expandedLongMsgs.add(seq);
  renderMessages(chatMsgs);
});

/** 上翻到顶时加载更早的历史（每次 200 条消息）。 */
async function loadMoreHistory() {
  if (!currentSessionId || chatLoadingMore || !chatHasMore || !chatMsgs.length) return;
  chatLoadingMore = true;
  const beforeSeq = chatMsgs[0].seq;
  try {
    const data = await api(`/m/session?sessionId=${encodeURIComponent(currentSessionId)}&beforeSeq=${beforeSeq}&maxMessages=200`);
    if (data.sessionId !== currentSessionId) return;
    const older = (data.messages || []).filter((m) => m.seq !== undefined && m.seq < beforeSeq);
    if (!older.length) { chatHasMore = false; return; }
    chatMsgs = mergeMessages(older, chatMsgs);
    renderMessages(chatMsgs, { keepPosition: true });
    chatHasMore = !!data.hasMore;
    writeCache(currentSessionId, chatMsgs);
  } catch (e) {
    toast('加载更早消息失败：' + e.message);
  } finally {
    chatLoadingMore = false;
  }
}

$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  if (box.scrollTop < 30) loadMoreHistory();
  updateScrollBottom();
});

/** 根据滚动位置显示/隐藏“回到最新”按钮（不在底部时显示）。 */
function updateScrollBottom() {
  const box = $('messages');
  const btn = $('btn-scroll-bottom');
  if (!btn) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  btn.style.display = nearBottom ? 'none' : 'flex';
}

$('btn-scroll-bottom').addEventListener('click', () => {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
  updateScrollBottom();
});

function renderPending(approvals, questions) {
  const area = $('pending-area');
  if (!approvals.length && !questions.length) {
    area.innerHTML = '';
    return;
  }
  let html = '';
  for (const a of approvals) {
    html += `
      <div class="pending-card">
        <h4>⚠️ 需要批准：工具 ${esc(a.toolName)}</h4>
        <div class="p-text">${esc(a.reason || '')}</div>
        <div class="p-actions">
          <button class="p-allow" data-approval="${esc(a.approvalId)}" data-action="allow">允许一次</button>
          <button class="p-reject" data-approval="${esc(a.approvalId)}" data-action="reject">拒绝</button>
        </div>
      </div>`;
  }
  for (const q of questions) {
    const q0 = q.questions && q.questions[0];
    if (!q0) continue;
    const opts = (q0.options || []).map((o, i) =>
      `<button class="q-opt" data-question="${esc(q.questionRpcId)}" data-opt="${i}">
        <span class="qo-label">${esc(o.label)}</span>
        ${o.description ? '<span class="qo-desc">' + esc(o.description) + '</span>' : ''}
      </button>`
    ).join('');
    html += `
      <div class="pending-card question-card">
        <h4>❓ ${esc(q0.question)}</h4>
        ${q0.description ? '<div class="p-text">' + esc(q0.description) + '</div>' : ''}
        <div class="q-options">${opts}</div>
        <div class="p-actions"><button class="p-reject" data-question="${esc(q.questionRpcId)}" data-opt="-1">取消</button></div>
      </div>`;
  }
  area.innerHTML = html;
  area.querySelectorAll('[data-approval]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const approvalId = btn.dataset.approval;
      const outcome = btn.dataset.action === 'allow' ? 'allowed-once' : 'rejected';
      try {
        await api('/m/respond', {
          method: 'POST',
          body: JSON.stringify({ sessionId: currentSessionId, approvalId, outcome }),
        });
        toast(outcome === 'allowed-once' ? '已允许' : '已拒绝');
        chatPoll();
      } catch (e) {
        toast(e.message);
      }
    });
  });
  area.querySelectorAll('[data-question]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const questionRpcId = btn.dataset.question;
      const opt = parseInt(btn.dataset.opt, 10);
      const q = (questions.find((x) => x.questionRpcId === questionRpcId) || {}).questions || [];
      const q0 = q[0] || {};
      const answers = opt >= 0 ? [{ id: (q0.options[opt] || {}).id || String(opt), label: (q0.options[opt] || {}).label }] : [];
      try {
        await api('/m/answer-question', {
          method: 'POST',
          body: JSON.stringify({ sessionId: currentSessionId, questionRpcId, answers }),
        });
        toast('已回答');
        chatPoll();
      } catch (e) {
        toast('手机端暂不能回答该问题，请在电脑上处理');
      }
    });
  });
}

$('btn-back').addEventListener('click', () => { showView('home'); homePoll(); });

function sendMessage() {
  const text = $('composer-input').value.trim();
  if (!text) return;
  const btn = $('btn-send');
  btn.disabled = true;
  const payload = { text };
  if (currentSessionId) payload.sessionId = currentSessionId;
  else if (currentWsId) payload.workspaceId = currentWsId;
  if (!currentSessionId && currentPreset) payload.agentPreset = currentPreset; // 新建会话指定预设
  api('/m/send', { method: 'POST', body: JSON.stringify(payload) })
    .then((r) => {
      $('composer-input').value = '';
      if (!currentSessionId && r.sessionId) {
        currentSessionId = r.sessionId;
        $('chat-title-text').textContent = '新会话';
      }
      setTimeout(chatPoll, 300);
    })
    .catch((e) => {
      toast(e.message);
      reportError('发送失败', e.message + '\n请求地址：' + base + '/m/send');
    })
    .finally(() => { btn.disabled = false; });
}

$('btn-send').addEventListener('click', sendMessage);
$('composer-input').addEventListener('keydown', (e) => {
  // Enter 插入换行（不发送）；Ctrl/Cmd+Enter 发送。
  // 注：Android 软键盘“换行”键也会触发 keydown Enter，不应被当成发送。
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
  // 其他 Enter 交给浏览器默认行为：插入换行
});
$('composer-input').addEventListener('input', () => {
  const el = $('composer-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  updateCmdPopup();
});

// ---------------------------------------------------------------------------
// 输入框内的会话操作快捷按钮：
//   [🤖 Agent] [🔒 权限] —— 点按弹出对应选择器；会话运行中时发送旁显示 [⏹ 停止]
// ---------------------------------------------------------------------------

let presetNameCache = {}; // preset id -> 显示名（/m/presets 返回）
let presetCacheLoading = false;

/** 拉取一次预设列表填充名称缓存（失败时静默，按钮回退显示原始 id）。 */
async function refreshPresetCache() {
  if (presetCacheLoading) return;
  presetCacheLoading = true;
  try {
    const d = await api('/m/presets');
    presetNameCache = {};
    for (const p of (d.presets || [])) presetNameCache[p.id] = p.name || p.id;
  } catch {} finally {
    presetCacheLoading = false;
  }
}

/** Agent 预设按钮：显示当前预设名，点按打开预设选择器。 */
function updatePresetChip(presetId) {
  currentPresetLabel = presetId ? (presetNameCache[presetId] || presetId) : '';
  $('chip-agent').textContent = '🤖 ' + (currentPresetLabel || 'Agent');
}

/** 权限按钮：显示当前权限模式名，点按打开权限选择器。 */
async function updatePermChip() {
  try {
    const p = await api('/m/permission');
    currentPerm = p.current || '';
  } catch {}
  $('chip-perm').textContent = '🔒 ' + (PERM_LABELS[currentPerm] || currentPerm || '权限');
}

/** 停止按钮：会话运行中显示，空闲时隐藏。 */
function updateStopButton() {
  $('btn-stop').style.display = sessionRunning ? 'block' : 'none';
}

$('chip-agent').addEventListener('click', () => {
  openPresetPicker(currentSessionId, (opt) => {
    // 选择后刷新按钮文字（新会话：currentPreset；已有会话：服务端已切换）
    if (opt && opt.id) {
      currentPresetLabel = opt.label || presetNameCache[opt.id] || opt.id;
      $('chip-agent').textContent = '🤖 ' + currentPresetLabel;
    }
  });
});

$('chip-perm').addEventListener('click', () => {
  openPermissionPicker();
});

$('btn-stop').addEventListener('click', () => {
  cancelChat();
});

/** 进入会话时初始化快捷按钮（每次打开会话调用一次）。 */
function initComposerTools() {
  sessionRunning = false;
  updateStopButton();
  updatePermChip();
  refreshPresetCache();
  const info = lastSessions.items.find((s) => s.sessionId === currentSessionId);
  updatePresetChip(info && info.agentPreset ? info.agentPreset : '');
}

// ---------------------------------------------------------------------------
// 斜杠命令浮层：输入 / 弹出命令菜单
// ---------------------------------------------------------------------------

// 斜杠命令：与桌面端同一数据源（服务端按会话/预设动态下发），
// 本地仅补充 /cancel（停止当前会话，桌面端停止是 UI 按钮、无对应命令）。
const CMD_ITEMS = [
  { key: '/cancel', label: '停止当前会话', desc: '取消正在运行的任务', action: 'cancel' },
];

/** 拉取当前会话的命令列表（服务端与桌面端一致，带会话级缓存）。 */
async function loadCommands(sessionId) {
  if (!sessionId || cmdLoading[sessionId]) return;
  cmdLoading[sessionId] = true;
  try {
    const data = await api(`/m/commands?sessionId=${encodeURIComponent(sessionId)}`);
    cmdCache[sessionId] = Array.isArray(data.items) ? data.items : [];
  } catch {
    cmdCache[sessionId] = []; // 拉取失败时只有本地命令可用
  } finally {
    cmdLoading[sessionId] = false;
  }
}

function updateCmdPopup() {
  const el = $('composer-input');
  const box = $('cmd-popup');
  const v = el.value;
  if (!v.startsWith('/') || v.length > 24 || !currentSessionId) {
    hideCmdPopup();
    return;
  }
  const q = v.slice(1).toLowerCase();
  const server = cmdCache[currentSessionId] || [];
  const items = CMD_ITEMS
    .concat(server.map((c) => ({ key: '/' + c.name, label: '/' + c.name, desc: c.description || '', action: 'run', line: '/' + c.name })))
    .filter((c) => !q || c.key.slice(1).startsWith(q));
  if (!items.length) { hideCmdPopup(); return; }
  box.innerHTML = items.map((c, i) => `
    <button class="cmd-item" data-i="${i}">
      <span class="ci-label">${c.key}</span>
      <span class="ci-desc">${esc(c.desc)}</span>
    </button>`).join('');
  box.style.display = 'block';
  box.querySelectorAll('[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      hideCmdPopup();
      const item = items[Number(b.dataset.i)];
      $('composer-input').value = '';
      runCommand(item);
    });
  });
}

function hideCmdPopup() {
  const box = $('cmd-popup');
  if (box) box.style.display = 'none';
}

function runCommand(cmd) {
  if (cmd.action === 'cancel') cancelChat();
  else if (cmd.action === 'run') executeSlash(cmd.line);
}

/** 执行服务端斜杠命令（/compact /plan /goal…），与桌面端同一 RPC。
 * 命令（如 /compact）会在电脑端阻塞执行较久，期间在聊天里显示“正在执行…”，
 * 避免手机端看起来没反应。 */
let pendingCmd = null; // { label }

function showPendingCmd(label) {
  pendingCmd = { label };
  renderMessages(chatMsgs);
}

function clearPendingCmd() {
  pendingCmd = null;
  renderMessages(chatMsgs);
}

async function executeSlash(line) {
  if (!currentSessionId) return;
  const cmdName = String(line || '').trim().split(/\s+/)[0] || '/command';
  const label = /^\/compact$/i.test(cmdName) ? '正在压缩上下文' : `正在执行 ${cmdName}`;
  showPendingCmd(label);
  try {
    const r = await api('/m/command', { method: 'POST', body: JSON.stringify({ sessionId: currentSessionId, line }) });
    clearPendingCmd();
    if (r.text) toast(r.text.slice(0, 120));
    setTimeout(chatPoll, 300);
  } catch (e) {
    clearPendingCmd();
    toast(e.message);
  }
}

/** 直接发送文本（由 agent 解析的命令等）。 */
function sendRaw(text) {
  if (!currentSessionId) return;
  api('/m/send', { method: 'POST', body: JSON.stringify({ sessionId: currentSessionId, text }) })
    .then(() => { setTimeout(chatPoll, 300); })
    .catch((e) => toast(e.message));
}

async function cancelChat() {
  if (!currentSessionId) return;
  try {
    await api('/m/cancel', { method: 'POST', body: JSON.stringify({ sessionId: currentSessionId }) });
    toast('已发送停止请求');
    setTimeout(chatPoll, 400);
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------
// 通用选择弹层（权限模式 / Agent 预设 / 会话操作）
// ---------------------------------------------------------------------------

function closeSheet() {
  $('sheet-modal').style.display = 'none';
}

function openSheet(title, options, onSelect) {
  const box = $('sheet-options');
  box.innerHTML = options.map((o, i) => `
    <button class="sheet-opt${o.selected ? ' sel' : ''}" data-i="${i}">
      <span class="so-label">${esc(o.label)}</span>
      ${o.desc ? '<span class="so-desc">' + esc(o.desc) + '</span>' : ''}
      ${o.selected ? '<span class="so-check">✓</span>' : ''}
    </button>`).join('');
  $('sheet-title').textContent = title;
  $('sheet-modal').style.display = 'flex';
  box.querySelectorAll('[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      closeSheet();
      onSelect(options[Number(b.dataset.i)]);
    });
  });
}

$('btn-sheet-close').addEventListener('click', closeSheet);

// --- 权限模式 ---
const PERM_LABELS = {
  'read-only': '只读',
  'workspace-write': '工作区写（默认）',
  'danger-full-access': '完全访问（Full Access）',
};
const PERM_DESCS = {
  'read-only': '只能读取电脑文件，Agent 不能修改任何内容',
  'workspace-write': '允许 Agent 在所选工作区内创建/编辑文件',
  'danger-full-access': '允许 Agent 执行任意操作（含危险命令），请谨慎',
};

async function openPermissionPicker() {
  try {
    const p = await api('/m/permission');
    openSheet('权限模式（电脑文件访问级别）', p.options.map((id) => ({
      id,
      label: PERM_LABELS[id] || id,
      desc: PERM_DESCS[id] || '',
      selected: id === p.current,
    })), async (opt) => {
      try {
        await api('/m/permission-set', { method: 'POST', body: JSON.stringify({ preset: opt.id }) });
        toast('已切换为「' + (PERM_LABELS[opt.id] || opt.id) + '」');
        currentPerm = opt.id;
        updatePermChip();
        if (currentView === 'settings') settingsPoll();
      } catch (e) { toast(e.message); }
    });
  } catch (e) { toast(e.message); }
}

// --- Agent 预设（模型与推理等级） ---
let currentPreset = null; // 新建会话使用的预设

async function openPresetPicker(sessionId, onDone) {
  try {
    const data = await api('/m/presets');
    const opts = (data.presets || []).map((p) => ({
      id: p.id,
      label: p.name || p.id,
      desc: p.description || '',
      selected: false,
    }));
    if (!opts.length) { toast('电脑上没有可用的 Agent 预设'); return; }
    openSheet('Agent 预设（决定模型与推理等级）', opts, async (opt) => {
      try {
        if (sessionId) {
          await api('/m/preset', { method: 'POST', body: JSON.stringify({ sessionId, agentPreset: opt.id }) });
          toast('已切换为「' + opt.label + '」');
          updatePresetChip(opt.id);
        } else {
          currentPreset = opt.id;
          toast('新建会话将使用「' + opt.label + '」');
          updatePresetChip(opt.id);
        }
        if (onDone) onDone();
      } catch (e) { toast(e.message); }
    });
  } catch (e) { toast(e.message); }
}

// --- 会话操作菜单（⋮） ---
$('btn-chat-settings').addEventListener('click', () => {
  const opts = [
    { id: 'permission', label: '权限模式', desc: '电脑文件访问级别（含完全访问）' },
    { id: 'preset', label: 'Agent 预设', desc: '模型与推理等级（仅新会话可切换）' },
  ];
  if (currentSessionId) opts.push({ id: 'cancel', label: '停止当前会话', desc: '取消正在运行的任务' });
  openSheet('会话操作', opts, (opt) => {
    if (opt.id === 'permission') openPermissionPicker();
    else if (opt.id === 'preset') openPresetPicker(currentSessionId);
    else if (opt.id === 'cancel') cancelChat();
  });
});

// --- 设置页：权限模式入口 ---
$('perm-card').addEventListener('click', () => {
  openPermissionPicker();
});

// --- 新建会话：Agent 预设选择 ---
async function loadPresetOptions() {
  try {
    const data = await api('/m/presets');
    const box = $('preset-options');
    const presets = data.presets || [];
    $('preset-pick').style.display = presets.length ? 'block' : 'none';
    box.innerHTML = presets.map((p) => `
      <button class="preset-opt${currentPreset === p.id ? ' sel' : ''}" data-id="${esc(p.id)}">
        <span class="po-name">${esc(p.name || p.id)}</span>
        <span class="po-desc">${esc((p.description || '').slice(0, 80))}</span>
      </button>`).join('');
    box.querySelectorAll('[data-id]').forEach((b) => {
      b.addEventListener('click', () => {
        currentPreset = b.dataset.id;
        box.querySelectorAll('.preset-opt').forEach((x) => x.classList.toggle('sel', x === b));
        const p = presets.find((x) => x.id === currentPreset);
        toast('新建会话将使用「' + (p && p.name || currentPreset) + '」');
      });
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

async function settingsPoll() {
  if (currentView !== 'settings') return;
  try {
    const me = await api('/m/me');
    const st = await api('/m/status');
    $('device-card').innerHTML = `
      <h3>此设备</h3>
      <div class="card-row"><span class="device-name">${esc(me.device.name)}</span>
        <span class="badge ${me.device.active ? 'run' : 'pending'}">${me.device.active ? '控制设备' : '仅查看'}</span></div>
      <div class="card-row"><span class="muted">电脑</span><span class="muted">${esc(st.serverName || 'DeepSeek Harness')}</span></div>`;
    try {
      const perm = await api('/m/permission');
      $('perm-current').textContent = PERM_LABELS[perm.current] || perm.current || '—';
    } catch { $('perm-current').textContent = '—'; }
    const rows = [];
    if (st.activeDevice) rows.push(`<div class="card-row"><span class="muted">当前控制设备</span><span>${esc(st.activeDevice.name)}</span></div>`);
    rows.push(`<div class="card-row"><span class="muted">电脑服务</span><span class="${st.dshUp ? 'badge run' : 'badge pending'}">${st.dshUp ? '运行中' : '未运行'}</span></div>`);
    if (st.tunnel && st.tunnel.url) rows.push(`<div class="card-row"><span class="muted">远程地址</span><span style="font-size:11px;color:#9fd0ff;word-break:break-all">${esc(st.tunnel.url)}</span></div>`);
    rows.push(`<div class="card-row"><span class="muted">已配对设备</span><span>${st.deviceCount}</span></div>`);
    $('server-card').innerHTML = `<h3>电脑状态</h3>${rows.join('')}`;
  } catch (e) {
    // 加载失败时给出可见提示，而不是空白页
    $('device-card').innerHTML = `<h3>此设备</h3><div class="card-row"><span class="muted">加载失败</span><span style="color:#f0a3a6">${esc(e.message || '未知错误')}</span></div>`;
    $('server-card').innerHTML = `<h3>电脑状态</h3><div class="card-row"><span class="muted">—</span><span class="muted">—</span></div>`;
    $('perm-current').textContent = '—';
  }
}

$('btn-settings').addEventListener('click', () => {
  showView('settings');
  // 先显示加载占位，避免空白
  $('device-card').innerHTML = '<h3>此设备</h3><div class="card-row"><span class="muted">加载中…</span></div>';
  $('server-card').innerHTML = '<h3>电脑状态</h3><div class="card-row"><span class="muted">加载中…</span></div>';
  settingsPoll();
});

$('btn-settings-back').addEventListener('click', () => showView('home'));

$('about-version').textContent = 'v' + APP_VERSION;

$('btn-disconnect').addEventListener('click', () => {
  if (!confirm('断开此设备？需重新配对才能连接。')) return;
  clearToken();
  showAuth('已断开。请在电脑上重新“添加手机”');
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

window.addEventListener('load', () => {
  boot().catch((err) => showFatalError('启动失败：' + (err && err.message ? err.message : err)));
});
