// 强制门禁启动器：npm run guard
// esbuild 主进程 → vite(5199) → electron(PR_ASSERT_E2E) → A/B/C/D 四断言 → GUARD ALL PASS 才算过
import { build } from 'esbuild';
import { electronBin } from './lib/launch.mjs';
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
console.log('[guard] electron main built');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-guard-'));
const logFile = path.join(tmpDir, 'guard.log');
const doneFile = path.join(tmpDir, 'done');

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  console.log('[guard] waiting vite :5199 ...');
  const timer = setInterval(async () => {
    try {
      const r = await fetch('http://localhost:5199');
      if (r.ok) { clearInterval(timer); resolve(null); }
    } catch { /* not up */ }
    if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error('vite timeout')); }
  }, 500);
});
console.log('[guard] vite up, launching electron guard ...');

const child = spawn(electronBin(), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: {
    ...process.env,
    PR_ASSERT_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
    VITE_DEV_SERVER_URL: 'http://localhost:5199',
  },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 120000) { clearInterval(timer); timedOut = true; child.kill(); resolve(null); }
  }, 500);
});

vite.kill(); child.kill();
try { process.kill(-vite.pid); } catch {}

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
console.log(log);
const ok = !timedOut && log.includes('GUARD ALL PASS');
console.log(`[visual-guard] ${ok ? 'ALL PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
