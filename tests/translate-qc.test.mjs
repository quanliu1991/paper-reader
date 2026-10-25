// 翻译质量引擎测试：QC 守卫 + 上下文组装 + 提示词构建（不依赖 LLM API）
import { build } from 'esbuild';
import { createRequire } from 'module';

await build({
  entryPoints: ['electron/translate.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: 'dist-electron/translate-test.mjs',
  external: ['electron'], logLevel: 'silent',
});

const tr = await import('../dist-electron/translate-test.mjs');
let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---------- QC：公式 ----------
{
  const en = 'The loss is $L = \\alpha L_1 + \\beta L_2$ over $N$ samples.';
  const zhGood = '损失为 $L = \\alpha L_1 + \\beta L_2$，基于 $N$ 个样本。';
  const zhBad = '损失为 $L = aL_1 + bL_2$，基于 N 个样本。';
  t('qc 公式完好 → ok', tr.qcTranslation(en, zhGood).ok);
  const bad = tr.qcTranslation(en, zhBad);
  t('qc 公式被改动 → 拦截', !bad.ok && bad.issues.some(i => i.includes('公式')), JSON.stringify(bad.issues));
}

// ---------- QC：数字 ----------
{
  const en = 'We evaluate on 3 datasets with 1.5B parameters and achieve 64x throughput at 12ms latency.';
  const zhGood = '我们在 3 个数据集上评估，模型 1.5B 参数，实现 64x 吞吐提升，延迟 12ms。';
  const zhBad = '我们在 3 个数据集上评估，实现巨大吞吐提升，延迟很低。';
  t('qc 数字齐全 → ok', tr.qcTranslation(en, zhGood).ok);
  const bad = tr.qcTranslation(en, zhBad);
  t('qc 数字丢失 → 拦截', !bad.ok && bad.issues.some(i => i.includes('数字')), JSON.stringify(bad.issues));
}

// ---------- QC：长度比 ----------
{
  const en = 'Attention mechanisms have become an integral part of compelling sequence modeling and transduction models in various tasks, allowing modeling of dependencies regardless of their distance in the input or output sequence.';
  const zhTooShort = '注意力很重要。';
  const zhOk = '注意力机制已成为各类任务中序列建模与转换模型的重要组成部分，它使得模型能够对输入或输出序列中任意距离的依赖关系进行建模，而不受距离限制。';
  t('qc 译文过短 → 拦截', !tr.qcTranslation(en, zhTooShort).ok);
  t('qc 正常长度 → ok', tr.qcTranslation(en, zhOk).ok);
}

// ---------- QC：整句未译 ----------
{
  const en = 'The model consists of an encoder and a decoder stack. We train it end-to-end on parallel corpora with label smoothing of 0.1.';
  const zhLeftover = '模型由编码器和解码器堆叠组成。We train it end-to-end on parallel corpora with label smoothing of 0.1.';
  const r = tr.qcTranslation(en, zhLeftover);
  t('qc 整句未译 → 拦截', !r.ok && r.issues.some(i => i.includes('未译')), JSON.stringify(r.issues));
}

// ---------- QC：越界输出 ----------
{
  const en = 'The result is significant.';
  const zhMeta = '翻译如下：结果显著。';
  const r = tr.qcTranslation(en, zhMeta);
  t('qc 越界输出 → 拦截', !r.ok && r.issues.some(i => i.includes('越界')), JSON.stringify(r.issues));
}

// ---------- 上下文组装 ----------
{
  const blocks = [
    { pid: 1, seq: 1, type: 'heading', level: 1, en: '1 Introduction', zh: null },
    { pid: 2, seq: 2, type: 'para', level: 0, en: 'In this paper we study the imprint phenomenon in transformer models. We ask how much information about the prompt survives after continued generation, and we find a conditional no-hair theorem describing exponential decay under mild assumptions on the residual stream norm and the attention pattern.', zh: null },
    { pid: 3, seq: 3, type: 'heading', level: 2, en: '3.1 Setup', zh: null },
    { pid: 4, seq: 4, type: 'para', level: 0, en: 'We use Pythia-160m at eight checkpoints.', zh: '我们使用 Pythia-160m 的八个检查点。' },
    { pid: 5, seq: 5, type: 'para', level: 0, en: 'It produces logits via a final linear layer.', zh: null },
    { pid: 6, seq: 6, type: 'para', level: 0, en: 'NEXT BLOCK AFTER TARGET', zh: null },
  ];
  const ctx = tr.extractContext(blocks, 5);
  t('ctx 章节链', ctx.sectionLine.includes('1 Introduction') && ctx.sectionLine.includes('3.1 Setup'), ctx.sectionLine);
  t('ctx 摘要提取（长 para）', ctx.abstractHint.includes('imprint phenomenon'));
  t('ctx 前文已译', ctx.prevZh.includes('八个检查点'));
  t('ctx 后文消歧', ctx.nextEn.includes('NEXT BLOCK AFTER TARGET'));
  const pack = tr.buildContextBlock({ ...ctx, paperLine: 'Test Paper · arXiv:2609.34683' });
  t('ctx 上下文包含论文行/章节/摘要/前文', pack.includes('Test Paper') && pack.includes('当前章节') && pack.includes('摘要') && pack.includes('前文译文') && pack.includes('后文原文'));
}

// ---------- 提示词 ----------
{
  const sys = tr.buildSystemPrompt(['- KV cache: 保留英文']);
  t('prompt 含忠实性铁律', sys.includes('语义完全忠实') && sys.includes('不增译、不漏译'));
  t('prompt 含公式铁律', sys.includes('逐字符保留'));
  t('prompt 含术语规范', sys.includes('KV cache') && sys.includes('缩放定律'));
  t('prompt 含术语表', sys.includes('本篇术语表') && sys.includes('KV cache: 保留英文'));
  const sysEmpty = tr.buildSystemPrompt([]);
  t('prompt 空术语表无残留', !sysEmpty.includes('本篇术语表'));
}

// ---------- 术语一致性提取 ----------
{
  const blocks = [
    { pid: 1, seq: 1, type: 'para', level: 0, en: 'We optimize the KV cache management with PagedAttention.', zh: '我们用 PagedAttention 优化了 KV cache 管理。' },
    { pid: 2, seq: 2, type: 'para', level: 0, en: 'The speculative decoding reduces latency.', zh: '投机解码 speculative decoding 降低了延迟。' },
  ];
  const terms = tr.extractSettledTerms(blocks);
  t('术语提取：保留英文的进入表', terms.some(l => l.includes('KV cache')) && terms.some(l => l.includes('PagedAttention')));
  t('术语提取：译成中文的不进表', !terms.some(l => l.includes('投机解码')), JSON.stringify(terms));
}

console.log(`\n[translate-qc] ${fail === 0 ? 'ALL PASS' : 'FAIL'} (${pass} pass / ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
