// vault 存储层单元测试：vault-sink 队列 + vault.ts 序列化 round-trip
// 模式：esbuild 离线自编译（同 topic-graph.test.mjs）
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import os from 'os';

await build({
  entryPoints: ['electron/vault-sink.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-vault/vault-sink.js', logLevel: 'silent',
});
await build({
  entryPoints: ['electron/vault.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  external: ['yaml'],
  outfile: 'tests/.tmp-vault/vault.js', logLevel: 'silent',
});
await build({
  entryPoints: ['electron/vault-wiring.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'tests/.tmp-vault/vault-wiring.cjs', logLevel: 'silent',
});

const { createSink } = await import('../tests/.tmp-vault/vault-sink.js');
const V = await import('../tests/.tmp-vault/vault.js');
const { createVaultProcessor } = await import('../tests/.tmp-vault/vault-wiring.cjs');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- vault-sink ----------
{
  console.log('== vault-sink 队列 ==');
  const flushed = [];
  const sink = createSink({ flush: async (tasks) => { flushed.push(...tasks); }, delayMs: 20 });
  sink.enqueue({ kind: 'meta', paperId: 1 });
  sink.enqueue({ kind: 'meta', paperId: 1 });   // 合并
  sink.enqueue({ kind: 'annotations', paperId: 1 });
  await sink.flush();
  assert(flushed.length === 2, `coalesce 同 key 只留一个（got ${flushed.length}）`);
  assert(flushed[0].kind === 'meta' && flushed[1].kind === 'annotations', '顺序保持');
  assert(sink.stats().pending === 0, 'flush 后 pending=0');
}

{
  console.log('== vault-sink journal 崩溃恢复 ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sink-'));
  const journal = path.join(tmp, 'journal.jsonl');
  // delayMs 大到防抖不会触发：模拟「enqueue 已落 journal、drain 前崩溃」
  const sink1 = createSink({ flush: async () => {}, journalPath: journal, delayMs: 10_000 });
  sink1.enqueue({ kind: 'meta', paperId: 7 });
  assert(fs.existsSync(journal) && fs.readFileSync(journal, 'utf8').includes('"paperId":7'), 'enqueue 即写 journal（防抖窗口内崩溃也不丢）');
  const calls2 = [];
  const sink2 = createSink({ flush: async (tasks) => { calls2.push(tasks); }, journalPath: journal, delayMs: 5 });
  await sink2.flush();
  assert(calls2.length === 1 && calls2[0].length === 1 && calls2[0][0].paperId === 7, '新实例重放未完成任务');
  assert(sink2.stats().pending === 0, '重放后 journal 清空');
  assert(!fs.existsSync(journal) || fs.readFileSync(journal, 'utf8').trim() === '', '成功后 journal truncate');
}

{
  console.log('== vault-sink 错误隔离（毒丸重试一次后丢弃） ==');
  let attempts = 0;
  const sink = createSink({
    flush: async () => { attempts++; throw new Error('disk full'); },
    delayMs: 5,
  });
  sink.enqueue({ kind: 'meta', paperId: 1 });
  await sleep(80); // 触发重试 + 二次失败丢弃
  assert(attempts >= 2, `毒丸至少重试一次（attempts=${attempts}）`);
  assert(sink.stats().errors >= 1, `错误计数（errors=${sink.stats().errors}）`);
  assert(sink.stats().pending === 0, '毒丸最终被丢弃不阻塞队列');
  assert(typeof sink.stats().lastError === 'string' && sink.stats().lastError.includes('disk full'), 'lastError 记录');
}

// ---------- vault.ts 序列化 ----------
{
  console.log('== paperKey / slug / srcHash ==');
  const k1 = V.paperKeyFor({ arxiv_id: '2401.02345', created_at: '2024-01-15 10:00:00' });
  assert(k1 === '2024-2401.02345', `arxiv key（got ${k1}）`);
  const k2 = V.paperKeyFor({ arxiv_id: null, created_at: '2026-03-01 09:00:00' });
  assert(/^2026-local-[0-9a-f]{12}$/.test(k2), `local key 用 created_at 哈希（got ${k2}）`);
  const k3 = V.paperKeyFor({ arxiv_id: 'hep-th/9901001', created_at: '1999-01-05 00:00:00' });
  assert(k3 === '1999-hep-th-9901001', `老式 id sanitize（got ${k3}）`);
  assert(V.slugFor('Speculative Decoding: 快速解码!') === 'Speculative-Decoding-快速解码', 'slug sanitize');
  assert(V.srcHash('KV cache  is $x^2$ like') === V.srcHash('KV cache is like'), 'srcHash 规范化公式与空白');
}

{
  console.log('== meta.yaml round-trip ==');
  const p = {
    id: 3, arxiv_id: '2401.02345', title: 'Deep Learning: 方法与$公式$', authors: 'A, B',
    source_url: 'https://arxiv.org/abs/2401.02345', import_type: 'html',
    created_at: '2024-01-15 10:00:00', status: 'reading', tags: '["a", "b"]',
  };
  const text = V.serializeMeta(p, { readPct: 45, sha256: 'abc123', hasDual: true, hasMono: false, summary: { provider: 'glm', model: 'glm-4', body: '{"oneLiner":"x"}', sections: '[]' } });
  const m = V.parseMeta(text);
  assert(m.legacy_id === 3 && m.arxiv_id === '2401.02345', 'legacy_id/arxiv_id');
  assert(m.title === 'Deep Learning: 方法与$公式$', `title 特殊字符（got ${m.title}）`);
  assert(m.status === 'reading' && JSON.stringify(m.tags) === JSON.stringify(['a', 'b']), 'status/tags');
  assert(m.read_pct === 45 && m.sha256 === 'abc123', 'read_pct/sha256');
  assert(m.pdf.dual === 'paper-dual.pdf' && m.pdf.mono == null, 'pdf 子对象');
  assert(m.summary.provider === 'glm' && m.summary.body === '{"oneLiner":"x"}', 'summary 嵌入');
  // 最小 meta（无 summary/无 pdf/无 tags）
  const text2 = V.serializeMeta({ id: 4, arxiv_id: null, title: 'Local PDF', authors: '', source_url: '', import_type: 'pdf', created_at: '2026-03-01 09:00:00', status: 'unread', tags: '' }, { readPct: 0 });
  const m2 = V.parseMeta(text2);
  assert(m2.legacy_id === 4 && m2.arxiv_id == null && Array.isArray(m2.tags) && m2.tags.length === 0, '最小 meta 边界');
  assert(m2.summary == null && m2.pdf.dual == null && m2.pdf.mono == null, '可选段缺省');
}

{
  console.log('== annotations.json round-trip ==');
  const items = [
    { sid: 'h1', legacy_id: 12, kind: 'text', seq: 5, text_en: 'scratch paper', note: '', color: 'yellow', created_at: '2026-11-08 10:00:00' },
    { sid: 'h2', legacy_id: 13, kind: 'rect', side: 'en', page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }], text: 'rect text', seq: null, note: '备注', color: 'green', created_at: '2026-11-08 10:01:00' },
  ];
  const text = V.serializeAnnotations(items);
  const back = V.parseAnnotations(text);
  assert(back.length === 2 && back[0].sid === 'h1' && back[1].sid === 'h2', 'sid 保序');
  assert(back[1].kind === 'rect' && back[1].rects[0].w === 0.3 && back[1].note === '备注', 'rect 字段');
  assert(V.parseAnnotations(V.serializeAnnotations([])).length === 0, '空数组');
}

{
  console.log('== notes.md round-trip ==');
  const rows = [
    { sid: 'n1', legacy_id: 5, pid: 7, text: '笔记正文，含 [[wikilink]] 和\n第二行', created_at: '2026-11-08 10:00:00', updated_at: '2026-11-08 11:00:00' },
    { sid: 'n2', legacy_id: 6, pid: null, text: '整篇笔记', created_at: '2026-11-08 10:05:00', updated_at: '2026-11-08 10:05:00' },
  ];
  const text = V.serializeNotes(rows);
  const back = V.parseNotes(text);
  assert(back.length === 2 && back[0].sid === 'n1' && back[0].text.includes('[[wikilink]]') && back[0].text.includes('\n第二行'), '多行正文完整');
  assert(back[0].seq === 7 && back[1].seq == null, 'seq 锚（null 保留）');
  assert(back[1].legacy_id === 6, 'legacy_id');
  assert(V.parseNotes(V.serializeNotes([])).length === 0, '空 notes');
}

{
  console.log('== qa.jsonl round-trip ==');
  const rows = [
    { sid: 'q1', legacy_id: 3, pid: 5, question: '什么是 KV cache？', answer: '显存中的缓存，含【段落 #5】引用', provider: 'glm', model: 'glm-4', created_at: '2026-11-08 10:00:00' },
    { sid: 'q2', legacy_id: 4, pid: null, question: 'q2', answer: '', provider: '', model: '', created_at: '2026-11-08 10:01:00' },
  ];
  const back = V.parseQa(V.serializeQa(rows));
  assert(back.length === 2 && back[0].answer.includes('【段落 #5】'), 'answer 原文含令牌');
  assert(back[1].seq == null && back[1].legacy_id === 4, 'null seq');
  assert(V.parseQa(V.serializeQa([])).length === 0, '空 qa');
}

{
  console.log('== translations.jsonl round-trip ==');
  const rows = [
    { seq: 5, en: 'KV cache is like $x$', zh: 'KV 缓存就像 x', provider: 'glm', model: 'glm-4', updated_at: '2026-11-08 10:00:00' },
    { seq: 6, en: 'Second para', zh: '第二段', provider: '', model: '', updated_at: '2026-11-08 10:00:01' },
  ];
  const text = V.serializeTranslations(rows);
  const back = V.parseTranslations(text);
  assert(back.length === 2 && back[0].en === 'KV cache is like $x$' && back[0].zh === 'KV 缓存就像 x', 'en+zh 自带');
  const hashMatch = text.includes('"src_hash"');
  assert(hashMatch, '含 src_hash 字段');
  assert(back[0].src_hash === V.srcHash('KV cache is like $x$'), 'src_hash 与 srcHash 一致');
}

{
  console.log('== digest.md round-trip ==');
  const body = '本文提出【H12】提到的方法，结合【N3】与【Q5】。';
  const text = V.serializeDigest(body, '2026-11-08 12:00:00');
  const back = V.parseDigest(text);
  assert(back && back.body === body && back.updated_at === '2026-11-08 12:00:00', 'body 原文含令牌');
  assert(V.parseDigest('') == null, '空 digest 返回 null');
  assert(V.parseDigest('<!-- digest kind=paper updated=2026-11-08 12:00:00 -->\n正文')?.body === '正文', '首行头注释剥离');
}

{
  console.log('== flashcards.jsonl round-trip ==');
  const rows = [
    { sid: 'f1', legacy_id: 9, paper_key: '2024-2401.02345', legacy_paper_id: 3, seq: 5, front: 'What?', back: '草稿纸', interval_days: 1, ease: 2.5, reps: 1, lapses: 0, due: '2026-11-09 00:00:00', created_at: '2026-11-08 10:00:00' },
  ];
  const back = V.parseFlashcards(V.serializeFlashcards(rows));
  assert(back.length === 1 && back[0].paper_key === '2024-2401.02345' && back[0].interval_days === 1, 'SM-2 字段');
}

{
  console.log('== topics round-trip ==');
  const t = { legacy_id: 2, name: 'Speculative Decoding', query: 'speculative decoding', status: 'ready', node_count: 2, edge_count: 1, note: '', created_at: '2026-11-08 10:00:00', updated_at: '2026-11-08 11:00:00' };
  const papers = [
    { arxiv_id: '2401.00001', title: 'A', year: 2023, citation_count: 100, layer: 'key', in_degree: 4, out_degree: 2, read_order: 1, imported: 0 },
    { arxiv_id: '2401.00002', title: 'B', year: 2024, citation_count: 5, layer: 'frontier', in_degree: 1, out_degree: 0, read_order: 2, imported: 1 },
  ];
  const edges = [{ src: '2401.00002', dst: '2401.00001' }];
  const back = V.parseTopic(V.serializeTopic(t, papers, edges));
  assert(back.legacy_id === 2 && back.name === 'Speculative Decoding' && back.status === 'ready', 'topic 头');
  assert(back.papers.length === 2 && back.papers[1].read_order === 2 && back.papers[1].imported === 1, 'papers 数组');
  assert(back.edges.length === 1 && back.edges[0].dst === '2401.00001', 'edges');
}

{
  console.log('== profile.md round-trip ==');
  const text = V.serializeProfile('AI Infra 方向', { concept: 3, method: 5 }, '2026-11-08 10:00:00');
  const back = V.parseProfile(text);
  assert(back.bg === 'AI Infra 方向' && back.signals.concept === 3 && back.signals.method === 5, 'bg + signals');
  const back2 = V.parseProfile(V.serializeProfile('', {}, '2026-11-08 10:00:00'));
  assert(back2.bg === '' && Object.keys(back2.signals).length === 0, '空 profile');
}

{
  console.log('== ensureLayout + writeAtomic ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-vault-'));
  V.ensureLayout(tmp);
  assert(fs.existsSync(path.join(tmp, 'AGENTS.md')), 'AGENTS.md 创建');
  const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
  assert(gi.includes('.paper-reader/') && gi.includes('trash/'), 'gitignore 模板');
  // 已存在不覆盖
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'CUSTOM');
  V.ensureLayout(tmp);
  assert(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8') === 'CUSTOM', 'AGENTS.md 不覆盖用户内容');
  V.writeAtomic(path.join(tmp, 'x.json'), '{"a":1}');
  assert(fs.readFileSync(path.join(tmp, 'x.json'), 'utf8') === '{"a":1}', 'writeAtomic');
  assert(fs.readdirSync(tmp).filter(f => f.includes('.tmp-')).length === 0, '无 tmp 残留');
}

// ---------- vault-wiring 处理器（fake provider + tmp 目录）----------
{
  console.log('== vault-wiring 全资产落盘 ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-wire-'));
  // fake provider：一篇论文的全量数据
  const paper = {
    id: 3, arxiv_id: '2401.02345', title: 'Test Paper', authors: 'A, B',
    source_url: 'https://arxiv.org/abs/2401.02345', import_type: 'html',
    created_at: '2024-01-15 10:00:00', status: 'reading', tags: '["ml"]',
    dual_pdf_path: null, mono_pdf_path: null,
  };
  const blocks = new Map([[10, { seq: 5, en: 'KV cache is like scratch paper' }], [11, { seq: 6, en: 'Second para' }]]);
  const fake = {
    getPaper: (id) => (id === 3 ? paper : null),
    listHighlights: () => [{ id: 12, pid: 5, text_en: 'scratch paper', note: '', color: 'green', created_at: '2026-11-08 10:00:00' }],
    listPdfHighlights: () => [{ id: 13, side: 'en', page: 3, rects: '[{"x":0.1,"y":0.2,"w":0.3,"h":0.1}]', text: 'rect', pid: null, note: '', color: 'yellow', created_at: '2026-11-08 10:01:00' }],
    listNotes: () => [{ id: 5, pid: 5, text: '笔记 [[链接]]', created_at: '2026-11-08 10:00:00', updated_at: '2026-11-08 11:00:00' }],
    listQa: () => [{ id: 3, pid: 5, question: 'Q?', answer: 'A【段落 #5】', provider: 'glm', model: 'glm-4', created_at: '2026-11-08 10:00:00' }],
    getBlockEn: () => blocks,
    getTranslationsFull: () => [{ pid: 10, zh: 'KV 缓存就像草稿纸', provider: 'glm', model: 'glm-4', updated_at: '2026-11-08 10:00:00' }],
    getDigest: (kind) => (kind === 'paper' ? { body: '精炼【H12】【N5】【Q3】', updated_at: '2026-11-08 12:00:00' } : undefined),
    getSummary: () => ({ provider: 'glm', model: 'glm-4', summary: '{"oneLiner":"x"}', section_summaries: '[]' }),
    getReadProgress: () => 45,
    getTopic: (id) => (id === 2 ? { id: 2, name: 'Speculative Decoding', query: 'sd', status: 'ready', node_count: 1, edge_count: 0, note: '', created_at: '2026-11-08 10:00:00', updated_at: '2026-11-08 11:00:00' } : null),
    listTopicPapers: () => [{ arxiv_id: '2401.02345', title: 'Test Paper', year: 2024, citation_count: 10, layer: 'key', in_degree: 2, out_degree: 1, read_order: 1, imported: 1 }],
    listTopicEdges: () => [],
    listAllFlashcards: () => [{ id: 9, paper_id: 3, pid: 5, front: 'F?', back: 'B', interval_days: 1, ease: 2.5, reps: 1, lapses: 0, due: '2026-11-09 00:00:00', created_at: '2026-11-08 10:00:00', arxiv_id: '2401.02345', paper_created_at: '2024-01-15 10:00:00' }],
    getReaderProfile: () => ({ bg: 'AI Infra', signals: { concept: 3 } }),
  };
  const proc = createVaultProcessor({ vaultDir: tmp, provider: fake });
  await proc.handle([
    { kind: 'meta', paperId: 3 }, { kind: 'annotations', paperId: 3 },
    { kind: 'notes', paperId: 3 }, { kind: 'qa', paperId: 3 },
    { kind: 'translations', paperId: 3 }, { kind: 'digest', paperId: 3 },
    { kind: 'flashcards' }, { kind: 'topics', topicId: 2 }, { kind: 'profile' },
  ]);
  const key = '2024-2401.02345';
  const dir = path.join(tmp, 'papers', key);
  assert(fs.existsSync(path.join(dir, 'meta.yaml')), 'meta.yaml');
  const meta = V.parseMeta(fs.readFileSync(path.join(dir, 'meta.yaml'), 'utf8'));
  assert(meta.legacy_id === 3 && meta.read_pct === 45 && meta.summary.body === '{"oneLiner":"x"}', 'meta 内容');
  const annos = V.parseAnnotations(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert(annos.length === 2 && annos[0].kind === 'text' && annos[1].kind === 'rect', 'annotations 混合类型');
  const notes = V.parseNotes(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'));
  assert(notes.length === 1 && notes[0].sid === 'n1' && notes[0].seq === 5, 'notes sid 分配');
  const qa = V.parseQa(fs.readFileSync(path.join(dir, 'qa.jsonl'), 'utf8'));
  assert(qa.length === 1 && qa[0].sid === 'q1', 'qa sid');
  const trs = V.parseTranslations(fs.readFileSync(path.join(dir, 'translations.jsonl'), 'utf8'));
  assert(trs.length === 1 && trs[0].seq === 5 && trs[0].en === 'KV cache is like scratch paper', 'translations 按 pid→seq 映射');
  const dg = V.parseDigest(fs.readFileSync(path.join(dir, 'digest.md'), 'utf8'));
  assert(dg.body.includes('【H12】'), 'digest 令牌保留');
  const fcs = V.parseFlashcards(fs.readFileSync(path.join(tmp, 'flashcards.jsonl'), 'utf8'));
  assert(fcs.length === 1 && fcs[0].paper_key === key, 'flashcards paper_key');
  const tp = V.parseTopic(fs.readFileSync(path.join(tmp, 'topics', 'Speculative-Decoding.json'), 'utf8'));
  assert(tp.legacy_id === 2 && tp.papers[0].imported === 1, 'topic json');
  const prof = V.parseProfile(fs.readFileSync(path.join(tmp, 'profile.md'), 'utf8'));
  assert(prof.bg === 'AI Infra', 'profile');

  // paperDelete → trash
  await proc.handle([{ kind: 'paperDelete', paperId: 3 }]);
  assert(!fs.existsSync(dir), '论文目录移出 papers/');
  const trash = fs.readdirSync(path.join(tmp, 'trash'));
  assert(trash.length === 1 && trash[0].startsWith(key), `trash 保留副本（${trash[0]}）`);

  // 幂等：重复执行不炸
  paper.id = 3;
  const fake2 = { ...fake, getPaper: (id) => (id === 3 ? paper : null) };
  const proc2 = createVaultProcessor({ vaultDir: tmp, provider: fake2 });
  await proc2.handle([{ kind: 'meta', paperId: 3 }]); // 目录已移除，重新写入
  assert(fs.existsSync(path.join(tmp, 'papers', key, 'meta.yaml')), '幂等重建');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
