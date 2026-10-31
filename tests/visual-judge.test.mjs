// 视觉检验启动器：依赖 ux-audit 截图；云端/本地视觉模型；不可用 SKIP
import { build } from 'esbuild';
import { runElectronE2E } from './lib/launch.mjs';

await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/main.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });
await build({ entryPoints: ['tests/visual-judge-entry.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/visual-judge-entry.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });

const { log, timedOut } = await runElectronE2E(process.cwd(), { PR_VISUAL_JUDGE: '1' }, { timeoutMs: 600000, viteUrl: 'http://localhost:5173' });
console.log(log);
const vf = log.split('\n').filter(l => l.startsWith('VISUAL-JUDGE-FINDING: ')).length;
const done = log.includes('VISUAL JUDGE DONE');
const skip = log.includes('SKIP');
console.log(`[visual-judge] ${done ? (skip ? 'SKIP' : 'DONE') : 'FAIL'} | findings=${vf} | → build/ux/visual-judge.json`);
process.exit(done ? 0 : 1);
