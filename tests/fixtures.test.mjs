// 解析 fixtures 回归测试：多形态论文快照 → 断言结构指标（防解析器退化）
// 用 esbuild 打包 electron/arxiv.ts 后在 Node 跑（解析器无 electron 依赖）
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

await build({
  entryPoints: ['electron/arxiv.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'tests/.arxiv-bundle.mjs',
  external: ['electron'],
  logLevel: 'silent',
});

const { parseArxivHtml } = await import('./.arxiv-bundle.mjs');

const EXPECT = {
  // 2609.34683：AgentPerfBench（v0.2 实测基线；arXiv 重渲染会造成 ±20% 波动，区间放宽）
  '2609.34683.html': {
    minBlocks: 90,
    mathParas: [15, 45],     // 带公式段落区间
    noise: 0,                 // 0 噪音段
    hasAbstract: true,
  },
  // 2610.24133：另一篇（结构性断言，指标宽）
  '2610.24133.html': {
    minBlocks: 30,
    noise: 0,
    hasAbstract: true,
  },
};

let failed = 0;
for (const [file, exp] of Object.entries(EXPECT)) {
  const fp = path.join('tests/fixtures', file);
  if (!fs.existsSync(fp)) { console.log(`SKIP ${file} (fixture 缺失)`); continue; }
  const html = fs.readFileSync(fp, 'utf8');
  const id = file.replace('.html', '');
  const parsed = parseArxivHtml(html, id);
  const paras = parsed.blocks.filter(b => b.type === 'para');
  const heads = parsed.blocks.filter(b => b.type === 'heading');
  const figs = parsed.blocks.filter(b => b.type === 'fig');
  const mathParas = paras.filter(b => /\$[^$]+\$/.test(b.en)).length;
  const noise = parsed.blocks.filter(b => /report issue|back to abstract|download pdf|have a free development/i.test(b.en)).length;
  const hasAbstract = heads.some(h => /abstract/i.test(h.en));

  const checks = [
    ['blocks ≥ min', parsed.blocks.length >= exp.minBlocks, `${parsed.blocks.length} vs ${exp.minBlocks}`],
    ...(exp.mathParas ? [['mathParas in range', mathParas >= exp.mathParas[0] && mathParas <= exp.mathParas[1], `${mathParas} in [${exp.mathParas}]`]] : []),
    ['noise = 0', noise === exp.noise, `${noise}`],
    ['hasAbstract', hasAbstract === exp.hasAbstract, `${hasAbstract}`],
    ['title non-trivial', parsed.title.length > 10 && !/untitled/i.test(parsed.title), parsed.title.slice(0, 50)],
  ];
  console.log(`\n== ${file}: ${heads.length} heads / ${paras.length} paras / ${figs.length} figs / ${mathParas} math`);
  for (const [name, ok, info] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} (${info})`);
    if (!ok) failed++;
  }
}

console.log(failed === 0 ? '\n[fixtures] ALL PASS' : `\n[fixtures] ${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
