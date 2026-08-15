'use strict';

/**
 * apply-dsh-ui-patches.js — 给 dsh 上游 web UI 打补丁（dsh-desktop 私有改动）。
 *
 * 改动点（@deepseek-ai/dsh-client-ui-workspace/lib/client.js）：
 *   1. 会话行三点菜单新增「打开会话目录」（menu.openSessionDir）：
 *      与「重命名 / 分叉会话 / 归档会话」同级，点击后向 window 派发
 *      `dsh-open-session-dir` 自定义事件（detail.path = 会话 cwd），
 *      由桌面端 preload.js 接收并调起系统资源管理器。
 *   2. 会话节点透传 cwd 字段（原先只用于分组/标题，未带到行菜单）。
 *
 * 幂等：检测到补丁标记（"dsh-desktop patch" 注释）即跳过。
 * 用法：node apply-dsh-ui-patches.js [client.js 路径...]（缺省自动探测）。
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'dsh-desktop patch';

function candidatePaths() {
  const here = __dirname;
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  const out = [path.join(here, rel)];
  // 打包产物里也有一份（release/win-unpacked/resources/app/node_modules/...）
  const unpacked = path.join(here, 'release', 'win-unpacked', 'resources', 'app', rel);
  if (fs.existsSync(unpacked)) out.push(unpacked);
  return out;
}

const REPLACEMENTS = [
  // 1) sessionNode 透传 cwd
  [
    `\t\t\t\t...s.pendingInteraction === void 0 ? {} : { pendingInteraction: s.pendingInteraction }\n\t\t\t};\n\t\t}`,
    `\t\t\t\t...s.pendingInteraction === void 0 ? {} : { pendingInteraction: s.pendingInteraction },\n\t\t\t\t...s.cwd === void 0 || s.cwd === "" ? {} : { cwd: s.cwd }\n\t\t\t};\n\t\t}`
  ],
  // 2) SessionNodeItem 签名 + 菜单项（含 dsh-desktop patch 标记）
  [
    `function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {`,
    `function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onOpenDir, drag, flat = false, t }) {`
  ],
  [
    `\t\t\tconst sessionMenuItems = [\n\t\t\t\t{\n\t\t\t\t\tid: "rename",`,
    `\t\t\tconst sessionMenuItems = [\n\t\t\t\t...(node.cwd === void 0 || node.cwd === "" ? [] : [{\n\t\t\t\t\tid: "openDir",\n\t\t\t\t\tlabel: t("menu.openSessionDir"),\n\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, {})\n\t\t\t\t}]),\n\t\t\t\t{\n\t\t\t\t\tid: "rename",`
  ],
  [
    `\t\t\t\t\t\t\t\t\tif (id === "rename") onRename(node.id, row.title);`,
    `\t\t\t\t\t\t\t\t\tif (id === "openDir") onOpenDir?.(node.id, node.cwd);\n\t\t\t\t\t\t\t\t\tif (id === "rename") onRename(node.id, row.title);`
  ],
  // 3) SessionTree 签名 + 传参
  [
    `function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {`,
    `function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, onOpenDir, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {`
  ],
  [
    `\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tdrag: {`,
    `\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tonOpenDir,\n\t\t\t\t\t\t\t\t\t\t\tdrag: {`
  ],
  // 4) FlatList 签名 + 传参
  [
    `function FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {`,
    `function FlatList({ useSessions, open, forkSession, onSessionRename, onSessionArchive, onOpenDir, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {`
  ],
  [
    `\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\tflat: true,`,
    `\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\tonOpenDir,\n\t\t\t\t\t\t\tflat: true,`
  ],
  // 5) WorkspaceBrowser：处理器 + 两处传参
  [
    `\t\t\tconst onSessionArchive = (sessionId) => {\n\t\t\t\tarchiveSession(sessionId).catch((reason) => {\n\t\t\t\t\tconsole.warn("session archive rejected:", reason);\n\t\t\t\t});\n\t\t\t};`,
    `\t\t\tconst onSessionArchive = (sessionId) => {\n\t\t\t\tarchiveSession(sessionId).catch((reason) => {\n\t\t\t\t\tconsole.warn("session archive rejected:", reason);\n\t\t\t\t});\n\t\t\t};\n\t\t\t// dsh-desktop patch: 会话三点菜单里的“打开会话目录”。在桌面端由\n\t\t\t// preload.js 监听该事件并通过 IPC 调起系统资源管理器；浏览器里无监听者，静默忽略。\n\t\t\tconst onOpenDir = (sessionId, cwd) => {\n\t\t\t\tif (!cwd) return;\n\t\t\t\ttry {\n\t\t\t\t\twindow.dispatchEvent(new CustomEvent("dsh-open-session-dir", { detail: { sessionId, path: cwd } }));\n\t\t\t\t} catch {}\n\t\t\t};`
  ],
  [
    `\t\t\t\t\t\t\tonSessionRename,\n\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tarchivedSessionIds,\n\t\t\t\t\t\t\torderBy,`,
    `\t\t\t\t\t\t\tonSessionRename,\n\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tonOpenDir,\n\t\t\t\t\t\t\tarchivedSessionIds,\n\t\t\t\t\t\t\torderBy,`
  ],
  [
    `\t\t\t\t\t\t\tonSessionRename,\n\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tforkSession,`,
    `\t\t\t\t\t\t\tonSessionRename,\n\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tonOpenDir,\n\t\t\t\t\t\t\tforkSession,`
  ],
  // 6) 翻译键（zh + en）
  [
    `"menu.fork": "分叉会话",\n\t\t\t"menu.archiveSession": "归档会话",`,
    `"menu.fork": "分叉会话",\n\t\t\t"menu.archiveSession": "归档会话",\n\t\t\t"menu.openSessionDir": "打开会话目录",`
  ],
  [
    `"menu.fork": "Fork session",\n\t\t\t"menu.archiveSession": "Archive session",`,
    `"menu.fork": "Fork session",\n\t\t\t"menu.archiveSession": "Archive session",\n\t\t\t"menu.openSessionDir": "Open session folder",`
  ],
];

function patchFile(file) {
  if (!fs.existsSync(file)) return { file, status: 'missing' };
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARKER)) return { file, status: 'already-patched' };
  const orig = src;
  let applied = 0;
  for (const [from, to] of REPLACEMENTS) {
    if (!src.includes(from)) {
      console.error(`  !! 未找到替换目标（该处可能已被其他改动覆盖，需人工检查）：\n     ${from.slice(0, 90)}...`);
      continue;
    }
    src = src.split(from).join(to);
    applied += 1;
  }
  if (applied < REPLACEMENTS.length) {
    console.error(`  ✗ ${file}: 只应用了 ${applied}/${REPLACEMENTS.length} 处，放弃写入（避免半成品）。`);
    return { file, status: 'incomplete' };
  }
  fs.writeFileSync(file, src);
  return { file, status: `patched (${applied} replacements)` };
}

const targets = process.argv.slice(2).filter((a) => a.endsWith('client.js'));
const files = targets.length > 0 ? targets : candidatePaths();
let ok = true;
for (const f of files) {
  const r = patchFile(f);
  console.log(`  ${r.status === 'missing' ? '跳过' : r.status === 'already-patched' ? '已打过' : r.status.startsWith('patched') ? '✓' : '✗'}  ${f}`);
  if (r.status === 'incomplete' || r.status === 'missing') ok = false;
}
process.exit(ok ? 0 : 1);
