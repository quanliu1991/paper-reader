// 主题依赖库 UI E2E 启动器
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-topic-ui-'));
const logFile = path.join(tmpDir, 'ui.log');
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
  env: {
    ...process.env,
    PR_TOPIC_UI_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
    VITE_DEV_SERVER_URL: 'http://localhost:5199',
  },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 180000) { clearInterval(timer); timedOut = true; child.kill(); reject(new Error('timeout')); }
  }, 1000);
});

vite.kill();
child.kill();
try { console.log(fs.readFileSync(logFile, 'utf8')); } catch { /* */ }
if (timedOut || fs.readFileSync(doneFile, 'utf8') !== 'done') { console.error('[topic-ui] FAIL'); process.exit(1); }
const log = fs.readFileSync(logFile, 'utf8');
const fails = (log.match(/FAIL/g) ?? []).length;
console.log(`[topic-ui] ${fails === 0 ? 'ALL PASS' : `${fails} FAIL`}`);
process.exit(fails === 0 ? 0 : 1);
