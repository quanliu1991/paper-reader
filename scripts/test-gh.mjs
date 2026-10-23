// 集成测试：GitHub 仓库桥（真实 D:\paper 只读 + 沙盒副本写测试）
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-gh-'));
const logFile = path.join(tmpDir, 'test.log');
const doneFile = path.join(tmpDir, 'done');

await build({
  entryPoints: ['scripts/test-gh-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/.test-gh-bundle.cjs',
  external: ['electron', 'better-sqlite3'],
  logLevel: 'silent',
});

const electronBin = path.join('node_modules', '.bin', 'electron.cmd');
const child = spawn(electronBin, ['scripts/.test-gh-bundle.cjs'], {
  env: { ...process.env, PR_TEST_DIR: tmpDir, PR_LOG: logFile, PR_DONE: doneFile },
  shell: true,
  stdio: 'ignore',
});

await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(); }
    else if (Date.now() - t0 > 60000) { clearInterval(timer); child.kill(); reject(new Error('timeout')); }
  }, 300);
});

const log = fs.readFileSync(logFile, 'utf8');
console.log(log);
process.exit(log.includes('ALL PASS') ? 0 : 1);
