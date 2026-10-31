// 集成测试：db 层 + 纯文本解析 —— 在 Electron 运行时执行（原生模块 ABI 匹配）
// Windows 下 Electron 是 GUI 子系统，stdout 不进控制台 → 输出写日志文件轮询
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-test-'));
const logFile = path.join(tmpDir, 'test.log');
const doneFile = path.join(tmpDir, 'done');

await build({
  entryPoints: ['scripts/test-db-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/.test-db-bundle.cjs',
  external: ['electron', 'better-sqlite3'],
  logLevel: 'silent',
});

const electronBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(electronBin, ['scripts/.test-db-bundle.cjs'], {
  env: { ...process.env, PR_TEST_DIR: tmpDir, PR_LOG: logFile, PR_DONE: doneFile },
  shell: true,
  stdio: 'ignore',
});

// 轮询日志直到 done 文件出现
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) {
      clearInterval(timer);
      resolve();
    } else if (Date.now() - t0 > 60000) {
      clearInterval(timer);
      child.kill();
      reject(new Error('timeout'));
    }
  }, 300);
});

const log = fs.readFileSync(logFile, 'utf8');
console.log(log);
const pass = log.includes('ALL PASS');
process.exit(pass ? 0 : 1);
