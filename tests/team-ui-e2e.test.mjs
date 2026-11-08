// 团队功能 UI E2E 启动器：起 team server + vite + Electron 真实窗口
// 运行：node tests/team-ui-e2e.test.mjs
// 注意：此测试先 esbuild electron/main.ts（含 PR_TEAM_UI_E2E 分支）——
// DEVELOPMENT.md 陷阱 #2：.test.mjs 只编译自己的 entry 不含 main.ts，改过 main.ts 必须重建。
import { build } from 'esbuild';
import { electronBin } from './lib/launch.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 1) 重建 main.js（团队 E2E 分支 + account IPC）
await build({
  entryPoints: ['electron/main.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/main.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent',
});

// 2) 起 team server（随机端口 + 隔离 DB）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-team-ui-'));
const logFile = path.join(tmpDir, 'ui.log');
const doneFile = path.join(tmpDir, 'done');
const teamPort = 18800 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(teamPort), DB_PATH: path.join(tmpDir, 'team.db') },
  stdio: ['ignore', 'ignore', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    try {
      const r = await fetch(`http://localhost:${teamPort}/api/teams`.slice(0, 0) || `http://localhost:${teamPort}/api/auth/me`);
      clearInterval(timer); resolve(null);
    } catch { /* not up */ }
    if (Date.now() - t0 > 8000) { clearInterval(timer); reject(new Error('team server timeout')); }
  }, 400);
});

// 3) vite dev
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

// 4) Electron E2E
const child = spawn(electronBin(), ['.'], {
  cwd: root, shell: true, stdio: 'ignore',
  env: {
    ...process.env,
    PR_TEAM_UI_E2E: '1', PR_E2E_LOG: logFile, PR_E2E_DONE: doneFile, PR_E2E_USER_DATA: tmpDir,
    VITE_DEV_SERVER_URL: 'http://localhost:5199',
    PR_TEAM_SERVER_URL: `http://localhost:${teamPort}`,
  },
});

const t0 = Date.now();
let timedOut = false;
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 120000) { clearInterval(timer); timedOut = true; child.kill(); reject(new Error('timeout')); }
  }, 1000);
});

vite.kill(); child.kill(); server.kill();
try { console.log(fs.readFileSync(logFile, 'utf8')); } catch { /* */ }
if (timedOut || fs.readFileSync(doneFile, 'utf8') !== 'done') { console.error('[team-ui] FAIL'); process.exit(1); }
const log = fs.readFileSync(logFile, 'utf8');
const fails = (log.match(/FAIL/g) ?? []).length;
console.log(`[team-ui] ${fails === 0 ? 'ALL PASS' : `${fails} FAIL`}`);
process.exit(fails === 0 ? 0 : 1);
