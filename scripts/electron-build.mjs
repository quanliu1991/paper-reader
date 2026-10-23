// 用 esbuild 把 Electron 主进程 + preload 编译为 CJS（dist-electron/）
// 独立于 vite renderer 构建，保证产物路径确定
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const outdir = 'dist-electron';
fs.rmSync(outdir, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: path.join(outdir, 'main.js'),
});

await build({
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: path.join(outdir, 'preload.js'),
});

console.log('[electron-build] done');
