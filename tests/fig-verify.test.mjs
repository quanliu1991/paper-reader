// fig-verify.test.mjs — 图表修复验证启动器（拷真实库到隔离 userData，PR_FIG_VERIFY 链路）
// 断言：4 张 SVG 真图在 pdf-dual/translate/bilingual/zh 布局全部加载，无「图片下载中」残留
import { build } from 'esbuild';
import { startVite, runElectronE2E, killTree } from './lib/launch.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/main.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/preload.js', external: ['electron'], logLevel: 'silent' });
await build({ entryPoints: ['tests/fig-verify-entry.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/fig-verify-entry.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });

const vite = await startVite(root, 5199, 'fig-verify');
try {
  const { log, timedOut } = await runElectronE2E(root, { PR_FIG_VERIFY: '1' }, { timeoutMs: 120000, viteUrl: 'http://localhost:5199' });
  console.log(log.trim());
  if (timedOut) { console.error('[fig-verify] TIMEOUT'); process.exit(1); }
  process.exit(log.includes('FIG VERIFY ALL PASS') ? 0 : 1);
} finally {
  killTree(vite);
}
