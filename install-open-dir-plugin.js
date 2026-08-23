'use strict';

/**
 * install-open-dir-plugin.js — 把自研 client 插件（plugins/dsh-client-ui-open-dir）
 * 安装到 node_modules，使其随 electron-builder 的 `files: node_modules/**` 一起打包，
 * 并在 dsh 启动时（main.js ensureOpenDirPlugin）被链接进 profile 解析路径。
 * 幂等：总是用 plugins/ 下的源码覆盖 node_modules 里的旧拷贝。
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
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
console.log('open-dir plugin installed -> ' + DST);
