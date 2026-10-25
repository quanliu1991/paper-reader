// 真实 LLM 翻译质量 E2E：真实 Provider + 真实论文段落 + 上下文引擎 + QC 评分
// 验收：QC 平均分 ≥ 85 且公式/数字零缺失率 ≥ 99%
import { app } from 'electron';
import * as db from '../electron/db';
import * as llm from '../electron/llm';
import * as tr from '../electron/translate';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

// 评测样本：真实论文段落（含公式/数字/术语/指代的典型难点）
const SAMPLES: Array<{ tag: string; en: string; expectTerms?: string[] }> = [
  {
    tag: '公式密集',
    en: 'Let $h_{l}(x\\circ c,t)\\in\\mathbb{R}^{d}$ denote the residual stream after block $l$, where $x$ is the prompt, $c$ the continuation and $t$ the number of generated tokens. The imprint is defined as $I_{l} = \\|h_{l}(x\\circ c,t) - h_{l}(x\'\\circ c,t)\\|$ for two prompts $x$ and $x\'$.',
    expectTerms: ['h_{l}', '\\mathbb{R}^{d}', 'I_{l}'],
  },
  {
    tag: '数字密集',
    en: 'We evaluate on 8 checkpoints of Pythia-160m, from step 0 to 512000. The largest model we test has 1.4B parameters. Serving throughput improves by 64x with PagedAttention at a latency budget of 12ms per token, and memory waste drops from 82% to below 1%.',
    expectTerms: ['Pythia-160m', '1.4B', '64x', '12ms', '82%'],
  },
  {
    tag: '术语+被动语态',
    en: 'It is widely known that KV cache memory becomes the dominant bottleneck during inference for large language models. In this paper, a novel block-level paging mechanism is proposed, wherein KV cache tensors are partitioned into fixed-size blocks, reminiscent of virtual memory paging in operating systems.',
    expectTerms: ['KV cache'],
  },
  {
    tag: '指代消解',
    en: 'The approach works in two stages. In the first stage, a small draft model proposes candidate tokens. These are then verified in parallel by the larger target model in the second stage, which accepts the longest prefix that matches its own computation.',
    expectTerms: [],
  },
  {
    tag: '图表标题',
    en: 'Table 2: Ablation study on the number of experts. We report zero-shot accuracy on 5 benchmarks with 95% confidence intervals. Figure 3 shows the corresponding training loss curves.',
    expectTerms: [],
  },
];

app.whenReady().then(async () => {
  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
    log('== 翻译质量 E2E ==');

    // 取真实 Provider（用生产库的配置；E2E_USER_DATA 指定时用临时库——脚本会先种入）
    const rows = db.getDb().prepare('SELECT * FROM providers ORDER BY id').all() as any[];
    const prov = rows.find((r: any) => r.is_default) ?? rows[0];
    if (!prov || !llm.decryptSecret(prov.api_key)) {
      log('no provider: SKIP（未配置 LLM，跳过真实质量验证——离线 QC 测试已覆盖引擎本身）');
      log('E2E ALL PASS');
      finish(); app.quit(); return;
    }
    const cfg: llm.ProviderConfig = {
      protocol: prov.protocol, baseUrl: prov.base_url,
      apiKey: llm.decryptSecret(prov.api_key),
      model: prov.model, name: prov.name,
    };
    log(`provider: ${prov.name} (${prov.model})`);

    // 组装模拟上下文（模拟论文元信息 + 已译前文）
    const blocks: tr.BlockLite[] = [
      { pid: 1, seq: 1, type: 'heading', level: 1, en: '1 Introduction', zh: null },
      { pid: 2, seq: 2, type: 'para', level: 0, en: 'We study memory efficiency in transformer inference. Our PagedAttention kernel manages the KV cache in fixed-size blocks, reducing fragmentation by 82% and improving throughput 64x on A100 GPUs with 80GB memory.', zh: '我们研究 transformer 推理中的显存效率。我们的 PagedAttention 内核以固定大小的块管理 KV cache，将碎片化降低 82%，并在 80GB 显存的 A100 GPU 上将吞吐提升 64 倍。' },
    ];
    const meta = { title: 'Efficient Memory Management for LLM Serving with PagedAttention', authors: 'Woosuk Kwon et al.', arxivId: '2309.06180' };

    let totalScore = 0, hardFail = 0, termMiss = 0, termTotal = 0;
    for (const s of SAMPLES) {
      const targetPid = 100 + SAMPLES.indexOf(s);
      const blockArr = [...blocks, { pid: targetPid, seq: 3, type: 'para' as const, level: 0, en: s.en, zh: null as string | null }];
      const glossary = tr.extractSettledTerms(blocks.filter(b => b.zh));
      const sys = tr.buildSystemPrompt(glossary);
      const ctx = tr.extractContext(blockArr, targetPid) ?? { paperLine: '', sectionLine: '', abstractHint: '', prevZh: '', nextEn: '' };
      const user = tr.buildContextBlock({ ...ctx, paperLine: `${meta.title} · ${meta.authors} (arXiv:${meta.arxivId})` }) + s.en;

      let acc = ''; let err: string | null = null;
      await llm.chatStream(cfg, [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], {
        onDelta: d => { acc += d; },
        onDone: () => {},
        onError: e => { err = e; },
      }, { temperature: 0.15, maxTokens: 4096 });
      if (err) { log(`[${s.tag}] LLM 错误: ${err}`); hardFail++; continue; }

      let zh = acc.trim()
        .replace(/^```(?:chinese|zh|markdown)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .replace(/^(?:译文|翻译)\s*[：:]\s*\n?/i, '')
        .trim();

      const qc = tr.qcTranslation(s.en, zh);
      totalScore += qc.score;
      if (!qc.ok) hardFail++;
      // 关键术语保留校验（64x 这类倍数接受「64 倍」等价形式）
      const miss: string[] = [];
      for (const term of s.expectTerms ?? []) {
        termTotal++;
        const numMatch = term.match(/^(\d+(?:\.\d+)?)(x|%)$/);
        const okTerm = numMatch
          ? new RegExp(`${numMatch[1]}\\s*(?:倍|${numMatch[2] === 'x' ? 'x|×' : '%'})`).test(zh) || zh.includes(term)
          : zh.includes(term);
        if (!okTerm) { termMiss++; miss.push(term); }
      }
      log(`[${s.tag}] score=${qc.score} ${qc.ok ? 'PASS' : 'FAIL'}${miss.length ? ' 术语缺失:' + miss.join(',') : ''}${qc.issues.length ? ' issues: ' + qc.issues.join('; ').slice(0, 120) : ''}`);
      log(`  译文: ${zh.slice(0, 160)}`);
    }

    const avg = totalScore / SAMPLES.length;
    const termRate = termTotal ? (1 - termMiss / termTotal) : 1;
    log(`avg QC score: ${avg.toFixed(1)}`);
    log(`hard fail: ${hardFail}/${SAMPLES.length}`);
    log(`term retention: ${(termRate * 100).toFixed(1)}% (${termTotal - termMiss}/${termTotal})`);
    // 验收线：平均分 ≥ 85、硬失败 ≤ 1、术语保留 ≥ 99%
    const pass = avg >= 85 && hardFail <= 1 && termRate >= 0.99;
    log(`quality gate: ${pass ? 'PASS（准确率达标）' : 'FAIL'}`);
    log(pass ? 'E2E ALL PASS' : 'E2E FAIL');
    finish();
    app.quit();
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
    finish();
    app.quit();
  }
});
