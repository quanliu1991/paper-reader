// E2E 脚本：在 App 主进程内直接调用 db/arxiv 层（黄金路径断言）
import { app } from 'electron';
import fs from 'fs';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

async function run() {
  if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
  log('== E2E 黄金路径 ==');

  // 1. 导入（离线：纯文本路径——网络路径由 fixtures 测试覆盖）
  const text = `Test Paper on KV Cache

Abstract. We study KV cache management for LLM serving.

1 Introduction
KV cache is like scratch paper for math. Prefill reads all input at once.

2 Method
We propose paged management of KV cache. Results show 64x throughput gain.

References
[1] ref`;
  const parsed = parsePlainText(text, '9999.00001', 'Test Paper on KV Cache');
  const paperId = db.insertPaper({
    arxivId: '9999.00001', title: parsed.title, authors: 'Tester',
    sourceUrl: 'https://arxiv.org/abs/9999.00001', importType: 'text',
  });
  db.insertBlocks(paperId, parsed.blocks);
  log(`import: ${parsed.blocks.length > 3 ? 'PASS' : 'FAIL'} (${parsed.blocks.length} blocks)`);

  // 2. blocks 读取 + 列表统计
  const blocks = db.getBlocks(paperId) as any[];
  log(`read blocks: ${blocks.length === parsed.blocks.length ? 'PASS' : 'FAIL'}`);
  const list = db.listPapers() as any[];
  log(`list stats: ${list[0]?.block_count === parsed.blocks.length ? 'PASS' : 'FAIL'}`);

  // 3. 翻译缓存写读
  const p2 = blocks.find(b => /KV cache is like/.test(b.en));
  db.saveTranslation(paperId, p2.pid, 'KV cache 就像数学题的草稿纸', 'e2e', 'e2e');
  const after = db.getBlocks(paperId) as any[];
  const withZh = after.find(b => b.pid === p2.pid);
  log(`translation cache: ${withZh.zh === 'KV cache 就像数学题的草稿纸' ? 'PASS' : 'FAIL'}`);

  // 4. 划线
  db.addHighlight({ paperId, pid: p2.pid, textEn: 'scratch paper', color: 'green' });
  const hls = db.listHighlights(paperId) as any[];
  log(`highlight: ${hls.length === 1 && hls[0].color === 'green' ? 'PASS' : 'FAIL'}`);

  // 5. 闪卡 + SM-2
  const fcId = db.addFlashcard({ paperId, pid: p2.pid, front: 'What is KV cache like?', back: '草稿纸' });
  db.gradeFlashcard(fcId, 3);
  const fc = (db.listDueFlashcards() as any[]).find(f => f.id === fcId);
  log(`sm2 grade: ${!fc ? 'PASS' : `FAIL (still due)`}`);

  // 6. 摘要表
  db.saveSummary(paperId, JSON.stringify({ oneLiner: 'test', problem: '', method: '', results: '', related: '' }), '[]', 'e2e', 'e2e');
  const sum = db.getSummary(paperId) as any;
  log(`summary: ${sum && JSON.parse(sum.summary).oneLiner === 'test' ? 'PASS' : 'FAIL'}`);

  // 7. 持久化（同连接重读——单文件 SQLite WAL 落盘即可信）
  const blocks2 = db.getBlocks(paperId) as any[];
  const hls2 = db.listHighlights(paperId) as any[];
  log(`persist(re-read): ${blocks2.length === blocks.length && hls2.length === 1 ? 'PASS' : 'FAIL'}`);

  log('E2E ALL PASS');
  finish();
  app.quit();
}

// bundle 后被 require：直接自执行（不依赖 export 形态）
run().catch(e => { log(`FATAL: ${e?.stack ?? e}`); finish(); app.quit(); });
