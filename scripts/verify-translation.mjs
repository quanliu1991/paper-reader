// 全篇真翻译验收启动器：隔离副本（含 .mk）→ translateAll 全部段 → 成功率断言
// 用法：node scripts/verify-translation.mjs（走真实 Provider，烧 token，发布前验收用）
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
await build({ ...common, entryPoints: ['tests/translate-verify-entry.ts'], outfile: 'dist-electron/translate-verify-entry.js' });
console.log('[translate-verify] built');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-trverify-'));
const logFile = path.join(tmpDir, 'tv.log');
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
  env: { ...process.env, PR_TR_VERIFY: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir, VITE_DEV_SERVER_URL: 'http://localhost:5199' },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 20 * 60 * 1000) { clearInterval(timer); timedOut = true; child.kill(); resolve(null); }
  }, 1000);
});
vite.kill(); child.kill();

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
console.log(log);
const ok = !timedOut && log.includes('TRANSLATION VERIFY PASS');
console.log(`[translate-verify] ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
