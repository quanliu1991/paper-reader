// vault bootstrap e2e：独立进程验证「DB 不存在 + vault 存在 → 自动重建」
// 两阶段：阶段 A 复用 vault-entry 的种子（跑完 vault-e2e 后 vault 目录已就绪）——
// 为自包含，本入口自己种数据 + migrate；阶段 B 删 DB 重启（第二次 electron 进程）验证。
// 简化：单进程内通过 app.relaunch 实现「重启」。
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as db from '../electron/db';
import * as vaultInit from '../electron/vault-init';
import { vaultMigrate } from '../electron/vault-migrate';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

async function run() {
  if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
  const ud = app.getPath('userData');
  const vaultDir = path.join(ud, 'vault');
  const flagFile = path.join(ud, 'phase2');
  log('== vault bootstrap e2e ==');

  if (!fs.existsSync(flagFile)) {
    // 阶段 A：种数据 → migrate → 标记 → 删 DB → relaunch
    vaultInit.setVaultDir(vaultDir);
    vaultInit.initVault();
    const paperId = db.insertPaper({ arxivId: '9999.00009', title: 'Bootstrap Paper', authors: '', sourceUrl: '', importType: 'text' });
    db.insertBlocks(paperId, parsePlainText('Title\n\nBody text here.\n\nRefs', '9999.00009', 'Bootstrap Paper').blocks);
    db.addHighlight({ paperId, pid: (db.getBlocks(paperId) as any[])[1].pid, textEn: 'Body', color: 'yellow' });
    db.addNote({ paperId, pid: null, text: 'bootstrap note' });
    // proto-vault 种子：repo_path 结构（glossary + notes/papers/历史 md）
    const repoPath = path.join(ud, 'repo');
    fs.mkdirSync(path.join(repoPath, 'glossary'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'glossary', 'terms.yaml'), 'terms:\n  - term: KV Cache\n    def: 键值缓存\n');
    fs.mkdirSync(path.join(repoPath, 'notes', 'papers'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'notes', 'papers', '9999.00009-notes.md'), '# 历史笔记\n旧知识库的沉淀内容\n');
    db.setSetting('repo_path', repoPath);
    await vaultInit.flushVault();
    const { vaultMigrate } = await import('../electron/vault-migrate');
    await vaultMigrate(vaultDir, { userDataDir: ud, repoPath });
    const notesMerged = fs.readFileSync(path.join(vaultDir, 'papers', `${new Date().getFullYear()}-9999.00009`, 'notes.md'), 'utf8');
    const glossaryCopied = fs.existsSync(path.join(vaultDir, 'glossary', 'terms.yaml'));
    log(`phase A proto-vault notes merged: ${notesMerged.includes('<!-- imported-from-repo -->') && notesMerged.includes('旧知识库的沉淀内容') ? 'PASS' : 'FAIL'}`);
    log(`phase A proto-vault glossary: ${glossaryCopied ? 'PASS' : 'FAIL'}`);
    log(`phase A seeded: paper=${paperId}`);
    // 删库 + 标记阶段 B + 重启
    db.setWriteHook(null);
    const dbFile = path.join(ud, 'paper-reader.db');
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + suf); } catch {}
    }
    fs.writeFileSync(flagFile, '1');
    log('phase A: DB deleted, relaunching');
    app.relaunch();
    app.quit();
    return;
  }

  // 阶段 B：新进程（relaunch）。DB 不存在 + vault 存在 → bootstrapIfNeeded 自动重建
  const dbExisted = fs.existsSync(path.join(ud, 'paper-reader.db'));
  const boot = vaultInit.bootstrapIfNeeded();
  const papers = db.listPapers() as any[];
  const hls = papers.length ? db.listHighlights(papers[0].id) as any[] : [];
  const notes = papers.length ? db.listNotes(papers[0].id) as any[] : [];
  log(`phase B db-was-missing: ${!dbExisted ? 'PASS' : 'FAIL'}`);
  log(`phase B bootstrap ran: ${boot && boot.papers >= 1 ? 'PASS' : `FAIL (${JSON.stringify(boot)})`}`);
  log(`phase B restored: ${papers.length === 1 && papers[0].arxiv_id === '9999.00009' && hls.length === 1 && notes.length === 1 ? 'PASS' : `FAIL (papers=${papers.length} hls=${hls.length} notes=${notes.length})`}`);
  log(`phase B same-id: ${papers[0]?.id === 1 && hls[0]?.text_en === 'Body' ? 'PASS' : 'FAIL (id=' + papers[0]?.id + ')'}`);

  log('ALL DONE');
  finish();
  app.quit();
}

run().catch(e => { log(`FATAL: ${e.stack ?? e}`); finish(); app.quit(); });
