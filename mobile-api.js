'use strict';

/**
 * mobile-api.js — dsh RPC 客户端 + 手机控制 API（供 mobile.js 挂载到 /m/*）。
 *
 * 桌面端主进程通过本模块与 dsh web 的 /api（JSON-RPC 信封）通信，并提供：
 *  - 会话列表 / 历史（折叠成手机 UI 用的消息）/ 工作区 / 发送 / 取消 / 审批应答；
 *  - 一条常驻的 /api/events.mux SSE 长连接：实时维护每个会话的
 *    “待批准工具调用”(approval/requested) 与“待回答问题”(question/requested)。
 *
 * 历史事件说明：会话日志是事件溯源式的（每个 token 一条 assistant/chunk），
 * 手机端渲染只用消息级事件：user/message、assistant/message、tool/call、tool/result。
 *
 * 用法（probe，开发用）：node mobile-api.js --probe [sessionId]
 */

const crypto = require('node:crypto');

let baseUrl = 'http://127.0.0.1:3080';

function setBase(url) {
  baseUrl = url;
}

function rpcError(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details !== undefined) e.details = details;
  return e;
}

/** dsh /api 一元 RPC 调用。 */
async function rpc(method, payload) {
  const rpcId = crypto.randomUUID();
  let res;
  try {
    res = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload || {} }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    throw rpcError('DSH_UNREACHABLE', 'dsh 服务不可用（' + err.message + '）');
  }
  if (!res.ok) throw rpcError('DSH_TRANSPORT', `dsh 传输错误 HTTP ${res.status}`);
  const env = await res.json();
  if (env.rpcId !== rpcId) throw rpcError('DSH_PROTO', 'dsh 协议错误（rpcId 不匹配）');
  if (!env.result || !env.result.ok) {
    const e = env.result && env.result.error ? env.result.error : { message: 'unknown' };
    throw rpcError(String(e.code || 'DSH_RPC'), String(e.message || 'dsh 调用失败'), e);
  }
  return env.result.value;
}

/**
 * dsh agent-scoped RPC 调用（斜杠端点 + args 包装，如 commands/list、commands/execute）。
 * 与一元 RPC 不同：端点路径是 /api/<method>（斜杠分隔），payload 必须是 {args: {...}}，
 * 且 args 需含 agentId（wire 名）标识目标会话。
 */
async function rpcAgentScoped(method, args) {
  const rpcId = crypto.randomUUID();
  let res;
  try {
    res = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: args || {} } }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    throw rpcError('DSH_UNREACHABLE', 'dsh 服务不可用（' + err.message + '）');
  }
  if (!res.ok) throw rpcError('DSH_TRANSPORT', `dsh 传输错误 HTTP ${res.status}`);
  const env = await res.json();
  if (env.rpcId !== rpcId) throw rpcError('DSH_PROTO', 'dsh 协议错误（rpcId 不匹配）');
  if (!env.result || !env.result.ok) {
    const e = env.result && env.result.error ? env.result.error : { message: 'unknown' };
    throw rpcError(String(e.code || 'DSH_RPC'), String(e.message || 'dsh 调用失败'), e);
  }
  return env.result.value;
}

/** 应答 dsh 的待批准请求（工具调用审批 / 问题回答）。 */
async function respond(method, payload) {
  const rpcId = crypto.randomUUID();
  let res;
  try {
    res = await fetch(`${baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, method, payload }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw rpcError('DSH_UNREACHABLE', 'dsh 服务不可用（' + err.message + '）');
  }
  if (!res.ok) throw rpcError('DSH_TRANSPORT', `respond 传输错误 HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// mux 长连接：实时维护待批准工具调用 / 待回答问题 / 事件进度
// ---------------------------------------------------------------------------

const live = {
  connected: false,
  pendingApprovals: new Map(), // sessionId -> [{approvalId, toolName, callId, reason}]
  pendingQuestions: new Map(), // sessionId -> [{questionRpcId, questions}]
  lastEventSeqs: new Map(), // sessionId -> seq
};
let muxTimer = null;
let muxStopped = false;

function handleMuxFrame(full) {
  const p = full && full.payload;
  if (!p || !p.type) return;
  if (p.type === 'approval/requested') {
    let list = live.pendingApprovals.get(p.sessionId) || [];
    if (!list.some((a) => a.approvalId === p.approvalId)) {
      list.push({ approvalId: p.approvalId, toolName: p.toolName, callId: p.callId, reason: p.reason });
      live.pendingApprovals.set(p.sessionId, list);
    }
  } else if (p.type === 'approval/resolved') {
    const list = (live.pendingApprovals.get(p.sessionId) || []).filter((a) => a.approvalId !== p.approvalId);
    live.pendingApprovals.set(p.sessionId, list);
  } else if (p.type === 'question/requested') {
    let list = live.pendingQuestions.get(p.sessionId) || [];
    if (!list.some((q) => q.questionRpcId === p.questionRpcId)) {
      list.push({ questionRpcId: p.questionRpcId, questions: p.questions });
      live.pendingQuestions.set(p.sessionId, list);
    }
  } else if (p.type === 'question/resolved') {
    const list = (live.pendingQuestions.get(p.sessionId) || []).filter((q) => q.questionRpcId !== p.questionRpcId);
    live.pendingQuestions.set(p.sessionId, list);
  } else if (p.type === 'session/event') {
    live.lastEventSeqs.set(p.sessionId, p.event.seq);
  }
}

function scheduleMuxRetry() {
  if (muxStopped) return;
  const delay = Math.min(30000, 2000 * (live.connected ? 1 : 2));
  clearTimeout(muxTimer);
  muxTimer = setTimeout(startMux, delay);
}

/** 建立（或重连）mux WebSocket 长连接。 */
async function startMux() {
  muxStopped = false; // start() 前会先 stop()，这里重新武装
  if (muxStopped) return;
  try {
    const url = new URL(`${baseUrl}/api/events.mux`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      live.connected = true;
    });
    socket.addEventListener('message', (event) => {
      try {
        handleMuxFrame(JSON.parse(String(event.data)));
      } catch {}
    });
    socket.addEventListener('close', () => {
      live.connected = false;
      scheduleMuxRetry();
    });
    socket.addEventListener('error', () => {
      try {
        socket.close();
      } catch {}
    });
  } catch {
    live.connected = false;
    scheduleMuxRetry();
  }
}

function stopMux() {
  muxStopped = true;
  clearTimeout(muxTimer);
  live.connected = false;
}

function pendingApprovals(sessionId) {
  return (live.pendingApprovals.get(sessionId) || []).map((a) => ({ ...a }));
}

function pendingQuestions(sessionId) {
  return (live.pendingQuestions.get(sessionId) || []).map((q) => ({ ...q, questions: q.questions }));
}

// ---------------------------------------------------------------------------
// 业务包装（供 mobile.js 的 HTTP 处理器调用）
// ---------------------------------------------------------------------------

/** 会话列表 → 手机 UI 用摘要（隐藏已归档会话，与桌面 GUI 行为一致）。 */
async function listSessions() {
  const [sessions, workspaces] = await Promise.all([
    rpc('session.list', {}),
    rpc('workspace.list', {}),
  ]);
  const archived = new Set(workspaces.archivedSessionIds || []);
  const items = Array.isArray(sessions.items) ? sessions.items : [];
  return {
    items: items
      .filter((s) => !archived.has(s.sessionId))
      .filter((s) => !s.blank) // 空会话（未发过消息）不显示，与桌面端一致
      .map((s) => {
      const proj = s.projections && s.projections.values ? s.projections.values : {};
      const projTitle = proj && typeof proj.title === 'string' && proj.title ? proj.title : '';
      return {
        sessionId: s.sessionId,
        title: projTitle || s.title || fallbackTitle(s),
        updatedAt: s.updatedAt,
        running: !!s.running,
        blank: !!s.blank,
        cwd: s.cwd || '',
        agentPreset: s.agentPreset || '',
        pendingApprovals: pendingApprovals(s.sessionId).length,
        pendingQuestions: pendingQuestions(s.sessionId).length,
      };
    }),
  };
}

function fallbackTitle(s) {
  if (s.cwd) {
    const parts = String(s.cwd).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || s.cwd;
  }
  return String(s.sessionId).slice(0, 18);
}

/** 会话历史（默认取最新窗口）→ 折叠成手机 UI 用的消息数组。 */
async function getHistory(sessionId, opts = {}) {
  const payload = { sessionId };
  payload.beforeSeq = opts.beforeSeq !== undefined ? opts.beforeSeq : Number.MAX_SAFE_INTEGER;
  payload.maxMessages = opts.maxMessages !== undefined ? opts.maxMessages : 2000;
  const value = await rpc('session.history', payload);
  const entries = Array.isArray(value.events) ? value.events : [];
  return {
    sessionId,
    messages: foldHistory(entries),
    hasMore: !!value.hasMore,
    pendingApprovals: pendingApprovals(sessionId),
    pendingQuestions: pendingQuestions(sessionId),
  };
}

function contentText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim();
}

/**
 * 把工具调用折叠成手机端友好标题：
 * - 压缩/解压类命令 → “压缩命令”（长耗时命令，手机端只显示动作名，不刷输出）；
 * - bash/pwsh 等命令执行类工具 → 显示去掉多余空白后的简短命令文本；
 * - 其他工具 → 返回空串，前端回退显示工具名 + 参数预览。
 */
function friendlyToolLabel(name, argsText) {
  const hay = (String(name) + ' ' + String(argsText || '')).toLowerCase();
  if (/\b(compress|decompress|unzip|zip|7z|tar|rar|gzip|archive)\b/.test(hay) || /压缩|解压/.test(hay)) {
    return '压缩命令';
  }
  if (/^(bash|pwsh|powershell|cmd|sh|shell|terminal)$/i.test(String(name))) {
    let cmd = '';
    try {
      const parsed = JSON.parse(argsText || '{}');
      cmd = parsed.command || parsed.script || parsed.line || '';
    } catch {}
    if (cmd) {
      const one = String(cmd).replace(/\s+/g, ' ').trim();
      return one.length > 40 ? one.slice(0, 40) + '…' : one;
    }
    return '执行命令';
  }
  return '';
}

function foldHistory(entries) {
  const out = [];
  let lastTool = null;
  for (const { event } of entries) {
    if (!event) continue;
    const d = event.data || {};
    const t = event.type || '';
    if (t === 'user/message') {
      // 注意：user/message 的 content 直接在 data.content（assistant/message 才是 data.message.content）。
      // 区分来源：dsh 会把插件/系统注入的消息（审批策略变化、运行时上下文快照等）也记录为
      // user/message（source.kind !== 'user'），这些不该显示成“用户输入”，标记为 system。
      const isRealUser = d.source && d.source.kind === 'user';
      let text = contentText(d.content);
      // 压缩上下文（/compact）落地的检查点消息是一大段
      // “automatically generated checkpoint … <compacted-summary>…</compacted-summary>”，
      // 手机上不需要倾倒全文，换成一句友好提示。
      if (text.includes('<compacted-summary>') || /automatically generated checkpoint/i.test(text)) {
        text = '✅ 上下文已压缩（历史已精简，对话可继续）';
      }
      out.push({
        kind: isRealUser ? 'user' : 'system',
        text,
        time: event.time,
        seq: event.seq,
      });
    } else if (t === 'assistant/message') {
      const blocks = (d.message && d.message.content) || [];
      const text = contentText(blocks.filter((b) => b && b.type === 'text'));
      const reasoning = contentText(blocks.filter((b) => b && b.type === 'reasoning'));
      // 保留完整 reasoning（不压缩成占位符），前端自行决定展示多少
      out.push({ kind: 'assistant', text, reasoning, time: event.time, seq: event.seq });
    } else if (t === 'tool/call') {
      const name = d.name || (d.call && d.call.name) || 'tool';
      const rawArgs = d.arguments !== undefined ? d.arguments : d.call && d.call.args;
      const args = typeof rawArgs === 'string' ? rawArgs.slice(0, 240) : safeJson(rawArgs);
      const label = friendlyToolLabel(name, args);
      out.push({ kind: 'tool', name, label, args, status: 'running', time: event.time, seq: event.seq });
      lastTool = out[out.length - 1];
    } else if (t === 'tool/result' && lastTool) {
      lastTool.status = 'done';
    }
  }
  return out;
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 220 ? s.slice(0, 220) + '…' : s || '';
  } catch {
    return String(v).slice(0, 220);
  }
}

/** 工作区列表（手机“新建会话”选文件夹用）。 */
async function listWorkspaces() {
  const value = await rpc('workspace.list', {});
  const items = Array.isArray(value.items) ? value.items : [];
  return {
    items: items.map((w) => ({
      workspaceId: w.workspaceId,
      title: w.title,
      path: w.path,
      sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
    })),
  };
}

/** 新建会话（可指定 workspaceId 或 cwd，可指定 agentPreset）。 */
async function createSession(workspaceId, cwd, agentPreset) {
  const payload = {};
  if (workspaceId) payload.workspaceId = workspaceId;
  else if (cwd) payload.cwd = cwd;
  if (agentPreset) payload.agentPreset = agentPreset;
  const value = await rpc('session.create', payload);
  return { sessionId: value.sessionId, agentPreset: value.agentPreset };
}

/** 发送消息：无 sessionId 时先建会话（可带 agentPreset）。 */
async function sendPrompt({ sessionId, workspaceId, cwd, text, agentPreset }) {
  const textClean = String(text || '').trim();
  if (!textClean) throw rpcError('BAD_REQUEST', '消息内容不能为空');
  if (!sessionId) {
    const created = await createSession(workspaceId, cwd, agentPreset);
    sessionId = created.sessionId;
  }
  const value = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: textClean }],
  });
  return { sessionId, agentPreset: undefined, accepted: !!(value && value.accepted) };
}

/** 取消正在运行的会话。 */
async function cancelSession(sessionId) {
  await rpc('session.cancel', { sessionId });
  return { cancelled: true };
}

/** 应答工具调用审批：outcome = 'allowed-once' | 'rejected'。 */
async function answerApproval(sessionId, approvalId, outcome) {
  const receipt = await respond('approvals.respond', { sessionId, approvalId, outcome });
  return { accepted: !!(receipt && receipt.accepted) };
}

/** 回答问题（ask_user_question）。若协议不被接受会抛错，由调用方提示去电脑端回答。 */
async function answerQuestion(sessionId, questionRpcId, answers) {
  const receipt = await respond('userQuestions.answer', { sessionId, questionRpcId, answers });
  return { accepted: !!(receipt && receipt.accepted) };
}

/** 服务健康检查。 */
async function ping() {
  try {
    await rpc('session.list', {});
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 会话能力扩展：Agent 预设（模型/推理等级）与权限模式
// ---------------------------------------------------------------------------

/** Agent 预设列表（standard/code/minimal/cordis…，决定模型与推理配置）。 */
async function listAgentPresets() {
  const value = await rpc('agentPreset.list', {});
  return { presets: Array.isArray(value.presets) ? value.presets : [] };
}

/** 为新会话选择 Agent 预设（仅未开始的会话可设置）。 */
async function selectAgentPreset(sessionId, agentPreset) {
  const value = await rpc('agentPreset.select', { sessionId, agentPreset });
  return { sessionId, agentPreset: value && value.agentPreset };
}

/** 当前权限模式（defaultPreset: read-only | workspace-write | danger-full-access）。 */
async function getPermission() {
  const value = await rpc('settings.describe', {});
  const perm = (value.namespaces || []).find((n) => n.ns === 'permission');
  if (!perm) throw rpcError('NOT_FOUND', '权限设置不可用');
  return {
    ns: 'permission',
    current: perm.value && perm.value.defaultPreset,
    writable: !!perm.writable,
    revision: perm.revision,
    options: Object.values(perm.schema && perm.schema.refs || {})
      .filter((r) => r && r.type === 'const' && typeof r.value === 'string')
      .map((r) => r.value),
  };
}

/** 修改权限模式。 */
async function setPermission(preset, expectedRevision) {
  const value = await rpc('settings.mutate', {
    ns: 'permission',
    ops: [{ op: 'set', path: ['defaultPreset'], value: preset }],
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });
  const perm = value && value.namespaces ? (value.namespaces.find((n) => n.ns === 'permission') || {}) : (value || {});
  return { current: perm.value && perm.value.defaultPreset, ok: true };
}

// ---------------------------------------------------------------------------
// 斜杠命令（与桌面端同一数据源：agent-scoped RPC）
// ---------------------------------------------------------------------------

/** 当前会话可用的斜杠命令列表（随预设/插件动态变化，与桌面端一致）。 */
async function listCommands(sessionId) {
  if (!sessionId) return { items: [] };
  const value = await rpcAgentScoped('commands/list', { agentId: sessionId });
  return { items: Array.isArray(value) ? value : [] };
}

/** 执行斜杠命令（如 /compact、/plan off）。 */
async function executeCommand(sessionId, line) {
  const value = await rpcAgentScoped('commands/execute', { agentId: sessionId, line: String(line || '') });
  const r = value && value.result;
  if (!r || r.kind === 'error') {
    throw rpcError('COMMAND_FAILED', (r && r.text) || '命令执行失败');
  }
  return { commandId: value.commandId, text: r.text || '' };
}

// ---------------------------------------------------------------------------
// probe（开发用）：打印真实数据结构
// ---------------------------------------------------------------------------

async function probe() {
  const target = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
  setBase(target);
  console.log('=== session.list ===');
  console.log(JSON.stringify(await listSessions(), null, 2).slice(0, 3000));
  const sid = process.argv[3] || (await listSessions()).items[0].sessionId;
  console.log('\n=== history folded (' + sid + ') ===');
  const h = await getHistory(sid, { maxMessages: 3000 });
  console.log('pendingApprovals:', JSON.stringify(h.pendingApprovals));
  console.log('pendingQuestions:', JSON.stringify(h.pendingQuestions));
  console.log('messages:');
  for (const m of h.messages.slice(-14)) {
    console.log(' - ' + JSON.stringify(m).slice(0, 300));
  }
  console.log('\n=== workspace.list ===');
  console.log(JSON.stringify(await listWorkspaces(), null, 2).slice(0, 2000));
  console.log('PROBE_DONE');
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--probe') {
    probe().catch((err) => {
      console.error('PROBE_ERROR', err.code, err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  setBase,
  rpc,
  rpcAgentScoped,
  respond,
  startMux,
  stopMux,
  live,
  pendingApprovals,
  pendingQuestions,
  listSessions,
  getHistory,
  listWorkspaces,
  createSession,
  sendPrompt,
  cancelSession,
  answerApproval,
  answerQuestion,
  ping,
  listAgentPresets,
  selectAgentPreset,
  getPermission,
  setPermission,
  listCommands,
  executeCommand,
};
