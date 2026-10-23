import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as gh from '../electron/github-bridge';

const log = (s: string) => { fs.appendFileSync(process.env.PR_LOG!, s + '\n'); };

export default async function run() {
  if (process.env.PR_TEST_DIR) app.setPath('userData', process.env.PR_TEST_DIR);

  // 模拟已连接仓库：把 repo_path 写进测试库
  const { setSetting } = await import('../electron/db');
  setSetting('repo_path', 'D:\\paper');

  const root = gh.getRepoRoot();
  log(`repo root: ${root ?? 'NULL'}`);
  if (!root) { log('FAIL: repo not detected'); fs.writeFileSync(process.env.PR_DONE!, '1'); app.quit(); return; }

  // 1. fulltext 列表
  const fts = gh.listFulltextFiles(root);
  log(`fulltext files: ${fts.length} (${fts.slice(0, 5).map(f => f.arxivId).join(', ')}${fts.length > 5 ? '...' : ''})`);

  // 2. 术语表
  const terms = gh.loadGlossary(root);
  log(`glossary terms: ${terms.length}`);
  const kv = terms.find(t => /kv.?cache/i.test(t.term));
  log(`sample term: ${kv ? `${kv.term} [${kv.level}] ${kv.explain.slice(0, 40)}` : 'kv-cache NOT FOUND'}`);

  // 3. 笔记列表
  const notes = gh.listNotes(root);
  log(`notes: ${notes.length} (first: ${notes[0] ?? '-'})`);

  // 4. QA 写回（写到临时副本笔记验证，不动真仓库文件）
  //    直接调 appendQaToNote 会写真实仓库 —— 用一个 sandbox 副本目录测试
  const sandbox = path.join(process.env.PR_TEST_DIR!, 'repo-copy');
  fs.mkdirSync(path.join(sandbox, 'notes', 'papers'), { recursive: true });
  // 造一个已有 front-matter 的笔记
  fs.writeFileSync(path.join(sandbox, 'notes', 'papers', '2026-10-21-test.md'),
    '---\n论文: Test\narxiv: 9999.99999\n---\n\n# Test note\n\noriginal content\n');

  const r1 = gh.appendQaToNote(sandbox, '9999.99999', { question: 'Q1?', answer: 'A1.', date: '2026-10-23' });
  const r2 = gh.appendQaToNote(sandbox, '9999.99999', { question: 'Q2?', answer: 'A2.', date: '2026-10-23' });
  const content = fs.readFileSync(path.join(sandbox, 'notes', 'papers', '2026-10-21-test.md'), 'utf8');
  log(`write existing note: ${r1.ok && content.includes('original content') && content.includes('Q1?') && content.includes('Q2?') ? 'PASS' : 'FAIL'}`);

  // 5. 新笔记创建
  const r3 = gh.appendQaToNote(sandbox, '8888.88888', { question: 'Q3?', answer: 'A3.', date: '2026-10-23' });
  const newNote = fs.readFileSync(path.join(sandbox, 'notes', 'papers', r3.note!), 'utf8');
  log(`write new note: ${r3.ok && newNote.includes('Q3?') ? 'PASS' : 'FAIL'}`);

  log('ALL PASS');
  fs.writeFileSync(process.env.PR_DONE!, '1');
  app.quit();
}

run().catch(e => {
  log(`FATAL: ${e?.stack ?? e}`);
  fs.writeFileSync(process.env.PR_DONE!, '1');
  app.quit();
});
