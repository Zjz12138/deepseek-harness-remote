'use strict';

/**
 * tunnel.js — 内嵌 cloudflared 快速隧道（远程访问，免装其它应用）。
 *
 * 启动 cloudflared 把本机 mobile 端口（如 3081）暴露为一个公网 HTTPS 地址
 * （*.trycloudflare.com，无需账号 / 公网 IP / 端口映射）。安全边界仍是
 * 手机访问服务本身的配对 + 设备令牌认证。
 *
 * 就绪验证：cloudflared 打印出公网地址后，边缘路由通常还要几秒才生效，
 * 过早扫码会拿到 530 → 手机端 “Failed to fetch”。因此拿到 URL 后本模块
 * 会持续探测该地址（GET /auth/status），直到真正可路由（ready=true），
 * 面板才展示远程二维码。
 *
 * 注意：快速隧道地址在每次启动时随机生成；应用重启后地址变化，
 * 手机端重新扫码即可。
 */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const APP_DIR = __dirname;
const CLOUDFLARED = path.join(APP_DIR, 'vendor', 'cloudflared.exe');

const VERIFY_DEADLINE_MS = 25000; // 拿到 URL 后等待边缘路由就绪的最大时长
const VERIFY_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 8000;

let child = null;
let url = null;
let ready = false;
let verifyFailed = false;
let stopping = false;
let reprobeTimer = null;
let logFn = (m) => console.log('[tunnel] ' + m);
let onUrl = null;
let onExit = null; // (code) => void 隧道非预期退出时回调（由主进程决定是否重启）

function setLogger(fn) {
  logFn = fn;
}

function setOnUrl(fn) {
  onUrl = fn;
}

function setOnExit(fn) {
  onExit = fn;
}

function isAvailable() {
  return fs.existsSync(CLOUDFLARED);
}

function getUrl() {
  return url;
}

function isRunning() {
  return !!child;
}

/** 隧道公网地址是否已被本机验证可路由（此时二维码才值得扫）。 */
function isReady() {
  return ready;
}

/** 拿到地址但探测未通过（本机网络可能屏蔽 Cloudflare）。 */
function isVerifyFailed() {
  return verifyFailed;
}

/**
 * 由“真实隧道流量”标记为已验证：手机端经隧道 URL 成功连上本机时调用。
 * 本机探测会因 GFW/网络屏蔽而误报失败，但手机能连上就是最可靠的证明。
 */
function markVerified() {
  if (!child || !url) return;
  ready = true;
  verifyFailed = false;
  clearTimeout(reprobeTimer);
  logFn('tunnel verified via real traffic: ' + url);
  if (onUrl) onUrl(url);
}

/** 探测未通过时，每隔一段时间自动重试（网络恢复后自动转为已就绪）。 */
function scheduleReprobe() {
  if (reprobeTimer || stopping || !child || !url || ready) return;
  reprobeTimer = setTimeout(async () => {
    reprobeTimer = null;
    if (!child || !url || ready) return;
    const code = await probeStatus(url + '/auth/status', PROBE_TIMEOUT_MS);
    if (code >= 200 && code < 500) {
      ready = true;
      verifyFailed = false;
      logFn('tunnel verified by reprobe: ' + url);
      if (onUrl) onUrl(url);
    } else {
      scheduleReprobe();
    }
  }, 20000);
}

/** curl 探测（Windows 自带 curl）：双栈 + 系统解析，对本机 trycloudflare 子域最可靠。 */
function curlProbe(targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    const secs = Math.max(3, Math.round(timeoutMs / 1000));
    execFile(
      'curl.exe',
      ['-sS', '-m', String(secs), '-o', 'NUL', '-w', '%{http_code}', targetUrl],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(0);
        const code = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(code) && code > 0 ? code : 0);
      }
    );
  });
}

/** 单次探测：GET /auth/status。curl 优先；失败再走 Node https（强制 IPv4）。 */
async function probeStatus(targetUrl, timeoutMs) {
  const viaCurl = await curlProbe(targetUrl + '/auth/status', timeoutMs);
  if (viaCurl >= 200 && viaCurl < 500) return viaCurl;
  return httpsProbe(targetUrl + '/auth/status', timeoutMs);
}

/** Node https 兜底探测（本网络 IPv6 无路由，fetch 默认走 IPv6 会假失败，故强制 IPv4）。 */
function httpsProbe(targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (!done) {
        done = true;
        resolve(code);
      }
    };
    let req;
    try {
      req = https.get(targetUrl, { family: 4, timeout: timeoutMs }, (res) => {
        res.resume();
        finish(res.statusCode || 0);
      });
    } catch {
      finish(0);
      return;
    }
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      finish(0);
    });
    req.on('error', () => finish(0));
  });
}

/** 探测隧道公网地址是否真的可路由：GET /auth/status 有 HTTP 响应即视为路由成功。 */
async function verify(targetUrl, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!child) return false;
    const code = await probeStatus(targetUrl + '/auth/status', PROBE_TIMEOUT_MS);
    if (code >= 200 && code < 500) return true;
    await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
  }
  return false;
}

/** 启动隧道，返回 Promise<{url, ready, verifyFailed}>（60 秒内拿到公网地址）。 */
function start(port) {
  return new Promise((resolve, reject) => {
    if (child) {
      resolve({ url, ready, verifyFailed });
      return;
    }
    if (!isAvailable()) {
      reject(new Error('缺少 vendor/cloudflared.exe'));
      return;
    }
    stopping = false;
    url = null;
    ready = false;
    verifyFailed = false;
    const target = `http://127.0.0.1:${port}`;
    logFn(`starting tunnel → ${target}`);
    child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', target], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        logFn('tunnel URL timeout');
        reject(new Error('获取隧道地址超时'));
      }
    }, 60000);

    const scan = (chunk) => {
      const text = String(chunk);
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        url = m[0];
        logFn('tunnel url: ' + url);
        if (onUrl) onUrl(url);
        // 等边缘真正开始路由（避免手机扫码拿到 530）
        verify(url, VERIFY_DEADLINE_MS).then((ok) => {
          ready = ok;
          verifyFailed = !ok;
          logFn(ok ? 'tunnel verified: ' + url : 'tunnel NOT verified (network may block trycloudflare)');
          if (!ok) scheduleReprobe(); // 本机探测受限时持续后台重试
          resolve({ url, ready, verifyFailed });
        });
      }
    };

    child.stdout.on('data', (d) => scan(d));
    child.stderr.on('data', (d) => scan(d));
    child.on('exit', (code, signal) => {
      const wasStopping = stopping;
      const wasSettled = settled;
      child = null;
      url = null;
      ready = false;
      verifyFailed = false;
      logFn(`tunnel exited (code=${code} signal=${signal})`);
      if (!wasSettled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('隧道进程退出（code=' + code + '）'));
      } else if (!wasStopping && onExit) {
        onExit(code);
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function stop() {
  stopping = true;
  clearTimeout(reprobeTimer);
  reprobeTimer = null;
  if (child) {
    try {
      child.kill();
    } catch {}
  }
  child = null;
  url = null;
  ready = false;
  verifyFailed = false;
}

module.exports = {
  isAvailable,
  isRunning,
  isReady,
  isVerifyFailed,
  getUrl,
  markVerified,
  start,
  stop,
  setLogger,
  setOnUrl,
  setOnExit,
};
