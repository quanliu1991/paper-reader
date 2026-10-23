// PDF 视图 UI E2E 启动器：vite dev + electron 窗口驱动 + 截图断言
import { build, } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({
  entryPoints: ['tests/pdf-ui-e2e.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/pdf-ui-e2e.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pdf-ui-'));
const logFile = path.join(tmpDir, 'ui.log');
const doneFile = path.join(tmpDir, 'done');

// vite dev server
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

const child = spawn(path.join('node_modules', '.bin', 'electron.cmd'), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: {
    ...process.env,
    PR_PDF_UI_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
    VITE_DEV_SERVER_URL: 'http://localhost:5199',
  },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 120000) { clearInterval(timer); timedOut = true; child.kill(); reject(new Error('timeout')); }
  }, 500);
}).catch(e => { console.error(e.message); });

vite.kill();
child.kill();
try { process.kill(-vite.pid); } catch {}

const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
console.log(log);
const ok = !timedOut && log.includes('E2E ALL PASS');
console.log(`[pdf-ui-e2e] ${ok ? 'ALL PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
