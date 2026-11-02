// 首页摘要显示验收启动器：node scripts/verify-home.mjs
import { build } from 'esbuild';
import { electronBin } from '../tests/lib/launch.mjs';
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
await build({ ...common, entryPoints: ['tests/home-summary-entry.ts'], outfile: 'dist-electron/home-summary-entry.js' });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-homev-'));
const logFile = path.join(tmpDir, 'home.log');
const doneFile = path.join(tmpDir, 'done');

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    try {
      const r = await fetch('http://localhost:5199');
      if (r.ok) { clearInterval(timer); resolve(null); }
    } catch { /* not up */ }
    if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error('vite timeout')); }
  }, 500);
});

const child = spawn(electronBin(), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: { ...process.env, PR_HOME_VERIFY: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir, VITE_DEV_SERVER_URL: 'http://localhost:5199' },
});

const t0 = Date.now();
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 90000) { clearInterval(timer); child.kill(); resolve(null); }
  }, 500);
});
vite.kill(); child.kill();

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
console.log(log);
const ok = log.includes('HOME SUMMARY PASS');
console.log(`[home-verify] ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
