#!/usr/bin/env node
/**
 * nightly.mjs — 夜间无人值守改进循环入口（launchd / 手动 均用此入口）
 *
 * 流程（对应计划步骤 7/8）：
 *  1. git pull --ff-only          保持 master 最新
 *  2. improve-loop --audit        全量审计并入台账（test:all + ux-audit + llm-judge + visual-judge）
 *  3. 逐个 improve-loop --next    取最高优先级问题（无则结束）
 *     —— 夜间模式不自动改代码，只产出工作简报供次日会话执行；
 *        简报按优先级排序写入 docs/quality/nightly/<date>.md
 *  4. improve-loop --report       更新 QUALITY.md 仪表盘
 *  5. 有变化则 commit + push master（遵守脚本提交规范）
 *
 * 用法：node scripts/nightly.mjs [--max N]
 * 日志：build/nightly/<date>.log（launchd 同步转发 stdout）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX = Number(process.argv.find((a) => a.startsWith('--max'))?.split('=')[1] ?? 3);
const date = new Date().toISOString().slice(0, 10);

const logDir = path.join(ROOT, 'build/nightly');
mkdirSync(logDir, { recursive: true });
mkdirSync(path.join(ROOT, 'docs/quality/nightly'), { recursive: true });

const log = (m) => console.log(`[nightly ${new Date().toISOString().slice(11, 19)}] ${m}`);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60_000, ...opts });

function git(args, allowFail = false) {
  try {
    return run('git', args);
  } catch (e) {
    if (allowFail) return String(e.stdout ?? e.message);
    throw e;
  }
}

log(`=== Paper Reader 夜间改进循环 ${date} ===`);

// 1. 同步 master
try {
  git(['pull', '--ff-only', 'origin', 'master']);
  log('git pull --ff-only: ok');
} catch (e) {
  log('git pull 失败（离线或有分叉），继续用本地状态');
}

// 2. 全量审计：先真实跑测试链刷新数据源（--audit 只读报告文件）
const steps = [
  ['全量回归 test:all', ['scripts/test-all.mjs'], 60],
  ['体验审计 ux:audit', ['tests/ux-audit.test.mjs'], 20],
  ['真实论文 ux:audit --real', ['tests/ux-audit.test.mjs', '--real'], 30],
  ['静态 ux-lint', ['scripts/ux-lint.mjs'], 5],
  ['llm-judge 体验评估', ['tests/llm-judge.test.mjs'], 20],
  ['visual-judge 视觉检验', ['tests/visual-judge.test.mjs'], 10],
];
for (const [name, args, toMin] of steps) {
  try {
    log(`${name} 开始…`);
    const out = run('node', args, { timeout: toMin * 60_000 });
    log(`${name}: ${out.trim().split('\n').slice(-1)[0].slice(0, 120)}`);
  } catch (e) {
    // 单层失败不阻塞：失败信号由 --audit 从报告文件采集入台账
    log(`${name} 失败（信号入台账）：${String(e.message).split('\n')[0].slice(0, 150)}`);
  }
}
log('improve-loop --audit 归并台账…');
try {
  const out = run('node', ['scripts/improve-loop.mjs', '--audit'], { timeout: 10 * 60_000 });
  log(out.trim().split('\n').slice(-2).join(' | '));
} catch (e) {
  log('audit 失败：' + String(e.message).slice(0, 200));
}

// 3. 收集最高优先级问题工作简报（不自动改码，防止夜间误修）
const briefs = [];
const seen = new Set();
for (let i = 0; i < MAX; i++) {
  try {
    const out = run('node', ['scripts/improve-loop.mjs', '--next']);
    const j = JSON.parse(out);
    if (!j.ok || seen.has(j.finding.id)) break; // 无问题 / 无新问题可取
    seen.add(j.finding.id);
    briefs.push(JSON.stringify(j, null, 2));
  } catch {
    break;
  }
}

// 4. 报告 + 台账落盘
const briefPath = path.join(ROOT, `docs/quality/nightly/${date}.md`);
writeFileSync(briefPath, [
  `# 夜间审计工作简报 ${date}`,
  '',
  ...(briefs.length > 0
    ? briefs.flatMap((b, i) => [`## 问题 ${i + 1}`, '', '```', b.trim(), '```', ''])
    : ['（本轮无未解决问题 🎉）']),
  '',
  `> 由 scripts/nightly.mjs 自动生成；次日会话按优先级执行修复后走 --verify。`,
  '',
].join('\n'));
log(`工作简报 → ${briefPath}（${briefs.length} 个问题）`);

try {
  log(run('node', ['scripts/improve-loop.mjs', '--report']).trim());
} catch (e) {
  log('report 失败：' + String(e.message).slice(0, 120));
}

// 5. 提交审计产物（仅台账/报告/简报，不含代码修复）
const status = git(['status', '--porcelain'], true);
const changed = status.split('\n').filter((l) => l.trim() && !l.includes('build/'));
if (changed.length > 0) {
  git(['add', 'docs/']);
  git(['commit', '-m', `chore: 夜间审计 ${date}（${briefs.length} 个开口问题入台账）`], true);
  const push = git(['push', 'origin', 'master'], true);
  log(push.includes('ERROR') || push.toLowerCase().includes('error') ? 'push 失败（下次补推）' : 'push: ok');
} else {
  log('无台账变化，跳过提交');
}

log(`=== 完成：open=${briefs.length} ===`);
