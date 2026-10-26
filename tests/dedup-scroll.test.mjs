// 启动器：npm run test:dedup-scroll
// esbuild 测试入口 → vite(5199) → electron 主进程(PR_DEDUP_E2E require 测试入口) → 日志回传
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], sourcemap: false, logLevel: 'silent' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js' });
await build({ ...common, entryPoints: ['tests/dedup-scroll.test.ts'], outfile: 'dist-electron/dedup-scroll-entry.js' });
console.log('[dedup-scroll] built');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-dedup-'));
const logFile = path.join(tmpDir, 'dedup.log');
const doneFile = path.join(tmpDir, 'done');

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  console.log('[dedup-scroll] waiting vite :5199 ...');
  const timer = setInterval(async () => {
    try {
      const r = await fetch('http://localhost:5199');
      if (r.ok) { clearInterval(timer); resolve(null); }
    } catch { /* not up */ }
    if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error('vite timeout')); }
  }, 500);
});
console.log('[dedup-scroll] vite up, launching electron ...');

const child = spawn(path.join('node_modules', '.bin', 'electron.cmd'), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: {
    ...process.env,
    PR_DEDUP_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
    VITE_DEV_SERVER_URL: 'http://localhost:5199',
  },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 180000) { clearInterval(timer); timedOut = true; child.kill(); resolve(null); }
  }, 500);
});

vite.kill(); child.kill();
try { process.kill(-vite.pid); } catch {}

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
fs.writeFileSync(path.resolve('build/dedup-scroll-console.txt'), log);
console.log(log);
const ok = !timedOut && log.includes('DEDUP-SCROLL ALL PASS');
console.log(`[dedup-scroll] ${ok ? 'ALL PASS' : 'FAIL'} | console log saved: build/dedup-scroll-console.txt`);
process.exit(ok ? 0 : 1);
