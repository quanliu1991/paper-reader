// 交互功能 UI E2E 启动器：vite + electron 真窗口（palette/review/ask/settings，PR_FAKE_LLM=1）
import { build } from 'esbuild';
import { electronBin, startVite, runElectronE2E, killTree } from './lib/launch.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/main.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/preload.js', external: ['electron'], logLevel: 'silent' });
await build({ entryPoints: ['tests/interact-ui-e2e.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/interact-ui-e2e.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });

const vite = await startVite(root, 5199, 'interact-ui');
try {
  const { log, timedOut } = await runElectronE2E(root, { PR_INTERACT_UI_E2E: '1', PR_FAKE_LLM: '1' }, { timeoutMs: 120000, viteUrl: 'http://localhost:5199' });
  console.log(log);
  const fails = (log.match(/: FAIL/g) || []).length;
  const ok = !timedOut && fails === 0 && log.includes('E2E ALL PASS');
  console.log(`[interact-ui] ${ok ? 'ALL PASS' : `${fails} FAILURES`}`);
  killTree(vite);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(e?.message ?? e);
  killTree(vite);
  process.exit(1);
}
