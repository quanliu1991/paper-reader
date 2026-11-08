// vault-import：pull 后把远端 vault 变更增量导入 DB。
// 变更集来源：git diff --name-status <before>..<after>（sync-service 在 pulled>0 时调用）。
// 语义：文件→DB upsert（按 legacy_id）；整篇论文目录删除→级联删 DB。
// 已知限制（文档化）：行级删除不同步——sidecar 是全量重写语义，删除单条标注 = 该文件
// 少一行，按文件级 upsert 天然覆盖；唯一例外是「DB 本地刚写、vault 旧版本被 pull 覆盖」
// 的竞态，由写后重序列化（DB 权威）自愈。
import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import * as db from './db';
import * as V from './vault';
import { vaultPaths } from './vault-sink';

export interface ImportReport {
  papersUpserted: number;
  filesUpserted: number;
  papersDeleted: number;
  errors: string[];
}

// 全量导入指定变更文件（相对 vault 根路径 + 状态 A/M/D）
export function importChanges(vaultDir: string, changes: Array<{ file: string; status: string }>): ImportReport {
  const report: ImportReport = { papersUpserted: 0, filesUpserted: 0, papersDeleted: 0, errors: [] };
  const paths = vaultPaths(vaultDir);

  for (const { file, status } of changes) {
    try {
      // 整篇论文删除：papers/<key>/ 下任意文件 D → 删该论文 DB 行
      const m = file.match(/^papers\/([^/]+)\//);
      if (m && status === 'D') {
        const metaPath = path.join(vaultDir, 'papers', m[1], 'meta.yaml');
        if (!fs.existsSync(metaPath)) {
          // 目录已物理消失——从 trash/ 或既有 DB 找 legacy_id：按 arxiv_id 反查
          const key = m[1];
          const arxivId = key.includes('-local-') ? null : key.replace(/^\d{4}-/, '');
          if (arxivId) {
            const papers = db.listPapers() as any[];
            const hit = papers.find(p => p.arxiv_id === arxivId);
            if (hit) { db.deletePaper(hit.id); report.papersDeleted += 1; }
          }
        }
        continue;
      }
      // upsert 路径：只认 App 管辖区文件
      if (!fs.existsSync(path.join(vaultDir, file))) continue;
      if (file.endsWith('meta.yaml')) {
        upsertPaperMeta(vaultDir, file);
        report.papersUpserted += 1;
      } else if (file.endsWith('annotations.json')) {
        upsertAnnotations(vaultDir, file);
        report.filesUpserted += 1;
      } else if (file.endsWith('notes.md')) {
        upsertNotes(vaultDir, file);
        report.filesUpserted += 1;
      } else if (file.endsWith('qa.jsonl')) {
        upsertQa(vaultDir, file);
        report.filesUpserted += 1;
      } else if (file.endsWith('flashcards.jsonl')) {
        upsertFlashcards(vaultDir, file);
        report.filesUpserted += 1;
      } else if (file.startsWith('topics/') && file.endsWith('.json')) {
        upsertTopic(vaultDir, file);
        report.filesUpserted += 1;
      } else if (file.endsWith('translations.jsonl') || file.endsWith('digest.md')) {
        // 译文/精炼依赖 blocks（B 级不入库）→ 存孤儿表等重导入重挂
        upsertTranslationsOrDigest(vaultDir, file);
        report.filesUpserted += 1;
      }
    } catch (e: any) {
      report.errors.push(`${file}: ${e.message}`);
    }
  }
  return report;
}

function paperDirOfFile(file: string): { dir: string; key: string } | null {
  const m = file.match(/^(papers\/[^/]+)\//);
  return m ? { dir: m[1], key: m[1].split('/')[1] } : null;
}

function paperIdOf(vaultDir: string, file: string): number | null {
  const loc = paperDirOfFile(file);
  if (!loc) return null;
  const metaPath = path.join(vaultDir, loc.dir, 'meta.yaml');
  if (!fs.existsSync(metaPath)) return null;
  const meta = V.parseMeta(fs.readFileSync(metaPath, 'utf8'));
  if (meta?.legacy_id) return meta.legacy_id;
  return null;
}

function ensurePaperRow(vaultDir: string, file: string): number | null {
  const loc = paperDirOfFile(file);
  if (!loc) return null;
  const metaPath = path.join(vaultDir, loc.dir, 'meta.yaml');
  if (!fs.existsSync(metaPath)) return null;
  upsertPaperMeta(vaultDir, `${loc.dir}/meta.yaml`);
  const meta = V.parseMeta(fs.readFileSync(metaPath, 'utf8'));
  return meta?.legacy_id ?? null;
}

function upsertPaperMeta(vaultDir: string, file: string): void {
  const meta = V.parseMeta(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
  if (!meta?.legacy_id) return;
  db.insertPaperWithId({
    id: meta.legacy_id, arxivId: meta.arxiv_id ?? null, title: meta.title ?? '',
    authors: meta.authors ?? '', sourceUrl: meta.source_url ?? '', importType: meta.import_type ?? 'html',
    createdAt: meta.created_at ?? '', status: meta.status ?? 'unread', tags: JSON.stringify(meta.tags ?? []),
  });
  db.restoreReadPct(meta.legacy_id, meta.read_pct ?? 0);
}

function upsertAnnotations(vaultDir: string, file: string): void {
  const paperId = ensurePaperRow(vaultDir, file);
  if (!paperId) return;
  const items = V.parseAnnotations(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
  const d = db.getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM highlights WHERE paper_id=?').run(paperId);
    d.prepare('DELETE FROM pdf_highlights WHERE paper_id=?').run(paperId);
    for (const a of items) {
      if (a.kind === 'text') {
        db.addHighlightWithId(a.legacy_id, { paperId, pid: a.seq ?? 0, textEn: a.text_en, note: a.note ?? '', color: a.color ?? 'yellow', createdAt: a.created_at });
      } else {
        db.addPdfHighlightWithId(a.legacy_id, {
          paperId, side: a.side ?? 'en', page: a.page ?? 1, rects: JSON.stringify(a.rects ?? []),
          text: a.text ?? '', pid: a.seq ?? null, note: a.note ?? '', color: a.color ?? 'yellow', createdAt: a.created_at,
        });
      }
    }
  });
  tx();
}

function upsertNotes(vaultDir: string, file: string): void {
  const paperId = ensurePaperRow(vaultDir, file);
  if (!paperId) return;
  const rows = V.parseNotes(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
  const d = db.getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM notes WHERE paper_id=?').run(paperId);
    for (const n of rows) {
      db.addNoteWithId(n.legacy_id, { paperId, pid: n.seq, text: n.text, createdAt: n.created_at, updatedAt: n.updated_at });
    }
  });
  tx();
}

function upsertQa(vaultDir: string, file: string): void {
  const paperId = ensurePaperRow(vaultDir, file);
  if (!paperId) return;
  const rows = V.parseQa(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
  const d = db.getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM qa_pairs WHERE paper_id=?').run(paperId);
    for (const q of rows) {
      db.addQaWithId(q.legacy_id, { paperId, pid: q.seq, question: q.question, answer: q.answer ?? '', provider: q.provider ?? '', model: q.model ?? '', createdAt: q.created_at });
    }
  });
  tx();
}

function upsertFlashcards(vaultDir: string, file: string): void {
  const rows = V.parseFlashcards(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
  const d = db.getDb();
  const tx = d.transaction(() => {
    for (const f of rows) {
      db.addFlashcardWithId(f.legacy_id, {
        paperId: f.legacy_paper_id, pid: f.seq ?? 0, front: f.front, back: f.back ?? '',
        intervalDays: f.interval_days ?? 0, ease: f.ease ?? 2.5, reps: f.reps ?? 0, lapses: f.lapses ?? 0,
        due: f.due, createdAt: f.created_at,
      });
    }
  });
  tx();
}

function upsertTopic(vaultDir: string, file: string): void {
  const t = V.parseTopic(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
  if (!t?.legacy_id) return;
  db.upsertTopicWithId(t.legacy_id, {
    name: t.name, query: t.query ?? '', status: t.status ?? 'ready',
    nodeCount: t.node_count ?? 0, edgeCount: t.edge_count ?? 0, note: t.note ?? '',
    createdAt: t.created_at, updatedAt: t.updated_at,
  });
  db.saveTopicGraphRows(t.legacy_id, t.papers ?? [], t.edges ?? []);
}

function upsertTranslationsOrDigest(vaultDir: string, file: string): void {
  const paperId = ensurePaperRow(vaultDir, file);
  if (!paperId) return;
  const d = db.getDb();
  if (file.endsWith('translations.jsonl')) {
    const rows = V.parseTranslations(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM orphan_translations WHERE paper_id=?').run(paperId);
      for (const t of rows) {
        d.prepare('INSERT INTO orphan_translations (paper_id, zh, provider, model, updated_at) VALUES (?,?,?,?,?)')
          .run(paperId, t.zh, t.provider ?? '', t.model ?? '', t.updated_at ?? '');
      }
    });
    tx();
  } else if (file.endsWith('digest.md')) {
    const dg = V.parseDigest(fs.readFileSync(path.join(vaultDir, file), 'utf8'));
    if (dg && dg.body) db.upsertDigestWithTime('paper', paperId, dg.body, dg.updated_at);
  }
}

// sync-service 用：pull 后取变更集并导入
export async function importAfterPull(vaultDir: string, headBefore: string): Promise<ImportReport> {
  const git = simpleGit(vaultDir);
  const head = await git.revparse(['HEAD']);
  if (head === headBefore) return { papersUpserted: 0, filesUpserted: 0, papersDeleted: 0, errors: [] };
  const diff = await git.diff([`${headBefore}..${head}`, '--name-status']);
  const changes = diff.split('\n').filter(Boolean).map(line => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], file: rest[rest.length - 1] };
  });
  return importChanges(vaultDir, changes);
}
