'use strict';

/**
 * apply-nsis-patches.js — 给 electron-builder 的 NSIS 模板打补丁（dsh-desktop 私有改动）。
 *
 * 改动点：
 *   1. templates/nsis/installSection.nsh
 *      非静默安装时 SetDetailsPrint none → both（详情区显示每个真实文件/进度，不再空白）。
 *   2. templates/nsis/include/extractAppPackage.nsh
 *      7z 解压改为【直接解压到最终安装目录】+ Nsis7z::ExtractWithCallback 进度回调：
 *      - 原模板先解压到 $PLUGINSDIR\7z-out 再用 CopyFiles 二次复制 —— 应用有 1.5 万+
 *        小文件，Windows 逐文件复制极慢（安装卡顿的根源）；直接解压=单次写入。
 *      - 回调（onNsis7zExtractProgress，定义在项目根 installer.nsh，模板的 include
 *        位于 Section 内部不能声明顶层 Function）驱动跑马灯进度条与真实百分比。
 *
 * 幂等：逐条判断目标片段是否已存在，存在即跳过。
 * 用法：node apply-nsis-patches.js [templates 根目录]（缺省自动探测 node_modules/app-builder-lib/templates/nsis）。
 */

const fs = require('node:fs');
const path = require('node:path');

function templateRoot() {
  const rel = path.join('node_modules', 'app-builder-lib', 'templates', 'nsis');
  return path.join(__dirname, rel);
}

const PATCHES = [
  {
    file: 'installSection.nsh',
    from: `\${IfNot} \${Silent}
  SetDetailsPrint none
\${endif}`,
    to: `\${IfNot} \${Silent}
  ; dsh-desktop patch: 显示每个文件的真实安装过程（原为 none，详情区一片空白）
  SetDetailsPrint both
\${endif}`,
  },
  // 2a) 解压头：原模板先解压到 7z-out，改为直接解压到 $OUTDIR + 进度回调
  {
    file: path.join('include', 'extractAppPackage.nsh'),
    from: `  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\\7z-out"
  Nsis7z::Extract "\${FILE}"
  Pop $R0
  SetOutPath $R0`,
    to: `  ; dsh-desktop patch: 直接解压到最终安装目录（$OUTDIR），
  ; 不再先解压到 $PLUGINSDIR\\7z-out 再用 CopyFiles 二次复制——
  ; 应用有 1.5 万+ 小文件，Windows 复制逐文件建句柄极慢（安装曾卡在复制阶段）。
  ; 直接解压 = 单次写入，速度快一倍以上，同时磁盘占用减半。
  Push $OUTDIR
  ClearErrors
  SetOutPath $OUTDIR
  SetDetailsPrint both
  DetailPrint "正在解压应用文件到安装目录，请稍候…"
  ; 用 ExtractWithCallback 驱动平滑进度（跑马灯）与真实百分比输出
  GetFunctionAddress $9 onNsis7zExtractProgress
  Nsis7z::ExtractWithCallback "\${FILE}" $9
  Pop $R0
  SetOutPath $R0`,
  },
  // 2b) 重试块：删掉 CopyFiles 二次复制与 7z-out 清理，保留 5 次重试兜底
  {
    file: path.join('include', 'extractAppPackage.nsh'),
    from: `  # Retry counter
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1

    # Attempt to copy files in atomic way
    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR
    IfErrors 0 DoneExtract7za

    DetailPrint \`Can't modify "\${PRODUCT_NAME}"'s files.\`
    \${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    \${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    \${endIf}

    # As an absolutely last resort after a few automatic attempts and user
    # intervention - we will just overwrite everything with \`Nsis7z::Extract\`
    # even though it is not atomic and will ignore errors.

    # Clear the temporary folder first to make sure we don't use twice as
    # much disk space.
    RMDir /r "$PLUGINSDIR\\7z-out"

    Nsis7z::Extract "\${FILE}"
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend`,
    to: `  # 失败重试（文件被占用等场景；保留原 5 次重试的兜底）
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1
    IfErrors 0 DoneExtract7za

    DetailPrint \`Can't modify "\${PRODUCT_NAME}"'s files.\`
    \${if} $R1 < 5
      Sleep 1000
      Goto LoopExtract7za
    \${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
      Goto LoopExtract7za
    \${endIf}

  AbortExtract7za:
    Quit

  DoneExtract7za:
!macroend`,
  },
];

function applyPatch(src, from, to) {
  if (src.includes(from)) return { src: src.split(from).join(to), status: 'patched' };
  if (src.includes(to)) return { src, status: 'already' };
  return { src, status: 'missing' };
}

const root = process.argv[2] ? path.resolve(process.argv[2]) : templateRoot();
let ok = true;
const byFile = new Map();
for (const p of PATCHES) {
  if (!byFile.has(p.file)) byFile.set(p.file, { full: path.join(root, p.file), patches: [] });
  byFile.get(p.file).patches.push(p);
}
for (const [rel, { full, patches }] of byFile) {
  if (!fs.existsSync(full)) {
    console.error(`  ✗ 不存在  ${rel}`);
    ok = false;
    continue;
  }
  let src = fs.readFileSync(full, 'utf8');
  let dirty = false;
  for (const p of patches) {
    const r = applyPatch(src, p.from, p.to);
    if (r.status === 'patched') {
      src = r.src;
      dirty = true;
      console.log(`  ✓  ${rel}`);
    } else if (r.status === 'already') {
      console.log(`  已打过  ${rel}`);
    } else {
      console.error(`  ✗ 未找到目标  ${rel}\n     ${p.from.slice(0, 80)}...`);
      ok = false;
    }
  }
  if (dirty) fs.writeFileSync(full, src);
}
process.exit(ok ? 0 : 1);
