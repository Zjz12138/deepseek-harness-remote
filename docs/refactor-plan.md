# dsh-desktop 架构与改造计划

> 目标读者：本项目维护者本人。本文既是学习材料（各模块原理），也是分阶段改造的施工图。

## 0. 目标（为什么改）

1. **G1 稳定**：dsh 会不断升级，但本桌面端希望**除非升级特别夸张，否则桌面端可以不动**。
2. **G2 插件化**：能在 dsh 进程内实现的功能，逐步改成 dsh 插件（host / client），替代现在的"改上游源码"打法。
3. **G3 体积**：尽力缩小安装包（当前 Setup ≈ 140 MB），不现实就放弃。
4. **G4 手机端**：手机端尽量不动，除非 dsh 升级特别夸张。

## 1. 各模块原理（学习材料）

### 1.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  Electron 壳（main.js / preload.js / mobile-panel.html）      │
│  · 窗口 / 托盘 / 快捷键 / 启动 dsh web(3080) / 生命周期       │
│  · 打开文件夹：shell.openPath（主进程能力，插件做不了）        │
│  · 手机访问面板窗口（壳内 BrowserWindow）                      │
│  · 手机访问服务 mobile.js(3081) + tunnel.js(cloudflared)      │
└───────────────┬──────────────────────────────┬───────────────┘
                │ 注入 UI（改 client.js / 插件） │ HTTP /auth /m/
                ▼                              ▼
┌──────────────────────────────┐   ┌───────────────────────────┐
│  dsh 进程（@deepseek-ai/dsh  │   │  手机 App（Capacitor +     │
│  + ~100 个插件包，端口 3080） │   │  mobile-ui 静态页）         │
│  · 插件树：host 插件（服务/   │   │  · 只认手机服务 3081 的 API │
│    工具/LLM/HTTP）+ client  │   │  · 配对码 / 令牌 / 会话代理  │
│    插件（UI 模块）           │   └───────────────────────────┘
│  · profile: ~/.dsh/profiles  │
│    /web + cordis.patch.yml   │
└──────────────────────────────┘
```

**边界铁律**：Electron 主进程的能力（窗口、托盘、`shell.openPath`、桌面快捷方式）**不可能**变成 dsh 插件——它们不在 dsh 进程里。能插件化的只是"dsh 进程内能做的事"。

### 1.2 Electron 壳（永远留在壳里）

- `main.js`：主进程。启动 `dsh web`（端口 3080，attach/自起两种模式）、托盘、关闭确认、`open-session-dir` IPC → `shell.openPath`、手机访问生命周期（`startMobileAccess`/`stopMobileAccess`）、隧道守护重启。
- `preload.js`：`contextBridge` 暴露 `window.dsh`（壳 API）+ 监听 `dsh-open-session-dir` 事件转发给主进程。
- `loading.html` / `icon.ico`：启动画面与图标。
- **结论**：这部分与 dsh 版本**几乎无关**，dsh 升级不动它。

### 1.3 dsh 本体与依赖网格

- `node_modules/@deepseek-ai/*` 约 100 个包，**版本强耦合**（monorepo 同发同版本）。当前装 `0.1.0-rc.6`，官方已发 `0.1.1-rc.2`（npm `latest` 标签是旧的，要用 `next`/具体版本号）。
- `@deepseek-ai/dsh` 是 CLI/启动器；`dsh web` 把插件树 + Web UI 起在 3080。
- **升级方式**：整套 `@deepseek-ai/dsh-*` 一起升到同一版本，只升一个会散架。

### 1.4 dsh 插件体系（核心知识）

- **Profile**：`~/.dsh/profiles/<name>/`（本项目是 `web`）。`package.json` 里 `dsh.profile.bundles` 列出"组合包"层；用户自己的 `cordis.patch.yml` 是**用户层**，可 `insert`/覆盖插件 entry，不用改任何上游源码。
- **host 插件**（服务端）：cordis 插件，`name + inject + apply`，注册 service / tool / LLM provider / HTTP 路由。例：`dsh-tool-todo`、`dsh-llm-deepseek`、`dsh-host-webserver`。
- **client 插件**（UI 端）：package.json 声明 `"dsh": { "client": { "inject": [...], "platform": "web" } }`，提供 `exports["./client"]` 的 `client.js`，在客户端注册 UI 模块（`slots.register` / `conversationViews.register` / commands 等）。`dsh-client-modules` 自动扫描、编成 `window.__DSH_BOOT__` 图、按 `/plugins/<id>/client.js?rev=` 提供。
- **现成的 UI 贡献点（实测确认）**：侧边栏 `sidebar.footer.action`、`sidebar.settings`、`sidebar.workspaces` 等 `slots.register` 插槽；会话视图、命令面板。
- **没有贡献点的**：**工作区行 "⋯" 菜单**（`workspaceMenuItems` 是组件内静态数组）——这正是我们之前用字符串补丁硬加"打开文件夹"的原因。

### 1.5 手机访问（mobile.js / mobile-api.js / tunnel.js）

- `mobile.js`：手机访问 HTTP 服务（端口 3081）。配对码、设备令牌认证、会话/状态 API。
- `mobile-api.js`：**转发层**——把 dsh web（3080）的 API 用 mux 转发给手机。**这是手机端与 dsh 版本唯一的耦合点**。
- `tunnel.js`：内嵌 cloudflared，把 3081 暴露成 `*.trycloudflare.com` 公网地址（每次启动随机）。
- `mobile-panel.html`：壳内控制面板（局域网/远程切换、二维码、设备管理）。
- `mobile-ui`：手机 App 的 Web 静态资源（打包进桌面端）。
- **结论**：手机端（App + 服务）不依赖 dsh 的具体版本，只依赖 `mobile-api.js` 转发的 dsh web API 契约；dsh 普通升级不影响。

### 1.6 UI 补丁机制（现状与脆弱性）

- `apply-dsh-picker-fix.js` / `apply-dsh-ui-patches.js`：对 `node_modules` 里的 `client.js` 做**字面字符串替换**（幂等标记 `dsh-desktop patch`），`package.json` 的 `postinstall` 自动执行。
- **脆弱点**：dsh 升级后 `client.js` 内容变化，补丁要么找不到目标、要么打错位置。上一轮确认：**升级 rc.2 会让现有补丁失效**，这是"桌面端不得不跟着 dsh 动"的最大原因。
- **出路**：能贡献的点（如侧边栏）用 client 插件；没有贡献点的工作区行菜单要么继续小补丁、要么等上游加贡献点、要么换入口位置。

### 1.7 体积构成（2026-xx-xx 实测）

| 部分 | 大小 | 说明 |
|---|---|---|
| Setup.exe（NSIS） | ~140 MB | v0.0.1/2/3 基本一致 |
| win-unpacked 合计 | ~518 MB | 安装产物 |
| Electron 运行时 | ~340 MB | `DeepSeek Harness.exe` 215MB + locales 47MB + dxcompiler 24MB + dll/pak —— **不可压缩的固定成本** |
| resources/app/node_modules | ~118 MB | 见下 |
| resources/app/vendor/cloudflared.exe | ~52 MB | Go 二进制，第二大块 |
| resources/app/mobile-ui + 壳文件 | ~1 MB | 很小 |

node_modules 大头：`@img/sharp` 18.3MB（libvips 原生）、`@deepseek-ai` 14.4MB（dsh 网格，很小）、`@shikijs` 10.5MB（代码高亮语言包）、`node-pty` 9.1MB（终端原生）、`@opentelemetry` 5.4MB、`@vscode/ripgrep` 5.2MB（rg.exe）、`@mistralai` 5.1 / `@google` 4.7（pi-ai 多供应商）、`react-dom` 4.3、`openai` 3.9、`katex` 3.9。

**结论**：Electron 运行时（340MB）+ cloudflared（52MB）是硬成本；"50MB"对"Electron + 完整 dsh web 前端 + cloudflared"不现实。可优化空间：NSIS 压缩级别、cloudflared 用 UPX 压缩、可选裁剪 shiki 语言包/跨平台 prebuild，目标 Setup 约 **70~110MB**；彻底到 50MB 需要换运行时（Tauri）或按需下载 cloudflared，代价大，先不做。

## 2. 耦合点清单（dsh 升级时哪些会受影响）

| 桌面端组件 | 与 dsh 版本耦合 | 影响 |
|---|---|---|
| main.js / preload.js / loading.html | 无 | 稳定 |
| mobile-panel.html / mobile-panel-preload.js | 无（只走自己 IPC） | 稳定 |
| mobile.js（服务） | 低（自己管配对/令牌） | 稳定 |
| mobile-api.js（转发层） | **中** | dsh web API 破坏性变更时需适配 |
| mobile-ui（手机页） | 低（只调手机服务 API） | 稳定 |
| apply-dsh-*.js 补丁 | **高（最容易碎）** | 每次 dsh 升级都要核对/重写 |
| `~/.dsh/settings.yaml`（llm-deepseek 配置） | 中 | 新版本 schema 字段变化（如 rc.2 的 inputModalities） |

## 3. 分阶段计划

### 阶段 A：基线整理（小，先做）
- 清理 `release/` 旧产物（v0.0.1/0.0.2 的 Setup、portable、ffmpeg.exe 231MB 等，省磁盘）。
- 把本计划 + 各模块原理固化成文档（就是本文件）。
- 建立 `docs/upgrade-checklist.md`：dsh 升级时桌面端要检查什么（补丁核对、settings.yaml 字段、mobile-api 转发、client 插件兼容）。

### 阶段 B：插件化第一例 —— "打开文件夹"（验证插件打法）
- **决定点**：先查 rc.2 的 `dsh-client-ui-workspace` 是否新增了行菜单贡献点/插槽。
  - 有 → 用贡献点做 client 插件，删掉对应补丁。
  - 没有 → 两个子选项：
    - B1：把入口挪到**侧边栏插槽**（`sidebar.footer.action` 或 `sidebar.workspaces`），做成正式 client 插件（体验略变：不在行菜单里）。
    - B2：保留行菜单位置，把补丁改造成"版本感知"的小补丁（diff 校验 + 版本号锚定，碎时报错而不是静默打错）。
- 产出：第一个自己的 client 插件包 + `cordis.patch.yml` 的 insert 写法，作为以后所有 UI 插件的模板。

### 阶段 C：dsh 升级 0.1.1-rc.2（拿视觉支持）
- 整套 `@deepseek-ai/dsh-*` 升到 `0.1.1-rc.2`（`next` 标签）。
- 处理：升级前先把 B 阶段完成（补丁越少，升级越稳）。
- `settings.yaml`：`deepseek-v4-flash-vision-exp` 补 `inputModalities: ["text","image"]`（或删自定义 models 用内置目录）。
- 起服务实测视觉模型传图。
- 出 v0.0.4 Setup，用户覆盖安装。

### 阶段 D：体积优化（easy wins 优先）
1. electron-builder `compression: "store"` → `"maximum"`，实测 Setup 大小变化（可能直接省几十 MB）。
2. `vendor/cloudflared.exe` 用 UPX 压缩（52MB → ~25MB），验证隧道功能正常。
3. 可选：裁剪 `@shikijs/langs`（只留常用语言）、清理 node-pty 其他平台 prebuild。
4. 可选（等补丁清零后）：`asar: true`（现在 asar:false 是为了能直接改文件，补丁没了就可以开）。

### 阶段 E：手机访问服务 host 插件化（大工程，可选/后续）
- 把 `mobile.js`/`mobile-api.js`/`tunnel.js` 迁成 host 插件：直接访问 dsh 的 session/tool 服务，去掉 mux 转发层。
- 收益：与 dsh 升级彻底解耦、手机端契约可正式化。
- 代价：重构量大（HTTP 流程 → cordis 服务），且有风险，**建议放最后、单独排期**。

### 阶段 F：固化"桌面端不动"策略
- 补丁清零；所有自研功能走插件；`docs/upgrade-checklist.md` 成为升级 dsh 的必走流程。
- 定义"升级特别夸张"的阈值：dsh 破坏性 API 变更 / client 插件注册 API 变化 / mobile-api 转发层需要重写 —— 这些才需要动桌面端。

## 4. 手机端结论（回答"手机端是不是不用管"）

**基本不用管**：
- 手机 App（APK + mobile-ui）只调手机服务（3081）的 `/auth`、`/m/` API，不直接依赖 dsh 版本。
- 手机服务（mobile.js）自己管配对/令牌/设备；对 dsh 的依赖集中在 `mobile-api.js` 转发层。
- dsh 普通升级（补丁之外）对手机端无感。

**需要管的场景**（升级特别夸张时）：
- dsh web API 破坏性变更 → `mobile-api.js` 转发层适配；
- dsh 新增会话/消息类型且手机 UI 要展示 → `mobile-ui` 加渲染；
- 桌面端重构手机服务（如阶段 E host 插件化）顺手改协议 → 手机 App 跟着发版。

## 5. 风险与回退

- 升级 rc.2：现有 UI 补丁可能失效 → **先做 B 再升 C**；保留旧版 `release/` 产物可回退。
- 插件化：client 插件 API 也可能随 dsh 变化 → 模板化 + checklist。
- 体积：所有优化前先打基线，逐项实测，避免为省几 MB 引入启动问题。
