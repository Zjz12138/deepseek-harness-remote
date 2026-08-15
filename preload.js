'use strict';

/**
 * Preload for the dsh-desktop shell (runs in both loading.html and the GUI).
 *
 * 1. Ctrl+wheel -> zoom (kept alongside the Ctrl+= / Ctrl+- / Ctrl+0 keys,
 *    which are handled in the main process via before-input-event).
 * 2. Injects the custom title bar (#dsh-titlebar) that replaces the native
 *    menu bar: app title + 文件/视图/帮助 buttons that open native menus, and
 *    minimize/maximize/close window controls. The window is frameless, so
 *    everything here is what the user sees at the top.
 */

const { ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// 1. Ctrl+wheel zoom
// ---------------------------------------------------------------------------

let wheelAcc = 0;
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    const step = 60; // normalize mouse notches vs trackpad deltas
    while (Math.abs(wheelAcc) >= step) {
      ipcRenderer.send('ui-zoom', wheelAcc > 0 ? -1 : 1);
      wheelAcc -= Math.sign(wheelAcc) * step;
    }
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// 2. Custom title bar
// ---------------------------------------------------------------------------

const TITLE = 'DeepSeek Harness';

const ICON_MIN =
  '<svg width="10" height="10" viewBox="0 0 10 10"><line x1="0.5" y1="5" x2="9.5" y2="5" stroke="currentColor" stroke-width="1"/></svg>';
const ICON_MAX =
  '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>';
const ICON_RESTORE =
  '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/></svg>';
const ICON_CLOSE =
  '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1"/></svg>';

function titlebarHtml() {
  return (
    '<div id="dsh-titlebar">' +
    '<span class="dsh-tb-title">' + TITLE + '</span>' +
    '<div class="dsh-tb-menus">' +
    '<button class="dsh-tb-menu" data-menu="file" title="文件">文件</button>' +
    '<button class="dsh-tb-menu" data-menu="view" title="视图">视图</button>' +
    '<button class="dsh-tb-menu" data-menu="help" title="帮助">帮助</button>' +
    '</div>' +
    '<span class="dsh-tb-spacer"></span>' +
    '<div class="dsh-tb-wins" id="dsh-win-controls">' +
    '<button class="dsh-tb-win" data-win="min" title="最小化">' + ICON_MIN + '</button>' +
    '<button class="dsh-tb-win" data-win="max" id="dsh-win-max" title="最大化">' + ICON_MAX + '</button>' +
    '<button class="dsh-tb-win" data-win="max" id="dsh-win-restore" title="还原" style="display:none">' + ICON_RESTORE + '</button>' +
    '<button class="dsh-tb-win dsh-tb-close" data-win="close" title="关闭">' + ICON_CLOSE + '</button>' +
    '</div>' +
    '</div>'
  );
}

function ensureTitlebar() {
  if (document.getElementById('dsh-titlebar') || !document.body) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = titlebarHtml();
  const bar = wrap.firstElementChild;
  document.body.insertBefore(bar, document.body.firstChild);
  applyWinState(lastWinState);
}

let lastWinState = { maximized: false, fullscreen: false };

function applyWinState(state) {
  lastWinState = state;
  const maxBtn = document.getElementById('dsh-win-max');
  const restoreBtn = document.getElementById('dsh-win-restore');
  const controls = document.getElementById('dsh-win-controls');
  if (maxBtn) maxBtn.style.display = state.maximized ? 'none' : 'inline-flex';
  if (restoreBtn) restoreBtn.style.display = state.maximized ? 'inline-flex' : 'none';
  if (controls) controls.style.display = state.fullscreen ? 'none' : 'flex';
}

document.addEventListener('click', (e) => {
  const menuBtn = e.target.closest && e.target.closest('.dsh-tb-menu');
  if (menuBtn) {
    const rect = menuBtn.getBoundingClientRect();
    ipcRenderer.send('menu-popup', {
      menu: menuBtn.dataset.menu,
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
    return;
  }
  const winBtn = e.target.closest && e.target.closest('.dsh-tb-win');
  if (winBtn) {
    ipcRenderer.send('win-control', winBtn.dataset.win);
  }
});

ipcRenderer.on('win-state', (_event, state) => applyWinState(state));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureTitlebar);
} else {
  ensureTitlebar();
}

// Re-inject if the app ever replaces <body>'s children.
const bodyObserver = new MutationObserver(() => {
  ensureTitlebar();
  ensureSidebarButton();
});
window.addEventListener('DOMContentLoaded', () => {
  if (document.body) bodyObserver.observe(document.body, { childList: true });
});

// ---------------------------------------------------------------------------
// 3. Sidebar "手机访问" button（注入到 dsh GUI 侧边栏，位于“新会话”下方）
//    完全克隆“新会话”按钮的样式类，保证视觉与主题一致。
// ---------------------------------------------------------------------------

const SIDEBAR_BTN_ID = 'dsh-sidebar-mobile';

const ICON_PHONE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><rect x="7" y="2" width="10" height="20" rx="2.5"/><line x1="10.8" y1="18" x2="13.2" y2="18"/></svg>';

function findNewSessionButton() {
  // 注意：顶部品牌（logo）按钮也带 aria-label="新建会话"，需排除，取真正的“新会话”按钮
  const labels = ['新建会话', 'New session'];
  const candidates = [];
  for (const l of labels) {
    document.querySelectorAll('[aria-label="' + l + '"]').forEach((el) => candidates.push(el));
  }
  const real = candidates.find((el) => el.tagName === 'BUTTON' && !/brand/i.test(el.className || ''));
  if (real) return real;
  const btns = document.querySelectorAll('button');
  for (const b of btns) {
    const t = (b.textContent || '').trim();
    if (t === '新会话' || t === 'New Session') return b;
  }
  return null;
}

function ensureSidebarButton() {
  if (document.getElementById(SIDEBAR_BTN_ID) || !document.body) return;
  const anchor = findNewSessionButton();
  if (!anchor || !anchor.parentElement) return;
  // 克隆“新会话”按钮 → 样式、尺寸、折叠态、主题完全一致
  const btn = anchor.cloneNode(true);
  btn.id = SIDEBAR_BTN_ID;
  btn.setAttribute('aria-label', '手机访问');
  btn.title = '手机访问：扫码配对，用手机操作电脑';
  // 原位替换：图标 → 手机图标；label 文本 → “手机访问”（保留克隆的全部类名）
  const icon = btn.querySelector('svg');
  if (icon) {
    const holder = document.createElement('span');
    holder.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
    holder.innerHTML = ICON_PHONE;
    icon.replaceWith(holder.firstElementChild);
  }
  const spans = [...btn.querySelectorAll('span')];
  const labelEl = spans.find((s) => /label/i.test(String(s.className))) || spans[spans.length - 1];
  if (labelEl) {
    labelEl.textContent = '手机访问';
  } else {
    // 极端情况：整体重建
    btn.innerHTML = '';
    const i = document.createElement('span');
    i.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
    i.innerHTML = ICON_PHONE;
    const t = document.createElement('span');
    t.textContent = '手机访问';
    btn.appendChild(i);
    btn.appendChild(t);
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('open-mobile-panel');
  });
  // 侧边栏折叠成窄条（rail）时只显示图标
  const textEl = labelEl;
  const adapt = () => {
    const w = anchor.getBoundingClientRect().width;
    if (textEl) textEl.style.display = w < 70 ? 'none' : 'inline';
  };
  adapt();
  window.addEventListener('resize', adapt);
  anchor.insertAdjacentElement('afterend', btn);
}

// 侧边栏由 React 渲染，可能重绘；定时兜底 + 上面 body 观察器共同保证注入
setInterval(ensureSidebarButton, 2000);
