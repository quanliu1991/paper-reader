// 解析器测试：跑本地 fixture（离线、快速）
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const useElectron = process.argv.includes('--electron');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-parse-'));
const logFile = path.join(tmpDir, 'test.log');
const doneFile = path.join(tmpDir, 'done');

await build({
  entryPoints: ['scripts/test-arxiv-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/.test-arxiv-bundle.cjs',
  external: ['electron'],
  logLevel: 'silent',
});

if (!useElectron) {
  // 纯 Node 直接跑（解析器不依赖 electron）
  const { execFileSync } = await import('child_process');
  const out = execFileSync(process.execPath, ['-e',
    `const m = require('./scripts/.test-arxiv-bundle.cjs'); m.default().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})`
  ], { encoding: 'utf8' });
  console.log(out);
  process.exit(0);
}

// electron 模式（Windows 下 stdout 丢，写文件轮询）
const electronBin = path.join('node_modules', '.bin', 'electron.cmd');
spawn(electronBin, ['scripts/.test-arxiv-bundle.cjs'], {
  env: { ...process.env, PR_LOG: logFile, PR_DONE: doneFile },
  shell: true, stdio: 'ignore',
});
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const t = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(t); resolve(); }
    else if (Date.now() - t0 > 60000) { clearInterval(t); reject(new Error('timeout')); }
  }, 300);
});
console.log(fs.readFileSync(logFile, 'utf8'));
