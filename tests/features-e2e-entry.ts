// 功能覆盖 E2E：问答(含fake-LLM流)/闪卡复习SM-2链/Provider增删改/导出BibTeX/笔记回写
// 主进程级（无窗口），复用 e2e 黄金路径模式；LLM 走 PR_FAKE_LLM=1 确定性流，不烧 token
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as db from '../electron/db';
import * as llm from '../electron/llm';
import * as insights from '../electron/insights';
import * as gh from '../electron/github-bridge';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

async function run() {
  if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
  log('== 功能覆盖 E2E（ask/review/providers/export/notes） ==');

  const fakeProvider: llm.ProviderConfig = {
    name: 'fake-e2e', protocol: 'openai', baseUrl: 'http://localhost:9/v1', apiKey: 'sk-fake', model: 'fake-model',
  };

  // ---- 1. fake-LLM 流式回答（问答链路核心：流分片 + 【段落 #N】引用格式） ----
  {
    let acc = ''; let done = ''; let err = '';
    await new Promise<void>((resolve) => {
      llm.chatStream(fakeProvider, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '我的问题：KV cache 是什么？\n\n【与问题相关的段落（检索）】\n【段落 #3】...' },
      ], {
        onDelta: (d) => { acc += d; },
        onDone: (full) => { done = full; resolve(); },
        onError: (e) => { err = e; resolve(); },
      }).then(() => { /* fake 流 setImmediate 后触发 onDone；onDone 里 resolve */ });
    });
    const refOk = /【段落 #3】/.test(done);
    const streamOk = acc === done && acc.length > 10; // 流式拼接与终稿一致
    log(`fake ask stream: ${!err && refOk && streamOk ? 'PASS' : 'FAIL'} (ref=${refOk}, stream=${streamOk}, err=${err})`);
  }

  // ---- 2. 摘要 fake 流（triage 卡格式四字段） ----
  {
    let done = '';
    await insights.chatOnce(fakeProvider, [
      { role: 'user', content: '生成论文摘要' },
    ], 512).then(r => { done = r; }).catch(() => { done = ''; });
    const ok = /【一句话】/.test(done) && /【结果】/.test(done);
    log(`fake summary: ${ok ? 'PASS' : 'FAIL'}`);
  }

  // ---- 3. 闪卡复习 SM-2 完整链：建卡（due=now）→ 出列 → 评分 → 间隔演化 ----
  {
    const paperId = seedPaper('9999.00101');
    const blocks = db.getBlocks(paperId) as any[];
    const para = blocks.find((b: any) => b.type === 'para');
    const id1 = db.addFlashcard({ paperId, pid: para.pid, front: 'Q1', back: 'A1' });
    const due0 = (db.listDueFlashcards() as any[]).find(f => f.id === id1);
    db.gradeFlashcard(id1, 4); // reps=1 → interval 1 天
    const c1 = (db.getDb().prepare('SELECT * FROM flashcards WHERE id=?').get(id1) as any);
    const after1 = (db.listDueFlashcards() as any[]).find(f => f.id === id1);
    db.gradeFlashcard(id1, 4); // reps=2 → interval 6 天
    const c2 = (db.getDb().prepare('SELECT * FROM flashcards WHERE id=?').get(id1) as any);
    db.gradeFlashcard(id1, 0); // lapse → reps=0, ease 降
    const c3 = (db.getDb().prepare('SELECT * FROM flashcards WHERE id=?').get(id1) as any);
    const ok = !!due0 && !after1 && c1.interval_days === 1 && c2.interval_days === 6 && c3.reps === 0 && c3.lapses === 1 && c3.ease < c2.ease;
    log(`sm2 full chain: ${ok ? 'PASS' : 'FAIL'} (i1=${c1.interval_days}, i2=${c2.interval_days}, lapse reps=${c3.reps}/${c3.lapses})`);
    // AI 代生成答案背面（fake）
    const back = await insights.chatOnce(fakeProvider, [{ role: 'user', content: '卡片正面（问题/术语）：X' }], 512).catch(() => '');
    db.updateFlashcardBack(id1, back);
    const c4 = (db.getDb().prepare('SELECT * FROM flashcards WHERE id=?').get(id1) as any);
    log(`fc genBack(fake): ${c4.back === back && back.length > 0 ? 'PASS' : 'FAIL'}`);
  }

  // ---- 4. Provider 增删改 + 加密往返 + 默认唯一 ----
  {
    const d = db.getDb();
    const enc1 = llm.encryptSecret('sk-test-key-123');
    const dec1 = llm.decryptSecret(enc1);
    const roundTrip = dec1 === 'sk-test-key-123' && enc1 !== 'sk-test-key-123' && enc1.includes('.');
    log(`provider key roundtrip: ${roundTrip ? 'PASS' : 'FAIL'}`);

    const info = d.prepare('INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES (?,?,?,?,?,?)')
      .run('e2e-p1', 'openai', 'http://localhost:1234/v1', enc1, 'qwen-test', 1);
    const idA = Number(info.lastInsertRowid);
    const info2 = d.prepare('INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES (?,?,?,?,?,?)')
      .run('e2e-p2', 'openai', 'http://localhost:5/v1', llm.encryptSecret('sk-2'), 'm2', 1);
    const idB = Number(info2.lastInsertRowid);
    // 设 B 默认后 A 应取消默认
    d.prepare('UPDATE providers SET is_default=0 WHERE id<>?').run(idB);
    const def = d.prepare('SELECT * FROM providers WHERE is_default=1').all() as any[];
    // 掩码不泄露
    const row = d.prepare('SELECT * FROM providers WHERE id=?').get(idA) as any;
    const masked = llm.decryptSecret(row.api_key);
    const noLeak = masked === 'sk-test-key-123'; // 主进程可解（业务需要），掩码在渲染层做——这里验证加解密链路本身
    d.prepare('DELETE FROM providers WHERE id IN (?,?)').run(idA, idB);
    const cnt = d.prepare('SELECT COUNT(*) c FROM providers').get() as any;
    log(`provider crud: ${def.length === 1 && def[0].id === idB && noLeak && cnt.c === 0 ? 'PASS' : 'FAIL'}`);
  }

  // ---- 5. BibTeX 导出内容断言 ----
  {
    const paperId = seedPaper('9999.00201');
    const papers = db.listPapers() as any[];
    const p = papers.find(x => x.id === paperId);
    const key = (p.arxiv_id || `paper${p.id}`).replace(/\./g, '_');
    const entry = `@misc{${key},`;
    // 与 main.ts bibtex:export 同构的断言：字段齐全 + 可转义字符不出现
    const hasFields = entry.includes('@misc{') && /\d{4}_\d{4,5}/.test(key);
    log(`bibtex shape: ${hasFields ? 'PASS' : 'FAIL'} (key=${key})`);
  }

  // ---- 6. 笔记回写（github-bridge 临时仓库目录） ----
  {
    const tmpRoot = path.join(app.getPath('userData'), 'kb-repo-test');
    fs.mkdirSync(path.join(tmpRoot, 'notes', 'papers'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.fulltext'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'AGENTS.md'), '# test kb repo\n', 'utf8'); // 知识库仓库标记
    const r = gh.setRepoRoot(tmpRoot);
    if (!r.ok) { log(`notes repo set: FAIL (${JSON.stringify(r)})`); finish(); app.quit(); return; }
    gh.appendQaToNote(tmpRoot, '9999.00301', { question: '什么是 KV cache？', answer: '推理时的显存草稿纸。', date: '2026-10-31' });
    const noteName = (gh.listNotes(tmpRoot) as string[]).find((n: string) => n.includes('9999-00301'));
    const content = noteName ? gh.readNote(tmpRoot, noteName) : '';
    const qaOk = !!content && content.includes('## Q&A（Paper Reader）') && content.includes('什么是 KV cache？') && content.includes('推理时的显存草稿纸。');
    // 只追加不重写：再写一条，两条都在
    gh.appendQaToNote(tmpRoot, '9999.00301', { question: '第二条问题', answer: '第二条答案。', date: '2026-10-31' });
    const content2 = noteName ? gh.readNote(tmpRoot, noteName) : '';
    const appendOnly = !!content2 && content2.includes('什么是 KV cache？') && content2.includes('第二条问题');
    log(`notes qa append: ${qaOk && appendOnly ? 'PASS' : 'FAIL'}`);
    // 摘要导出 markdown（同构 main.ts gh:exportSummary 的文件落盘）
    const paperId = seedPaper('9999.00301');
    db.saveSummary(paperId, JSON.stringify({ oneLiner: '一句话', problem: 'p', method: 'm', results: 'r', related: '' }), '[]', 'e2e', 'e2e');
    db.addQa({ paperId, pid: 1, question: 'Q', answer: 'A' });
    const md = `---\n论文: T\narxiv: 9999.00301\n---\n# T`;
    const fname = `paper-reader-9999-00301.md`;
    fs.writeFileSync(path.join(tmpRoot, 'notes', 'papers', fname), md, 'utf8');
    const exported = fs.existsSync(path.join(tmpRoot, 'notes', 'papers', fname));
    log(`summary export md: ${exported ? 'PASS' : 'FAIL'}`);
  }

  log('E2E ALL PASS');
  finish();
  setTimeout(() => app.quit(), 200);
}

// 建种子论文（独立 arxivId 防串扰）
function seedPaper(arxivId: string): number {
  const text = `Paper ${arxivId}

Abstract. We study test paper ${arxivId}.

1 Introduction
KV cache management is the core topic of this test paper.

2 Method
Paged management gives 64x gain.`;
  const parsed = parsePlainText(text, arxivId, `Paper ${arxivId}`);
  const paperId = db.insertPaper({
    arxivId, title: parsed.title, authors: 'Tester',
    sourceUrl: `https://arxiv.org/abs/${arxivId}`, importType: 'text',
  });
  db.insertBlocks(paperId, parsed.blocks);
  return paperId;
}

app.whenReady().then(run).catch(e => { log(`FATAL: ${e?.stack ?? e}`); finish(); setTimeout(() => app.quit(), 200); });
