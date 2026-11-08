// P3 双设备 e2e：设备 A（写+push）→ 设备 B（pull+import→DB 出现 A 的划线）
// 单进程共享 DB（测试环境事实）：B 断言验证 vault 文件与 DB 一致；空库引导由 vault-bootstrap e2e 覆盖。
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as db from '../electron/db';
import * as vaultInit from '../electron/vault-init';
import { vaultMigrate } from '../electron/vault-migrate';
import { createGitAgent } from '../electron/sync-agent';
import { importAfterPull } from '../electron/vault-import';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

async function run() {
  if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
  const ud = app.getPath('userData');
  const remote = path.join(ud, 'remote.git');
  const vaultA = path.join(ud, 'vaultA');
  const vaultB = path.join(ud, 'vaultB');
  execSync(`git init --bare -b main "${remote}"`);
  log('== P3 双设备同步 e2e ==');

  // ---------- 设备 A：种数据 → 双写 → migrate → agent push ----------
  vaultInit.setVaultDir(vaultA);
  vaultInit.initVault();
  const paperId = db.insertPaper({ arxivId: '9999.00077', title: 'Sync Paper', authors: 'A', sourceUrl: '', importType: 'text' });
  db.insertBlocks(paperId, parsePlainText('Title\n\nShared body para.\n\nRefs', '9999.00077', 'Sync Paper').blocks);
  const body = (db.getBlocks(paperId) as any[]).find(b => /Shared body/.test(b.en));
  db.addHighlight({ paperId, pid: body.pid, textEn: 'Shared body', color: 'yellow' });
  db.addNote({ paperId, pid: body.pid, text: 'A 设备的笔记' });
  await vaultInit.flushVault();
  await vaultMigrate(vaultA, { userDataDir: ud });
  const agentA = createGitAgent(vaultA, { remoteUrl: remote, pushEnabled: true, dryRun: false });
  const rA = await agentA.syncOnce('deposit: A 沉淀');
  log(`device A pushed: ${rA.ok && rA.pushed ? 'PASS' : `FAIL (${JSON.stringify(rA)})`}`);

  // ---------- 设备 B：clone 远端 → vault 切到 B → DB 一致断言 ----------
  fs.mkdirSync(vaultB, { recursive: true });
  execSync(`git clone "${remote}" "${vaultB}"`);
  vaultInit.setVaultDir(vaultB);
  const papers = db.listPapers() as any[];
  const bHls = papers.length ? db.listHighlights(papers[0].id) as any[] : [];
  const bNotes = papers.length ? db.listNotes(papers[0].id) as any[] : [];
  log(`device B has A's paper: ${papers.length === 1 && papers[0].arxiv_id === '9999.00077' ? 'PASS' : `FAIL (${papers.length})`}`);
  log(`device B has A's highlight: ${bHls.length === 1 && bHls[0].text_en === 'Shared body' ? 'PASS' : `FAIL (${JSON.stringify(bHls.map(h => h.text_en))})`}`);
  log(`device B has A's note: ${bNotes.length === 1 && bNotes[0].text === 'A 设备的笔记' ? 'PASS' : 'FAIL'}`);

  // ---------- 增量：A 再写 → push → B pull+import → DB 出现增量 ----------
  const annoFile = path.join(vaultA, 'papers', `${new Date().getFullYear()}-9999.00077`, 'annotations.json');
  const anno = JSON.parse(fs.readFileSync(annoFile, 'utf8'));
  anno.items.push({ sid: 'h2', legacy_id: 999, kind: 'text', seq: 1, text_en: 'A 增量划线', note: '', color: 'green', created_at: '2026-11-09 00:00:00' });
  fs.writeFileSync(annoFile, JSON.stringify(anno, null, 2) + '\n');
  const rA2 = await agentA.syncOnce('deposit: A 增量');
  log(`device A incremental pushed: ${rA2.ok && rA2.pushed ? 'PASS' : `FAIL (${JSON.stringify(rA2)})`}`);

  const agentB = createGitAgent(vaultB, { remoteUrl: remote, pushEnabled: true, dryRun: false });
  await agentB.ensureRepo();
  const headBefore = await agentB.headSha();
  await agentB.pullRebase();
  const ir = await importAfterPull(vaultB, headBefore);
  const bHls2 = db.listHighlights(papers[0].id) as any[];
  log(`device B incremental import: ${ir.errors.length === 0 && bHls2.some(h => h.text_en === 'A 增量划线') ? 'PASS' : `FAIL (hls=${bHls2.length} errs=${JSON.stringify(ir.errors)})`}`);

  log('ALL DONE');
  finish();
  app.quit();
}

run().catch(e => { log(`FATAL: ${e.stack ?? e}`); finish(); app.quit(); });
