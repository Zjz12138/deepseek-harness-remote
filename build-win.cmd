@echo off
rem ============================================================
rem  DeepSeek Harness - Windows build script
rem  Usage: build-win.cmd [--dir]   (--dir = package dir only)
rem
rem  Why these env vars are fixed here:
rem  - HTTP(S)_PROXY points at a stale local proxy (127.0.0.1:7897);
rem    when the proxy app is off, electron-builder hangs/fails with
rem    ECONNREFUSED, so we clear them.
rem  - ELECTRON_BUILDER_BINARIES_MIRROR points at the npmmirror
rem    (China) mirror so tool downloads (winCodeSign etc.) never
rem    depend on GitHub being reachable.
rem ============================================================
setlocal
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
rem 打包前强制把自研插件（plugins/）拷进 node_modules，防止 postinstall 未执行/
rem file: 依赖符号链接失败留下空壳，打出带空插件目录的安装包
call node install-open-dir-plugin.js || exit /b 1
call node_modules\.bin\electron-builder.cmd --win --config.directories.output=release-new %*
exit /b %ERRORLEVEL%
