// apply-dsh-picker-fix.js
// Applies the directory-picker crash fix to @deepseek-ai/dsh-host-directory-picker-native.
// Run after `npm install` (node_modules may be recreated).
//
// WHY: dsh's worker.cjs readUtf16() does `koffi.view(address, 32768)` to read a
// NUL-terminated UTF-16 path from CoTaskMemAlloc memory. A short folder path
// allocates a tiny heap block, so the blind 32 KiB read crosses into an
// uncommitted page and crashes the worker with a native access violation
// (napi_fatal_error) right after the user picks a folder in the workspace
// directory picker. koffi.decode(addr, 'str16') also dereferences the pointer
// and crashes. The safe API is koffi.decode.string16(addr), which reads a
// NUL-terminated UTF-16 string without over-reading the allocation.
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(
  __dirname,
  'node_modules',
  '@deepseek-ai',
  'dsh-host-directory-picker-native',
  'lib',
  'worker.cjs'
);

if (!fs.existsSync(target)) {
  console.error('[dsh-picker-fix] worker.cjs not found:', target);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');

// Already patched? (match only the function body, not the doc comment)
if (/function readUtf16\(koffi, address\) \{\s*\/\/ Fixed:[\s\S]*?return koffi\.decode\.string16\(address\);/.test(src)) {
  console.log('[dsh-picker-fix] already applied, skipping.');
  process.exit(0);
}

const oldFn = /function readUtf16\(koffi, address\) \{[\s\S]*?\n\}/;
if (!oldFn.test(src)) {
  console.error('[dsh-picker-fix] readUtf16 not found (dsh version changed?). Please update this script.');
  process.exit(1);
}

const newFn = `function readUtf16(koffi, address) {
	// Fixed: koffi.decode.string16 reads a NUL-terminated UTF-16 string safely.
	// The previous koffi.view(address, 32768) blind read crashed on short
	// CoTaskMemAlloc blocks (see file header).
	return koffi.decode.string16(address);
}`;

src = src.replace(oldFn, newFn);
fs.writeFileSync(target, src, 'utf8');
console.log('[dsh-picker-fix] worker.cjs patched (string16 safe decode).');
