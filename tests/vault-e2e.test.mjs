// vault e2e 启动器（克隆 e2e.test.mjs 模式）
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
  entryPoints: ['tests/vault-entry.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/vault-entry.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'],
  logLevel: 'silent',
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-vault-e2e-'));
const logFile = path.join(tmpDir, 'vault.log');
const doneFile = path.join(tmpDir, 'done');

const electronBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const env = {
  ...process.env,
  PR_VAULT_E2E: '1',
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
    else if (Date.now() - t0 > 60000) { clearInterval(timer); try { child.kill(); } catch {} reject(new Error('vault e2e timeout')); }
  }, 300);
});

const out = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
console.log(out);
const fails = (out.match(/FAIL/g) ?? []).length;
const passes = (out.match(/PASS/g) ?? []).length;
console.log(`\n[vault-e2e] ${passes} PASS / ${fails} FAIL`);
process.exit(fails ? 1 : 0);
