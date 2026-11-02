// 用户旅程 E2E 启动器：vite dev + electron + fake-LLM（不烧 token）
// 用法：node tests/uex-e2e.test.mjs [--timeout 180000] [--no-fake-llm]
import { build } from 'esbuild';
import { electronBin, startVite, runElectronE2E, killTree } from './lib/launch.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const timeoutIdx = args.indexOf('--timeout');
const timeoutMs = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 180000;
const noFakeLlm = args.includes('--no-fake-llm');

await build({
  entryPoints: ['tests/uex-e2e.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'dist-electron/uex-e2e.js',
  external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'silent',
});

const vite = await startVite(root, 5199, 'uex-e2e');
try {
  const env = { PR_UEX_E2E: '1' };
  if (!noFakeLlm) env.PR_FAKE_LLM = '1';
  const { log, timedOut } = await runElectronE2E(root, env, { timeoutMs, viteUrl: 'http://localhost:5199' });
  console.log(log);
  const ok = !timedOut && log.includes('E2E ALL PASS');
  console.log(`[uex-e2e] ${ok ? 'ALL PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  killTree(vite);
}
