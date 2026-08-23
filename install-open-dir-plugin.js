'use strict';

/**
 * install-open-dir-plugin.js — 把自研 client 插件（plugins/dsh-client-ui-open-dir）
 * 安装到 node_modules，使其随 electron-builder 的 `files: node_modules/**` 一起打包，
 * 并在 dsh 启动时（main.js ensureOpenDirPlugin）被链接进 profile 解析路径。
 * 幂等：总是用 plugins/ 下的源码覆盖 node_modules 里的旧拷贝。
 *
 * 安全说明：npm 的 `file:` 依赖可能把 node_modules/dsh-client-ui-open-dir 建成
 * junction/symlink（指向 plugins/ 源码）。Electron 内置 Node v24 的
 * `fs.rmSync(recursive)` 会跟随 junction 递归删除其指向的目标（曾因此清空安装
 * 目录里的插件、导致 dsh 解析 bundle 失败）。因此删除目标前先 lstat 判断：
 * 链接只用 unlinkSync（只删链接本身），真实目录才 rmSync。
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const SRC = path.join(APP_DIR, 'plugins', 'dsh-client-ui-open-dir');
const DST = path.join(APP_DIR, 'node_modules', 'dsh-client-ui-open-dir');

if (!fs.existsSync(path.join(SRC, 'package.json'))) {
  console.error('open-dir plugin source missing: ' + SRC);
  process.exit(1);
}

/** 安全删除路径：junction/symlink 用 unlinkSync（不跟随），普通目录才 rmSync。 */
function removeIfPresent(p) {
  let st = null;
  try {
    st = fs.lstatSync(p);
  } catch {
    // 不存在或断裂链接：force 删除兜底（对 reparse point 只删链接本身）
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {}
    return;
  }
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
  } else {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

removeIfPresent(DST);
fs.cpSync(SRC, DST, { recursive: true });
console.log('open-dir plugin installed -> ' + DST);
