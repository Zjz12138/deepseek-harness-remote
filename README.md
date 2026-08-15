# DeepSeek Harness 桌面版 + 手机遥控

把 **DeepSeek Harness**（dsh 智能体工作台）变成一个桌面应用，并支持 **手机远程操控电脑**：
不用开命令行、不用装 Node.js —— 下载安装包，双击即可用；手机装 APK，扫码配对后就能在手机上给电脑发指令、看回复。

> 手机端是独立设计的界面，会话与电脑端完全共享；**agent 始终在电脑上执行**，手机只是遥控器。

---

## 📥 下载（Release 页面）

到本仓库右侧 **Releases** 最新版（v0.0.1）下载，只有两个文件，平台不通用：

| 文件 | 支持平台 | 用途 |
| --- | --- | --- |
| `DeepSeek-Harness-0.0.1-Setup.exe` | **仅 Windows**（Win10/11 x64） | 电脑端**安装包**，双击安装，自动创建桌面快捷方式 |
| `DeepSeek-Harness-0.0.1-mobile.apk` | **仅 Android**（无需 Google 服务） | 手机端 App（约 32MB），传到手机安装 |

> ⚠️ `.exe` 只能装到 Windows 电脑，`.apk` 只能装到安卓手机，两者不能互换使用。
> 电脑端已**内置 dsh 服务与所有依赖**（含 Cloudflare 隧道组件），无需安装 Node.js 或任何其它软件。
> 安装包较大（约 140MB）是因为自带了完整的运行环境，保证开箱即用。

---

## 🚀 快速开始（3 步）

1. **电脑**：安装/运行桌面版 → 左侧边栏点 **“📱 手机访问”** → 点 **“🚀 启动手机访问”** → 出现二维码。
   - 同一 WiFi 选“同一网络”；不在同一网络选“远程访问（Cloudflare 隧道，免费免配置）”。
2. **手机**：安装 APK → 打开 App → 点 **“扫描二维码”**（或“从相册选择二维码”）→ 扫电脑上的码。
3. **电脑**：弹出配对确认 → **允许并设为当前设备** → 手机进入首页，开始使用。

之后每次打开 App 都会自动连上（同一手机无需重新扫码）；电脑端可随时在面板中移除设备。

---

## ✨ 功能

- **桌面端**
  - 双击启动，自动拉起/复用 dsh 服务（端口 3080），秒开
  - 自定义字号（Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0）、字体、宽屏模式
  - 关闭时可选“后台运行（托盘，服务继续跑，下次秒开）”或“彻底关闭”
  - 自绘标题栏菜单、托盘图标、手机访问控制面板

- **手机端**
  - 原生扫码配对（ZXing，**不依赖 Google Play 服务**，国内手机可用），零输入
  - 会话列表 / 聊天 / 新建会话（可选工作区）/ 设置
  - 打开会话只加载最新 **200 条**，上翻到顶分批加载更早历史
  - 斜杠命令（`/permission` 权限模式、`/preset` Agent 预设、`/stop` 停止等，与桌面端同一数据源）
  - 执行命令时显示友好动作名（如“正在执行压缩命令…”），不再直接刷屏输出；
    超长回复自动折叠，点“展开全部”查看
  - 支持显示思考过程（reasoning）、工具调用、系统消息（灰色）与用户输入（蓝色）区分
  - 离线自动重连（网络恢复无需重新扫码）、“回到最新”悬浮按钮、返回手势

- **安装体验**
  - 安装进度条为平滑动画，详情区显示正在解压的文件与真实百分比（不再“填满后冻结/跳回”）
  - 首次启动稍慢属正常（内置完整 dsh 运行环境）

- **安全模型**
  - 扫码配对 + 电脑端确认；每台设备独立 256 位令牌（电脑只存哈希，可单独吊销）
  - 单活跃控制设备：手机丢失也无法被远程接管
  - 工具调用仍需 dsh 自身审批；全部操作写入审计日志；失败限流

---

## ❓ 常见问题

- **手机连不上电脑？** 确认手机与电脑在同一 WiFi；Windows 防火墙首次弹窗选“允许专用网络”；面板里可点“放行防火墙”。
- **远程访问连不上？** 部分网络会屏蔽 `trycloudflare.com`，可先试手机流量；不行就用“同一网络”。
- **电脑重启后远程地址变了？** Cloudflare 隧道地址每次重启会变，重新扫码一次即可（手机 App 会记住电脑，局域网连接不受影响）。
- **APK 装不上？** 手机需开启“允许安装未知来源”。
- **报错信息？** 任何报错都会弹窗并带“复制错误详情”按钮，可直接粘贴反馈。

---

## 🔧 从源码构建（开发者）

```powershell
# 电脑端（需要 Node.js 18+）
cd dsh-desktop
npm install
npm run dist          # 产出 release/ 下的安装包 + 便携版

# 手机端 APK（需要 Android SDK + JDK21）
cd dsh-desktop\apk
copy /y capacitor.config.json.prod.bak capacitor.config.json
xcopy /e /y ..\mobile-ui\* www\
npx cap copy android
set JAVA_HOME=<JDK21路径> & set ANDROID_HOME=<SDK路径>
gradle-8.14.3\bin\gradle.bat -p android assembleDebug
```

目录结构：`main.js`（Electron 主进程）、`mobile.js`（手机访问服务）、`mobile-api.js`（dsh RPC 客户端）、`mobile-ui/`（手机 App 界面）、`apk/`（Capacitor Android 工程）、`tunnel.js`（Cloudflare 隧道）。

### 已知修复补丁（dsh 上游 bug）

`npm install` 后会自动运行 3 个补丁脚本：

1. **`apply-dsh-picker-fix.js`** — 修复 `@deepseek-ai/dsh-host-directory-picker-native`
   的目录选择崩溃：
   - **现象**：桌面端新建会话选择文件夹时，worker 进程以原生访问违规崩溃
     （`win32 folder dialog worker exited before reporting a result`），
     控制台/日志出现 `napi_fatal_error`。
   - **根因**：dsh 的 `worker.cjs` 用 `koffi.view(address, 32768)` 盲读 32KB 取路径；
     短路径的 `CoTaskMemAlloc` 块很小，越界读入未提交页即崩溃。
     `koffi.decode(addr, 'str16')` 也会崩溃（解引用指针）。
   - **修复**：改用官方安全 API `koffi.decode.string16(addr)`
     （NUL 终止 UTF-16 安全解码，不超读分配）。

2. **`apply-dsh-ui-patches.js`** — 给 `dsh-client-ui-workspace` 会话菜单加
   **“打开会话目录”**（与重命名/分叉/归档同级，用系统资源管理器打开该会话的目录）。

3. **`apply-nsis-patches.js`** — 安装器进度体验：
   进度条切换为平滑跑马灯动画，详情区按真实字节进度输出“正在解压应用文件：x%”，
   并显示每个正在写入的文件（修复进度条“快速填满→冻结→跳回”的假进度）。

---

## ⚠️ 免责声明

本项目为个人使用而开发，用于在自己的电脑上远程使用 DeepSeek Harness。**请勿**在未授权设备上安装使用；远程访问（公网隧道）会暴露控制能力，请仅在可信网络使用并及时在电脑端移除不再使用的设备。
