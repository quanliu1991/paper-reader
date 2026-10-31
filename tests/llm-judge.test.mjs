// LLM 体验评估启动器：本地优先/云端兜底，不可用降级 SKIP（不阻塞）
import { build } from 'esbuild';
import { runElectronE2E } from './lib/launch.mjs';
import fs from 'fs';

await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/main.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });
await build({ entryPoints: ['tests/llm-judge-entry.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist-electron/llm-judge-entry.js', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent' });

const { log, timedOut } = await runElectronE2E(process.cwd(), { PR_LLM_JUDGE: '1' }, { timeoutMs: 300000, viteUrl: 'http://localhost:5173' });
console.log(log);
const judgeFindings = log.split('\n').filter(l => l.startsWith('LLM-JUDGE-FINDING: ')).length;
const done = log.includes('LLM JUDGE DONE');
const skip = log.includes('provider: NONE');
console.log(`[llm-judge] ${done ? (skip ? 'SKIP (no provider)' : 'DONE') : 'FAIL'} | findings=${judgeFindings} | → build/ux/llm-judge.json`);
// SKIP 不算失败（降级策略），FAIL（崩溃/超时）才非 0
process.exit(done ? 0 : 1);
