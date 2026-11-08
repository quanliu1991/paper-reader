// vault-wiring：writeHook 事件 → sidecar 文件落盘的处理器。
// 核心语义：每类资产按 DB 当前状态「全量重序列化」该 sidecar（幂等，无增量状态机）。
// 处理器不 import db（避免环）；数据访问全部走 VaultProvider 接口（main.ts 注入真实 db，
// 测试注入 fake）。文件写入走 vault.ts 的 writeAtomic。
import path from 'path';
import fs from 'fs';
import type { VaultTask } from './vault-sink';
import { vaultPaths } from './vault-sink';
import * as V from './vault';

export interface VaultProvider {
  getPaper(id: number): any;
  listHighlights(paperId: number): any[];
  listPdfHighlights(paperId: number): any[];
  listNotes(paperId: number): any[];
  listQa(paperId: number): any[];
  getBlockEn(paperId: number): Map<number, { seq: number; en: string }>; // pid → block
  getTranslationsFull(paperId: number): Array<{ pid: number; zh: string; provider: string; model: string; updated_at: string }>;
  getDigest(kind: string, refId: number): any;
  getSummary(paperId: number): any;
  getReadProgress(paperId: number): number;
  getTopic(id: number): any;
  listTopicPapers(topicId: number): any[];
  listTopicEdges(topicId: number): any[];
  listAllFlashcards(): any[];
  getReaderProfile(): { bg: string; signals: Record<string, number> };
}

interface SidAssigner {
  // 按 legacy_id 升序给 sid 前缀编序（h1..hN / n1.. / q1..），创建后不变
  assign(rows: any[], prefix: string, idKey: string): any[];
}

function assignSids(rows: any[], prefix: string, idKey: string): any[] {
  const sorted = [...rows].sort((a, b) => (a[idKey] ?? 0) - (b[idKey] ?? 0));
  return sorted.map((r, i) => ({ ...r, sid: `${prefix}${i + 1}` }));
}

export function createVaultProcessor(opts: { vaultDir: string; provider: VaultProvider }) {
  const P = opts.provider;
  const paths = vaultPaths(opts.vaultDir);

  function requirePaper(paperId: number): { key: string; paper: any } | null {
    const paper = P.getPaper(paperId);
    if (!paper) return null; // 论文已删（paperDelete 之外的残余事件）
    return { key: V.paperKeyFor({ arxiv_id: paper.arxiv_id ?? null, created_at: paper.created_at }), paper };
  }

  async function writeMeta(paperId: number): Promise<void> {
    const ctx = requirePaper(paperId);
    if (!ctx) return;
    const { key, paper } = ctx;
    const sum = P.getSummary(paperId);
    const text = V.serializeMeta(paper, {
      readPct: P.getReadProgress(paperId),
      sha256: sha256OfFile(paths.paperDir(key) + '/paper.pdf') ?? '',
      hasDual: !!(paper.dual_pdf_path && fs.existsSync(paper.dual_pdf_path)),
      hasMono: !!(paper.mono_pdf_path && fs.existsSync(paper.mono_pdf_path)),
      summary: sum ? { provider: sum.provider ?? '', model: sum.model ?? '', body: sum.summary ?? '', sections: sum.section_summaries ?? '' } : undefined,
    });
    V.writeAtomic(paths.meta(key), text);
  }

  async function writeAnnotations(paperId: number): Promise<void> {
    const ctx = requirePaper(paperId);
    if (!ctx) return;
    const { key } = ctx;
    const textHl = assignSids(P.listHighlights(paperId), 'h', 'id').map(h => ({
      sid: h.sid, legacy_id: h.id, kind: 'text', seq: h.pid,
      text_en: h.text_en, note: h.note ?? '', color: h.color ?? 'yellow', created_at: h.created_at,
    }));
    const rectHl = assignSids(P.listPdfHighlights(paperId), 'h', 'id').map(h => ({
      sid: h.sid, legacy_id: h.id, kind: 'rect', side: h.side, page: h.page,
      rects: safeParse(h.rects), text: h.text, seq: h.pid ?? null, note: h.note ?? '', color: h.color ?? 'yellow', created_at: h.created_at,
    }));
    V.writeAtomic(paths.annotations(key), V.serializeAnnotations([...textHl, ...rectHl]));
  }

  async function writeNotes(paperId: number): Promise<void> {
    const ctx = requirePaper(paperId);
    if (!ctx) return;
    const { key } = ctx;
    const rows = assignSids(P.listNotes(paperId), 'n', 'id').map(n => ({ ...n, legacy_id: n.id }));
    V.writeAtomic(paths.notes(key), V.serializeNotes(rows));
  }

  async function writeQa(paperId: number): Promise<void> {
    const ctx = requirePaper(paperId);
    if (!ctx) return;
    const { key } = ctx;
    const rows = assignSids(P.listQa(paperId), 'q', 'id').map(q => ({ ...q, legacy_id: q.id }));
    V.writeAtomic(paths.qa(key), V.serializeQa(rows));
  }

  async function writeTranslations(paperId: number): Promise<void> {
    const ctx = requirePaper(paperId);
    if (!ctx) return;
    const { key } = ctx;
    const blocks = P.getBlockEn(paperId); // pid → {seq, en}
    const rows = P.getTranslationsFull(paperId)
      .map(t => {
        const b = blocks.get(t.pid);
        if (!b) return null; // 译文挂在已消失的 block 上（孤儿，重锚后不应出现）
        return { seq: b.seq, en: b.en, zh: t.zh, provider: t.provider ?? '', model: t.model ?? '', updated_at: t.updated_at };
      })
      .filter(Boolean) as any[];
    V.writeAtomic(paths.translations(key), V.serializeTranslations(rows));
  }

  async function writeDigest(paperId: number): Promise<void> {
    const ctx = requirePaper(paperId);
    if (!ctx) return;
    const { key } = ctx;
    const dg = P.getDigest('paper', paperId);
    if (!dg) {
      // 摘要被删（当前无删除路径，防御）——写空文件等同清除
      V.writeAtomic(paths.digest(key), '');
      return;
    }
    V.writeAtomic(paths.digest(key), V.serializeDigest(dg.body, dg.updated_at));
  }

  async function writeFlashcards(): Promise<void> {
    const rows = P.listAllFlashcards().map(f => ({
      sid: `f${f.id}`, legacy_id: f.id,
      paper_key: f.arxiv_id ? V.paperKeyFor({ arxiv_id: f.arxiv_id, created_at: f.paper_created_at }) : `${V.paperKeyFor({ arxiv_id: null, created_at: f.paper_created_at ?? '' })}`,
      legacy_paper_id: f.paper_id, seq: f.pid, front: f.front, back: f.back ?? '',
      interval_days: f.interval_days, ease: f.ease, reps: f.reps, lapses: f.lapses,
      due: f.due, created_at: f.created_at,
    }));
    V.writeAtomic(paths.flashcards, V.serializeFlashcards(rows));
  }

  async function writeTopic(topicId: number): Promise<void> {
    const t = P.getTopic(topicId);
    if (!t) return;
    const slug = V.slugFor(t.name);
    const papers = P.listTopicPapers(topicId);
    const edges = P.listTopicEdges(topicId);
    V.writeAtomic(paths.topicJson(slug), V.serializeTopic(t, papers, edges));
    const dg = P.getDigest('topic', topicId);
    if (dg) V.writeAtomic(paths.topicDigest(slug), V.serializeDigest(dg.body, dg.updated_at));
  }

  async function writeProfile(): Promise<void> {
    const prof = P.getReaderProfile();
    V.writeAtomic(paths.profile, V.serializeProfile(prof.bg, prof.signals, new Date().toISOString().slice(0, 19).replace('T', ' ')));
  }

  async function handlePaperDelete(paperId: number): Promise<void> {
    // DB 行已删，paperKey 无从计算——扫描 papers/ 找 meta.legacy_id 匹配
    const papersDir = paths.papersDir;
    if (!fs.existsSync(papersDir)) return;
    for (const name of fs.readdirSync(papersDir)) {
      const metaPath = path.join(papersDir, name, 'meta.yaml');
      try {
        if (!fs.existsSync(metaPath)) continue;
        const meta = V.parseMeta(fs.readFileSync(metaPath, 'utf8'));
        if (meta?.legacy_id === paperId) {
          fs.mkdirSync(paths.trashDir, { recursive: true });
          const dest = path.join(paths.trashDir, `${name}-${Date.now()}`);
          fs.renameSync(path.join(papersDir, name), dest);
          return;
        }
      } catch { /* 单个目录损坏跳过 */ }
    }
  }

  return {
    async handle(tasks: VaultTask[]): Promise<void> {
      V.ensureLayout(opts.vaultDir);
      // 同类任务去重（kind+id），保持顺序
      const seen = new Set<string>();
      const uniq = tasks.filter(t => {
        const k = `${t.kind}:${t.paperId ?? t.topicId ?? ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      for (const t of uniq) {
        switch (t.kind) {
          case 'meta': await writeMeta(t.paperId!); break;
          case 'annotations': await writeAnnotations(t.paperId!); break;
          case 'notes': await writeNotes(t.paperId!); break;
          case 'qa': await writeQa(t.paperId!); break;
          case 'translations': await writeTranslations(t.paperId!); break;
          case 'digest': await writeDigest(t.paperId!); break;
          case 'flashcards': await writeFlashcards(); break;
          case 'topics': if (t.topicId != null) await writeTopic(t.topicId); break;
          case 'profile': await writeProfile(); break;
          case 'paperDelete': await handlePaperDelete(t.paperId!); break;
          default: { const _exhaustive: never = t.kind; throw new Error(`未知任务类型 ${_exhaustive}`); }
        }
      }
    },
  };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return []; }
}

function sha256OfFile(p: string): string | null {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}
