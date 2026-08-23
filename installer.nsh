; DeepSeek Harness — NSIS installer customization
; 真实安装进度：
;   - 详情区默认展开，显示每个正在写入的文件与解压百分比（installSection.nsh /
;     extractAppPackage.nsh 的补丁保证）；
;   - 安装进度条为平滑“跑马灯”动画（见下方 onNsis7zExtractProgress 回调），
;     不再出现“快速填满 → 长时间冻结 → 突然跳回”的假进度。

; 本文件在模板顶部被 include，LogicLib 尚未加载，先声明（模板内已有同名 include，重复无害）
!include "LogicLib.nsh"

!macro customHeader
  ; 详情页默认展开，显示真实安装过程（文件列表 + 百分比）
  ShowInstDetails show
!macroend

; ---------------------------------------------------------------------------
; 说明（2026-08-23 更新）：electron-builder 26.15.3 的 extractAppPackage.nsh
; 使用 Nsis7z::Extract（无回调），不再调用自定义解压进度函数；旧版自定义的
; onNsis7zExtractProgress 已删除（否则 makensis 报 6010 未引用警告并被当作
; 错误）。安装进度改回 electron-builder 默认；ShowInstDetails 仍保留。
; ---------------------------------------------------------------------------

!macro customInstall
  SetDetailsPrint both
  DetailPrint "安装完成！"

  ; 冷启动提速（可选）：把安装目录加入 Windows Defender 排除列表，
  ; 避免实时扫描应用内的上万个文件（dsh node_modules）拖慢每次启动。
  ; 由用户在安装时明确选择（默认推荐“是”）；需要管理员权限，
  ; 非管理员安装时通过 UAC 二次提升执行（会多弹一次 UAC，正常现象）。
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "是否添加 Windows Defender 排除以加速启动？$\r$\n$\r$\n排除后冷启动可从十几秒提速到几秒（推荐）。$\r$\n仅排除应用安装目录，卸载时会自动移除，不影响系统安全。$\r$\n（需要管理员权限，可能弹出 UAC 确认）" IDYES dshDoExcl IDNO dshSkipExcl
  Goto dshSkipExcl
  dshDoExcl:
    DetailPrint "正在优化启动速度（Windows Defender 排除）…"
    nsExec::Exec "powershell.exe -NoProfile -WindowStyle Hidden -Command $\"Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','Add-MpPreference -ExclusionPath ''$INSTDIR'' -ErrorAction SilentlyContinue'$\""
  dshSkipExcl:
!macroend

!macro customUnInstall
  ; 卸载时移除安装时添加的 Defender 排除（若仍在），不留残留。
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "admin"
    nsExec::Exec "powershell.exe -NoProfile -WindowStyle Hidden -Command $\"Remove-MpPreference -ExclusionPath '$INSTDIR' -ErrorAction SilentlyContinue$\""
  ${EndIf}
!macroend
