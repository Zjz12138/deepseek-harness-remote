'use strict';

/**
 * apply-nsis-progress-fix.js — 让 NSIS 安装器显示真实解压进度。
 *
 * electron-builder 26.15.3 的模板 extractAppPackage.nsh 用无回调的
 * `Nsis7z::Extract` 解压 app-*.7z：解压期间进度条不动、详情区空白（"假进度"）。
 * 本脚本把两处调用改成 `Nsis7z::ExtractWithDetails`（nsis7z 插件原生支持，
 * 参数是含 %s% 占位符的进度文本），解压时显示 "Extracting application files: N%"
 * 且进度条真实推进。幂等：含补丁标记行即跳过。
 *
 * 注：electron-builder 升级（npm install 重装 app-builder-lib）会还原模板，
 * postinstall / build-win.cmd 都会重跑本脚本。
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(
  __dirname,
  'node_modules',
  'app-builder-lib',
  'templates',
  'nsis',
  'include',
  'extractAppPackage.nsh'
);

const MARKER = '; dsh-desktop patch: real extract progress via ExtractWithDetails';
const FROM = 'Nsis7z::Extract "${FILE}"';
const TO = 'Nsis7z::ExtractWithDetails "${FILE}" "Extracting application files: %s%"';

if (!fs.existsSync(TARGET)) {
  console.error('[nsis-progress-fix] extractAppPackage.nsh not found: ' + TARGET);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');

if (src.includes(MARKER)) {
  console.log('[nsis-progress-fix] already applied, skipping.');
  process.exit(0);
}

const count = src.split(FROM).length - 1;
if (count < 2) {
  console.error(`[nsis-progress-fix] 期望找到 2 处 Nsis7z::Extract，实际 ${count} 处（模板版本变了？）`);
  console.error('  请检查 ' + TARGET + ' 后更新本脚本。');
  process.exit(1);
}

src = src.split(FROM).join(TO);
// 在文件头加补丁标记（保持 NSIS 注释语法）
src = `; ${MARKER.slice(2)}\n` + src;
fs.writeFileSync(TARGET, src, 'utf8');
console.log(`[nsis-progress-fix] patched ${count} spots -> ${TARGET}`);
