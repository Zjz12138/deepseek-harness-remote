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
; 7z 解压进度回调（由 extractAppPackage.nsh 的 Nsis7z::ExtractWithCallback 调用）
;   - 首次回调：把安装进度条切成“跑马灯”（平滑匀速动画），消除原进度条
;     “快速填满 → 长时间冻结 → 突然跳回”的假进度问题；
;   - 每次回调：按真实字节进度（已处理/总量）在详情区输出百分比，
;     用户能清楚看到正在解压而不是卡住。
; 静默安装（/S）没有对话框，全部跳过。
; 注意：卸载器（BUILD_UNINSTALLER）不引用本函数，需跳过以免 makensis 警告报错。
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
Var /GLOBAL dshMarqueeOn
Var /GLOBAL dshExtractLastPct

Function onNsis7zExtractProgress
  Pop $R8   ; 已处理字节（累计）
  Pop $R9   ; 总字节（未压缩）
  ${If} $R9 > 0
    ; 百分比（Int64 防 32 位溢出）
    System::Int64Op $R8 * 100
    Pop $R7
    System::Int64Op $R7 / $R9
    Pop $R6
    ${If} $R6 > 100
      StrCpy $R6 100
    ${EndIf}

    ${IfNot} ${Silent}
      ; 首次调用时切换跑马灯（PBS_MARQUEE = 0x08，PBM_SETMARQUEE = WM_USER+10）
      ${If} $dshMarqueeOn != "1"
        FindWindow $2 "#32770" "" $HWNDPARENT
        GetDlgItem $3 $2 1004
        System::Call 'user32::GetWindowLong(i r3, i -16) .r4'   ; GWL_STYLE
        IntOp $4 $4 | 0x08
        System::Call 'user32::SetWindowLong(i r3, i -16, i r4)'
        SendMessage $3 0x040A 1 0
        StrCpy $dshMarqueeOn "1"
      ${EndIf}

      ; 百分比文本（每 >=5% 打一条，避免刷屏）
      ${If} $dshExtractLastPct == ""
        StrCpy $dshExtractLastPct 0
      ${EndIf}
      IntOp $R5 $R6 - $dshExtractLastPct
      ${If} $R5 >= 5
        StrCpy $dshExtractLastPct $R6
        SetDetailsPrint both
        DetailPrint "正在解压应用文件：$R6%"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  SetDetailsPrint both
  ; 解压阶段已把进度条切成跑马灯；到这里安装接近完成：
  ; 关掉跑马灯并把进度条定格为 100%，避免“满了又退回去”的错觉。
  FindWindow $2 "#32770" "" $HWNDPARENT
  GetDlgItem $3 $2 1004
  SendMessage $3 0x040A 0 0        ; PBM_SETMARQUEE off
  SendMessage $3 0x0402 100 0      ; PBM_SETPOS 100
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
