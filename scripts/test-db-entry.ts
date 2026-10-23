import { app } from 'electron';
import fs from 'fs';
import * as db from '../electron/db';
import { parsePlainText, normalizeArxivId } from '../electron/arxiv';

const log = (s: string) => {
  fs.appendFileSync(process.env.PR_LOG!, s + '\n');
};

export default async function run() {
  // 测试脚本模式：userData 指到临时目录，不建窗口不等 ready
  if (process.env.PR_TEST_DIR) app.setPath('userData', process.env.PR_TEST_DIR);

  // 1. 纯文本解析（模拟 .fulltext 导入）
  const sampleText = `AgentPerfBench: A Benchmarking and Evaluation Suite

Abstract. We present AgentPerfBench, a benchmark for agentic LLM inference.

1 Introduction
Agentic inference has driven a dramatic increase in the volume of LLM inference workloads. Serving engines must adapt.

2 Background
KV cache management is central to serving efficiency. The prefill phase differs from decode.

References
[1] Some reference.`;
  const parsed = parsePlainText(sampleText, '2609.34683', 'AgentPerfBench');
  log(`plaintext blocks: ${parsed.blocks.length}`);

  // 2. 入库 + 幂等
  const paperId = db.insertPaper({
    arxivId: '2609.34683', title: parsed.title, authors: '',
    sourceUrl: 'https://arxiv.org/abs/2609.34683', importType: 'text',
  });
  db.insertBlocks(paperId, parsed.blocks);
  const again = db.insertPaper({
    arxivId: '2609.34683', title: parsed.title, authors: '', sourceUrl: '', importType: 'text',
  });
  log(`idempotent insert: ${again === paperId ? 'PASS' : `FAIL (${again} vs ${paperId})`}`);

  const blocks = db.getBlocks(paperId) as any[];
  log(`blocks read back: ${blocks.length}`);

  // 3. 翻译缓存
  db.saveTranslation(paperId, blocks[1].pid, '测试译文', 'test-provider', 'test-model');
  const after = db.getBlocks(paperId) as any[];
  log(`translation cached: ${after[1].zh === '测试译文' ? 'PASS' : 'FAIL'}`);

  // 4. 高亮
  const hlId = db.addHighlight({ paperId, pid: blocks[1].pid, textEn: 'KV cache management' });
  const hls = db.listHighlights(paperId) as any[];
  log(`highlight: ${hls.length === 1 && hls[0].id === hlId ? 'PASS' : 'FAIL'}`);
  db.removeHighlight(hlId);
  log(`highlight removed: ${(db.listHighlights(paperId) as any[]).length === 0 ? 'PASS' : 'FAIL'}`);

  // 5. QA
  db.addQa({ paperId, pid: blocks[1].pid, question: '什么是 prefill？', answer: '一口气读完题目的阶段' });
  const qas = db.listQa(paperId) as any[];
  log(`qa: ${qas.length === 1 ? 'PASS' : 'FAIL'}`);

  // 6. settings
  db.setSetting('repo_path', 'D:\\paper');
  log(`settings: ${db.getSetting('repo_path') === 'D:\\paper' ? 'PASS' : 'FAIL'}`);

  // 7. 论文列表统计
  const list = db.listPapers() as any[];
  log(`list: ${list.length === 1 && list[0].block_count === parsed.blocks.length ? 'PASS' : 'FAIL'}`);

  // 8. normalize
  log(`normalize: ${normalizeArxivId('https://arxiv.org/abs/2609.34683') === '2609.34683' ? 'PASS' : 'FAIL'}`);

  log('ALL PASS');
  fs.writeFileSync(process.env.PR_DONE!, '1');
  app.quit();
}

// bundle 是 CJS default export 形态，Electron 直接 require 执行
run().catch(e => {
  log(`FATAL: ${e?.stack ?? e}`);
  fs.writeFileSync(process.env.PR_DONE!, '1');
  app.quit();
});
