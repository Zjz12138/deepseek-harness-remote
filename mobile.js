'use strict';

/**
 * mobile.js v2 — 手机访问：配对安全模型 + 手机 UI / 控制 API 服务。
 *
 * 在 0.0.0.0:<port> 上监听，提供：
 *  - GET  /            手机 UI（mobile-ui/，独立设计的移动端界面，PWA 可安装）
 *  - /m/*              控制 API（见 mobile-api.js），需要设备令牌
 *  - /auth/*           配对 / 密码登录 / 身份查询
 *
 * 安全模型：
 *  - 扫码配对（推荐，默认）：电脑面板生成一次性配对码 → 手机提交 → 电脑弹窗确认
 *    （设备名 + 配对码）→ 允许并设为当前设备 / 仅允许查看 / 拒绝；
 *  - 设备令牌：每台配对设备一个 256-bit 随机令牌，电脑只存 sha256 哈希；
 *    手机保存令牌，之后自动登录（记住设备），可单独吊销；
 *  - 单活跃控制设备：发送消息 / 批准工具 / 取消 等写操作只允许“当前设备”，
 *    切换必须由电脑端操作（面板“设为当前设备”）；查看操作任意已配对设备可用；
 *  - 密码模式（可选）：一次密码登录换取会话令牌，按活跃控制器对待；
 *  - 防爆破：/auth/* 每 IP 限流 + 锁定；所有控制操作写入审计日志。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const api = require('./mobile-api');

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const AUTH_MAX_FAILS = 10;
const AUTH_LOCK_MS = 15 * 60 * 1000;

let server = null;
let port = 3081;
let mode = 'pair';
let passwordHash = ''; // sha256 hex
let plainPassword = '';
let devices = []; // {id, name, tokenHash, createdAt, lastSeen, active}
let pendingPair = null; // {code, deviceName, expiresAt}
let passwordSessions = new Map(); // token -> expiresAt
const authFails = new Map(); // ip -> {count, lockUntil}

let saveConfig = () => {};
let logFn = (m) => console.log('[mobile] ' + m);
let pairConfirmHandler = null; // async (deviceName, code) => 'active' | 'view' | 'reject' | 'timeout'
let tunnelStatus = () => null; // () => {url} | null
let onTunnelTraffic = null; // () => void 请求经隧道地址到达时回调（证明隧道真实可用）

function log(message) {
  logFn(message);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function generateCode(len = 16) {
  // 配对码只藏在二维码里（手机扫码自动获取，无需人看/输）；
  // 16 位大写随机字符 = 32^16 ≈ 2^80，单次有效 + 10 分钟过期 + 电脑端确认
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function generatePassword(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function readJson(req) {
  return parseBody(req).then((b) => {
    try {
      return JSON.parse(b || '{}');
    } catch {
      return null;
    }
  });
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

/** 认证：设备令牌（配对）或会话令牌（密码模式）。返回 {device, via} | null */
function authenticate(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const hash = sha256Hex(token);
  const dev = devices.find((d) => d.tokenHash === hash);
  if (dev) {
    dev.lastSeen = Date.now();
    return { device: dev, via: 'device' };
  }
  const exp = passwordSessions.get(token);
  if (exp) {
    if (Date.now() > exp) {
      passwordSessions.delete(token);
      return null;
    }
    return { device: { id: 'password-session', name: '密码登录', active: true }, via: 'password' };
  }
  return null;
}

function ipKey(req) {
  const ip = req.socket.remoteAddress || '?';
  return ip.replace(/^::ffff:/, '');
}

function rateLimited(ip) {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (rec.lockUntil > Date.now()) return true;
  authFails.delete(ip);
  return false;
}

function recordFail(ip) {
  const rec = authFails.get(ip) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= AUTH_MAX_FAILS) {
    rec.lockUntil = Date.now() + AUTH_LOCK_MS;
    log(`auth lockout for ${ip} (${AUTH_LOCK_MS / 60000} min)`);
  }
  authFails.set(ip, rec);
}

function recordOk(ip) {
  authFails.delete(ip);
}

function persist() {
  saveConfig();
}

// ---------------------------------------------------------------------------
// 设备管理（供电脑端面板调用）
// ---------------------------------------------------------------------------

function listDevices() {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    active: d.active,
    createdAt: d.createdAt,
    lastSeen: d.lastSeen,
  }));
}

function setActiveDevice(id) {
  let found = false;
  for (const d of devices) {
    d.active = d.id === id;
    if (d.active) found = true;
  }
  persist();
  return found;
}

function removeDevice(id) {
  // 原地修改（splice）而不是重新赋值：main.js 传入的 devices 与 config.mobile.devices
  // 是同一数组引用，重新赋值会让 config 里的旧数组保留被删设备（重启后“复活”）。
  for (let i = devices.length - 1; i >= 0; i--) {
    if (devices[i].id === id) devices.splice(i, 1);
  }
  persist();
}

function activeDevice() {
  return devices.find((d) => d.active) || null;
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

// CORS：手机 App 页面运行在 https://localhost（Capacitor WebView），
// 请求电脑的 http://局域网IP:端口 与 https://隧道 都是跨域，
// 必须放行浏览器跨域读取（安全边界仍是配对码 + 设备令牌）。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

async function handleAuth(req, res, urlPath) {
  const ip = ipKey(req);

  if (req.method === 'GET' && urlPath === '/auth/me') {
    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: '未认证或令牌已失效' });
    return sendJson(res, 200, {
      device: { id: auth.device.id, name: auth.device.name, active: auth.device.active },
      mode,
    });
  }

  if (req.method === 'POST' && urlPath === '/auth/pair') {
    if (mode !== 'pair') return sendJson(res, 409, { error: '当前为密码模式，请在电脑上切换为配对模式' });
    if (rateLimited(ip)) return sendJson(res, 429, { error: '尝试过多，请稍后再试' });
    const body = await readJson(req);
    const code = String((body && body.code) || '').trim().toUpperCase();
    const deviceName = String((body && body.deviceName) || '我的手机').slice(0, 40);
    if (!code || !pendingPair || pendingPair.code !== code || pendingPair.expiresAt < Date.now()) {
      recordFail(ip);
      return sendJson(res, 404, { error: '配对码无效或已过期，请在电脑上重新点击“添加手机”' });
    }
    pendingPair.deviceName = deviceName;
    log(`pair request: "${deviceName}" code=${code} (awaiting PC confirm)`);
    let decision;
    try {
      decision = pairConfirmHandler ? await pairConfirmHandler(deviceName, code) : 'reject';
    } catch {
      decision = 'timeout';
    }
    if (decision === 'reject' || decision === 'timeout') {
      pendingPair = null;
      recordFail(ip);
      return sendJson(res, 403, { error: decision === 'timeout' ? '电脑端未确认（超时），请重试' : '电脑端拒绝了配对' });
    }
    recordOk(ip);
    const token = crypto.randomBytes(32).toString('hex');
    // 同一设备重新配对：手机端携带持久 deviceId，替换旧记录（避免同一手机被识别成多个设备）
    const deviceKey = String((body && body.deviceId) || '').slice(0, 64);
    if (deviceKey) {
      // 原地修改（splice）：保持与 config.mobile.devices 的引用一致，删除才能持久化
      for (let i = devices.length - 1; i >= 0; i--) {
        if (devices[i].deviceKey === deviceKey) devices.splice(i, 1);
      }
      log(`re-pair: removed old record for deviceKey=${deviceKey.slice(0, 8)}…`);
    }
    const device = {
      id: crypto.randomUUID(),
      deviceKey: deviceKey || undefined,
      name: deviceName,
      tokenHash: sha256Hex(token),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      active: decision === 'active',
    };
    devices.push(device);
    if (device.active) for (const d of devices) if (d.id !== device.id) d.active = false;
    pendingPair = null;
    persist();
    log(`paired device "${deviceName}" active=${device.active}`);
    // 把当前可用的所有地址（局域网 IP + 远程隧道）一并给手机：
    // 隧道地址每次重启都会变，但局域网地址基本稳定 —— 手机保存后
    // 下次连不上时能自动换地址重试，而不是只能重新扫码。
    const addrs = [...new Set(urls())];
    const turl = tunnelStatus ? tunnelStatus() : null;
    if (turl && turl.url) addrs.push(turl.url);
    return sendJson(res, 200, {
      token,
      device: { id: device.id, name: device.name, active: device.active },
      mode,
      urls: addrs,
    });
  }

  if (req.method === 'POST' && urlPath === '/auth/password-login') {
    if (mode !== 'password') return sendJson(res, 409, { error: '当前为配对模式，请扫码配对' });
    if (rateLimited(ip)) return sendJson(res, 429, { error: '尝试过多，请稍后再试' });
    const body = await readJson(req);
    const pw = String((body && body.password) || '');
    const expected = Buffer.from(passwordHash, 'hex');
    const given = Buffer.from(sha256Hex(pw), 'hex');
    if (!passwordHash || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      recordFail(ip);
      return sendJson(res, 401, { error: '密码错误' });
    }
    recordOk(ip);
    const token = crypto.randomBytes(32).toString('hex');
    passwordSessions.set(token, Date.now() + PASSWORD_SESSION_TTL_MS);
    if (passwordSessions.size > 200) {
      const now = Date.now();
      for (const [k, exp] of passwordSessions) if (exp < now) passwordSessions.delete(k);
    }
    log(`password login ok from ${ip}`);
    return sendJson(res, 200, { token, mode });
  }

  if (req.method === 'GET' && urlPath === '/auth/status') {
    return sendJson(res, 200, { mode, pairPending: !!pendingPair, deviceCount: devices.length });
  }

  return sendJson(res, 404, { error: 'not found' });
}

/** 写操作需要“当前设备”。返回 true 放行；否则已应答并返回 false。 */
function requireActive(req, res, auth) {
  if (!auth) {
    sendJson(res, 401, { error: '未认证或令牌已失效，请重新配对' });
    return false;
  }
  if (auth.via === 'password') return true;
  if (!auth.device.active) {
    sendJson(res, 403, {
      error: '该设备不是控制设备。切换控制设备请在电脑端“手机访问”面板操作。',
      code: 'NOT_ACTIVE',
    });
    return false;
  }
  return true;
}

function requireAuth(req, res) {
  const auth = authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: '未认证或令牌已失效，请重新配对' });
    return null;
  }
  return auth;
}

async function handleApi(req, res, urlPath) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const devLabel = auth.device.name;

  try {
    if (req.method === 'GET' && urlPath === '/m/me') {
      return sendJson(res, 200, {
        device: { id: auth.device.id, name: auth.device.name, active: auth.device.active },
        mode,
        serverName: 'DeepSeek Harness',
      });
    }

    if (req.method === 'GET' && urlPath === '/m/status') {
      const dshUp = await api.ping();
      return sendJson(res, 200, {
        dshUp,
        muxConnected: api.live.connected,
        mode,
        activeDevice: activeDevice() ? { id: activeDevice().id, name: activeDevice().name } : null,
        deviceCount: devices.length,
        tunnel: tunnelStatus(),
      });
    }

    if (req.method === 'GET' && urlPath === '/m/sessions') {
      return sendJson(res, 200, await api.listSessions());
    }

    if (req.method === 'GET' && urlPath === '/m/session') {
      const u = new URL(req.url, 'http://local');
      const sessionId = u.searchParams.get('sessionId') || '';
      if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
      const max = Math.min(3000, Math.max(100, Number(u.searchParams.get('maxMessages')) || 1500));
      const beforeSeqParam = u.searchParams.get('beforeSeq');
      const beforeSeq = beforeSeqParam !== null && beforeSeqParam !== ''
        ? Number(beforeSeqParam)
        : undefined;
      return sendJson(res, 200, await api.getHistory(sessionId, { beforeSeq, maxMessages: max }));
    }

    if (req.method === 'GET' && urlPath === '/m/workspaces') {
      return sendJson(res, 200, await api.listWorkspaces());
    }

    if (req.method === 'GET' && urlPath === '/m/pending') {
      return sendJson(res, 200, {
        approvals: [...api.live.pendingApprovals.entries()].map(([sessionId, list]) => ({ sessionId, list })),
        questions: [...api.live.pendingQuestions.entries()].map(([sessionId, list]) => ({ sessionId, list })),
      });
    }

    if (req.method === 'POST' && urlPath === '/m/send') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      const result = await api.sendPrompt({
        sessionId: body.sessionId,
        workspaceId: body.workspaceId,
        cwd: body.cwd,
        text: body.text,
        agentPreset: body.agentPreset,
        mode: body.mode, // 'queue' | 'steer'（插话）
      });
      log(`${devLabel}: send${body.mode === 'steer' ? ' (steer)' : ''} → ${result.sessionId}`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && urlPath === '/m/respond') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      const result = await api.answerApproval(body.sessionId, body.approvalId, body.outcome);
      log(`${devLabel}: respond approval ${body.approvalId} = ${body.outcome}`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && urlPath === '/m/answer-question') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      const result = await api.answerQuestion(body.sessionId, body.questionRpcId, body.answers);
      log(`${devLabel}: answered question ${body.questionRpcId}`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && urlPath === '/m/cancel') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      const result = await api.cancelSession(body.sessionId);
      log(`${devLabel}: cancel ${body.sessionId}`);
      return sendJson(res, 200, result);
    }

    // --- 会话能力扩展：Agent 预设（模型/推理等级）与权限模式 ---

    if (req.method === 'GET' && urlPath === '/m/presets') {
      return sendJson(res, 200, await api.listAgentPresets());
    }

    if (req.method === 'POST' && urlPath === '/m/preset') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      if (!body.sessionId || !body.agentPreset) return sendJson(res, 400, { error: '缺少 sessionId 或 agentPreset' });
      const result = await api.selectAgentPreset(body.sessionId, body.agentPreset);
      log(`${devLabel}: preset ${body.sessionId} → ${body.agentPreset}`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && urlPath === '/m/permission') {
      // 支持会话级权限：?sessionId=xxx 时返回该会话的权限（与桌面端聊天里的 /permission 一致）；
      // 不传 sessionId 时返回全局默认（新建会话的初始权限，对应桌面端设置页）。
      const u = new URL(req.url, 'http://local');
      const sessionId = u.searchParams.get('sessionId') || '';
      if (sessionId) return sendJson(res, 200, await api.getSessionPermission(sessionId));
      return sendJson(res, 200, await api.getPermission());
    }

    if (req.method === 'POST' && urlPath === '/m/permission-set') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      if (!body.preset) return sendJson(res, 400, { error: '缺少 preset' });
      // 会话级：执行 /permission <preset>（与桌面端一致）；全局：改 defaultPreset 设置。
      const result = body.sessionId
        ? await api.setSessionPermission(body.sessionId, body.preset)
        : await api.setPermission(body.preset, body.expectedRevision);
      log(`${devLabel}: permission${body.sessionId ? ' [session]' : ' [global]'} → ${body.preset}`);
      return sendJson(res, 200, result);
    }

    // --- 斜杠命令（与桌面端同一数据源） ---

    if (req.method === 'GET' && urlPath === '/m/commands') {
      if (!requireActive(req, res, auth)) return;
      const u = new URL(req.url, 'http://local');
      const sessionId = u.searchParams.get('sessionId') || '';
      if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
      const result = await api.listCommands(sessionId);
      log(`${devLabel}: commands list ${sessionId} (${result.items.length})`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && urlPath === '/m/command') {
      if (!requireActive(req, res, auth)) return;
      const body = await readJson(req);
      if (!body.sessionId || !body.line) return sendJson(res, 400, { error: '缺少 sessionId 或 line' });
      const result = await api.executeCommand(body.sessionId, body.line);
      log(`${devLabel}: command ${body.sessionId} → ${body.line}`);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    log(`api error (${devLabel}): ${err.code || ''} ${err.message}`);
    const status = err.code === 'BAD_REQUEST' ? 400 : err.code === 'DSH_UNREACHABLE' ? 503 : 500;
    return sendJson(res, status, { error: err.message, code: err.code || 'INTERNAL' });
  }
}

async function handleRequest(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  // 真实隧道流量检测：请求的 Host 与隧道公网地址一致 → 证明隧道可路由，
  // 立即通知主进程标记“已验证”（本机探测会因网络屏蔽误报，真实流量最可靠）。
  // 注意：cloudflared 转发时保留原始 Host（*.trycloudflare.com）。
  try {
    const host = String(req.headers.host || '').split(':')[0];
    const tun = tunnelStatus();
    if (host && tun && tun.url && onTunnelTraffic) {
      let tunHost = '';
      try {
        tunHost = new URL(tun.url).hostname;
      } catch {}
      if (tunHost && host === tunHost) onTunnelTraffic();
    }
  } catch {}
  // 跨域预检（手机 App 从 https://localhost 发起带 Authorization/JSON 的请求）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (urlPath.startsWith('/auth/')) return handleAuth(req, res, urlPath);
  if (urlPath.startsWith('/m/')) return handleApi(req, res, urlPath);
  return sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

function start(options) {
  stop();
  port = options.port || 3081;
  // 只支持扫码配对：密码模式已废弃（历史配置里的 password 一律忽略），
  // 保证手机端永远走“扫码配对”流程，不会再出现密码输入界面。
  mode = 'pair';
  passwordHash = options.passwordHash || sha256Hex(options.password || '');
  plainPassword = options.password || '';
  devices = Array.isArray(options.devices) ? options.devices : [];
  // 上一会话持久化的 lastSeen 可能是“刚用过手机”的旧值：清零，
  // 避免面板在手机尚未真正连上本会话时误显示“在线/已连接”。
  for (const d of devices) d.lastSeen = 0;
  pendingPair = null;
  passwordSessions.clear();
  if (typeof options.saveConfig === 'function') saveConfig = options.saveConfig;
  if (typeof options.log === 'function') logFn = options.log;
  if (typeof options.pairConfirmHandler === 'function') pairConfirmHandler = options.pairConfirmHandler;
  if (typeof options.tunnelStatus === 'function') tunnelStatus = options.tunnelStatus;
  if (typeof options.onTunnelTraffic === 'function') onTunnelTraffic = options.onTunnelTraffic;
  api.setBase(options.targetUrl || 'http://127.0.0.1:3080');
  api.startMux();

  server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      server.removeListener('error', onErr);
      log(`手机访问已启用: 0.0.0.0:${server.address().port} (mode=${mode})`);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onListen);
    server.listen(port, '0.0.0.0');
  });
}

function stop() {
  api.stopMux();
  pendingPair = null;
  onTunnelTraffic = null;
  if (server) {
    try {
      server.close();
    } catch {}
    server = null;
  }
}

function isRunning() {
  return !!server && server.listening;
}

function getPort() {
  return server ? server.address().port : 0;
}

/** 电脑端面板：生成新配对码（返回码 + 过期时间）。 */
function createPendingPair() {
  const code = generateCode();
  pendingPair = { code, deviceName: null, expiresAt: Date.now() + PAIR_CODE_TTL_MS };
  return { code, expiresAt: pendingPair.expiresAt };
}

function cancelPendingPair() {
  pendingPair = null;
}

function getState() {
  const running = isRunning();
  return {
    running,
    port: running ? getPort() : port,
    mode,
    hasPassword: !!passwordHash,
    password: plainPassword,
    devices: listDevices(),
    activeDevice: activeDevice() ? { id: activeDevice().id, name: activeDevice().name } : null,
    pairPending: pendingPair
      ? { code: pendingPair.code, deviceName: pendingPair.deviceName || '', expiresAt: pendingPair.expiresAt }
      : null,
  };
}

/** 手机 UI 的局域网访问地址（不含隧道）。 */
function urls() {
  const p = isRunning() ? getPort() : port;
  const out = [];
  const ifaces = os.networkInterfaces();
  const entries = Object.entries(ifaces).sort(([a], [b]) => {
    const rank = (n) => (/wlan|wi-fi|wireless/i.test(n) ? 0 : /ethernet|以太网|lan/i.test(n) ? 1 : 2);
    return rank(a) - rank(b);
  });
  for (const [name, list] of entries) {
    if (/vEthernet|wsl|virtualbox|hyper-v|vmware|docker|loopback/i.test(name)) continue;
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && i.address) out.push(`http://${i.address}:${p}`);
    }
  }
  return [...new Set(out)];
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getState,
  createPendingPair,
  cancelPendingPair,
  listDevices,
  setActiveDevice,
  removeDevice,
  generatePassword,
  generateCode,
  urls,
};
