// 一键全量回归：npm run test:all（分层串行，产出 build/test-report.json）
// 分层：离线快测 → 主进程 e2e → UI e2e → guard；soak 与真实网络测试归入 test:all:full
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const FULL = process.argv.includes('--full');

// launchd/Aqua 会话检测：夜间定时任务无交互 GUI session 时，真窗口截图类测试
// （dedup-scroll 的三态截图稳定性断言 / visual-guard 的 capturePage）会因窗口服务
// 不可用而误报 FAIL（2026-11-01 实证）。跳过并在报告中标注，交互终端跑不受影响。
const guiAvailable = (() => {
  // launchd 启动的进程没有 TERM_PROGRAM；交互终端必有。XPC 服务判断兜底。
  const inLaunchd = !process.env.TERM_PROGRAM && process.env.XPC_SERVICE_NAME?.includes('com.apple.launchd');
  return !inLaunchd;
})();

// 每层：名字、命令、超时（ms）、是否需要网络
// 2026-11-09 差缺补漏：纳入游离测试层（团队功能 MVP server-api/team-ui、格式对齐、digest/highlight/
// reader-profile/pdf-align/fig-listing 离线单元、split-ui GUI）——18 层 → 27 层；--full 增真实网络层
const LAYERS = [
  { name: 'fixtures（arXiv 解析回归）', cmd: ['node', 'tests/fixtures.test.mjs'], timeout: 60000, offline: true },
  { name: 'translate-qc（翻译 QC 离线）', cmd: ['node', 'tests/translate-qc.test.mjs'], timeout: 60000, offline: true },
  { name: 'topic-graph（分层引擎单元）', cmd: ['node', 'tests/topic-graph.test.mjs'], timeout: 60000, offline: true },
  { name: 'highlight（划线高亮单元）', cmd: ['node', 'tests/highlight.test.mjs'], timeout: 60000, offline: true },
  { name: 'pdf-align（PDF 行对齐单元）', cmd: ['node', 'tests/pdf-align.test.mjs'], timeout: 60000, offline: true },
  { name: 'digest（精炼笔记单元）', cmd: ['node', 'tests/digest.test.mjs'], timeout: 60000, offline: true },
  { name: 'reader-profile（读者画像单元）', cmd: ['node', 'tests/reader-profile.test.mjs'], timeout: 60000, offline: true },
  { name: 'fig-listing（图表提取单元）', cmd: ['node', 'tests/fig-listing.test.mjs'], timeout: 60000, offline: true },
  { name: 'vault-unit（存储层序列化/队列）', cmd: ['node', 'tests/vault-unit.test.mjs'], timeout: 60000, offline: true },
  { name: 'vault-format-align（桌面↔Web 格式对齐）', cmd: ['node', 'tests/vault-format-align.test.mjs'], timeout: 120000, offline: true },
  { name: 'server-api（团队服务端 API）', cmd: ['node', 'tests/server-api.test.mjs'], timeout: 120000, offline: true },
  { name: 'e2e（黄金路径主进程）', cmd: ['node', 'tests/e2e.test.mjs'], timeout: 120000, offline: true },
  { name: 'vault-e2e（写穿/迁移/重建）', cmd: ['node', 'tests/vault-e2e.test.mjs'], timeout: 120000, offline: true },
  { name: 'vault-bootstrap（启动引导）', cmd: ['node', 'tests/vault-bootstrap.test.mjs'], timeout: 120000, offline: true },
  { name: 'vault-sync-unit（git agent 双 repo）', cmd: ['node', 'tests/vault-sync.test.mjs'], timeout: 120000, offline: true },
  { name: 'vault-sync-e2e（双设备同步）', cmd: ['node', 'tests/vault-sync-e2e.test.mjs'], timeout: 120000, offline: true },
  { name: 'features-e2e（问答/复习/Provider/导出/笔记）', cmd: ['node', 'tests/features-e2e.test.mjs'], timeout: 120000, offline: true },
  { name: 'interact-ui（命令面板/复习/问答/设置 UI）', cmd: ['node', 'tests/interact-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'dedup-scroll（滚动同步 UI）', cmd: ['node', 'tests/dedup-scroll.test.mjs'], timeout: 240000, offline: true, needsGui: true },
  { name: 'bilingual-ui（双语书 UI）', cmd: ['node', 'tests/bilingual-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'split-ui（原版对照 UI）', cmd: ['node', 'tests/split-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'pdf-ui（PDF 原位翻译 UI）', cmd: ['node', 'tests/pdf-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'topic-ui（主题库 UI）', cmd: ['node', 'tests/topic-ui-e2e.test.mjs'], timeout: 330000, offline: false },
  { name: 'team-ui（团队功能 UI）', cmd: ['node', 'tests/team-ui-e2e.test.mjs'], timeout: 300000, offline: true, needsGui: true },
  { name: 'profile-ui（用户画像 UI）', cmd: ['node', 'tests/profile-ui-e2e.test.mjs'], timeout: 240000, offline: true },
  { name: 'uex（用户旅程全流程）', cmd: ['node', 'tests/uex-e2e.test.mjs', '--timeout', '240000'], timeout: 300000, offline: true },
  { name: 'guard（视觉门禁）', cmd: ['node', 'tests/visual-guard.test.mjs'], timeout: 240000, offline: true, needsGui: true },
  ...(FULL ? [
    { name: 'soak（30 轮稳定性）', cmd: ['node', 'tests/soak.test.mjs'], timeout: 420000, offline: true },
    { name: 'pdf-e2e（PDF 真实下载链路）', cmd: ['node', 'tests/pdf-e2e.test.mjs'], timeout: 300000, offline: false },
    { name: 'topic-e2e（主题构建真实网络）', cmd: ['node', 'tests/topic-e2e.mjs'], timeout: 300000, offline: false },
    { name: 'translate-quality（翻译质量真实 LLM）', cmd: ['node', 'tests/translate-quality.test.mjs', '--isolated'], timeout: 300000, offline: false },
    { name: 'fig-verify（真实库图表验证）', cmd: ['node', 'tests/fig-verify.test.mjs'], timeout: 240000, offline: true, needsGui: true },
  ] : []),
];

fs.mkdirSync('build', { recursive: true });
const report = { startedAt: new Date().toISOString(), full: FULL, layers: [], allPass: true };

let idx = 0;
for (const layer of LAYERS) {
  idx += 1;
  const t0 = Date.now();
  // launchd 无 GUI：跳过真窗口截图敏感层（标注 skipped，不算失败——improve-loop 只看 pass=false）
  if (!guiAvailable && layer.needsGui) {
    console.log(`\n========== [${idx}/${LAYERS.length}] ${layer.name} ==========`);
    console.log(`[SKIP] ${layer.name}（launchd 无 GUI session，真窗口截图断言会误报；交互终端跑不受影响）`);
    report.layers.push({ name: layer.name, cmd: layer.cmd.join(' '), pass: true, skipped: true, elapsed: 0, exitCode: 0, error: null, tail: '[skipped] launchd no-GUI session' });
    continue;
  }
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
