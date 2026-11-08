// vault-migrate：P2 迁移（DB→vault 全量导出）+ 重建（vault→DB）+ 对账。
// 迁移导出复用 vault-wiring 的序列化路径（同一 provider），PDF/图表文件复制进 vault。
// 重建用显式 legacy_id 插入——跨设备整型 id 不变，读路径/精炼令牌/join 零改动。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as db from './db';
import * as V from './vault';
import { vaultPaths } from './vault-sink';
import { createVaultProcessor, type VaultProvider } from './vault-wiring';

// 与 vault-init 相同的 provider 适配（这里直接 import db——迁移器只在主进程跑）
export function buildProvider(): VaultProvider {
  return {
    getPaper: (id) => db.getPaper(id) as any,
    listHighlights: (pid) => db.listHighlights(pid) as any[],
    listPdfHighlights: (pid) => db.listPdfHighlights(pid) as any[],
    listNotes: (pid) => db.listNotes(pid) as any[],
    listQa: (pid) => db.listQa(pid) as any[],
    getBlockEn(paperId: number) {
      const rows = db.getBlocks(paperId) as any[];
      const m = new Map<number, { seq: number; en: string }>();
      for (const b of rows) m.set(b.pid, { seq: b.seq, en: b.en });
      return m;
    },
    getTranslationsFull: (pid) => {
      const d = db.getDb();
      return d.prepare(
        `SELECT t.pid, t.zh, t.provider, t.model, t.updated_at FROM translations t WHERE t.paper_id=? ORDER BY t.pid`
      ).all(pid) as any[];
    },
    getDigest: (kind, refId) => db.getDigest(kind as 'paper' | 'topic', refId) as any,
    getSummary: (pid) => db.getSummary(pid) as any,
    getReadProgress: (pid) => db.getReadProgress(pid),
    getTopic: (id) => db.getTopic(id) as any,
    listTopicPapers: (id) => db.listTopicPapers(id) as any[],
    listTopicEdges: (id) => db.listTopicEdges(id) as any[],
    listAllFlashcards: () => db.listAllFlashcards() as any[],
    getReaderProfile: () => db.getReaderProfile(),
  };
}

function sha256File(p: string): string | null {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

function copyIfNewer(src: string, dest: string): boolean {
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch { return false; }
}

// ---------- 迁移导出：DB 全量 → vault ----------
export async function vaultMigrate(vaultDir: string, opts: { userDataDir: string; repoPath?: string }): Promise<{ report: any }> {
  const provider = buildProvider();
  const processor = createVaultProcessor({ vaultDir, provider });
  const paths = vaultPaths(vaultDir);
  V.ensureLayout(vaultDir);
  const report = { papers: 0, files: 0, bytes: 0, pdfs: 0, errors: [] as string[], topics: 0, flashcards: 0 };

  const papers = db.listPapers() as any[];
  const allTasks: any[] = [];
  for (const p of papers) {
    const key = V.paperKeyFor({ arxiv_id: p.arxiv_id ?? null, created_at: p.created_at });
    const dir = paths.paperDir(key);
    fs.mkdirSync(dir, { recursive: true });
    // PDF 复制：userData/pdfs/<id>.pdf|-dual|-mono + library file_path 就地模式（不复制库文件，meta 记路径提示）
    const ud = opts.userDataDir;
    const pdfSources: Array<[string, string]> = [
      [path.join(ud, 'pdfs', `${p.id}.pdf`), 'paper.pdf'],
      [path.join(ud, 'pdfs', `${p.id}-dual.pdf`), 'paper-dual.pdf'],
      [path.join(ud, 'pdfs', `${p.id}-mono.pdf`), 'paper-mono.pdf'],
    ];
    if (p.file_path && fs.existsSync(p.file_path)) {
      pdfSources.push([p.file_path, 'paper.pdf']); // 本地库导入：原位文件复制入 vault
    }
    const existed = new Set(fs.readdirSync(dir));
    for (const [src, name] of pdfSources) {
      if (existed.has(name)) continue; // 幂等：已存在不重复复制
      if (copyIfNewer(src, path.join(dir, name))) { report.pdfs += 1; report.bytes += fs.statSync(path.join(dir, name)).size; }
    }
    // 图表复制（可选资产，重建可再抓）：userData/figures/<id>/ → cache 区不入 vault（B 级，跳过）
    allTasks.push(
      { kind: 'meta', paperId: p.id },
      { kind: 'annotations', paperId: p.id },
      { kind: 'notes', paperId: p.id },
      { kind: 'qa', paperId: p.id },
      { kind: 'translations', paperId: p.id },
      { kind: 'digest', paperId: p.id },
    );
    report.papers += 1;
  }
  // 全局资产
  allTasks.push({ kind: 'flashcards' }, { kind: 'profile' });
  for (const t of db.listTopics() as any[]) {
    allTasks.push({ kind: 'topics', topicId: t.id });
    report.topics += 1;
  }

  // 同步执行全部 sidecar 序列化（processor.handle 内部全是同步 fs，await 只是形式）
  await processor.handle(allTasks);

  // proto-vault 升格（Task 13）：repo_path 存在时并入术语表与历史笔记
  if (opts.repoPath && fs.existsSync(opts.repoPath)) {
    try { mergeProtoVault(opts.repoPath, vaultDir, report); } catch (e: any) { report.errors.push(`proto-vault: ${e.message}`); }
  }
  report.files = countFiles(vaultDir);
  return { report };
}

function countFiles(dir: string): number {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
      else n += 1;
    }
  } catch { /* ignore */ }
  return n;
}

// ---------- 重建导入：vault → 空库（显式 legacy_id）----------
// blocks 是 B 级派生数据不进 vault：重建后 blocks 为空，阅读器走重新导入 upgrade 路径，
// 译文等重解析资产后续按 src_hash 重挂。S 级资产（划线/笔记/qa/闪卡/精炼）全量恢复。
export function vaultRebuild(vaultDir: string): { report: any } {
  const paths = vaultPaths(vaultDir);
  const report = { papers: 0, highlights: 0, notes: 0, qa: 0, flashcards: 0, digests: 0, topics: 0, profile: false, errors: [] as string[] };

  // 全局：闪卡 + 画像
  if (fs.existsSync(paths.flashcards)) {
    for (const f of V.parseFlashcards(fs.readFileSync(paths.flashcards, 'utf8'))) {
      try {
        db.addFlashcardWithId(f.legacy_id, {
          paperId: f.legacy_paper_id, pid: f.seq ?? 0, front: f.front, back: f.back ?? '',
          intervalDays: f.interval_days ?? 0, ease: f.ease ?? 2.5, reps: f.reps ?? 0, lapses: f.lapses ?? 0,
          due: f.due, createdAt: f.created_at,
        });
        report.flashcards += 1;
      } catch (e: any) { report.errors.push(`flashcard f=${f.sid}: ${e.message}`); }
    }
  }
  if (fs.existsSync(paths.profile)) {
    const prof = V.parseProfile(fs.readFileSync(paths.profile, 'utf8'));
    db.setReaderProfileRows(prof.bg, prof.signals);
    report.profile = true;
  }

  // 每篇论文
  const papersDir = paths.papersDir;
  if (fs.existsSync(papersDir)) {
    for (const key of fs.readdirSync(papersDir)) {
      const dir = path.join(papersDir, key);
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, 'meta.yaml');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = V.parseMeta(fs.readFileSync(metaPath, 'utf8'));
        if (!meta?.legacy_id) { report.errors.push(`paper ${key}: meta 缺 legacy_id`); continue; }
        db.insertPaperWithId({
          id: meta.legacy_id, arxivId: meta.arxiv_id ?? null, title: meta.title ?? key,
          authors: meta.authors ?? '', sourceUrl: meta.source_url ?? '', importType: meta.import_type ?? 'html',
          createdAt: meta.created_at ?? '', status: meta.status ?? 'unread',
          tags: JSON.stringify(meta.tags ?? []),
        });
        db.restoreReadPct(meta.legacy_id, meta.read_pct ?? 0);
        if (meta.summary) {
          db.insertPaperSummaryWithId(meta.legacy_id, {
            summary: meta.summary.body ?? '', sectionSummaries: meta.summary.sections ?? '',
            provider: meta.summary.provider ?? '', model: meta.summary.model ?? '',
          });
        }
        report.papers += 1;

        // annotations
        const annoPath = path.join(dir, 'annotations.json');
        if (fs.existsSync(annoPath)) {
          for (const a of V.parseAnnotations(fs.readFileSync(annoPath, 'utf8'))) {
            if (a.kind === 'text') {
              db.addHighlightWithId(a.legacy_id, { paperId: meta.legacy_id, pid: a.seq ?? 0, textEn: a.text_en, note: a.note ?? '', color: a.color ?? 'yellow', createdAt: a.created_at });
            } else {
              db.addPdfHighlightWithId(a.legacy_id, {
                paperId: meta.legacy_id, side: a.side ?? 'en', page: a.page ?? 1,
                rects: JSON.stringify(a.rects ?? []), text: a.text ?? '', pid: a.seq ?? null,
                note: a.note ?? '', color: a.color ?? 'yellow', createdAt: a.created_at,
              });
            }
            report.highlights += 1;
          }
        }
        // notes（含 proto-vault 并入的历史段——注释定界行外的正文都属于该条目）
        const notePath = path.join(dir, 'notes.md');
        if (fs.existsSync(notePath)) {
          for (const n of V.parseNotes(fs.readFileSync(notePath, 'utf8'))) {
            db.addNoteWithId(n.legacy_id, { paperId: meta.legacy_id, pid: n.seq, text: n.text, createdAt: n.created_at, updatedAt: n.updated_at });
            report.notes += 1;
          }
        }
        // qa
        const qaPath = path.join(dir, 'qa.jsonl');
        if (fs.existsSync(qaPath)) {
          for (const q of V.parseQa(fs.readFileSync(qaPath, 'utf8'))) {
            db.addQaWithId(q.legacy_id, {
              paperId: meta.legacy_id, pid: q.seq, question: q.question, answer: q.answer ?? '',
              provider: q.provider ?? '', model: q.model ?? '', createdAt: q.created_at,
            });
            report.qa += 1;
          }
        }
        // digest
        const dgPath = path.join(dir, 'digest.md');
        if (fs.existsSync(dgPath)) {
          const dg = V.parseDigest(fs.readFileSync(dgPath, 'utf8'));
          if (dg && dg.body) { db.upsertDigestWithTime('paper', meta.legacy_id, dg.body, dg.updated_at); report.digests += 1; }
        }
        // translations.jsonl：blocks 不重建，译文暂存孤儿表？——不：译文以文件为事实源保存，
        // 重导入解析 blocks 后由 src_hash 重挂路径消费孤儿表（见 rebuildTranslationsToOrphans）
        const trPath = path.join(dir, 'translations.jsonl');
        if (fs.existsSync(trPath)) {
          for (const t of V.parseTranslations(fs.readFileSync(trPath, 'utf8'))) {
            db.getDb().prepare(
              'INSERT INTO orphan_translations (paper_id, zh, provider, model, updated_at) VALUES (?,?,?,?,?)'
            ).run(meta.legacy_id, t.zh, t.provider ?? '', t.model ?? '', t.updated_at ?? '');
          }
        }
      } catch (e: any) { report.errors.push(`paper ${key}: ${e.message}`); }
    }
  }

  // topics
  const topicsDir = paths.topicsDir;
  if (fs.existsSync(topicsDir)) {
    for (const f of fs.readdirSync(topicsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = V.parseTopic(fs.readFileSync(path.join(topicsDir, f), 'utf8'));
        db.upsertTopicWithId(t.legacy_id, {
          name: t.name, query: t.query ?? '', status: t.status ?? 'ready',
          nodeCount: t.node_count ?? 0, edgeCount: t.edge_count ?? 0, note: t.note ?? '',
          createdAt: t.created_at, updatedAt: t.updated_at,
        });
        db.saveTopicGraphRows(t.legacy_id, t.papers ?? [], t.edges ?? []);
        // 主题精炼
        const dgFile = paths.topicDigest(V.slugFor(t.name));
        if (fs.existsSync(dgFile)) {
          const dg = V.parseDigest(fs.readFileSync(dgFile, 'utf8'));
          if (dg && dg.body) db.upsertDigestWithTime('topic', t.legacy_id, dg.body, dg.updated_at);
        }
        report.topics += 1;
      } catch (e: any) { report.errors.push(`topic ${f}: ${e.message}`); }
    }
  }
  return { report };
}
// ---------- 对账：迁移 → 临时重建 → 逐表比对 ----------
// 验证「迁移导出的 vault 重建后数据不丢」。临时库用 SQLite backup 到 tmp 文件、
// 换 userData 打开的方式成本高；简化：迁移后在同一进程做行数对账（sidecar 解析 vs DB 行数）
// + 逐篇 H/N/Q 令牌解析校验（digests 引用链完整性）。
export function vaultReconcile(vaultDir: string): { ok: boolean; report: any } {
  const paths = vaultPaths(vaultDir);
  const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

  const cnt = (sql: string, ...args: any[]): number =>
    (db.getDb().prepare(sql).get(...args) as any)?.n ?? 0;

  // 行数对账：sidecar 条目数 vs DB 行数
  const papersDir = paths.papersDir;
  let sidecarHighlights = 0, sidecarNotes = 0, sidecarQa = 0;
  const dbHighlights = cnt('SELECT COUNT(*) AS n FROM highlights');
  const dbNotes = cnt('SELECT COUNT(*) AS n FROM notes');
  const dbQa = cnt('SELECT COUNT(*) AS n FROM qa_pairs');
  const dbFlashcards = cnt('SELECT COUNT(*) AS n FROM flashcards');
  const dbDigests = cnt('SELECT COUNT(*) AS n FROM digests');
  if (fs.existsSync(papersDir)) {
    for (const key of fs.readdirSync(papersDir)) {
      const dir = path.join(papersDir, key);
      sidecarHighlights += V.parseAnnotations(fs.existsSync(path.join(dir, 'annotations.json')) ? fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8') : '').length;
      sidecarNotes += V.parseNotes(fs.existsSync(path.join(dir, 'notes.md')) ? fs.readFileSync(path.join(dir, 'notes.md'), 'utf8') : '').length;
      sidecarQa += V.parseQa(fs.existsSync(path.join(dir, 'qa.jsonl')) ? fs.readFileSync(path.join(dir, 'qa.jsonl'), 'utf8') : '').length;
    }
  }
  checks.push({ name: 'highlights 行数', pass: sidecarHighlights === dbHighlights, detail: `vault=${sidecarHighlights} db=${dbHighlights}` });
  checks.push({ name: 'notes 行数', pass: sidecarNotes === dbNotes, detail: `vault=${sidecarNotes} db=${dbNotes}` });
  checks.push({ name: 'qa 行数', pass: sidecarQa === dbQa, detail: `vault=${sidecarQa} db=${dbQa}` });

  const sidecarFlashcards = fs.existsSync(paths.flashcards) ? V.parseFlashcards(fs.readFileSync(paths.flashcards, 'utf8')).length : 0;
  checks.push({ name: 'flashcards 行数', pass: sidecarFlashcards === dbFlashcards, detail: `vault=${sidecarFlashcards} db=${dbFlashcards}` });

  // 精炼令牌回归：每个 digest 的 【H/N/Q n】 都必须能 resolveCites 命中
  let tokenMiss = 0, tokenTotal = 0;
  for (const dg of db.listDigests('paper') as any[]) {
    for (const tok of String(dg.body).match(/【[HNQ]\d+】/g) ?? []) {
      tokenTotal += 1;
      const resolved = db.resolveCites(dg.body).find(c => c.token === tok);
      if (!resolved) tokenMiss += 1;
    }
  }
  checks.push({ name: 'digest 令牌回归', pass: tokenMiss === 0, detail: `${tokenTotal - tokenMiss}/${tokenTotal} 命中` });

  // meta 覆盖：DB 每篇论文在 vault 都有 meta.yaml
  let metaMiss = 0;
  for (const p of db.listPapers() as any[]) {
    const key = V.paperKeyFor({ arxiv_id: p.arxiv_id ?? null, created_at: p.created_at });
    if (!fs.existsSync(paths.meta(key))) metaMiss += 1;
  }
  checks.push({ name: 'meta 覆盖', pass: metaMiss === 0, detail: `缺 ${metaMiss} 篇` });

  const ok = checks.every(c => c.pass);
  return { ok, report: { checks, digests: dbDigests } };
}

// ---------- proto-vault 升格：glossary 复制 + 历史 md 并入 ----------
function mergeProtoVault(repoPath: string, vaultDir: string, report: any): void {
  // glossary/ → vault/glossary/（不存在才建——vault 是事实源后 repo 侧退役）
  const srcG = path.join(repoPath, 'glossary');
  const dstG = path.join(vaultDir, 'glossary');
  if (fs.existsSync(srcG) && !fs.existsSync(dstG)) {
    fs.cpSync(srcG, dstG, { recursive: true });
    report.files += countFiles(dstG);
  }
  // notes/papers/*.md：匹配 arxivId 的历史内容并入对应论文 notes.md 尾部（只增不删）
  const notesDir = path.join(repoPath, 'notes', 'papers');
  if (!fs.existsSync(notesDir)) return;
  const paths = vaultPaths(vaultDir);
  for (const f of fs.readdirSync(notesDir)) {
    if (!f.endsWith('.md') || f.startsWith('paper-reader-')) continue;
    const arxivId = extractArxivId(f);
    if (!arxivId) continue;
    const paper = papersByArxiv()[arxivId];
    if (!paper) continue;
    const key = V.paperKeyFor({ arxiv_id: paper.arxiv_id, created_at: paper.created_at });
    const noteFile = paths.notes(key);
    const legacy = fs.readFileSync(path.join(notesDir, f), 'utf8');
    if (fs.existsSync(noteFile) && fs.readFileSync(noteFile, 'utf8').includes('<!-- imported-from-repo -->')) continue; // 幂等
    fs.mkdirSync(path.dirname(noteFile), { recursive: true });
    const prev = fs.existsSync(noteFile) ? fs.readFileSync(noteFile, 'utf8') : '';
    fs.writeFileSync(noteFile, `${prev}\n<!-- imported-from-repo -->\n## 历史知识库笔记（${f}）\n${legacy}\n`);
    report.errors.push(`note: 并入 ${f} → ${key}`); // 用 errors 通道做提示日志
  }
}

function extractArxivId(f: string): string | null {
  const m = f.match(/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/);
  return m ? m[1] : null;
}

function papersByArxiv(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of db.listPapers() as any[]) if (p.arxiv_id) out[p.arxiv_id] = p;
  return out;
}
