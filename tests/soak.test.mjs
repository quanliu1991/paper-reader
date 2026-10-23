// 稳定性 soak：主进程内反复 导入/读取/删除 论文 × N 轮，监控 RSS 与耗时
// 判定：RSS 增长 < 30%（相对第 1 轮），无异常
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

await build({
  entryPoints: ['tests/soak-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/soak-entry.js',
  external: ['electron', 'better-sqlite3'],
  logLevel: 'silent',
});
// main 重编（保证钩子）
await build({
  entryPoints: ['electron/main.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/main.js',
  external: ['electron', 'better-sqlite3'], logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-soak-'));
const logFile = path.join(tmpDir, 'soak.log');
const doneFile = path.join(tmpDir, 'done');

const child = spawn(path.join('node_modules', '.bin', 'electron.cmd'), ['.'], {
  env: { ...process.env, PR_SOAK: '1', PR_SOAK_LOG: logFile, PR_SOAK_DONE: doneFile, PR_SOAK_USER_DATA: tmpDir },
  shell: true, stdio: 'ignore',
});

const t0 = Date.now();
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(); }
    else if (Date.now() - t0 > 300000) { clearInterval(timer); child.kill(); reject(new Error('soak timeout')); }
  }, 500);
});

const log = fs.readFileSync(logFile, 'utf8');
console.log(log);
const ok = log.includes('SOAK PASS');
console.log(`[soak] ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
