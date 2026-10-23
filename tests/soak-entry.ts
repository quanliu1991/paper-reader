// soak 脚本：在主进程反复 导入(含解析)→读→删，监控 RSS
import { app } from 'electron';
import fs from 'fs';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_SOAK_LOG) fs.appendFileSync(process.env.PR_SOAK_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_SOAK_DONE) fs.writeFileSync(process.env.PR_SOAK_DONE, '1'); };

const ROUNDS = 30;
const OPEN_PER_ROUND = 10;

async function run() {
  if (process.env.PR_SOAK_USER_DATA) app.setPath('userData', process.env.PR_SOAK_USER_DATA);

  const mkText = (i: number) => Array.from({ length: 40 }, (_, k) =>
    `Section ${k}.`.padEnd(4, ' ') + 'KV cache management for LLM serving '.repeat(8) + `round ${i}`
  ).join('\n\n');

  const rss = () => Number(process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  const t0 = Date.now();
  const rss0 = process.memoryUsage().rss;

  for (let i = 0; i < ROUNDS; i++) {
    const parsed = parsePlainText(mkText(i), `8888.${String(i).padStart(5, '0')}`, `Soak Paper ${i}`);
    const paperId = db.insertPaper({
      arxivId: parsed.arxivId, title: parsed.title, authors: 'soak',
      sourceUrl: '', importType: 'text',
    });
    db.insertBlocks(paperId, parsed.blocks);
    // 反复读（模拟开关论文）
    for (let j = 0; j < OPEN_PER_ROUND; j++) {
      const blocks = db.getBlocks(paperId) as any[];
      // 模拟渲染负载：字符串拼接
      let acc = 0;
      for (const b of blocks) acc += b.en.length;
      if (acc === 0) throw new Error('empty read');
    }
    // 高亮+翻译写读
    const blocks = db.getBlocks(paperId) as any[];
    db.saveTranslation(paperId, blocks[1].pid, '测试译文', 'soak', 'soak');
    db.addHighlight({ paperId, pid: blocks[1].pid, textEn: 'KV cache' });
    db.listPapers();
    // 每轮留 1 篇，其余删除（防库膨胀）
    if (i > 0) db.deletePaper(paperId);
    if (i % 10 === 0) log(`round ${i}: rss=${rss()}MB`);
  }

  const elapsed = Date.now() - t0;
  const growth = (process.memoryUsage().rss - rss0) / rss0 * 100;
  log(`rounds=${ROUNDS} opens=${ROUNDS * OPEN_PER_ROUND} elapsed=${elapsed}ms`);
  log(`rss: start=${(rss0 / 1048576).toFixed(1)}MB end=${rss()}MB growth=${growth.toFixed(1)}%`);
  const pass = growth < 30;
  log(pass ? 'SOAK PASS' : 'SOAK FAIL (内存增长超标)');
  finish();
  app.quit();
}

run().catch(e => { log(`FATAL: ${e?.stack ?? e}`); finish(); app.quit(); });
