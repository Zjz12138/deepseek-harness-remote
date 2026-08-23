# dsh 升级时桌面端检查清单（upgrade checklist）

> 目的：dsh（`@deepseek-ai/dsh` 网格）升级时，按此清单逐项核对，保证桌面端"尽量不动、动了也知道动哪"。
> 配套：《refactor-plan.md》阶段 C/F。

## 0. 升级前准备

- [ ] `git status` 干净，当前版本（`package.json` 的 version）与上次发布一致。
- [ ] 记录当前 dsh 版本：`npm view @deepseek-ai/dsh dist-tags --json`（`latest` 标签可能是旧的，认 `next`/具体版本号）。
- [ ] 确认**整套网格同版本**：`dsh`、`dsh-llm`、`dsh-host-apiproxy`、`dsh-client-ui-*` 等 `@deepseek-ai/*` 全部要有目标版本号。
- [ ] 备份 `~/.dsh/settings.yaml`（模型/provider 配置）。

## 1. 依赖网格

- [ ] `dsh-desktop/package.json` 里所有 `@deepseek-ai/*`（约 20 个直接依赖）升到同一版本号，**不允许混版本**。
- [ ] `npm install` 后抽查关键包版本：`node_modules/@deepseek-ai/dsh/package.json`、`dsh-llm-deepseek`、`dsh-client-ui-workspace`。
- [ ] postinstall 是否成功（`apply-dsh-picker-fix.js` / `apply-dsh-ui-patches.js` 是否报错——报错=补丁目标已变）。

## 2. UI 补丁核对（最易碎，优先）

- [ ] 逐个补丁脚本跑一遍（幂等），看 `found` 数量是否为 0 或与上次不一致。
- [ ] 抽查三份副本的 `client.js`（dev node_modules / release win-unpacked / 用户安装实例）是否一致、是否含补丁标记 `dsh-desktop patch`。
- [ ] 新版本是否已原生包含原补丁功能（如行菜单"打开文件夹"）→ 是则删除对应补丁。
- [ ] 目标已变的补丁：改用 client 插件（有贡献点）或重写锚点（无贡献点）。

## 3. client 插件核对

- [ ] 自研 client 插件用的 `slots.register` / `conversationViews.register` / commands API 签名是否变化（对照 `dsh-client-runtime`）。
- [ ] `window.__DSH_BOOT__` 图里自研插件条目仍在（抓 `/plugins/<自研包>/client.js?rev=` 200）。
- [ ] `dsh.client` 声明（`inject`/`platform`）校验是否仍通过。

## 4. settings.yaml（~/.dsh）

- [ ] `llm-deepseek` 配置字段是否仍被 schema 接受（如 rc.2 新增 `inputModalities`/`imagePixelBudget`）。
- [ ] 模型目录：自定 models 若缺 `inputModalities`，视觉模型会默认回落成 text-only（rc.2 起）。
- [ ] `agent-default-model` 的 provider 名是否仍注册（`deepseek-official`）。

## 5. 手机访问（mobile.js / mobile-api.js / mobile-ui）

- [ ] `mobile-api.js` 转发的 dsh web API（session/tool/状态）是否有破坏性变更 → 有则适配转发层。
- [ ] 手机 App（APK）不需要动，除非：dsh 新增会话/消息类型要手机端展示、或协议重构。
- [ ] `tunnel.js`/cloudflared 与 dsh 版本无关，跳过。

## 6. 冒烟测试（起服务后）

- [ ] `dsh web` 能起，3080 页面正常。
- [ ] 桌面端壳功能：窗口/托盘/打开文件夹/手机访问面板。
- [ ] 配对二维码生成；手机 App 连上（局域网）。
- [ ] 模型能力：视觉模型能传图（或至少不再报"不支持图片"）。
- [ ] 远程隧道开启、二维码可扫。

## 7. 出包与回退

- [ ] `node --check` 全部自研脚本；三份副本同步（node_modules / release / 用户实例）。
- [ ] 构建新 Setup；保留上一版 Setup 可回退。
- [ ] 用户安装后：确认 profile 写入（自研插件 entry）幂等、不破坏既有配置。
