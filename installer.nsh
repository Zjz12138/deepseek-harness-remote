; DeepSeek Harness — NSIS installer customization
; Show real per-file install progress in the details page (no fake progress bar).

!macro customHeader
  ; Details page shows the actual file being extracted (真实安装进度)
  ShowInstDetails show
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "正在安装 DeepSeek Harness ... 请稍候"
  SetDetailsPrint listonly
!macroend
