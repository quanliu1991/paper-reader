// 共享测试启动器库：平台自适应 electron 二进制、vite 生命周期、log/done 文件协议
// 由各 .test.mjs 复用；Mac/Linux 用 node_modules/.bin/electron，Windows 用 electron.cmd
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const ESBUILD_COMMON = {
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  sourcemap: false, logLevel: 'silent',
};

// electron 二进制按平台选：Windows 是 electron.cmd，mac/linux 是 electron。
// 历史教训：9 个启动器写死 electron.cmd，Mac 上 spawn 失败静默超时（2026-10 修复）
export function electronBin() {
  return path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
}

// esbuild 一组 entry → outfile
export async function buildEntries(entries) {
  for (const [entryPoints, outfile] of entries) {
    await build({ ...ESBUILD_COMMON, entryPoints, outfile });
  }
}

// 起 vite dev server（strictPort，默认 5199），resolve 后即可 fetch
export async function startVite(root, port = 5199, label = 'test') {
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`http://localhost:${port}`);
        if (r.ok) { clearInterval(timer); resolve(null); }
      } catch { /* not up */ }
      if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error(`[${label}] vite timeout`)); }
    }, 500);
  });
  return vite;
}

// 起 electron 跑 E2E 入口：等 doneFile 出现或超时；返回 { log, timedOut }
// envFlags 形如 { PR_E2E: '1' }，自动带 PR_E2E_LOG/PR_E2E_DONE/PR_E2E_USER_DATA/VITE_DEV_SERVER_URL
export async function runElectronE2E(root, envFlags, { timeoutMs = 120000, viteUrl = 'http://localhost:5199' } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-e2e-lib-'));
  const logFile = path.join(tmpDir, 'e2e.log');
  const doneFile = path.join(tmpDir, 'done');

  const child = spawn(electronBin(), ['.'], {
    cwd: root, shell: true, stdio: 'ignore',
    env: {
      ...process.env,
      ...envFlags,
      PR_E2E_LOG: logFile,
      PR_E2E_DONE: doneFile,
      PR_E2E_USER_DATA: tmpDir,
      VITE_DEV_SERVER_URL: viteUrl,
    },
  });

  const t0 = Date.now();
  let timedOut = false;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); timedOut = true; resolve(null); }
    }, 400);
  });
  killTree(child);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
  return { log, timedOut, logFile, tmpDir };
}

// 杀进程树（vite 用 shell:true 起的进程组，要整组杀）
export function killTree(child) {
  try { child.kill(); } catch { /* already dead */ }
  try { if (child.pid) process.kill(-child.pid); } catch { /* group gone */ }
}
