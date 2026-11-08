// vault bootstrap e2e 启动器（两阶段：种数据→删库→relaunch→验证重建）
import { build } from 'esbuild';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

await build({
  entryPoints: ['electron/main.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/main.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  logLevel: 'silent',
});
await build({
  entryPoints: ['tests/vault-bootstrap-entry.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/vault-bootstrap-entry.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-vboot-'));
const logFile = path.join(tmpDir, 'boot.log');
const doneFile = path.join(tmpDir, 'done');

const electronBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const env = {
  ...process.env,
  PR_VAULT_BOOT_E2E: '1',
  PR_E2E_LOG: logFile,
  PR_E2E_DONE: doneFile,
  PR_E2E_USER_DATA: tmpDir,
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ['.'], { env, shell: true, stdio: 'ignore' });

const t0 = Date.now();
await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); resolve(null); }
    else if (Date.now() - t0 > 90000) { clearInterval(timer); try { child.kill(); } catch {} reject(new Error('bootstrap e2e timeout')); }
  }, 300);
});

const out = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
console.log(out);
const fails = (out.match(/FAIL/g) ?? []).length;
const passes = (out.match(/PASS/g) ?? []).length;
console.log(`\n[vault-bootstrap] ${passes} PASS / ${fails} FAIL`);
process.exit(fails ? 1 : 0);
