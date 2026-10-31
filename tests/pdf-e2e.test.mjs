// PDF 链路 E2E 启动器（dev: 完整链路；--packaged: 生产包内 pdfjs 冒烟）
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const packaged = process.argv.includes('--packaged');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pdf-e2e-'));
const logFile = path.join(tmpDir, 'e2e.log');
const doneFile = path.join(tmpDir, 'done');

if (packaged) {
  // 生产校验：PDF 放 tmpDir（PR_E2E_USER_DATA 指向 tmpDir，setPath 已验证生效）
  const pdfsDir = path.join(tmpDir, 'pdfs');
  fs.mkdirSync(pdfsDir, { recursive: true });
  const resp = await fetch('https://arxiv.org/pdf/2609.34683', { signal: AbortSignal.timeout(90000) });
  if (!resp.ok) { console.error('download FAIL'); process.exit(1); }
  fs.writeFileSync(path.join(pdfsDir, '1.pdf'), Buffer.from(await resp.arrayBuffer()));
} else {
  await build({
    entryPoints: ['tests/pdf-e2e-entry.ts'],
    bundle: true, platform: 'node', format: 'cjs',
    outfile: 'dist-electron/pdf-e2e-entry.js',
    external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent',
  });
}

const electronBin = packaged
  ? path.resolve('release/win-unpacked/Paper Reader.exe')
  : path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

// 防宿主 shell 残留 PR_E2E 等变量误入子进程（曾导致 dev 模式 require 错入口超时）
const { PR_E2E, PR_PDF_E2E, PR_E2E_LOG, PR_E2E_DONE, PR_E2E_USER_DATA, ...cleanEnv } = process.env;
const env = {
  ...cleanEnv,
  PR_PDF_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
};

const child = spawn('"' + electronBin + '"', packaged ? [] : ['.'], {
  env, shell: true, stdio: 'ignore',
});

const t0 = Date.now();
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(); }
    else if (Date.now() - t0 > 180000) { clearInterval(timer); child.kill(); reject(new Error('timeout')); }
  }, 500);
});
const log = fs.readFileSync(logFile, 'utf8');
console.log(log);
const ok = log.includes('E2E ALL PASS');
console.log(`[pdf-e2e${packaged ? ' packaged' : ''}] ${ok ? 'ALL PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
