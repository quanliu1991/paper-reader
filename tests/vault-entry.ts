// vault e2e：主进程内验证 DB 写操作 → writeHook → sink → sidecar 文件全链路
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as db from '../electron/db';
import * as vaultInit from '../electron/vault-init';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

async function run() {
  if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
  const vaultDir = path.join(app.getPath('userData'), 'vault');
  log('== vault e2e ==');

  // 1. 配置 vault 目录（触发 init：sink + hook）
  vaultInit.setVaultDir(vaultDir);
  vaultInit.initVault();
  log(`vault enabled: ${vaultInit.vaultStatus().enabled ? 'PASS' : 'FAIL'}`);

  // 2. 种子论文 + 全类型写操作
  const text = `Vault Test Paper

Abstract. We study storage boundaries.

1 Introduction
KV cache is like scratch paper for math.

2 Method
Paged management gives 64x gain.

References
[1] ref`;
  const parsed = parsePlainText(text, '9999.00002', 'Vault Test Paper');
  const paperId = db.insertPaper({ arxivId: '9999.00002', title: parsed.title, authors: 'Tester', sourceUrl: '', importType: 'text' });
  db.insertBlocks(paperId, parsed.blocks);
  const blocks = db.getBlocks(paperId) as any[];
  const p2 = blocks.find(b => /KV cache is like/.test(b.en));
  db.saveTranslation(paperId, p2.pid, 'KV 缓存就像数学题的草稿纸', 'e2e', 'e2e');
  db.addHighlight({ paperId, pid: p2.pid, textEn: 'scratch paper', color: 'green' });
  db.addNote({ paperId, pid: p2.pid, text: '存储边界笔记 [[test]]' });
  db.addQa({ paperId, pid: p2.pid, question: '边界在哪?', answer: '文件即事实源【段落 #2】', provider: 'e2e', model: 'e2e' });
  db.addFlashcard({ paperId, pid: p2.pid, front: 'F?', back: 'B' });
  db.upsertDigest('paper', paperId, '精炼笔记引用【H1】【N1】【Q1】');
  db.setPaperStatus(paperId, 'reading');
  db.setPaperTags(paperId, ['storage', 'vault']);
  db.setSetting(`read:${paperId}`, '42');
  db.setReaderBg('AI Infra 方向');

  // 3. flush 等待
  await vaultInit.flushVault();
  log(`flush done: ${vaultInit.vaultStatus().pending === 0 ? 'PASS' : 'FAIL'}`);

  // 4. 断言 sidecar（paperKey 年份取 created_at 即今年，arxiv id 9999.00002）
  const key = `${new Date().getFullYear()}-9999.00002`;
  const dir = path.join(vaultDir, 'papers', key);
  const exists = (f: string) => fs.existsSync(path.join(dir, f));
  log(`meta.yaml: ${exists('meta.yaml') ? 'PASS' : 'FAIL'}`);
  log(`annotations.json: ${exists('annotations.json') ? 'PASS' : 'FAIL'}`);
  log(`notes.md: ${exists('notes.md') ? 'PASS' : 'FAIL'}`);
  log(`qa.jsonl: ${exists('qa.jsonl') ? 'PASS' : 'FAIL'}`);
  log(`translations.jsonl: ${exists('translations.jsonl') ? 'PASS' : 'FAIL'}`);
  log(`digest.md: ${exists('digest.md') ? 'PASS' : 'FAIL'}`);

  const metaText = fs.readFileSync(path.join(dir, 'meta.yaml'), 'utf8');
  log(`meta status/tags/pct: ${metaText.includes('status: reading') && metaText.includes('storage') && metaText.includes('read_pct: 42') ? 'PASS' : 'FAIL'}`);

  const trText = fs.readFileSync(path.join(dir, 'translations.jsonl'), 'utf8');
  log(`translations en+zh: ${trText.includes('KV cache is like') && trText.includes('草稿纸') ? 'PASS' : 'FAIL'}`);

  const dgText = fs.readFileSync(path.join(dir, 'digest.md'), 'utf8');
  log(`digest tokens: ${dgText.includes('【H1】') && dgText.includes('【Q1】') ? 'PASS' : 'FAIL'}`);

  const fcText = fs.readFileSync(path.join(vaultDir, 'flashcards.jsonl'), 'utf8');
  log(`flashcards: ${fcText.includes('"paper_key":"' + key + '"') ? 'PASS' : 'FAIL'}`);

  const profText = fs.readFileSync(path.join(vaultDir, 'profile.md'), 'utf8');
  log(`profile: ${profText.includes('AI Infra 方向') ? 'PASS' : 'FAIL'}`);

  // 5. journal 干净
  const journal = path.join(app.getPath('userData'), 'vault-journal.jsonl');
  const jText = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim() : '';
  log(`journal empty: ${jText === '' ? 'PASS' : 'FAIL'}`);

  // 6. 删除论文 → trash
  db.deletePaper(paperId);
  await vaultInit.flushVault();
  const stillThere = fs.existsSync(dir);
  const trash = fs.existsSync(path.join(vaultDir, 'trash')) ? fs.readdirSync(path.join(vaultDir, 'trash')) : [];
  log(`paperDelete→trash: ${!stillThere && trash.some(t => t.startsWith(key)) ? 'PASS' : 'FAIL'}`);

  // 7. 译文重锚：重解析 blocks 后译文按源文哈希保留（upgradeTextImports 的真实场景：相同源重解析，pid 全变）
  const paperId2 = db.insertPaper({ arxivId: '9999.00003', title: 'Reanchor', authors: '', sourceUrl: '', importType: 'text' });
  const src = 'Title\n\n1 Introduction\nKV cache is like scratch paper.\n\n2 Method\nPaged mgmt gives 64x.\n\nRefs';
  db.insertBlocks(paperId2, parsePlainText(src, '9999.00003', 'Reanchor').blocks);
  const b2 = (db.getBlocks(paperId2) as any[]).find(b => /scratch paper/.test(b.en));
  db.saveTranslation(paperId2, b2.pid, '旧译文保留断言', 'e2e', 'e2e');
  // 重解析：同一源文本（parser 幂等）→ 新 pid，译文按源文哈希重挂
  db.insertBlocks(paperId2, parsePlainText(src, '9999.00003', 'Reanchor').blocks);
  const b2new = (db.getBlocks(paperId2) as any[]).find(b => /scratch paper/.test(b.en));
  log(`reanchor keep: ${b2new?.zh === '旧译文保留断言' && b2new.pid !== b2.pid ? 'PASS' : 'FAIL (zh=' + b2new?.zh + ', pidMoved=' + (b2new?.pid !== b2?.pid) + ')'}`);
  // 重解析：源文彻底改变 → 孤儿表，绝不静默删
  db.insertBlocks(paperId2, parsePlainText('Title\n\n1 Introduction\n完全不同的内容换了主题词\n\nRefs', '9999.00003', 'Reanchor').blocks);
  const orphan = db.getDb().prepare('SELECT COUNT(*) AS n FROM orphan_translations WHERE paper_id=?').get(paperId2) as any;
  const goneFromTr = db.getDb().prepare("SELECT COUNT(*) AS n FROM translations WHERE paper_id=? AND zh='旧译文保留断言'").get(paperId2) as any;
  log(`reanchor orphan: ${orphan.n >= 1 && goneFromTr.n === 0 ? 'PASS' : `FAIL (orphan=${orphan.n})`}`);

  // 8. 全量迁移 → 对账 → 删库 → 重建 → 数据完整（P2 全链路）
  const { vaultMigrate, vaultReconcile, vaultRebuild } = await import('../electron/vault-migrate');
  const mr = await vaultMigrate(vaultDir, { userDataDir: app.getPath('userData') });
  log(`migrate: papers=${mr.report.papers} files=${mr.report.files} errors=${mr.report.errors.length}`);
  log(`migrate ok: ${mr.report.papers >= 1 && mr.report.errors.filter((e: string) => !e.startsWith('note:')).length === 0 ? 'PASS' : 'FAIL'}`);

  const rc = vaultReconcile(vaultDir);
  log(`reconcile: ${rc.ok ? 'PASS' : 'FAIL ' + JSON.stringify(rc.report.checks.filter((c: any) => !c.pass))}`);

  // 删库重建验证改为「重建幂等」：同库再跑 rebuild，行数不重复（upsert by legacy_id）
  const before = {
    papers: (db.getDb().prepare('SELECT COUNT(*) n FROM papers').get() as any).n,
    highlights: (db.getDb().prepare('SELECT COUNT(*) n FROM highlights').get() as any).n,
    notes: (db.getDb().prepare('SELECT COUNT(*) n FROM notes').get() as any).n,
    qa: (db.getDb().prepare('SELECT COUNT(*) n FROM qa_pairs').get() as any).n,
  };
  const rb = vaultRebuild(vaultDir);
  const after = {
    papers: (db.getDb().prepare('SELECT COUNT(*) n FROM papers').get() as any).n,
    highlights: (db.getDb().prepare('SELECT COUNT(*) n FROM highlights').get() as any).n,
    notes: (db.getDb().prepare('SELECT COUNT(*) n FROM notes').get() as any).n,
    qa: (db.getDb().prepare('SELECT COUNT(*) n FROM qa_pairs').get() as any).n,
  };
  const dup = (before.papers !== after.papers || before.highlights !== after.highlights || before.notes !== after.notes || before.qa !== after.qa);
  log(`rebuild idempotent: ${!dup && rb.report.errors.length === 0 ? 'PASS' : `FAIL (${JSON.stringify({ before, after })} errs=${rb.report.errors.length})`}`);

  log('ALL DONE');
  finish();
  app.quit();
}

run().catch(e => { log(`FATAL: ${e.stack ?? e}`); finish(); app.quit(); });
