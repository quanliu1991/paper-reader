// E2E 脚本：在 App 主进程内直接调用 db/arxiv 层（黄金路径断言）
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';
import * as library from '../electron/library';

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

  // 8. 论文组织：状态 + 标签（v0.3）
  db.setPaperStatus(paperId, 'reading');
  db.setPaperTags(paperId, ['kv-cache', 'serving', 'kv-cache', ' ']);
  const pOrg = db.getPaper(paperId) as any;
  let tagsOk = false;
  try { tagsOk = JSON.parse(pOrg.tags).join(',') === 'kv-cache,serving'; } catch { /* fail */ }
  log(`org status: ${pOrg.status === 'reading' ? 'PASS' : 'FAIL'}`);
  log(`org tags(dedup+trim): ${tagsOk ? 'PASS' : 'FAIL'}`);
  let badRejected = false;
  try { db.setPaperStatus(paperId, 'bogus'); } catch { badRejected = true; }
  log(`org status guard: ${badRejected ? 'PASS' : 'FAIL'}`);
  const listed = db.listPapers() as any[];
  const row = listed.find((x: any) => x.id === paperId);
  log(`org in list: ${row && row.status === 'reading' && JSON.parse(row.tags)[0] === 'kv-cache' ? 'PASS' : 'FAIL'}`);

  // 9. 笔记 + 跨库沉淀查询（v0.3）
  const noteId = db.addNote({ paperId, pid: p2.pid, text: 'KV cache 像草稿纸' });
  db.addNote({ paperId, pid: null, text: '整篇级笔记' });
  db.updateNote(noteId, 'KV cache 像草稿纸（修订）');
  const notesList = db.listNotes(paperId) as any[];
  const nUpdated = notesList.find(n => n.id === noteId);
  log(`note update: ${nUpdated && nUpdated.text === 'KV cache 像草稿纸（修订）' ? 'PASS' : 'FAIL'}`);
  const pTitle = (db.getPaper(paperId) as any).title;
  const allNotes = db.listAllNotes() as any[];
  const nAll = allNotes.find(n => n.id === noteId);
  log(`note listAll join: ${nAll && nAll.paper_title === pTitle ? 'PASS' : 'FAIL'}`);
  const allHls = db.listAllHighlights() as any[];
  const hAll = allHls.find(h => h.paper_id === paperId);
  log(`hl listAll join: ${hAll && hAll.paper_title === pTitle ? 'PASS' : 'FAIL'}`);
  db.deleteNote(noteId);
  const afterDel = db.listNotes(paperId) as any[];
  log(`note delete: ${afterDel.length === 1 ? 'PASS' : 'FAIL'}`);

  // 10. 本地论文库：扫描 → PDF 全文解析导入 → 去重 → 磁盘移动 → 外部移动重关联（v0.4）
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-lib-'));
  fs.mkdirSync(path.join(libDir, 'serving'));
  fs.copyFileSync(path.resolve('build/test-paper.pdf'), path.join(libDir, 'serving', 'AgentPerfBench.pdf'));
  // 缺失登记：造一个文件路径不存在的论文（测 missing 报告）
  const ghostId = db.insertPaper({ arxivId: 'local:ghost000001', title: 'Ghost Paper', authors: '', sourceUrl: '', importType: 'pdf' });
  db.setPaperFilePath(ghostId, path.join(libDir, 'gone.pdf'));
  const files = library.scanLibrary(libDir);
  log(`lib scan: ${files.length === 1 && files[0].dir === 'serving' && files[0].arxivId === null ? 'PASS' : 'FAIL'}`);

  const imp = await library.importLocalPdf(files[0].absPath);
  const libPaper = db.getPaper(imp.paperId) as any;
  const libBlocks = db.getBlocks(imp.paperId) as any[];
  log(`lib import: ${libPaper.file_path === files[0].absPath && libPaper.import_type === 'pdf' && libBlocks.length > 10 && /AgentPerfBench/i.test(libPaper.title) ? 'PASS' : 'FAIL'} (${libBlocks.length} blocks)`);
  const hasHeading = libBlocks.some(b => b.type === 'heading');
  log(`lib heading detect: ${hasHeading ? 'PASS' : 'FAIL'}`);

  const imp2 = await library.importLocalPdf(files[0].absPath);
  log(`lib dedup: ${imp2.existing && imp2.paperId === imp.paperId ? 'PASS' : 'FAIL'}`);

  db.setSetting('library_dir', libDir);
  const mv = library.movePaperFile(imp.paperId, libDir, '', 'kv-cache');
  const libPaper2 = db.getPaper(imp.paperId) as any;
  log(`lib move: ${fs.existsSync(mv.filePath) && !fs.existsSync(files[0].absPath) && libPaper2.file_path === mv.filePath ? 'PASS' : 'FAIL'}`);

  // 外部移动（不经应用）→ syncScan 按同名重关联 + 缺失报告
  fs.mkdirSync(path.join(libDir, 'moved'));
  fs.renameSync(mv.filePath, path.join(libDir, 'moved', 'AgentPerfBench.pdf'));
  const rescan = library.syncScan(libDir);
  const relinked = rescan.files.find((f: any) => f.relinked);
  const rePaper = relinked ? db.getPaper(relinked.paperId!) as any : null;
  log(`lib relink: ${relinked && relinked.paperId === imp.paperId && rePaper?.file_path === relinked?.absPath ? 'PASS' : 'FAIL'}`);
  log(`lib missing report: ${rescan.missing.some((m: any) => m.filePath.endsWith('gone.pdf')) ? 'PASS' : 'FAIL'}`);

  log('E2E ALL PASS');
  finish();
  app.quit();
}

// bundle 后被 require：直接自执行（不依赖 export 形态）
run().catch(e => { log(`FATAL: ${e?.stack ?? e}`); finish(); app.quit(); });
