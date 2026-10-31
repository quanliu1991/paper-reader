// E2E 黄金路径测试：启动真实 App（隔离 userData）→ 主进程内断言 导入→读取→划线→闪卡→SM-2→持久化
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 编译 e2e 入口（main.js 由 scripts/electron-build.mjs 产出，本测试重编保证钩子最新）
await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist-electron/main.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  logLevel: 'silent',
});
await build({
  entryPoints: ['tests/e2e-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/e2e-entry.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-e2e-'));
const logFile = path.join(tmpDir, 'e2e.log');
const doneFile = path.join(tmpDir, 'done');

// electron 二进制按平台选：Windows 是 electron.cmd，mac/linux 是 electron
const electronBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
// 宿主环境（IDE 内嵌终端等）可能残留 ELECTRON_RUN_AS_NODE=1，
// 会让 electron 二进制退化成纯 Node（protocol undefined）——必须清掉
const env = {
  ...process.env,
  PR_E2E: '1',
  PR_E2E_LOG: logFile,
  PR_E2E_DONE: doneFile,
  PR_E2E_USER_DATA: tmpDir,
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ['.'], {
  env,
  shell: true,
  stdio: 'ignore',
});

const t0 = Date.now();
const TIMEOUT = 60000;
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(); }
    else if (Date.now() - t0 > TIMEOUT) { clearInterval(timer); try { child.kill(); } catch {} reject(new Error('E2E timeout')); }
  }, 400);
});

const log = fs.readFileSync(logFile, 'utf8');
console.log(log);
const failCount = (log.match(/FAIL/g) || []).length;
const ok = log.includes('E2E ALL PASS');
console.log(`[e2e] ${ok ? 'ALL PASS' : `${failCount} FAILURES`}`);
process.exit(ok ? 0 : 1);
