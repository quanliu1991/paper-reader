// UX 审计启动器：vite + electron 真窗口黄金旅程 + 截图 + findings 收集
// 产出 build/ux/screenshots/ + build/ux/findings.json（供 improve-loop 消费）
import { build } from 'esbuild';
import { startVite, runElectronE2E, killTree } from './lib/launch.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/main.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/preload.js', external: ['electron'], logLevel: 'silent' });
await build({ entryPoints: ['tests/ux-audit-entry.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/ux-audit-entry.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });

const vite = await startVite(root, 5199, 'ux-audit');
try {
  const { log, timedOut } = await runElectronE2E(root, { PR_UX_AUDIT: '1', PR_FAKE_LLM: '1' }, { timeoutMs: 180000, viteUrl: 'http://localhost:5199' });
  console.log(log);

  // 收集 UX-FINDING 行 → build/ux/findings.json
  const findings = log.split('\n')
    .filter(l => l.startsWith('UX-FINDING: '))
    .map(l => { try { return JSON.parse(l.slice('UX-FINDING: '.length)); } catch { return null; } })
    .filter(Boolean);
  fs.mkdirSync('build/ux', { recursive: true });
  fs.writeFileSync('build/ux/findings.json', JSON.stringify({ at: new Date().toISOString(), findings }, null, 2));

  const fatal = log.includes('FATAL') || log.includes('UX AUDIT FAIL');
  const ok = !timedOut && !fatal;
  console.log(`[ux-audit] ${ok ? 'DONE' : 'FAIL'} | findings=${findings.length} | screenshots → build/ux/screenshots/`);
  console.log(`[ux-audit] findings → build/ux/findings.json`);
  killTree(vite);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(e?.message ?? e);
  killTree(vite);
  process.exit(1);
}
