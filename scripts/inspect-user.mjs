// 用户库检查启动器：vite + electron（连真实 userData，不污染——只读打开）
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-inspect-'));
const logFile = path.join(tmpDir, 'inspect.log');
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

const child = spawn(path.join('node_modules', '.bin', 'electron.cmd'), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: { ...process.env, PR_UI_INSPECT: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, VITE_DEV_SERVER_URL: 'http://localhost:5199' },
});

const t0 = Date.now();
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 60000) { clearInterval(timer); resolve(null); }
  }, 500);
});
vite.kill(); child.kill();
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
console.log(log);
