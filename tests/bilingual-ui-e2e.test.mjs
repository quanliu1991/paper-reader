// 双语书模式 UI E2E：布局切换 + 英中交错渲染 + 划词冒泡挂载 + 高亮标记
import { build } from 'esbuild';
import { electronBin } from './lib/launch.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({
  entryPoints: ['electron/main.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/main.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent',
});
await build({
  entryPoints: ['electron/preload.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/preload.js',
  external: ['electron'], logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-bilingual-ui-'));
const logFile = path.join(tmpDir, 'ui.log');
const doneFile = path.join(tmpDir, 'done');

const vite = spawn('npx', ['vite', '--port', '5197', '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    try {
      const r = await fetch('http://localhost:5197');
      if (r.ok) { clearInterval(timer); resolve(null); }
    } catch { /* */ }
    if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error('vite timeout')); }
  }, 500);
});

const child = spawn(electronBin(), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: {
    ...process.env,
    PR_BILINGUAL_UI_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
    VITE_DEV_SERVER_URL: 'http://localhost:5197',
  },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 120000) { clearInterval(timer); timedOut = true; child.kill(); reject(new Error('timeout')); }
  }, 500);
}).catch(e => console.error(e.message));

vite.kill();
child.kill();
try { console.log(fs.readFileSync(logFile, 'utf8')); } catch { /* */ }
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
const fails = (log.match(/FAIL/g) ?? []).length;
console.log(`[bilingual-ui] ${(!timedOut && fails === 0 && log.includes('ALL PASS')) ? 'ALL PASS' : `${fails} FAIL`}`);
process.exit(!timedOut && fails === 0 && log.includes('ALL PASS') ? 0 : 1);
