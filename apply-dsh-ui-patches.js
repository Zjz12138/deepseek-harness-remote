'use strict';

/**
 * apply-dsh-ui-patches.js — 给 dsh 上游 web UI 打补丁（dsh-desktop 私有改动）。
 *
 * 改动点（@deepseek-ai/dsh-client-ui-workspace/lib/client.js，仅工作区行三点菜单）：
 *   在「重命名 / 删除工作区」前新增「打开文件夹」（menu.openWorkspaceDir），
 *   点击后向 window 派发 `dsh-open-session-dir` 自定义事件（detail.path = 工作区
 *   目录 row.cwd），由 desktop 端 preload.js 接收并调起系统资源管理器；
 *   浏览器里无监听者，静默忽略。
 *
 * 针对 rc.2 的 client.js（rc.1 之前锚点已变）。幂等：含补丁标记即跳过。
 * 用法：node apply-dsh-ui-patches.js [client.js 路径...]（缺省自动探测）。
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'dsh-desktop patch';

function candidatePaths() {
  const here = __dirname;
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  const out = [path.join(here, rel)];
  const unpacked = path.join(here, 'release', 'win-unpacked', 'resources', 'app', rel);
  if (fs.existsSync(unpacked)) out.push(unpacked);
  return out;
}

const REPLACEMENTS = [
  // 1) 工作区行三点菜单：在「重命名」前插入「打开文件夹」项
  [
    'const workspaceMenuItems = [{\n\t\t\t\tid: "rename",',
    'const workspaceMenuItems = [{\n\t\t\t\tid: "openDir",\n\t\t\t\tlabel: t("openWorkspaceDir"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, {})\n\t\t\t}, {\n\t\t\t\tid: "rename",'
  ],
  // 2) onSelect：处理 openDir（派发 dsh-open-session-dir 事件）
  [
    'onSelect: (id) => {\n\t\t\t\t\t\t\t\tsetMenuOpen(false);\n\t\t\t\t\t\t\t\t/* v8 ignore next -- workspaceMenuItems carries exactly these two rows today. */\n\t\t\t\t\t\t\t\tif (id !== "rename" && id !== "delete") return;',
    'onSelect: (id) => {\n\t\t\t\t\t\t\t\tsetMenuOpen(false);\n\t\t\t\t\t\t\t\t// dsh-desktop patch: 工作区菜单“打开文件夹”→ 复用会话的 dsh-open-session-dir 事件\n\t\t\t\t\t\t\t\tif (id === "openDir") {\n\t\t\t\t\t\t\t\t\tif (row.cwd) {\n\t\t\t\t\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\t\t\t\t\twindow.dispatchEvent(new CustomEvent("dsh-open-session-dir", { detail: { path: row.cwd } }));\n\t\t\t\t\t\t\t\t\t\t} catch {}\n\t\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\t/* v8 ignore next -- workspaceMenuItems carries exactly these two rows today. */\n\t\t\t\t\t\t\t\tif (id !== "rename" && id !== "delete") return;'
  ],
  // 3) zh 字典加键
  [
    '"rename": "重命名",\n\t\t\t"rename.workspace.title": "重命名工作区",',
    '"rename": "重命名",\n\t\t\t"openWorkspaceDir": "打开文件夹",\n\t\t\t"rename.workspace.title": "重命名工作区",'
  ],
  // 4) en 字典加键
  [
    '"rename": "Rename",\n\t\t\t"rename.workspace.title": "Rename workspace",',
    '"rename": "Rename",\n\t\t\t"openWorkspaceDir": "Open workspace folder",\n\t\t\t"rename.workspace.title": "Rename workspace",'
  ],
];

function patchFile(file) {
  if (!fs.existsSync(file)) return { file, status: 'missing' };
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARKER)) return { file, status: 'already-patched' };
  let applied = 0;
  for (const [from, to] of REPLACEMENTS) {
    if (!src.includes(from)) {
      console.error(`  !! 未找到替换目标（第 ${applied + 1} 处）：\n     ${JSON.stringify(from.slice(0, 80))}`);
      continue;
    }
    src = src.split(from).join(to);
    applied += 1;
  }
  if (applied < REPLACEMENTS.length) {
    console.error(`  ✗ ${file}: 只应用了 ${applied}/${REPLACEMENTS.length} 处，放弃写入。`);
    return { file, status: 'incomplete' };
  }
  fs.writeFileSync(file, src, 'utf8');
  return { file, status: `patched (${applied} replacements)` };
}

const targets = process.argv.slice(2).filter((a) => a.endsWith('client.js'));
const files = targets.length > 0 ? targets : candidatePaths();
let ok = true;
for (const f of files) {
  const r = patchFile(f);
  const label = r.status === 'missing' ? '跳过' : r.status === 'already-patched' ? '已打过' : r.status.startsWith('patched') ? '✓' : '✗';
  console.log(`  ${label}  ${f}`);
  if (r.status === 'incomplete' || r.status === 'missing') ok = false;
}
process.exit(ok ? 0 : 1);
