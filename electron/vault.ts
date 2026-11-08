// vault.ts：vault 文件格式的序列化/解析（唯一权威实现，P4 Web 端对齐此契约）。
// 契约见 docs/superpowers/plans/2026-11-08-vault-storage-p1-p2.md「格式契约」节。
// 原则：文件人类可读、机器可精确 round-trip；写入原子（tmp+rename）。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';

// ---------- key / slug / hash ----------

export function sanitizeKeyPart(s: string): string {
  return s.replace(/[/:\\]/g, '-');
}

export function paperKeyFor(p: { arxiv_id: string | null; created_at: string }): string {
  const year = (p.created_at ?? '').slice(0, 4) || '0000';
  if (p.arxiv_id) return `${year}-${sanitizeKeyPart(p.arxiv_id)}`;
  // 本地导入无 arxiv_id：created_at 做确定性哈希（同一论文重迁移 key 稳定）
  const h = crypto.createHash('sha1').update(p.created_at ?? '').digest('hex').slice(0, 12);
  return `${year}-local-${h}`;
}

export function slugFor(name: string): string {
  return (name ?? '').trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '') || 'topic';
}

export function srcHash(en: string): string {
  const norm = (en ?? '').replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

// ---------- 布局 ----------

const AGENTS_MD = `# Paper Reader Vault

这是论文阅读的知识库（事实源）。App 的 SQLite 只是可重建索引。

## 目录

- papers/&lt;year&gt;-&lt;arxivId&gt;/：每篇论文一个文件夹
  - paper.pdf / paper-dual.pdf / paper-mono.pdf：原始与翻译产物
  - meta.yaml：题录/状态/标签/进度（App 管辖区）
  - annotations.json：划线（文本 + 坐标，含 sid/legacy_id）
  - notes.md：段落锚定笔记（&lt;!-- note ... --&gt; 定界，正文区人类可编辑）
  - qa.jsonl：问答（追加式）
  - translations.jsonl：译文（src_hash 锚定，自带原文）
  - digest.md：精炼笔记（含 【H12】【N3】【Q5】 引用令牌）
- topics/：主题图谱 + 主题精炼
- glossary/terms.yaml：术语表
- flashcards.jsonl / profile.md：闪卡与画像

## 外部编辑规则

1. frontmatter/HTML 注释定界行/JSON 字段（sid、legacy_id、seq 锚）是 App 管辖区，请勿改动
2. notes.md 定界行之间的正文可自由编辑，App 写前会重读并不覆盖你的修改区语义
3. 删除行 = 删除该条目（rebuild 时以文件为准）

同步：本目录即 git 仓库，远端由用户配置。
`;

const GITIGNORE = `.paper-reader/
trash/
*.conflict.*
`;

export function ensureLayout(vaultDir: string): void {
  fs.mkdirSync(path.join(vaultDir, 'papers'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'topics'), { recursive: true });
  const agents = path.join(vaultDir, 'AGENTS.md');
  if (!fs.existsSync(agents)) fs.writeFileSync(agents, AGENTS_MD);
  const gi = path.join(vaultDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE);
}

export function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.tmp-${path.basename(filePath)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------- meta.yaml ----------

export function serializeMeta(
  p: any,
  extra: { readPct: number; sha256?: string; hasDual?: boolean; hasMono?: boolean; summary?: any },
): string {
  const tags = (() => {
    if (Array.isArray(p.tags)) return p.tags;
    if (typeof p.tags === 'string' && p.tags.trim()) { try { return JSON.parse(p.tags); } catch { return []; } }
    return [];
  })();
  const obj: any = {
    version: 1,
    legacy_id: p.id,
    arxiv_id: p.arxiv_id ?? null,
    title: p.title ?? '',
    authors: p.authors ?? '',
    source_url: p.source_url ?? '',
    import_type: p.import_type ?? 'html',
    status: p.status ?? 'unread',
    tags,
    created_at: p.created_at ?? '',
    read_pct: extra.readPct ?? 0,
    sha256: extra.sha256 ?? '',
    pdf: {
      ...(extra.hasDual ? { dual: 'paper-dual.pdf' } : {}),
      ...(extra.hasMono ? { mono: 'paper-mono.pdf' } : {}),
    },
    ...(extra.summary ? { summary: extra.summary } : {}),
  };
  return YAML.stringify(obj);
}

export function parseMeta(text: string): any {
  return YAML.parse(text);
}

// ---------- annotations.json ----------

export function serializeAnnotations(items: any[]): string {
  return JSON.stringify({ version: 1, items }, null, 2) + '\n';
}

export function parseAnnotations(text: string): any[] {
  if (!text.trim()) return [];
  try {
    const obj = JSON.parse(text);
    return Array.isArray(obj?.items) ? obj.items : [];
  } catch {
    return [];
  }
}

// ---------- notes.md ----------
// 定界行：<!-- note sid=n1 legacy=5 seq=7 created=... updated=... -->
// seq 为空表示整篇笔记。定界行之间为正文（人类可编辑区）。

const NOTE_RE = /^<!--\s*note\s+sid=(\S+)\s+legacy=(\d+)\s+seq=(\S*)\s+created=(.+?)\s+updated=(.+?)\s*-->$/;

export function serializeNotes(rows: any[]): string {
  const parts: string[] = [];
  for (const n of rows) {
    const head = `<!-- note sid=${n.sid} legacy=${n.legacy_id} seq=${n.pid ?? ''} created=${n.created_at} updated=${n.updated_at} -->`;
    parts.push(`${head}\n${n.text ?? ''}`);
  }
  return parts.join('\n\n') + (parts.length ? '\n' : '');
}

export function parseNotes(text: string): any[] {
  if (!text.trim()) return [];
  const out: any[] = [];
  const lines = text.split('\n');
  let cur: any = null;
  const body: string[] = [];
  const flush = () => {
    if (cur) {
      // 去掉分段之间的一个空行（serializeNotes 用 \n\n 连接）
      cur.text = body.join('\n').replace(/\n+$/, '');
      out.push(cur);
    }
    cur = null;
    body.length = 0;
  };
  let inBody = false;
  for (const line of lines) {
    const m = line.trim().match(NOTE_RE);
    if (m) {
      flush();
      cur = {
        sid: m[1],
        legacy_id: Number(m[2]),
        seq: m[3] === '' ? null : Number(m[3]),
        created_at: m[4],
        updated_at: m[5],
        text: '',
      };
      inBody = true;
    } else if (inBody && cur) {
      body.push(line);
    }
  }
  flush();
  return out;
}

// ---------- qa.jsonl ----------

export function serializeQa(rows: any[]): string {
  return rows.map(r => JSON.stringify({
    sid: r.sid, legacy_id: r.legacy_id, seq: r.pid ?? null,
    question: r.question, answer: r.answer ?? '',
    provider: r.provider ?? '', model: r.model ?? '', created_at: r.created_at,
  })).join('\n') + (rows.length ? '\n' : '');
}

export function parseQa(text: string): any[] {
  return parseJsonl(text);
}

// ---------- translations.jsonl ----------

export function serializeTranslations(rows: Array<{ seq: number; en: string; zh: string; provider: string; model: string; updated_at: string }>): string {
  return rows.map(r => JSON.stringify({
    seq: r.seq, src_hash: srcHash(r.en), en: r.en, zh: r.zh,
    provider: r.provider ?? '', model: r.model ?? '', updated_at: r.updated_at,
  })).join('\n') + (rows.length ? '\n' : '');
}

export function parseTranslations(text: string): any[] {
  return parseJsonl(text);
}

// ---------- digest.md ----------

const DIGEST_HEAD_RE = /^<!--\s*digest\s+kind=(\S+)\s+updated=(.+?)\s*-->$/;

export function serializeDigest(body: string, updatedAt: string): string {
  return `<!-- digest kind=paper updated=${updatedAt} -->\n${body}\n`;
}

export function parseDigest(text: string): { body: string; updated_at: string } | null {
  if (!text.trim()) return null;
  const lines = text.split('\n');
  const m = lines[0].trim().match(DIGEST_HEAD_RE);
  if (!m) return { body: text, updated_at: '' };
  return { body: lines.slice(1).join('\n').replace(/\n+$/, ''), updated_at: m[2] };
}

// ---------- flashcards.jsonl ----------

export function serializeFlashcards(rows: any[]): string {
  return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function parseFlashcards(text: string): any[] {
  return parseJsonl(text);
}

// ---------- topics/<slug>.json ----------

export function serializeTopic(t: any, papers: any[], edges: any[]): string {
  return JSON.stringify({
    version: 1,
    legacy_id: t.legacy_id ?? t.id, name: t.name, query: t.query ?? '', status: t.status ?? 'ready',
    node_count: t.node_count ?? papers.length, edge_count: t.edge_count ?? edges.length,
    note: t.note ?? '', created_at: t.created_at, updated_at: t.updated_at,
    papers: papers.map(p => ({
      arxiv_id: p.arxiv_id, title: p.title, year: p.year ?? null,
      citation_count: p.citation_count ?? 0, layer: p.layer ?? 'node',
      in_degree: p.in_degree ?? 0, out_degree: p.out_degree ?? 0,
      read_order: p.read_order ?? null, imported: p.imported ? 1 : 0,
    })),
    edges: edges.map(e => ({ src: e.src, dst: e.dst })),
  }, null, 2) + '\n';
}

export function parseTopic(text: string): any {
  return JSON.parse(text);
}

// ---------- profile.md ----------

const PROFILE_BG_RE = /^<!--\s*profile\s+kind=bg\s+updated=(.+?)\s*-->$/;
const PROFILE_SIG_RE = /^<!--\s*profile\s+kind=signals\s+updated=(.+?)\s*-->$/;

export function serializeProfile(bg: string, signals: Record<string, number>, updatedAt: string): string {
  const sig = Object.entries(signals ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `<!-- profile kind=bg updated=${updatedAt} -->\n${bg ?? ''}\n\n<!-- profile kind=signals updated=${updatedAt} -->\n${sig}\n`;
}

export function parseProfile(text: string): { bg: string; signals: Record<string, number> } {
  const lines = (text ?? '').split('\n');
  let bg: string[] = [];
  const signals: Record<string, number> = {};
  let mode: 'none' | 'bg' | 'signals' = 'none';
  for (const line of lines) {
    if (PROFILE_BG_RE.test(line.trim())) { mode = 'bg'; continue; }
    if (PROFILE_SIG_RE.test(line.trim())) { mode = 'signals'; continue; }
    if (mode === 'bg') bg.push(line);
    else if (mode === 'signals') {
      const m = line.match(/^(\S+):\s*(\d+)$/);
      if (m) signals[m[1]] = Number(m[2]);
    }
  }
  return { bg: bg.join('\n').replace(/\n+$/, ''), signals };
}

// ---------- 公共 ----------

function parseJsonl(text: string): any[] {
  if (!text.trim()) return [];
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
  }
  return out;
}
