// 翻译质量 E2E 启动器：esbuild bundle → electron 跑真实 LLM 翻译 → QC 验收
// 注意：默认用生产 userData（拿真实 Provider 配置）；--isolated 用临时库（无 Provider 则 SKIP）
import { build } from 'esbuild';
import { electronBin } from './lib/launch.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const isolated = process.argv.includes('--isolated');

await build({
  entryPoints: ['tests/translate-quality-entry.ts'],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: 'dist-electron/translate-quality-entry.js',
  external: ['electron', 'better-sqlite3'], logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tr-quality-'));
const logFile = path.join(tmpDir, 'quality.log');
const doneFile = path.join(tmpDir, 'done');

const env = {
  ...process.env,
  PR_TR_QUALITY_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile,
  ...(isolated ? { PR_E2E_USER_DATA: tmpDir } : {}),
};

const child = spawn(electronBin(), ['.'], {
  cwd: process.cwd(), shell: true, stdio: 'ignore', env,
});

const t0 = Date.now();
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 300000) { clearInterval(timer); child.kill(); reject(new Error('timeout')); }
  }, 500);
});

const logTxt = fs.readFileSync(logFile, 'utf8');
console.log(logTxt);
const ok = logTxt.includes('E2E ALL PASS');
console.log(`[translate-quality] ${ok ? 'ALL PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
