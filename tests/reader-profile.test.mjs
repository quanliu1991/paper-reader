// 读者画像策略推导 + 建议问题生成：离线单元测试
// 由测试自行 esbuild 打包（见文件尾注）；先动态导入
const { deriveReaderStrategy, suggestQuestions } = await (async () => {
  const { build } = await import('esbuild');
  await build({
    entryPoints: ['electron/insights.ts'],
    bundle: true, platform: 'node', target: 'node20', format: 'cjs',
    outfile: 'tests/.tmp-ins/insights.cjs',
    external: ['electron', 'better-sqlite3'], logLevel: 'silent',
  });
  return await import('./.tmp-ins/insights.cjs');
})();

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

console.log('\n[1] 冷启动（无任何信号）');
const cold = deriveReaderStrategy({ bg: '', signals: {} });
assert(cold.depthRule.includes('研究生'), '默认研究生深度');
assert(cold.suggestKind === 'concept', '冷启动建议概念类');
assert(cold.rationale.includes('还没有'), '冷启动理由说明无记录');

console.log('\n[2] 太浅反馈驱动调深');
const shallow = deriveReaderStrategy({ bg: '', signals: { tooShallow: 3, tooDeep: 0 } });
assert(shallow.depthRule.includes('更深'), '太浅×3 → 调深');
assert(shallow.rationale.includes('调深'), '理由带调深标注');

console.log('\n[3] 太深反馈驱动调浅');
const deep = deriveReaderStrategy({ bg: '', signals: { tooDeep: 4, tooShallow: 1 } });
assert(deep.depthRule.includes('更浅') || deep.depthRule.includes('打比方'), '太深×4 → 调浅');

console.log('\n[4] 正反馈保持');
const right = deriveReaderStrategy({ bg: '', signals: { justRight: 6, tooShallow: 0, tooDeep: 0 } });
assert(right.depthRule.includes('保持'), '刚好×6 → 保持');

console.log('\n[5] 背景文本驱动词汇策略');
const newbie = deriveReaderStrategy({ bg: '刚入行的新手，不熟悉 serving', signals: {} });
assert(newbie.vocabRule.includes('类比'), '自述新手 → 术语配类比');
const expert = deriveReaderStrategy({ bg: '多年推理系统专家，精通 CUDA', signals: {} });
assert(expert.vocabRule.includes('黑话') || expert.vocabRule.includes('专家'), '自述专家 → 直接黑话');

console.log('\n[6] 提问类型驱动建议方向');
const methodHeavy = deriveReaderStrategy({ bg: '', signals: { concept: 1, method: 8, result: 2 } });
assert(methodHeavy.suggestKind === 'method', '方法类提问多 → 建议方法类');
assert(methodHeavy.rationale.includes('方法'), '理由写明方法偏好');
const resultHeavy = deriveReaderStrategy({ bg: '', signals: { concept: 0, method: 1, result: 9 } });
assert(resultHeavy.suggestKind === 'result', '结果类提问多 → 建议结果类');

console.log('\n[7] 概念类提问多 → 术语解释');
const conceptHeavy = deriveReaderStrategy({ bg: '', signals: { concept: 9, method: 1, result: 0 } });
assert(conceptHeavy.vocabRule.includes('不熟') || conceptHeavy.vocabRule.includes('解释'), '概念问得多 → 默认读者不熟术语');

console.log('\n[8] 建议问题生成');
const heads = ['Introduction', 'Method: Speculative Decoding', 'Experiments', 'Related Work'];
for (const kind of ['concept', 'method', 'result']) {
  const st = { depthRule: '', vocabRule: '', suggestKind: kind, rationale: '' };
  const qs = suggestQuestions(st, heads);
  assert(qs.length === 3, `${kind} 类生成 3 条建议`);
  assert(qs.every(q => q.label && q.prompt), `${kind} 类建议 label/prompt 完整`);
}
const empty = suggestQuestions({ depthRule: '', vocabRule: '', suggestKind: 'concept', rationale: '' }, []);
assert(empty.length === 3, '无标题也能出通用建议');

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
