'use strict';

/**
 * apply-dsh-privacy-patch.js — 给 dsh 桌面 Web 的会话行加 data-session-id。
 *
 * 目的：桌面"隐私模式"需要按会话 id 对会话行做显示/隐藏与"隐藏/取消隐藏"。
 * dsh 的会话行（dsh-client-ui-workspace/lib/client.js 的 SessionNodeItem）不会把
 * session id 暴露成 DOM 属性，这里用字符串补丁给该行 div 补上 data-session-id={node.id}。
 * preload.js 注入的隐私控制器据此监听 DOM。
 *
 * 幂等：已含 "data-session-id": node.id 即跳过。与 apply-dsh-ui-patches.js（rc.2）
 * 同一机制：因 rc 升级会改变锚点，故加标记，改错目标则后续必重新核对。
 *
 * 用法：node apply-dsh-privacy-patch.js <client.js 路径>
 */

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('用法: node apply-dsh-privacy-patch.js <dsh-client-ui-workspace/lib/client.js>');
  process.exit(1);
}

const file = path.resolve(target);
if (!fs.existsSync(file)) {
  console.error('目标文件不存在: ' + file);
  process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');

if (src.includes('"data-session-id": node.id')) {
  console.log('[privacy-patch] already patched, skip: ' + file);
  process.exit(0);
}

// 精确匹配 SessionNodeItem 的树节点行（role=treeitem + aria-selected + onClick onOpen）
// 其它 treeitem（工作区树节点）不含 onClick onOpen，不会误命中。
const anchor =
  '\t\t\t\t\trole: "treeitem",\n' +
  '\t\t\t\t\t"aria-selected": selected,\n' +
  '\t\t\t\t\tonClick: () => {\n' +
  '\t\t\t\t\t\tonOpen(node.id);\n' +
  '\t\t\t\t\t},';

if (!src.includes(anchor)) {
  console.error('[privacy-patch] 未命中 SessionNodeItem 锚点，可能 rc 已变，请人工核对: ' + file);
  process.exit(2);
}

const replacement =
  '\t\t\t\t\trole: "treeitem",\n' +
  '\t\t\t\t\t"data-session-id": node.id, // dsh-desktop privacy patch\n' +
  '\t\t\t\t\t"aria-selected": selected,\n' +
  '\t\t\t\t\tonClick: () => {\n' +
  '\t\t\t\t\t\tonOpen(node.id);\n' +
  '\t\t\t\t\t},';

src = src.replace(anchor, replacement);
fs.writeFileSync(file, src, 'utf8');
console.log('[privacy-patch] patched: ' + file);
