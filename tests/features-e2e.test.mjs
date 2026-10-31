// 功能覆盖 E2E 启动器：主进程级（无窗口），PR_FAKE_LLM=1 不烧 token
import { build } from 'esbuild';
import { electronBin, runElectronE2E } from './lib/launch.mjs';

await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/main.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });
await build({ entryPoints: ['tests/features-e2e-entry.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/features-e2e-entry.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });

const { log, timedOut } = await runElectronE2E(process.cwd(), { PR_FEATURES_E2E: '1', PR_FAKE_LLM: '1' }, { timeoutMs: 90000, viteUrl: 'http://localhost:5173' });
console.log(log);
const fails = (log.match(/: FAIL/g) || []).length;
const ok = !timedOut && fails === 0 && log.includes('E2E ALL PASS');
console.log(`[features-e2e] ${ok ? 'ALL PASS' : `${fails} FAILURES`}`);
process.exit(ok ? 0 : 1);
