// 一键全量回归：npm run test:all（分层串行，产出 build/test-report.json）
// 分层：离线快测 → 主进程 e2e → UI e2e → guard；soak 与真实网络测试归入 test:all:full
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const FULL = process.argv.includes('--full');

// 每层：名字、命令、超时（ms）、是否需要网络
const LAYERS = [
  { name: 'fixtures（arXiv 解析回归）', cmd: ['node', 'tests/fixtures.test.mjs'], timeout: 60000, offline: true },
  { name: 'translate-qc（翻译 QC 离线）', cmd: ['node', 'tests/translate-qc.test.mjs'], timeout: 60000, offline: true },
  { name: 'topic-graph（分层引擎单元）', cmd: ['node', 'tests/topic-graph.test.mjs'], timeout: 60000, offline: true },
  { name: 'e2e（黄金路径主进程）', cmd: ['node', 'tests/e2e.test.mjs'], timeout: 120000, offline: true },
  { name: 'features-e2e（问答/复习/Provider/导出/笔记）', cmd: ['node', 'tests/features-e2e.test.mjs'], timeout: 120000, offline: true },
  { name: 'interact-ui（命令面板/复习/问答/设置 UI）', cmd: ['node', 'tests/interact-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'dedup-scroll（滚动同步 UI）', cmd: ['node', 'tests/dedup-scroll.test.mjs'], timeout: 240000, offline: true },
  { name: 'bilingual-ui（双语书 UI）', cmd: ['node', 'tests/bilingual-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'pdf-ui（PDF 原位翻译 UI）', cmd: ['node', 'tests/pdf-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'topic-ui（主题库 UI）', cmd: ['node', 'tests/topic-ui-e2e.test.mjs'], timeout: 300000, offline: false },
  { name: 'profile-ui（用户画像 UI）', cmd: ['node', 'tests/profile-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'guard（视觉门禁）', cmd: ['node', 'tests/visual-guard.test.mjs'], timeout: 240000, offline: true },
  ...(FULL ? [
    { name: 'soak（30 轮稳定性）', cmd: ['node', 'tests/soak.test.mjs'], timeout: 420000, offline: true },
    { name: 'pdf-e2e（PDF 真实下载链路）', cmd: ['node', 'tests/pdf-e2e.test.mjs'], timeout: 300000, offline: false },
  ] : []),
];

fs.mkdirSync('build', { recursive: true });
const report = { startedAt: new Date().toISOString(), full: FULL, layers: [], allPass: true };

let idx = 0;
for (const layer of LAYERS) {
  idx += 1;
  const t0 = Date.now();
  console.log(`\n========== [${idx}/${LAYERS.length}] ${layer.name} ==========`);
  const r = spawnSync(layer.cmd[0], layer.cmd.slice(1), {
    encoding: 'utf8', timeout: layer.timeout,
    env: { ...process.env, PR_TEST_ALL: '1' },
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = r.status === 0 && !r.error;
  const tail = out.trim().split('\n').slice(-12).join('\n');
  console.log(tail);
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${layer.name} (${elapsed}s)`);
  report.layers.push({ name: layer.name, cmd: layer.cmd.join(' '), pass, elapsed, exitCode: r.status, error: r.error ? String(r.error) : null, tail });
  if (!pass) report.allPass = false;
  // 失败不中断：跑完所有层给出完整画像（improve-loop 需要全量失败清单）
}

report.finishedAt = new Date().toISOString();
report.passCount = report.layers.filter(l => l.pass).length;
report.failCount = report.layers.filter(l => !l.pass).length;
fs.writeFileSync('build/test-report.json', JSON.stringify(report, null, 2));

console.log(`\n========== 汇总 ==========`);
console.log(`${report.passCount} PASS / ${report.failCount} FAIL → build/test-report.json`);
report.layers.filter(l => !l.pass).forEach(l => console.log(`  FAIL: ${l.name}`));
process.exit(report.allPass ? 0 : 1);
