// P4 格式对齐测试：同一 fixture 让 electron/vault.ts 与 web/src/vault-format.ts 双侧解析，
// 断言结果一致（格式契约防漂移）。esbuild 编译两侧后跑。
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['electron/vault.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['yaml'],
  outfile: 'tests/.tmp-vault/vault.cjs', logLevel: 'silent',
});
await build({
  entryPoints: ['web/src/vault-format.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outfile: 'tests/.tmp-vault/web-format.cjs', logLevel: 'silent',
});
const E = require('../tests/.tmp-vault/vault.cjs');
const W = require('../tests/.tmp-vault/web-format.cjs');

let pass = 0, fail = 0;
const assert = (c, n) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.error(`  FAIL  ${n}`); } };

// ---------- fixture：electron 侧序列化，web 侧解析 ----------
{
  console.log('== meta.yaml：electron 序列化 → web 解析 ==');
  const p = {
    id: 7, arxiv_id: '2401.02345', title: 'Align Test', authors: 'A, B',
    source_url: 'https://arxiv.org/abs/2401.02345', import_type: 'html',
    created_at: '2024-01-15 10:00:00', status: 'reading', tags: '["align", "vault"]',
  };
  const text = E.serializeMeta(p, { readPct: 66, sha256: 'abc', hasDual: true, hasMono: false, summary: { provider: 'glm', model: 'glm-4', body: '{"x":1}', sections: '[]' } });
  const m = W.parseMeta(text);
  assert(m.legacy_id === 7 && m.arxiv_id === '2401.02345', 'legacy_id/arxiv_id');
  assert(m.title === 'Align Test', 'title');
  assert(m.status === 'reading', 'status');
  assert(m.read_pct === 66 && m.sha256 === 'abc', 'read_pct/sha256');
  assert(Array.isArray(m.tags) && m.tags.join(',') === 'align,vault', `tags 内联数组（got ${JSON.stringify(m.tags)}）`);
  assert(m.pdf?.dual === 'paper-dual.pdf', 'pdf.dual 嵌套');
  assert(m.summary?.provider === 'glm' && m.summary?.body === '{"x":1}', 'summary 嵌套');
}

{
  console.log('== notes.md：electron → web ==');
  const rows = [
    { sid: 'n1', legacy_id: 5, pid: 9, text: '对齐笔记 [[link]]', created_at: '2026-11-09 10:00:00', updated_at: '2026-11-09 11:00:00' },
    { sid: 'n2', legacy_id: 6, pid: null, text: '整篇笔记', created_at: '2026-11-09 10:05:00', updated_at: '2026-11-09 10:05:00' },
  ];
  const back = W.parseNotes(E.serializeNotes(rows));
  assert(back.length === 2 && back[0].sid === 'n1' && back[0].text === '对齐笔记 [[link]]', 'note 解析');
  assert(back[0].seq === 9 && back[1].seq == null, 'seq 锚');
}

{
  console.log('== digest/annotations：electron → web ==');
  const dg = W.parseDigest(E.serializeDigest('精炼【H1】【N2】', '2026-11-09 12:00:00'));
  assert(dg.body === '精炼【H1】【N2】' && dg.updated_at === '2026-11-09 12:00:00', 'digest');
  const items = [
    { sid: 'h1', legacy_id: 12, kind: 'text', seq: 5, text_en: 'hi', note: '', color: 'yellow', created_at: '2026-11-09 10:00:00' },
  ];
  const text = E.serializeAnnotations(items);
  const back = W.parseAnnotations(text);
  assert(back.length === 1 && back[0].sid === 'h1' && back[0].legacy_id === 12, 'annotations 读');
}

{
  console.log('== annotations 回写字节级对齐：web 序列化 == electron 序列化 ==');
  const items = [
    { sid: 'h1', legacy_id: 12, kind: 'text', seq: 5, text_en: 'hi', note: '', color: 'yellow', created_at: '2026-11-09 10:00:00' },
    { sid: 'h2', legacy_id: 13, kind: 'text', seq: null, text_en: 'x“y’z', note: '', color: 'yellow', created_at: '2026-11-09 10:00:00' },
  ];
  const e = E.serializeAnnotations(items);
  const w = W.serializeAnnotations(items);
  assert(e === w, `字节级一致（e=${JSON.stringify(e.slice(0, 60))} w=${JSON.stringify(w.slice(0, 60))}）`);
}

{
  console.log('== translations/qa/flashcards：JSONL 双侧 ==');
  const trs = [{ seq: 3, en: 'en $x$', zh: '中', provider: 'p', model: 'm', updated_at: '2026-11-09 10:00:00' }];
  const wt = W.parseTranslations(E.serializeTranslations(trs));
  assert(wt.length === 1 && wt[0].seq === 3 && wt[0].zh === '中' && wt[0].src_hash?.length === 64, `translations（hash=${wt[0].src_hash?.slice(0, 8)}…）`);
  const qa = [{ sid: 'q1', legacy_id: 1, pid: 3, question: 'Q', answer: 'A', provider: '', model: '', created_at: '2026-11-09 10:00:00' }];
  assert(W.parseQa(E.serializeQa(qa))[0].question === 'Q', 'qa');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
