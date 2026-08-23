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
cd /d "%~dp0"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
rem Force-copy the local plugin into node_modules before packaging so a
rem missing postinstall / failed file: symlink can never ship an empty shell.
call node "%~dp0install-open-dir-plugin.js" || exit /b 1
call "%~dp0node_modules\.bin\electron-builder.cmd" --win --config.directories.output=release-new %*
exit /b %ERRORLEVEL%
