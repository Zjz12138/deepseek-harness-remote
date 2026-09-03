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
const LS_BASES = 'dshm_bases'; // 已知电脑地址列表 [{url, lastOk}]，连不上时自动换地址重试
const LS_DEVICE_ID = 'dshm_device_id';
const LS_CACHE = 'dshm_cache'; // 会话消息缓存 {sessionId: {msgs, ts}}
const LS_HIDDEN = 'dshm_hidden'; // 被隐藏（隐私）的会话 id 数组
const LS_PRIVACY = 'dshm_privacy'; // '1'=隐私模式已开启
const APP_VERSION = '0.1.1';

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
let bases = []; // 已知地址列表 [{url, lastOk}]，自动切换用
let token = null;
let device = null;
let mode = 'pair';
let currentView = 'auth';
let pollTimer = null;
let currentSessionId = null;
let currentWsId = null; // 新建会话选中的工作区
let lastSessions = { items: [] };
let pairingInFlight = false;
let failoverInFlight = false; // 防止并发自动切换地址

// 待回应项（问题/审批）：内联渲染进消息流，不再常驻消息列表上方。
let pendingList = { approvals: [], questions: [] };
let questionPage = 0; // 多问题时分页：当前显示第几题（0 基）
// 问题组草稿：keyed by 子问题 id -> { selected, custom, skipped }，用于整组一次性提交（匹配桌面端 matchesQuestions 的长度与 id 校验）
let qDrafts = {};
let qDraftGroup = null; // 当前草稿所属的问题组 rpcId，切组即清空
let lastTunnelSync = 0; // 上次同步隧道地址的时间（限速，防频繁 /m/status）

// 会话操作状态（输入框内的快捷切换按钮）
let currentPerm = ''; // 当前权限模式 id（read-only / workspace-write / danger-full-access）
let currentPresetLabel = ''; // 当前会话的 Agent 预设显示名
let sessionRunning = false; // 当前会话是否在运行（控制停止按钮显隐）

// 隐私模式：可把部分会话隐藏，进入需要隐蔽操作，退出一键。
let hiddenSessions = new Set(); // 被隐藏的会话 id
let privacyActive = false; // 是否处于隐私模式（true=查看被隐藏的会话）
let lastHiddenWrite = 0; // 最近一次本机写入共享隐藏名单的时间（防轮询旧值覆盖）

// 待发送图片（base64 data URL 数组，vision 输入）
let pendingImages = [];
const MAX_ATTACH = 4; // 单次最多附 4 张图，避免 payload 过大
const MAX_IMG_BYTES = 6 * 1024 * 1024; // 单张 ≤6MB（超限压缩到该尺寸内）

// 主题（深色/浅色），持久化到 localStorage
const LS_THEME = 'dshm_theme';
let theme = 'dark';

function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(LS_THEME, theme); } catch {}
  const cur = $('theme-current');
  if (cur) cur.textContent = theme === 'light' ? '浅色' : '深色';
  const darkBtn = $('seg-theme-dark');
  const lightBtn = $('seg-theme-light');
  if (darkBtn) darkBtn.classList.toggle('on', theme !== 'light');
  if (lightBtn) lightBtn.classList.toggle('on', theme === 'light');
}

function initTheme() {
  try {
    const saved = localStorage.getItem(LS_THEME);
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {}
  applyTheme();
}

function toggleTheme() {
  theme = theme === 'light' ? 'dark' : 'light';
  applyTheme();
}

// 会话消息状态（支持上翻增量加载）
let chatMsgs = []; // 当前会话已加载的消息（带 seq，最早在前）
let chatHasMore = false; // 是否还有更早历史可加载
let chatLoadingMore = false; // 正在加载更早历史
let justOpenedChat = false; // 刚进入会话：首次渲染强制滚到底部（最新消息），避免停留在中间
let pendingOutgoing = []; // 本地待发送消息 [{id,text,images,status}]，显示"发送中/已发送/失败"
let outSeq = 1;
let agentStatus = ''; // 会话运行时在对话流末尾显示的 agent 状态（接收信息中/思考中）
let cmdCache = {}; // 斜杠命令缓存 {sessionId: [{name,description,hint}]}
let cmdLoading = {}; // 正在加载命令的会话
let cmdErr = {}; // 命令列表加载错误 {sessionId: Error}，命令菜单点击可弹窗复制

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

/** 统一错误弹窗：把 Error（含 api() 附带的 status/path/resp）展开成可复制的完整详情。 */
function showErr(title, err, extra) {
  const e = err || {};
  const parts = [];
  if (e.status) parts.push('HTTP 状态：' + e.status);
  if (e.path) parts.push('请求：' + (base || '') + e.path);
  if (e.code) parts.push('错误码：' + e.code);
  const msg = e.message || String(e) || '未知错误';
  parts.push('原因：' + msg);
  if (e.resp && e.resp !== msg) parts.push('服务端返回：' + e.resp);
  if (extra) parts.push(extra);
  reportError(title || '操作失败', parts.join('\n'));
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
  // 带超时的 fetch：切换网络后局域网地址可能不可达，若不设超时请求会一直挂起，
  // 轮询的 catch 触发不了 -> autoFailover 不跑 -> 只能杀进程重开。超时后走失败重试/换地址。
  // _timeoutMs：覆盖默认 9s 超时（慢操作如 /compact 压缩上下文，往往需要数十秒）。
  // _noRetry：跳过"失败自动重试一次"。重试只适合非幂等的读/轮询；对 /m/command 这类会
  //   在服务端实际执行的有状态命令，超时自动重发会造成"输入一次却执行两次"（第二次撞 busy）。
  //   慢命令一旦发出，服务端会继续跑完，客户端只需等待 + 显示进行中，绝不能重发。
  const timeoutMs = opts._timeoutMs || 9000;
  const noRetry = !!opts._noRetry;
  const doFetch = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(base + path, { ...opts, signal: ctl.signal, headers: { ...headers, ...(opts.headers || {}) } });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const err = new Error('连接超时');
        err.code = 'TIMEOUT';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let res;
  try {
    res = await doFetch();
  } catch (e) {
    // 网络层失败（离线/隧道空闲断开/抖动）：自动重试一次，避免"连接上后一段时间不用就超时"。
    // 重试仍失败才报错，交由调用方 catch 触发 autoFailover。
    // 注意：_noRetry 用于 /m/command，杜绝"超时→重发→执行两遍"。
    if (!noRetry && !opts._retried) {
      await new Promise((r) => setTimeout(r, 700));
      try {
        res = await doFetch();
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
    // 错误带 status + path + 服务端返回体，上层弹窗可展示具体原因（如 HTTP 404 not found）。
    const err = new Error(data.error || ('HTTP ' + res.status));
    err.code = data.code;
    err.status = res.status;
    err.path = path;
    err.resp = data.error || '';
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
  setupNetworkWatcher(); // 切网自动重连：WiFi↔流量 时主动换到可用地址，无需杀进程重开
  loadBases();
  const storedBase = localStorage.getItem(LS_BASE);
  if (storedBase) base = storedBase;
  token = localStorage.getItem(LS_TOKEN);
  // 有 token：依次尝试所有已知地址（当前地址优先），找到能连上的直接进入
  if (token) {
    const r = await tryAllBases();
    if (r === 'ok') {
      showView('home');
      homePoll();
      return;
    }
    if (r === 'auth') {
      // 地址可达但 401 → token 被吊销，需要重新配对
      clearToken();
      showAuth('登录已失效，请重新扫码配对');
      return;
    }
    showAuth('无法连接电脑（' + (bases.length ? '已尝试 ' + bases.length + ' 个地址' : '未设置地址') + '）——请点「扫描电脑上的二维码」获取最新地址');
    $('btn-retry').style.display = 'block';
    return;
  }
  // PWA 同源场景：base 为空 → 直接用当前源
  try {
    await api('/auth/status');
  } catch (e) {
    if (!base && !location.protocol.startsWith('http')) {
      showAuth('请先输入电脑的访问地址');
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
  // 扫码 / 重连入口恒显，且放在任何异步探测之前 —— 保证“连不上”的状态也能立即重新扫码，
  // 不依赖下面 /auth/status 的结果（它可能因网络/地址失效而拖慢或失败）。
  $('btn-retry').style.display = 'none';
  $('btn-scan').style.display = 'block';
  $('scan-hint').style.display = 'block';
  $('btn-gallery').style.display = 'block';
  $('pair-form').style.display = 'none'; // 手动输入配对码已移除
  const pwForm = $('pw-form');
  if (pwForm) pwForm.style.display = 'none'; // 密码模式已废弃；旧服务端残留时给出提示
  try {
    const st = await api('/auth/status');
    mode = st.mode;
  } catch {}
  const hasCam = canUseCamera();
  // 完全没有相机能力时才需要手动输入电脑地址
  const needBase = !base && !hasCam;
  const showPair = mode === 'pair';
  $('base-form').style.display = needBase ? 'block' : 'none';
  $('auth-sub').textContent = showPair
    ? '扫电脑面板上的二维码即可连接'
    : '请在电脑上重新开启“手机访问”后再扫码';
}

// 手动输入电脑地址已移除：扫码是唯一连接入口（配合「从相册选择二维码」）。
// 手机端不再暴露手输 URL，避免断开后误填导致连错主机。无相机能力时只提示去电脑端扫码。
// （保留 base-form 作为 PWA 同源/极少数无相机场景的兜底，但不渲染手动展开链接。）

// 重新连接：token 仍在但网络错误时，一键重试（不清 token、不重新扫码）。
// 会依次尝试所有已知地址（当前地址 → 最近可用的其它地址）。
$('btn-retry').addEventListener('click', () => {
  $('btn-retry').disabled = true;
  $('auth-status').textContent = '正在重新连接…';
  $('auth-status').className = 'status';
  (async () => {
    const r = await tryAllBases();
    if (r === 'ok') {
      showView('home');
      homePoll();
      return;
    }
    if (r === 'auth') {
      clearToken();
      showAuth('登录已失效，请重新扫码配对');
      return;
    }
    $('auth-status').textContent = '连接失败：所有已知地址均不可达，请检查网络后重试';
    $('auth-status').className = 'status err';
    $('btn-retry').style.display = 'block';
  })().finally(() => { $('btn-retry').disabled = false; });
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

$('btn-base-save').addEventListener('click', async () => {
  const v = $('base-input').value.trim();
  if (!/^https?:\/\/\S+$/i.test(v)) {
    $('auth-status').textContent = '地址格式不对，示例：http://192.168.1.5:3081';
    $('auth-status').className = 'status err';
    return;
  }
  try {
    setBase(v);
  } catch (e) {
    $('auth-status').textContent = '地址无效：' + e.message;
    $('auth-status').className = 'status err';
    return;
  }
  // 有 token：保存地址后直接尝试连接（无需重新扫码）
  token = localStorage.getItem(LS_TOKEN);
  if (token) {
    $('auth-status').textContent = '正在连接…';
    $('auth-status').className = 'status';
    const ok = await tryAllBases();
    if (ok) {
      showView('home');
      homePoll();
      return;
    }
    $('auth-status').textContent = '无法连接该地址，请确认电脑端“手机访问”已启动';
    $('auth-status').className = 'status err';
    return;
  }
  showAuth('');
});

function canUseCamera() {
  if (nativeScanner()) return true; // APK 原生扫码
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
}

function setBase(url) {
  const u = new URL(url);
  base = u.origin;
  localStorage.setItem(LS_BASE, base);
  rememberBase(base);
}

// ---------------------------------------------------------------------------
// 多地址记忆：电脑可能同时有 局域网地址 + 远程隧道地址。
// 隧道地址每次重启都会变，但局域网地址基本稳定 —— 手机记住所有地址，
// 连不上时按“最近可用”顺序自动换地址重试，而不是只能重新扫码。
// ---------------------------------------------------------------------------

function loadBases() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_BASES) || '[]');
    bases = Array.isArray(arr) ? arr.filter((b) => b && typeof b.url === 'string' && /^https?:\/\//.test(b.url)) : [];
  } catch { bases = []; }
  const cur = localStorage.getItem(LS_BASE);
  if (cur && !bases.some((b) => b.url === cur)) bases.unshift({ url: cur, lastOk: 0 });
}

function saveBases() {
  try {
    localStorage.setItem(LS_BASES, JSON.stringify(bases.slice(0, 6)));
  } catch {}
}

function rememberBase(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) return;
  bases = bases.filter((b) => b.url !== u);
  bases.unshift({ url: u, lastOk: Date.now() });
  saveBases();
}

function markBaseOk(url) {
  const u = String(url || '').replace(/\/+$/, '');
  const b = bases.find((x) => x.url === u);
  if (b) {
    b.lastOk = Date.now();
    bases.sort((a, c) => (c.lastOk || 0) - (a.lastOk || 0));
    saveBases();
  }
}

/** 把当前隧道公网地址同步进地址池（保持最新）。
 * 隧道地址每次桌面重启都会变，但手机只要连上（本地/隧道任一）就能从 /m/status
 * 拿到最新地址保存下来；之后切到蜂窝流量等局域网不可达的网络时，才能自动切到隧道，
 * 而不是死记旧的局域网地址导致“切网就断”。 */
function syncTunnelBase(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) return;
  const b = bases.find((x) => x.url === u);
  if (b) {
    b.lastOk = Date.now();
  } else {
    bases.unshift({ url: u, lastOk: Date.now() });
  }
  saveBases();
}

/** 所有已知地址（当前 base 优先，其余按最近可用排序）。
 * 局域网地址（http://IP）比隧道地址（https://*.trycloudflare.com）稳定：
 * 隧道地址每次重启都会变 —— 当前 base 是隧道时，先试局域网，
 * 能连上就省去等待死隧道超时；当前 base 是局域网时直接秒连。 */
function candidateBases() {
  const lan = (u) => !isTunnelUrl(u);
  const cur = base;
  const others = [...bases]
    .filter((b) => b.url && b.url !== cur)
    .sort((a, c) => (c.lastOk || 0) - (a.lastOk || 0));
  const out = [];
  if (cur) {
    if (lan(cur)) {
      out.push(cur);
      // 其余：局域网优先（稳定，重启后隧道地址变化但局域网不变），再按最近可用
      out.push(...others.filter((b) => lan(b.url)).map((b) => b.url));
      out.push(...others.filter((b) => !lan(b.url)).map((b) => b.url));
    } else {
      // 当前是隧道（重启后大概率已失效）：先试局域网，再当前隧道，最后其它隧道
      out.push(...others.filter((b) => lan(b.url)).map((b) => b.url));
      out.push(cur);
      out.push(...others.filter((b) => !lan(b.url)).map((b) => b.url));
    }
  } else {
    // PWA 同源场景（base 为空且页面由电脑的 3081 服务提供）：直接用当前页面源。
    // 排除 Capacitor WebView 自身的 https://localhost（那不是电脑地址）。
    if (location && /^http:/.test(location.protocol) && !/localhost|127\.0\.0\.1/.test(location.hostname || '')) {
      out.push(location.origin);
    }
    out.push(...others.filter((b) => lan(b.url)).map((b) => b.url));
    out.push(...others.filter((b) => !lan(b.url)).map((b) => b.url));
  }
  return [...new Set(out)];
}

function isTunnelUrl(u) {
  return /trycloudflare\.com/i.test(String(u || ''));
}

/** 当前地址属于哪条连接路径（用于首页/设置显示"正在用哪条路"）。 */
function connLabel(u) {
  if (!u) return '未连接';
  if (isTunnelUrl(u)) return '隧道（兜底）';
  if (/^https?:\/\/\[[0-9a-fA-F:]+\]/.test(String(u))) return 'IPv6 直连';
  if (/^https?:\/\//.test(String(u))) return '局域网直连';
  return '未知';
}

/** 带超时的探测请求（不触发 api() 的 401 清理逻辑；失败返回 null 而非抛错）。 */
async function probeBase(url, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url + '/auth/me', {
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (res.status === 401) return { status: 401 };
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.device ? { status: 200, data } : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

/**
 * 依次尝试所有已知地址，找到第一个能连上的并切换过去。
 * @returns {Promise<string>} 'ok'（已连上）| 'auth'（地址可达但 token 被吊销）| 'fail'
 */
async function tryAllBases() {
  const cands = candidateBases();
  let saw401 = false;
  for (let i = 0; i < cands.length; i++) {
    const u = cands[i];
    // 当前地址（可能刚死的隧道）用短超时快速失败，尽快切到局域网
    const r = await probeBase(u, i === 0 ? 2500 : 4000);
    if (r && r.status === 200 && r.data) {
      if (base !== u) {
        base = u;
        localStorage.setItem(LS_BASE, u);
      }
      markBaseOk(u);
      device = r.data.device;
      mode = r.data.mode;
      saveToken(token, device);
      return 'ok';
    }
    if (r && r.status === 401) saw401 = true;
  }
  return saw401 ? 'auth' : 'fail';
}

/**
 * 网络错误时的自动换地址：轮询发现当前地址连不上时调用。
 * 只尝试其它地址（当前地址刚失败，不重复试），成功则切换并通知界面。
 * @returns {Promise<boolean>}
 */
async function autoFailover() {
  if (failoverInFlight) return false;
  failoverInFlight = true;
  try {
    const others = bases
      .map((b) => b.url)
      .filter((u) => u && u !== base)
      .sort((a, c) => (isTunnelUrl(a) ? 1 : 0) - (isTunnelUrl(c) ? 1 : 0));
    for (const u of others) {
      const r = await probeBase(u, 3500);
      if (r && r.status === 200 && r.data) {
        base = u;
        localStorage.setItem(LS_BASE, u);
        markBaseOk(u);
        device = r.data.device;
        mode = r.data.mode;
        saveToken(token, device);
        toast('已自动切换连接地址');
        return true;
      }
      if (r && r.status === 401) {
        // 其它地址可达但 token 已被吊销 → 需要重新配对
        clearToken();
        showAuth('登录已失效，请重新扫码配对');
        return true;
      }
    }
  } finally {
    failoverInFlight = false;
  }
  return false;
}

// --- 网络变化自动重连：切换 WiFi/流量 等导致当前地址不可达时，主动切换到最优可用地址 ---
let lastNetChange = 0; // 限速，防止 connection.change 高频触发
let netSwitchBusy = false;
async function onNetChanged() {
  if (netSwitchBusy) return;
  const now = Date.now();
  if (now - lastNetChange < 2500) return; // 限速
  lastNetChange = now;
  netSwitchBusy = true;
  const prevBase = base;
  try {
    const res = await tryAllBases();
    if (res === 'ok') {
      if (base !== prevBase) toast('已切换连接方式：' + connLabel(base));
      if (currentView === 'home') homePoll();
      else if (currentView === 'chat') chatPoll();
      else if (currentView === 'settings') settingsPoll();
    }
  } catch {} finally {
    netSwitchBusy = false;
  }
}
function setupNetworkWatcher() {
  window.addEventListener('online', onNetChanged);
  try {
    if (navigator.connection && typeof navigator.connection.addEventListener === 'function') {
      navigator.connection.addEventListener('change', onNetChanged);
    }
  } catch {}
}

let lastLanProbe = 0; // 上次探测“局域网直连”的时间（限速）

/** 手机与电脑在同一 WiFi 时，自动改走局域网直连（192.168.x.x）而非隧道，
 * 避免消息往返 Cloudflare 导致的接收慢。仅在“当前是隧道地址且局域网可达”时切换。 */
async function preferLan() {
  if (!isTunnelUrl(base)) return false;           // 已在局域网直连（非隧道），无需切
  if (Date.now() - lastLanProbe < 15000) return false; // 15s 限速
  lastLanProbe = Date.now();
  const lanList = bases.filter((b) => !isTunnelUrl(b.url)).map((b) => b.url);
  if (!lanList.length) return false;
  for (const u of lanList) {
    const r = await probeBase(u, 2500);
    if (r && r.status === 200 && r.data) {
      base = u;
      localStorage.setItem(LS_BASE, u);
      markBaseOk(u);
      device = r.data.device;
      mode = r.data.mode;
      saveToken(token, device);
      toast('已切换到局域网直连（更快）');
      return true;
    }
  }
  return false;
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
    // 服务端把当前所有可用地址（局域网 IP + 远程隧道）一并返回：
    // 保存下来，之后连不上时自动换地址重试
    if (Array.isArray(data.urls)) {
      for (const u of data.urls) rememberBase(u);
    }
    rememberBase(base);
    $('auth-status').textContent = '配对成功！';
    $('auth-status').className = 'status ok';
    showView('home');
    homePoll();
    return true;
  } catch (e) {
    const isTimeout = e.name === 'AbortError';
    const isNetwork = e.name === 'TypeError' || /failed to fetch|network|load failed/i.test(String(e.message || ''));
    const hint = isNetwork
      ? '无法连接电脑：网络异常或该地址已失效。\n请确认电脑端「手机访问」已开启，并扫描电脑上最新的二维码；\n若手机与电脑在同一 WiFi，请改用局域网二维码。'
      : (isTimeout ? '电脑端未确认（超时），请重试' : e.message);
    $('auth-status').textContent = hint;
    $('auth-status').className = 'status err';
    if (!isTimeout) {
      reportError('连接电脑失败', hint + '\n请求地址：' + base + '/auth/pair');
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

if ($('btn-pw-login')) {
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
}

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

/** 展开手动输入兜底（没有地址时先让用户填电脑地址）。已不再渲染“手动输入”链接，仅保留无相机兜底。 */
function showManualFallback(hint) {
  $('btn-scan').style.display = 'none';
  $('scan-hint').style.display = 'none';
  const manual = $('btn-manual');
  if (manual) manual.style.display = 'none';
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
    await loadHiddenFromServer(); // 同步桌面端/共享隐藏名单
    renderSessions(data.items);
    const st = await api('/m/status');
    // 把最新隧道公网地址同步进地址池：之后切到蜂窝等局域网不可达的网络仍能连上
    if (st.tunnel && st.tunnel.url) syncTunnelBase(st.tunnel.url);
    const parts = [];
    if (st.dshUp) parts.push('电脑已连接');
    else parts.push('电脑服务未运行');
    parts.push('📶 ' + connLabel(base));
    if (st.tunnel && st.tunnel.url && !isTunnelUrl(base)) parts.push('隧道兜底可用');
    $('conn-bar').textContent = parts.join(' · ');
    // 同一 WiFi 时自动改用局域网直连（更快），切换成功后重新拉取
    preferLan().then((switched) => { if (switched) homePoll(); });
  } catch (e) {
    $('conn-bar').textContent = e.message;
    // 只有 401（token 被吊销）才清 token 重新配对；
    // 网络错误/隧道地址变化 → 保留 token，自动尝试其它已知地址
    if (e && e.code === 'AUTH_EXPIRED') {
      clearToken();
      showAuth('登录已失效，请重新配对');
      return;
    }
    autoFailover().then((switched) => {
      if (switched) {
        $('conn-bar').textContent = '已切换地址，正在重连…';
        homePoll();
      } else if (currentView === 'home') {
        // 所有已知地址都连不上：回到连接页（扫码/重试入口），但不清 token
        showAuth('连接已断开：电脑端可能已重启（远程地址变化）或网络不可达——请点「扫描电脑上的二维码」重新连接');
        $('btn-retry').style.display = 'block';
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 隐私模式：隐藏部分对话，进入需要隐蔽操作，退出一键。
//
//   · 把某个会话设为「隐藏」后，它不会出现在首页列表。
//   · 想看隐藏会话：在首页顶部标题「DeepSeek Harness」上快速连续点 5 下，
//     进入隐私模式（隐藏会话此时出现，顶部多一条提示 + 「一键退出」按钮）。
//   · 退出：点「一键退出」即回到普通列表。
//   · 隐藏 / 取消隐藏：会话 ⋮ 菜单，或会话行右侧的「👁/🔒」开关。
// ---------------------------------------------------------------------------

function loadPrivacy() {
  // active（是否处于隐私视图）是本机状态；隐藏名单由服务端共享（桌面+手机同源）。
  privacyActive = localStorage.getItem(LS_PRIVACY) === '1';
  hiddenSessions = new Set(); // 稍后从服务端拉取
  applyPrivacyUI();
}

/** 从服务端拉取共享的隐藏会话列表（桌面端改动也会同步到这里）。 */
async function loadHiddenFromServer() {
  // 刚本机写过分到服务端，服务端可能还是旧值；短暂跳过本轮，避免用旧值覆盖刚隐藏的状态
  if (Date.now() - lastHiddenWrite < 2500) return;
  try {
    const d = await api('/m/hidden');
    hiddenSessions = new Set(d && Array.isArray(d.hidden) ? d.hidden.filter((x) => typeof x === 'string') : []);
  } catch {
    // 网络/未登录时保留当前列表，等下次轮询再同步
  }
}

function savePrivacy() {
  // 仅持久化 active（本机）；隐藏名单直接写服务端，见 syncHiddenToServer()
  try { localStorage.setItem(LS_PRIVACY, privacyActive ? '1' : '0'); } catch {}
}

/** 把当前隐藏名单全量上报到共享存储（桌面端可读）。 */
function syncHiddenToServer() {
  lastHiddenWrite = Date.now();
  api('/m/hidden', { method: 'POST', body: JSON.stringify({ hidden: [...hiddenSessions] }) })
    .then(() => { lastHiddenWrite = Date.now(); })
    .catch(() => {});
}

function isHidden(sessionId) { return hiddenSessions.has(sessionId); }

/** 切换隐私模式，并同步界面（顶部提示条 + 退出按钮 + 重新渲染列表）。 */
function setPrivacy(active) {
  privacyActive = !!active;
  savePrivacy();
  applyPrivacyUI();
  if (currentView === 'home') {
    renderSessions(lastSessions.items || []);
    homePoll(); // 立即刷新（列表可能因过滤变化）
  }
}

function enterPrivacyMode() {
  setPrivacy(true);
  toast('已进入隐私模式，正在显示全部会话');
}

function exitPrivacyMode() {
  setPrivacy(false);
  toast('已退出隐私模式');
}

/** 隐藏 / 取消隐藏某个会话。 */
function toggleHideSession(sessionId) {
  if (!sessionId) return;
  if (hiddenSessions.has(sessionId)) {
    hiddenSessions.delete(sessionId);
    toast('已取消隐藏该会话');
  } else {
    hiddenSessions.add(sessionId);
    toast('已隐藏该会话，进入隐私模式可见');
  }
  syncHiddenToServer();
  if (currentView === 'home') renderSessions(lastSessions.items || []);
}

/** 根据 privacyActive 更新界面：顶部提示条 +「一键退出」按钮 + 空态文案。 */
function applyPrivacyUI() {
  const banner = $('privacy-banner');
  if (banner) banner.style.display = privacyActive ? 'flex' : 'none';
  document.body.classList.toggle('privacy-on', privacyActive);
  const t = $('home-empty-text');
  if (t) t.textContent = '还没有会话';
}

$('btn-privacy-exit').addEventListener('click', exitPrivacyMode);

// 隐蔽入口：在首页顶部标题上快速连续点 5 下进入隐私模式。
(function setupPrivacyEntry() {
  const brand = document.querySelector('#view-home .brand');
  if (!brand) return;
  let taps = 0;
  let lastTap = 0;
  brand.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap > 900) taps = 0; // 停顿即重新计数
    lastTap = now;
    taps += 1;
    if (taps >= 5) {
      taps = 0;
      enterPrivacyMode();
    }
  });
})();

function renderSessions(items) {
  const list = $('session-list');
  const all = items || [];
  // 普通模式：隐藏被标记为隐私的会话；隐私模式：显示全部（含隐藏会话，隐藏会话带标识）。
  const visible = all.filter((s) => (privacyActive ? true : !isHidden(s.sessionId)));
  $('home-empty').style.display = visible.length ? 'none' : 'flex';
  list.innerHTML = '';
  const seen = new Set();
  for (const s of visible) {
    if (seen.has(s.sessionId)) continue;
    // 子智能体会话（origin === 'subagent'）不显示在主会话列表里，避免同一任务
    // 派生出的多个子对话刷屏。子 agent 的进展在父会话里以消息形式呈现。
    if (s.origin === 'subagent') continue;
    seen.add(s.sessionId);
    const hid = isHidden(s.sessionId);
    const item = document.createElement('div');
    item.className = 'session-item' + (hid ? ' hidden-item' : '');
    const badges = [];
    if (hid) badges.push('<span class="badge priv">🔒 隐私</span>');
    if (s.running) badges.push('<span class="badge run">运行中</span>');
    if (s.pendingApprovals || s.pendingQuestions) badges.push('<span class="badge pending">待处理</span>');
    // 上下文用量：进度条 + 已用/上限（无数据时不显示）
    let ctxHtml = '';
    if (s.context && s.context.contextWindow) {
      const pct = Math.min(100, Math.max(0, s.context.percent || 0));
      const warn = pct >= 80 ? ' warn' : pct >= 50 ? ' mid' : '';
      ctxHtml = `
        <div class="ctx-meter${warn}">
          <div class="ctx-bar"><div class="ctx-fill" style="width:${pct}%"></div></div>
          <span class="ctx-text">${fmtTokens(s.context.usedTokens)} / ${fmtTokens(s.context.contextWindow)}</span>
        </div>`;
    } else if (s.tokens) {
      // 无上下文压力数据时回退显示累计用量
      ctxHtml = `<div class="ctx-meter"><span class="ctx-text">Σ ${fmtTokens(s.tokens.input)} in / ${fmtTokens(s.tokens.output)} out</span></div>`;
    }
    item.innerHTML = `
      <div class="si-main">
        <div class="si-title">${esc(s.title)}</div>
        <div class="si-sub">${esc(s.cwd || '')}</div>
        <div class="si-badges">${badges.join('')}</div>
        ${ctxHtml}
      </div>
      <div class="si-side">
        <button class="si-eye${hid ? ' locked' : ''}" data-hide="${esc(s.sessionId)}"
          title="${hid ? '取消隐藏' : '隐藏此会话'}">${hid ? '🔒' : '👁'}</button>
        <div class="si-time">${fmtTime(s.updatedAt)}</div>
      </div>`;
    item.addEventListener('click', () => openChat(s.sessionId, s.title));
    list.appendChild(item);
  }
  // 行内隐藏/取消隐藏开关（阻止冒泡，避免误触发打开会话）
  list.querySelectorAll('[data-hide]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHideSession(b.dataset.hide);
    });
  });
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 紧凑 token 数：517 / 12.2K / 517K / 1.2M（与桌面端 formatTokens 一致）。 */
function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (n < 1e3) return String(n);
  if (n < 1e6) return `${scaled(n / 1e3)}K`;
  return `${scaled(n / 1e6)}M`;
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

// --- 新建会话时是否作为"隐藏"会话创建（隐私模式下默认开启） ---
let createAsHidden = false;

// ---------------------------------------------------------------------------
// 新建会话：选文件夹（电脑上已配置的工作区）
// ---------------------------------------------------------------------------

async function openNew() {
  showView('new');
  const list = $('workspace-list');
  list.innerHTML = '<div class="empty">加载中…</div>';
  loadPresetOptions();
  // 隐私模式下新建会话默认作为"隐藏"会话创建，用户在新建页可取消勾选
  const toggle = $('priv-new-toggle');
  const check = $('priv-new-check');
  if (toggle && check) {
    toggle.style.display = privacyActive ? 'flex' : 'none';
    check.checked = privacyActive;
    createAsHidden = privacyActive;
  }
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

$('priv-new-check').addEventListener('change', (e) => {
  createAsHidden = e.target.checked;
  toast(createAsHidden ? '该会话将以隐藏状态创建' : '该会话将以正常状态创建');
});

// ---------------------------------------------------------------------------
// 会话详情
// ---------------------------------------------------------------------------

function openChat(sessionId, title) {
  currentSessionId = sessionId;
  $('chat-title-text').textContent = title || '新会话';
  pendingList = { approvals: [], questions: [] };
  pendingOutgoing = []; // 切会话时清空本地待发送气泡
  questionPage = 0;
  $('composer-input').value = '';
  clearPendingImages();
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
    renderMessages(chatMsgs, { scrollToBottom: true });
    $('chat-sub').textContent = '同步中…';
  } else {
    $('messages').innerHTML = '<div class="empty" style="padding:48px 0">加载中…</div>';
  }
  $('composer-input').focus();
  justOpenedChat = true; // 首次拉取最新消息后强制滚到底部，避免停留在中间
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
    // 问题/审批改为内联进消息流（可滚动），并重置分页到已回答后的有效范围
    pendingList = { approvals: data.pendingApprovals || [], questions: data.pendingQuestions || [] };
    if (questionPage >= pendingList.questions.length) questionPage = Math.max(0, pendingList.questions.length - 1);
    renderPending();
    // 运行状态与输入框快捷按钮：同步一次会话列表（轻量），刷新"停止"按钮与 Agent 预设名
    try {
      const s = await api('/m/sessions');
      lastSessions = s;
    } catch {}
    // 限速同步最新隧道地址（每 30s 一次）：切到蜂窝等网络时能自动切到隧道，避免断连
    if (Date.now() - lastTunnelSync > 30000) {
      lastTunnelSync = Date.now();
      api('/m/status').then((st) => { if (st.tunnel && st.tunnel.url) syncTunnelBase(st.tunnel.url); }).catch(() => {});
    }
    // 同一 WiFi 时自动改用局域网直连（更快），切换成功后重新拉取消息
    preferLan().then((switched) => { if (switched) chatPoll(); });
    const info = lastSessions.items.find((s) => s.sessionId === currentSessionId);
    sessionRunning = !!(info && info.running);
    if (info && info.agentPreset) updatePresetChip(info.agentPreset);
    updateStopButton();
    const ctx = info && info.context;
    // agent 状态：运行中且已产出文本 → 接收信息中；运行中尚无文本 → 思考中。
    // 显示在对话流末尾（agentStatus 由 renderMessages 渲染成占位行），不放到菜单栏。
    let st = '';
    if (sessionRunning) {
      const lastAsst = [...chatMsgs].reverse().find((m) => m.kind === 'assistant' && m.text && m.text.trim());
      st = (lastAsst && lastAsst.text && lastAsst.text.trim()) ? '📥 接收信息中…' : '🤔 思考中…';
    }
    if (st !== agentStatus) {
      agentStatus = st;
      renderMessages(chatMsgs); // 状态变化时重渲染，把占位行加到对话流末尾
      renderPending();
    }
    const subParts = [];
    if (sessionRunning) subParts.push('● 运行中');
    if (ctx && ctx.contextWindow) subParts.push(`🧠 ${fmtTokens(ctx.usedTokens)} / ${fmtTokens(ctx.contextWindow)} (${Math.min(100, ctx.percent || 0)}%)`);
    $('chat-sub').innerHTML = subParts.join(' · ');
  } catch (e) {
    // 会话可能刚创建；忽略瞬时错误。连续网络错误 → 尝试自动换地址
    if (e && e.code === 'AUTH_EXPIRED') {
      clearToken();
      showAuth('登录已失效，请重新配对');
      return;
    }
    autoFailover().then((switched) => {
      if (switched) {
        $('chat-sub').textContent = '⚠ 已切换地址，正在重连…';
        chatPoll();
      }
    });
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
  // 先做 pending 去重（渲染真实消息前）：服务端回显同文本用户消息已到 → 立即移除对应 pending 气泡，
  // 避免同一句话瞬间出现两条。回显不带图片，故把 pending 里的图片记到 echoImgs 补回回显气泡。
  const consumed = new Set();
  const echoImgs = {};
  {
    const kept = [];
    for (const o of pendingOutgoing) {
      let dup = false;
      if (o.text && o.text.trim()) {
        const refSeq = o.refSeq || 0;
        // 只匹配“发送之后新到的回显”（seq > refSeq），避免误匹配到更早的同文本历史
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m && m.kind === 'user' && String(m.text || '') === String(o.text) && (m.seq || 0) > refSeq && !consumed.has(i)) {
            consumed.add(i); dup = true;
            if (o.images && o.images.length) echoImgs[i] = o.images;
            break;
          }
        }
      }
      if (!dup) kept.push(o);
    }
    pendingOutgoing = kept;
  }
  let lastToolIdx = -1;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.kind === 'system') {
      // 系统消息（dsh 注入的上下文快照/策略变化等）：居中灰色小字，不冒充用户输入
      const div = document.createElement('div');
      div.className = 'msg system';
      div.innerHTML = `<div class="sys-line">${esc(m.text)}</div>`;
      box.appendChild(div);
    } else if (m.kind === 'user') {
      // 图片专用消息（无文字）在折叠历史里不带图片，会渲染成空泡；跳过（回显气泡已补回图片）
      if (!m.text || !m.text.trim()) continue;
      const imgHtml = echoImgs[mi] ? `<div class="out-images">${echoImgs[mi].map((s) => `<img src="${s}" class="ap-thumb" />`).join('')}</div>` : '';
      const div = document.createElement('div');
      div.className = 'msg user';
      div.innerHTML = `<div class="bubble bubble-md">${renderMarkdown(m.text)}${imgHtml}</div>`;
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
        // 统一用字符串作 key（与点击事件的 dataset.seq 一致，Set.has 才匹配得上）
        const seqKey = String(m.seq !== undefined ? m.seq : (m.time || ''));
        if (full.length > LONG_MSG_LIMIT && !expandedLongMsgs.has(seqKey)) {
          // 长输出（如压缩命令的完整结果）默认折叠，避免刷屏；点击可展开。
          // 折叠时仍渲染完整 markdown（CSS 高度截断），保证格式始终可见，
          // 而不是先显示纯文本预览、展开后才变成 markdown。
          parts.push(
            `<div class="bubble bubble-md msg-folded">${renderMarkdown(full)}</div>` +
            `<button type="button" class="msg-expand" data-seq="${esc(seqKey)}">展开全部（${full.length} 字）</button>`
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
  // 本地待发送气泡（发送中转圈 / 已发送 / 失败）：排在消息流末尾。
  // 注意：去重+图片补回已在上面完成，这里只渲染真正的 pendingOutgoing（kept）。
  if (pendingOutgoing.length) {
    for (const o of pendingOutgoing) {
      const div = document.createElement('div');
      div.className = 'msg user pending-out';
      const imgHtml = (o.images && o.images.length)
        ? `<div class="out-images">${o.images.map((s) => `<img src="${s}" class="ap-thumb" />`).join('')}</div>` : '';
      const st = o.status === 'sending'
        ? '<span class="out-status sending"><span class="spin"></span>发送中…</span>'
        : o.status === 'sent'
          ? '<span class="out-status sent">✓ 已发送</span>'
          : `<span class="out-status fail">✗ ${esc(o.err || '发送失败')}</span>`;
      div.innerHTML = `<div class="bubble bubble-md">${renderMarkdown(o.text)}${imgHtml}</div>${st}`;
      box.appendChild(div);
    }
  }
  // agent 运行状态：作为对话流末尾的占位行显示（接收信息中 / 思考中），而不是放在菜单栏
  if (agentStatus) {
    const div = document.createElement('div');
    div.className = 'msg agent-status';
    div.innerHTML = `<div class="agent-line">${esc(agentStatus)}</div>`;
    box.appendChild(div);
  }
  const snapBottom = () => { box.scrollTop = box.scrollHeight; };
  if (opts.keepPosition) {
    box.scrollTop += box.scrollHeight - oldHeight; // 顶部插入更早消息后保持视觉位置
  } else if (justOpenedChat || opts.scrollToBottom) {
    // 进入会话/首次加载：强制滚到最新（底部），避免停留在中间；rAF 再断言，防图片/布局未完成
    snapBottom();
    requestAnimationFrame(snapBottom);
    justOpenedChat = false;
  } else if (nearBottom) {
    snapBottom();
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
// 注意：data-* 属性取值永远是字符串，而 seqKey 是数字 —— 这里统一转字符串再比较，
// 否则 Set.has(数字) 永远匹配不到已加入的字符串，导致“展开全部”点了没反应。
$('messages').addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.msg-expand');
  if (!btn) return;
  const seq = String(btn.dataset.seq);
  if (seq !== 'undefined') expandedLongMsgs.add(seq);
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
/** 把“回到最新”按钮紧贴输入框（含图片按钮/预览框）上方，避免与它们重叠。 */
function positionScrollBottom() {
  const btn = $('btn-scroll-bottom');
  const composer = document.querySelector('.composer');
  if (btn && composer) {
    // composer 高度动态（图片预览框/多行文本会增高），让按钮始终悬停在 composer 上沿之上一点。
    btn.style.bottom = (composer.offsetHeight + 12) + 'px';
  }
}

function updateScrollBottom() {
  const box = $('messages');
  const btn = $('btn-scroll-bottom');
  if (!btn) return;
  positionScrollBottom();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  btn.style.display = nearBottom ? 'none' : 'flex';
}

$('btn-scroll-bottom').addEventListener('click', () => {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
  updateScrollBottom();
});

// composer 高度变化（图片预览框出现/增删、多行文本增高）时，同步调整“回到最新”按钮贴齐位置
(function watchComposerHeight() {
  const composer = document.querySelector('.composer');
  if (composer && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => positionScrollBottom());
    ro.observe(composer);
  }
})();

function qDraftOf(id) {
  if (!qDrafts[id]) qDrafts[id] = { selected: [], custom: '', skipped: false };
  return qDrafts[id];
}

/** 从 pendingList.questions 里按 rpcId 找到问题组。 */
function findQuestionGroup(rpcId) {
  return (pendingList.questions || []).find((x) => x.questionRpcId === rpcId);
}

/** 提交整个问题组的答案（与桌面端 submitDrafts 一致：全部子问题一次提交，含 skipped/自定义）。 */
async function submitQuestionGroup(group) {
  const groupRpcId = group.questionRpcId;
  const subs = group.questions || [];
  let missing = -1;
  const answers = subs.map((sub, i) => {
    const d = qDraftOf(sub.id);
    const custom = (d.custom || '').trim();
    const done = d.skipped || d.selected.length > 0 || custom !== '';
    if (!done && missing < 0) missing = i;
    if (d.skipped) return { id: sub.id, selected: [] };
    return {
      id: sub.id,
      selected: (custom === '' || sub.multiSelect === true) ? d.selected : [],
      ...(custom === '' ? {} : { custom }),
    };
  });
  if (missing >= 0) {
    toast('请先完成第 ' + (missing + 1) + ' 题（或点跳过本题）');
    return;
  }
  try {
    const res = await api('/m/answer-question', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentSessionId, questionRpcId: groupRpcId, answers }),
    });
    if (res && res.accepted) {
      toast('已提交');
      qDrafts = {}; qDraftGroup = null;
      pendingList.questions = pendingList.questions.filter((x) => x.questionRpcId !== groupRpcId);
      if (questionPage >= pendingList.questions.length) questionPage = Math.max(0, pendingList.questions.length - 1);
      chatPoll();
    } else {
      toast('服务端未接受本次回答，请在电脑端处理');
    }
  } catch (e) {
    showErr('提交失败', e, '请在电脑端回答该问题');
  }
}

/** 放弃整组问题（对应桌面端“放弃整组问题/取消”）。 */
async function dismissQuestionGroup(groupRpcId) {
  try {
    const res = await api('/m/cancel-question', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentSessionId, questionRpcId: groupRpcId }),
    });
    if (res && res.accepted) {
      toast('已放弃该组问题');
      qDrafts = {}; qDraftGroup = null;
      pendingList.questions = pendingList.questions.filter((x) => x.questionRpcId !== groupRpcId);
      if (questionPage >= pendingList.questions.length) questionPage = Math.max(0, pendingList.questions.length - 1);
      chatPoll();
    } else {
      toast('无法放弃，请到电脑端处理');
    }
  } catch (e) {
    showErr('放弃失败', e, '请在电脑端处理该问题');
  }
}

function renderPending() {
  const box = $('messages');
  if (!box) return;
  // 问题/审批卡片内联进消息流：先清掉旧卡片，再按当前待回应项追加到对话末尾，
  // 让它像普通消息一样可滚动，而不是固定在消息列表上方（常驻前台）。
  box.querySelectorAll('.pending-card').forEach((n) => n.remove());
  const approvals = pendingList.approvals || [];
  const questions = pendingList.questions || [];
  if (!approvals.length && !questions.length) return;

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
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

  if (questions.length) {
    const total = questions.length;
    const page = Math.min(Math.max(0, questionPage), total - 1);
    const group = questions[page];
    const groupRpcId = group.questionRpcId;
    // 切到新问题组时清空旧组草稿
    if (qDraftGroup !== groupRpcId) { qDrafts = {}; qDraftGroup = groupRpcId; }
    const subs = (group.questions || []);
    const subHtml = subs.map((sub) => {
      const sid = sub.id;
      const d = qDraftOf(sid);
      const multi = sub.multiSelect === true;
      const opts = (sub.options || []).map((o) => {
        const sel = d.selected.includes(o.label) ? ' q-opt-sel' : '';
        return `<button class="q-opt${sel}" data-q="${esc(groupRpcId)}" data-id="${esc(sid)}" data-opt="${esc(o.label)}" data-multi="${multi ? '1' : ''}">
          <span class="qo-label">${esc(o.label)}</span>
          ${o.description ? '<span class="qo-desc">' + esc(o.description) + '</span>' : ''}
        </button>`;
      }).join('');
      const cid = 'q-custom-' + String(groupRpcId).replace(/[^\w-]/g, '_') + '-' + String(sid).replace(/[^\w-]/g, '_');
      return `<div class="q-sub">
        <h4>❓ ${esc(sub.question)}</h4>
        ${sub.description ? '<div class="p-text">' + esc(sub.description) + '</div>' : ''}
        ${sub.options && sub.options.length ? `<div class="q-options">${opts}</div>` : ''}
        <div class="q-custom">
          <input type="text" id="${cid}" data-draft-id="${esc(sid)}" class="q-custom-input" placeholder="自定义回答（或补充说明）" />
          <button class="q-custom-send" data-q="${esc(groupRpcId)}" data-id="${esc(sid)}" data-custom-id="${cid}">✍️ 发送</button>
        </div>
        <div class="p-actions"><button class="q-skip" data-q="${esc(groupRpcId)}" data-id="${esc(sid)}">跳过本题</button></div>
      </div>`;
    }).join('');
    html += `<div class="pending-card question-card">
      <h4>🤖 需要你回答${subs.length > 1 ? '（' + subs.length + ' 题）' : ''}</h4>
      ${subHtml}
      ${total > 1 ? `<div class="q-pager">
        <button class="q-prev" data-qprev="1" ${page <= 0 ? 'disabled' : ''}>‹ 上一组</button>
        <span class="q-page">第 ${page + 1} / ${total} 组</span>
        <button class="q-next" data-qnext="1" ${page >= total - 1 ? 'disabled' : ''}>下一组 ›</button>
      </div>` : ''}
      <div class="p-actions">
        <button class="q-submit" data-q="${esc(groupRpcId)}">✅ 提交答案</button>
        <button class="q-dismiss" data-q="${esc(groupRpcId)}">✖ 放弃整组</button>
      </div>
    </div>`;
  }

  box.insertAdjacentHTML('beforeend', html);

  // 恢复自定义回答输入框的已输入草稿（组内多题时切换选项/子题重渲染不丢失）
  box.querySelectorAll('.pending-card .q-custom-input[data-draft-id]').forEach((inp) => {
    const d = qDrafts[inp.dataset.draftId];
    if (d && d.custom) inp.value = d.custom;
  });

  box.querySelectorAll('.pending-card [data-approval]').forEach((btn) => {
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
        showErr('应答失败', e, '请在电脑端处理该审批');
      }
    });
  });
  // 选项按钮：单选立即写入草稿；若该组只有 1 个子问题且非多选 → 直接提交（一次点击完成）；
  // 否则仅打勾，等“提交答案”。
  box.querySelectorAll('.pending-card [data-q][data-opt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = findQuestionGroup(btn.dataset.q);
      if (!group) return;
      const sub = (group.questions || []).find((s) => String(s.id) === String(btn.dataset.id));
      if (!sub) return;
      const d = qDraftOf(sub.id);
      const multi = sub.multiSelect === true;
      const label = btn.dataset.opt;
      if (multi) {
        d.selected = d.selected.includes(label) ? d.selected.filter((x) => x !== label) : [...d.selected, label];
      } else {
        d.selected = [label];
        d.custom = '';
      }
      d.skipped = false;
      if (!multi && (group.questions || []).length === 1) {
        submitQuestionGroup(group);
      } else {
        renderPending();
      }
    });
  });
  // 自定义回答发送：写入草稿 custom，单选时清空 selected
  box.querySelectorAll('.pending-card [data-custom-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = findQuestionGroup(btn.dataset.q);
      if (!group) return;
      const sub = (group.questions || []).find((s) => String(s.id) === String(btn.dataset.id));
      if (!sub) return;
      const input = $(btn.dataset.customId);
      const custom = input ? input.value.trim() : '';
      if (!custom) { toast('请先输入自定义回答'); if (input) input.focus(); return; }
      const d = qDraftOf(sub.id);
      d.custom = custom;
      if (sub.multiSelect !== true) d.selected = [];
      d.skipped = false;
      renderPending();
    });
  });
  // 跳过本题：标记该子问题为跳过；单子问题组直接提交整组
  box.querySelectorAll('.pending-card [data-q][data-id].q-skip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = findQuestionGroup(btn.dataset.q);
      if (!group) return;
      const sub = (group.questions || []).find((s) => String(s.id) === String(btn.dataset.id));
      if (!sub) return;
      const d = qDraftOf(sub.id);
      d.selected = []; d.custom = ''; d.skipped = true;
      if ((group.questions || []).length === 1) {
        submitQuestionGroup(group);
      } else {
        renderPending();
      }
    });
  });
  // 提交答案（整组）
  box.querySelectorAll('.pending-card [data-q].q-submit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = findQuestionGroup(btn.dataset.q);
      if (group) submitQuestionGroup(group);
    });
  });
  // 放弃整组（对应桌面端取消，取消整个 ask_user_question）
  box.querySelectorAll('.pending-card [data-q].q-dismiss').forEach((btn) => {
    btn.addEventListener('click', () => { dismissQuestionGroup(btn.dataset.q); });
  });
  // 多组问题分页导航（上一组 / 下一组）
  box.querySelectorAll('.pending-card [data-qprev]').forEach((btn) => {
    btn.addEventListener('click', () => { if (questionPage > 0) { questionPage -= 1; renderPending(); } });
  });
  box.querySelectorAll('.pending-card [data-qnext]').forEach((btn) => {
    btn.addEventListener('click', () => { if (questionPage < pendingList.questions.length - 1) { questionPage += 1; renderPending(); } });
  });

  if (nearBottom) box.scrollTop = box.scrollHeight;
}

$('btn-back').addEventListener('click', () => { showView('home'); homePoll(); });

function sendMessage() {
  const text = $('composer-input').value.trim();
  const images = pendingImages.slice();
  if (!text && !images.length) return;
  const btn = $('btn-send');
  btn.disabled = true;
  const isNewSend = !currentSessionId; // 本次是否新建会话（尚无 sessionId）
  const payload = { text, images };
  if (currentSessionId) payload.sessionId = currentSessionId;
  else if (currentWsId) payload.workspaceId = currentWsId;
  if (!currentSessionId && currentPreset) payload.agentPreset = currentPreset; // 新建会话指定预设
  // 会话运行中 → 插话发送（steer）：消息插入 agent 正在执行的下一步，优先处理；
  // 空闲 → 普通排队（queue）。
  if (currentSessionId && sessionRunning) payload.mode = 'steer';
  // 本地“发送中”气泡：立即显示转圈，成功后“已发送”，失败显示“发送失败”
  const outId = 'out-' + (outSeq++);
  pendingOutgoing.push({ id: outId, text, images, status: 'sending', refSeq: lastRealUserSeq(chatMsgs) });
  renderMessages(chatMsgs);
  $('composer-input').value = '';
  clearPendingImages();
  api('/m/send', { method: 'POST', body: JSON.stringify(payload) })
    .then((r) => {
      const o = pendingOutgoing.find((x) => x.id === outId);
      if (o) o.status = 'sent';
      renderMessages(chatMsgs);
      if (isNewSend && r.sessionId) {
        currentSessionId = r.sessionId;
        $('chat-title-text').textContent = '新会话';
        // 新建的会话按需作为"隐藏"会话（隐私模式下默认勾选，新建页可取消）
        if (createAsHidden) {
          hiddenSessions.add(r.sessionId);
          syncHiddenToServer();
        }
      }
      if (payload.mode === 'steer') toast('⏩ 已插话，agent 将优先处理');
      // 服务端已回显 → 短暂保留“已发送”后移除本地气泡
      setTimeout(() => {
        const idx = pendingOutgoing.findIndex((x) => x.id === outId);
        if (idx >= 0 && pendingOutgoing[idx].status === 'sent') pendingOutgoing.splice(idx, 1);
        renderMessages(chatMsgs);
      }, 1800);
      setTimeout(chatPoll, 300);
    })
    .catch((e) => {
      const o = pendingOutgoing.find((x) => x.id === outId);
      if (o) { o.status = 'failed'; o.err = e && e.message ? e.message : '发送失败'; }
      // 还原输入内容与图片，方便直接重试
      $('composer-input').value = text;
      if (images.length) {
        pendingImages = images.slice();
        renderAttachPreview();
      }
      renderMessages(chatMsgs);
      showErr('发送失败', e);
    })
    .finally(() => { btn.disabled = false; });
}

$('btn-send').addEventListener('click', sendMessage);

/** 最近一条真实用户消息的 seq（用于判断回显是否“晚于本次发送”，避免误匹配到更早的同文本历史）。 */
function lastRealUserSeq(msgs) {
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.kind === 'user' && m.seq !== undefined) return m.seq;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 发送图片（vision 输入）：选图 → 压缩成 base64 data URL → 预览 → 随消息发送
// ---------------------------------------------------------------------------

/** 渲染待发送图片预览（缩略图 + 移除按钮）。 */
function renderAttachPreview() {
  const box = $('attach-preview');
  box.style.display = pendingImages.length ? 'flex' : 'none';
  box.innerHTML = pendingImages.map((img, i) => `
    <div class="ap-item">
      <img src="${img}" class="ap-thumb" />
      <button class="ap-remove" data-i="${i}" title="移除">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      pendingImages.splice(Number(b.dataset.i), 1);
      renderAttachPreview();
    });
  });
}

function clearPendingImages() {
  pendingImages = [];
  renderAttachPreview();
}

/** 读取图片文件，统一转成 JPEG data URL（dsh 的 session.prompt 只接受
 * image/png|jpeg|webp|gif，且手机端相册常见 HEIC 等格式必须归一化到 jpeg 才合法）。
 * 先按宽度缩到合理范围，再按字节上限循环缩放。 */
function imgFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.onload = () => {
        let { width, height } = img;
        const maxSide = 1600;
        if (Math.max(width, height) > maxSide) {
          const ratio = maxSide / Math.max(width, height);
          height = Math.round(height * ratio);
          width = Math.round(width * ratio);
        }
        // 一律重绘成 JPEG；超限再循环缩小。
        let scale = 1, out = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          out = canvas.toDataURL('image/jpeg', 0.85);
          if (out.length * 3 / 4 <= MAX_IMG_BYTES) break;
          scale *= 0.7;
        }
        resolve(out || '');
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function onAttachSelected(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  for (const file of files) {
    if (pendingImages.length >= MAX_ATTACH) { toast('最多附 ' + MAX_ATTACH + ' 张图'); break; }
    try {
      const url = await imgFileToDataUrl(file);
      pendingImages.push(url);
    } catch (err) {
      toast(err.message || '图片处理失败');
    }
  }
  renderAttachPreview();
}

$('chip-attach').addEventListener('click', () => $('attach-input').click());
$('attach-input').addEventListener('change', onAttachSelected);

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

/** 权限按钮：显示当前权限模式名，点按打开权限选择器。
 * 聊天页显示当前会话的权限；设置页显示全局默认。 */
async function updatePermChip() {
  try {
    const q = currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : '';
    const p = await api('/m/permission' + q);
    currentPerm = p.current || '';
  } catch {}
  $('chip-perm').textContent = '🔒 ' + (PERM_LABELS[currentPerm] || currentPerm || '权限');
}

/** 停止按钮：会话运行中显示，空闲时隐藏。发送键同时切换为“插话”。 */
function updateStopButton() {
  $('btn-stop').style.display = sessionRunning ? 'block' : 'none';
  $('btn-send').textContent = sessionRunning ? '插话' : '发送';
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
  // 聊天页：当前会话权限；新建会话（无 sessionId）前：全局默认
  openPermissionPicker(currentSessionId);
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
    cmdErr[sessionId] = null;
  } catch (e) {
    cmdCache[sessionId] = []; // 拉取失败时只有本地命令可用
    cmdErr[sessionId] = e; // 保留错误，命令菜单里点击可弹窗复制具体原因（如 404）
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
  // 服务端命令列表若加载失败（如 /m/commands 404），在菜单顶部放一个可点开复制的错误项，
  // 让用户能看到、复制具体原因，而不是只显示本地 /cancel。
  const cmdError = cmdErr[currentSessionId];
  let errHtml = '';
  if (cmdError && (items.length === 0 || !q)) {
    errHtml = `<button class="cmd-item cmd-err" data-err="1">
      <span class="ci-label">⚠ 服务端命令加载失败</span>
      <span class="ci-desc">点我查看/复制具体原因</span>
    </button>`;
  }
  if (!items.length && !errHtml) { hideCmdPopup(); return; }
  box.innerHTML = errHtml + items.map((c, i) => `
    <button class="cmd-item" data-i="${i}">
      <span class="ci-label">${c.key}</span>
      <span class="ci-desc">${esc(c.desc)}</span>
    </button>`).join('');
  box.style.display = 'block';
  if (cmdError) {
    const eb = box.querySelector('[data-err]');
    if (eb) eb.addEventListener('click', () => {
      hideCmdPopup();
      showErr('服务端命令加载失败', cmdError, '请把以上内容发给我排查');
    });
  }
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
    const r = await api('/m/command', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentSessionId, line }),
      // /compact 等慢命令：放宽超时到 3 分钟，且禁止"超时自动重发"（重发会执行两遍、第二次撞 busy）
      _timeoutMs: 180000,
      _noRetry: true
    });
    clearPendingCmd();
    if (r.text) toast(r.text.slice(0, 120));
    setTimeout(chatPoll, 300);
  } catch (e) {
    clearPendingCmd();
    showErr('执行命令失败', e, '命令：' + line);
  }
}

/** 直接发送文本（由 agent 解析的命令等）。 */
function sendRaw(text) {
  if (!currentSessionId) return;
  api('/m/send', { method: 'POST', body: JSON.stringify({ sessionId: currentSessionId, text }) })
    .then(() => { setTimeout(chatPoll, 300); })
    .catch((e) => showErr('发送失败', e, '内容：' + text));
}

async function cancelChat() {
  if (!currentSessionId) return;
  try {
    // 立即反馈并乐观更新按钮状态（不等下一次轮询），避免“点了没反应”
    $('btn-stop').style.display = 'none';
    toast('已发送停止请求…');
    await api('/m/cancel', { method: 'POST', body: JSON.stringify({ sessionId: currentSessionId }) });
    toast('已停止');
    sessionRunning = false;
    updateStopButton();
    // 稍等再拉一次，确认 agent 真的停下（取消是异步的，可能需要一两秒）
    setTimeout(chatPoll, 600);
    setTimeout(chatPoll, 2200);
  } catch (e) {
    toast('停止失败：' + e.message);
    sessionRunning = false;
    updateStopButton();
    setTimeout(chatPoll, 600);
  }
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

/**
 * 打开权限选择器。
 * @param sessionId 可选：传入则操作“当前会话的权限”（与桌面端聊天里的 /permission 一致，
 *   数据源是会话级 permissions 投影）；不传则操作“全局默认”（新建会话的初始权限，设置页）。
 */
async function openPermissionPicker(sessionId) {
  try {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const p = await api('/m/permission' + q);
    const title = sessionId ? '权限模式（当前会话）' : '权限模式（新建会话默认）';
    openSheet(title, p.options.map((id) => ({
      id,
      label: PERM_LABELS[id] || id,
      desc: PERM_DESCS[id] || '',
      selected: id === p.current,
    })), async (opt) => {
      try {
        const body = { preset: opt.id };
        if (sessionId) body.sessionId = sessionId;
        await api('/m/permission-set', { method: 'POST', body: JSON.stringify(body) });
        toast('已切换为「' + (PERM_LABELS[opt.id] || opt.id) + '」');
        if (sessionId) {
          currentPerm = opt.id;
          updatePermChip();
          setTimeout(chatPoll, 400); // 会话权限投影变化后刷新
        } else if (currentView === 'settings') {
          settingsPoll();
        }
      } catch (e) { showErr('切换权限失败', e, '目标权限：' + (PERM_LABELS[opt.id] || opt.id)); }
    });
  } catch (e) { showErr('加载权限失败', e); }
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
      } catch (e) { showErr('切换预设失败', e, '目标预设：' + opt.label); }
    });
  } catch (e) { showErr('加载预设失败', e); }
}

// --- 模型选择（当前会话单独切换 LLM 模型，与桌面端 /model 同一数据源） ---
async function openModelPicker(sessionId) {
  if (!sessionId) { toast('请先打开一个会话'); return; }
  try {
    const data = await api('/m/models?sessionId=' + encodeURIComponent(sessionId));
    const groups = Array.isArray(data.groups) ? data.groups : [];
    if (!groups.length) { toast('电脑上没有可用的模型'); return; }
    const cur = data.current || {};
    // 平铺成选项：group.name 作为分组前缀（若有），模型名用 name（dsh 返回 name 而非 label）
    const opts = [];
    for (const g of groups) {
      const gLabel = (g.label || g.name) ? String(g.label || g.name) : '';
      const gProvider = g.id || '';
      for (const m of (g.models || [])) {
        const isCur = cur.model === m.id || cur.id === m.id;
        opts.push({
          id: m.id,
          label: (gLabel ? gLabel + ' · ' : '') + (m.label || m.name || m.id || '').trim(),
          desc: (m.description || '') + (m.reasoning && typeof m.reasoning === 'object' ? '' : ''),
          selected: isCur,
          provider: gProvider,
          model: m,
        });
      }
    }
    if (!opts.length) { toast('电脑上没有可用的模型'); return; }
    openSheet('模型（当前会话）', opts, async (opt) => {
      try {
        // select-model 需要 provider（group.id）+ model（model.id），与桌面端 /model 一致。
        const m = opt.model || {};
        const selection = {
          provider: opt.provider || '',
          model: m.id || m.model || '',
          ...(m.reasoning && m.reasoning.defaultEffort !== undefined) ? { reasoningEffort: m.reasoning.defaultEffort } : {},
        };
        await api('/m/select-model', { method: 'POST', body: JSON.stringify({ sessionId, selection }) });
        toast('已切换模型为「' + opt.label + '」');
        setTimeout(chatPoll, 400);
      } catch (e) {
        showErr('切换模型失败', e, '目标模型：' + opt.label);
      }
    });
  } catch (e) { showErr('加载模型失败', e); }
}

// --- 会话操作菜单（⋮） ---
$('btn-chat-settings').addEventListener('click', () => {
  const opts = [
    { id: 'permission', label: '权限模式', desc: '当前会话的电脑文件访问级别（含完全访问）' },
    { id: 'preset', label: 'Agent 预设', desc: '模型与推理等级组合（仅新会话可切换）' },
  ];
  if (currentSessionId) {
    opts.push({ id: 'model', label: '模型', desc: '当前会话单独切换 LLM 模型' });
    opts.push({
      id: 'hide',
      label: isHidden(currentSessionId) ? '取消隐藏（隐私）' : '隐藏此会话（隐私）',
      desc: isHidden(currentSessionId) ? '恢复在会话列表中显示' : '从列表隐藏，进入隐私模式可见',
    });
    opts.push({ id: 'cancel', label: '停止当前会话', desc: '取消正在运行的任务' });
  }
  openSheet('会话操作', opts, (opt) => {
    if (opt.id === 'permission') openPermissionPicker(currentSessionId);
    else if (opt.id === 'preset') openPresetPicker(currentSessionId);
    else if (opt.id === 'model') openModelPicker(currentSessionId);
    else if (opt.id === 'hide') toggleHideSession(currentSessionId);
    else if (opt.id === 'cancel') cancelChat();
  });
});

// --- 设置页：权限模式入口（全局默认，新建会话的初始权限） ---
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
    if (st.tunnel && st.tunnel.url) syncTunnelBase(st.tunnel.url);
    $('device-card').innerHTML = `
      <h3>此设备</h3>
      <div class="card-row"><span class="device-name">${esc(me.device.name)}</span>
        <span class="badge ${me.device.active ? 'run' : 'pending'}">${me.device.active ? '控制设备' : '仅查看'}</span></div>
      <div class="card-row"><span class="muted">电脑</span><span class="muted">${esc(st.serverName || 'DeepSeek Harness')}</span></div>`;
    try {
      const perm = await api('/m/permission');
      $('perm-current').textContent = (PERM_LABELS[perm.current] || perm.current || '—') + '（新建会话默认）';
    } catch { $('perm-current').textContent = '—'; }
    const rows = [];
    if (st.activeDevice) rows.push(`<div class="card-row"><span class="muted">当前控制设备</span><span>${esc(st.activeDevice.name)}</span></div>`);
    rows.push(`<div class="card-row"><span class="muted">连接方式</span><span class="badge run">${esc(connLabel(base))}</span></div>`);
    rows.push(`<div class="card-row"><span class="muted">连接地址</span><span style="font-size:11px;color:#9fd0ff;word-break:break-all">${esc(base || '—')}</span></div>`);
    rows.push(`<div class="card-row"><span class="muted">已保存地址</span><span style="font-size:11px;word-break:break-all">${esc(bases.map((b) => b.url).join('、') || '—')}</span></div>`);
    rows.push(`<div class="card-row"><span class="muted">电脑服务</span><span class="${st.dshUp ? 'badge run' : 'badge pending'}">${st.dshUp ? '运行中' : '未运行'}</span></div>`);
    if (st.tunnel && st.tunnel.url) rows.push(`<div class="card-row"><span class="muted">远程兜底（隧道）</span><span style="font-size:11px;color:#9fd0ff;word-break:break-all">${esc(st.tunnel.url)}</span></div>`);
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

// --- 主题切换（设置页：深色 / 浅色） ---
$('seg-theme-dark').addEventListener('click', () => { theme = 'dark'; applyTheme(); });
$('seg-theme-light').addEventListener('click', () => { theme = 'light'; applyTheme(); });

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
  initTheme(); // 先应用主题，避免浅色/深色切换后闪烁
  loadPrivacy(); // 恢复隐私隐藏列表与模式（顶部提示条随之显示）
  boot().catch((err) => showFatalError('启动失败：' + (err && err.message ? err.message : err)));
});
