// 本地论文库：目录扫描 + PDF 全文解析 + 双向同步（v0.4）
// 身份策略：
//   - 文件名/首页文本能识别出 arXiv ID → 用真实 ID 走 upsert（与 arXiv 导入自动去重，
//     主进程升级循环还能后台换 LaTeXML HTML 结构化块）
//   - 识别不出 → 用内容 sha1 前 12 位合成 ID（local:xxxx），文件改名/移动身份不丢
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as db from './db';
import { normalizeArxivId } from './arxiv';
import type { ParsedBlock } from './arxiv';

export interface LibFile {
  absPath: string;
  relPath: string;   // 相对库根（/ 分隔）
  dir: string;       // 相对文件夹（'' = 根，/ 分隔）
  name: string;      // 文件名（不含 .pdf）
  size: number;
  mtime: string;
  arxivId: string | null;  // 从文件名识别（导入时还会从首页文本再识别一次）
}

export interface ScanItem extends LibFile {
  state: 'new' | 'imported';
  paperId: number | null;
  relinked?: boolean; // 外部移动后扫描时自动重新关联
}

export interface ScanResult {
  dir: string;
  files: ScanItem[];
  missing: Array<{ paperId: number; title: string; filePath: string }>;
  stats: { total: number; newCount: number; imported: number; missing: number };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'release', 'dist', 'dist-electron']);

// ---------- 目录扫描 ----------
export function scanLibrary(root: string): LibFile[] {
  const out: LibFile[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile() && /\.pdf$/i.test(e.name)) {
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { continue; }
        out.push({
          absPath: abs,
          relPath: r,
          dir: rel,
          name: e.name.replace(/\.pdf$/i, ''),
          size: st.size,
          mtime: st.mtime.toISOString(),
          arxivId: normalizeArxivId(e.name),
        });
      }
    }
  };
  walk(root, '');
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// ---------- PDF 全文解析 ----------
export interface ParsedLocalPdf {
  arxivId: string | null;  // 首页文本识别（arXiv 论文首页常有 "arXiv:xxxx.xxxxx" 标记）
  title: string;
  blocks: ParsedBlock[];
  hash: string;            // 内容 sha1 前 12 位
  pageCount: number;
}

let pdfjsReady = false;
async function getPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (!pdfjsReady) {
    // Node 环境无 worker 线程文件可加载：注入 worker 模块（与 pdf:pageMap 同款模式）
    try {
      const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      (globalThis as any).pdfjsWorker = workerMod;
    } catch { /* 部分版本可无 worker 运行 */ }
    pdfjsReady = true;
  }
  return pdfjs;
}

export async function parseLocalPdf(absPath: string, fallbackTitle: string): Promise<ParsedLocalPdf> {
  const buf = fs.readFileSync(absPath);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true,
  }).promise;
  try {
    // 元数据标题（arXiv PDF 通常有）
    let metaTitle = '';
    try {
      const meta: any = await doc.getMetadata();
      const t = String(meta?.info?.Title ?? '').trim();
      if (t.length > 5 && !/^untitled/i.test(t) && !/\.pdf$/i.test(t)) metaTitle = t;
    } catch { /* 无元数据 */ }

    // 逐页抽文本 → 行（pdfjs 文本项带 hasEOL，拼成行）
    const pageLines: string[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const it of tc.items as any[]) {
        if (typeof it.str !== 'string') continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line.trim()) lines.push(line);
      pageLines.push(lines);
    }

    const arxivId = normalizeArxivId(pageLines[0]?.join(' ').slice(0, 8000) ?? '') ?? null;
    const title = pickTitle(pageLines[0] ?? [], metaTitle, fallbackTitle);
    const blocks = pdfToBlocks(pageLines, title);
    return { arxivId, title, blocks, hash, pageCount: doc.numPages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// 标题启发：元数据 → 首页第一行长文本 → 文件名
function pickTitle(page1: string[], metaTitle: string, fallback: string): string {
  let t = metaTitle.trim();
  if (!t) {
    const cands = page1.map(l => l.replace(/\s+/g, ' ').trim())
      .filter(l => l.length >= 12 && !/^\d+$/.test(l) && !/^arxiv:/i.test(l));
    if (cands.length) t = cands[0];
  }
  if (!t) t = fallback.replace(/[_\-]+/g, ' ').trim();
  return t || 'Untitled PDF';
}

// 常见章节标题形态：Abstract / 1 Introduction / 2.1 Setup / References / Appendix A / II. Method
const HEADING_RE = /^(abstract\b|references\b|appendix\b|acknowledg(e?ments?)?\b|chapter\b|conclusion\b|introduction\b|related work\b|\d+(\.\d+)*\.?\s+\S+|[ivx]+\.\s*[A-Z])/i;

// PDF 行流 → 结构化块（剔噪 + 段落重组 + 标题识别）
function pdfToBlocks(pageLines: string[][], title: string): ParsedBlock[] {
  // 1) 规整空白
  const norm = pageLines.map(lines => lines.map(l => l.replace(/\s+/g, ' ').trim()));

  // 2) 首页剔除标题行（避免标题混进正文段）
  const titleNorm = title.toLowerCase();
  const page1 = norm[0]?.filter(l => {
    if (l.length < 8) return true;
    const ln = l.toLowerCase();
    return !(titleNorm.includes(ln) || ln.includes(titleNorm));
  }) ?? [];

  // 3) 剔噪：页码 / arXiv 侧标 / 跨页重复的页眉页脚
  const rawLines = [...page1, ...norm.slice(1).flat()];
  const counts = new Map<string, number>();
  for (const l of rawLines) {
    if (!l || l.length > 80) continue;
    const key = l.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const pages = norm.length;
  const repeatTh = pages >= 4 ? Math.max(3, Math.floor(pages * 0.25)) : Infinity;
  const isNoise = (l: string) =>
    !l ||
    /^\d{1,3}$/.test(l) ||
    /^arxiv:\d{4}\.\d{4,5}/i.test(l) ||
    /^page\s+\d+/i.test(l) ||
    (l.length <= 80 && (counts.get(l.toLowerCase()) ?? 0) >= repeatTh);
  const lines = rawLines.filter(l => !isNoise(l));
  if (!lines.length) return [];

  // 4) 行 → 段落：句末标点 + 行长偏短/下一行是标题 → 断段；连字符换行拼接
  const lens = lines.filter(l => l.length > 20).map(l => l.length);
  const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 70;

  const paras: string[] = [];
  let buf = '';
  const flush = () => { const t = buf.trim(); if (t) paras.push(t); buf = ''; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const nextIsHeading = i + 1 < lines.length && lines[i + 1].length < 90 && HEADING_RE.test(lines[i + 1]);
    if (l.length < 90 && HEADING_RE.test(l) && l.split(/\s+/).length <= 10) {
      // 标题行独立成块
      flush();
      paras.push(l);
      continue;
    }
    buf = buf ? (buf.endsWith('-') ? buf.slice(0, -1) + l : buf + ' ' + l) : l;
    if (/[.!?…:]$/.test(l) && (l.length < avgLen * 0.78 || nextIsHeading)) flush();
  }
  flush();

  // 5) 段落 → 块（heading / para）
  const blocks: ParsedBlock[] = [];
  let seq = 0;
  for (const t of paras) {
    const isHeading = t.length < 90 && HEADING_RE.test(t) && t.split(/\s+/).length <= 10;
    let level = 2;
    const m = t.match(/^(\d+(?:\.\d+)*)\.?\s/);
    if (m) level = Math.min(4, m[1].split('.').length + 1);
    blocks.push({ seq: seq++, type: isHeading ? 'heading' : 'para', level, en: t });
  }
  return blocks;
}

// ---------- 导入（一个文件 → papers/blocks 落库）----------
export async function importLocalPdf(absPath: string): Promise<{
  paperId: number; title: string; arxivId: string; existing: boolean; blockCount: number;
}> {
  const fallback = path.basename(absPath).replace(/\.pdf$/i, '');
  const parsed = await parseLocalPdf(absPath, fallback);
  const arxivId = parsed.arxivId ?? `local:${parsed.hash}`;
  const existing = db.findPaperByArxiv(arxivId);
  if (existing && (existing.block_count ?? 0) > 0) {
    // 已有更优块（arXiv HTML 导入等）——只登记本地文件，不动内容
    db.setPaperFilePath(existing.id, absPath);
    return { paperId: existing.id, title: existing.title || parsed.title, arxivId, existing: true, blockCount: existing.block_count };
  }
  const paperId = db.insertPaper({
    arxivId,
    title: parsed.title,
    authors: '',
    sourceUrl: parsed.arxivId ? `https://arxiv.org/abs/${parsed.arxivId}` : '',
    importType: 'pdf',
  });
  db.setPaperFilePath(paperId, absPath);
  db.insertBlocks(paperId, parsed.blocks);
  return { paperId, title: parsed.title, arxivId, existing: false, blockCount: parsed.blocks.length };
}

// ---------- 扫描 + 双向同步（匹配 / 外部移动重关联 / 缺失报告）----------
export function syncScan(root: string): ScanResult {
  const files = scanLibrary(root);
  const scanned: ScanItem[] = [];
  const matchedPaperIds = new Set<number>();

  const byPath = new Map<string, any>();
  for (const p of db.listLocalPapers() as any[]) byPath.set(p.file_path, p);
  for (const f of files) {
    let paper = byPath.get(f.absPath);
    if (!paper && f.arxivId) paper = db.findPaperByArxiv(f.arxivId);
    if (paper) matchedPaperIds.add(paper.id);
    scanned.push({ ...f, state: paper ? 'imported' : 'new', paperId: paper?.id ?? null });
  }

  // 库里登记的文件不在磁盘上：在扫描树里按同名唯一匹配 → 重新关联（外部移动同步）
  const missing: ScanResult['missing'] = [];
  const newByName = new Map<string, ScanItem[]>();
  for (const s of scanned) if (s.state === 'new') {
    if (!newByName.has(s.name)) newByName.set(s.name, []);
    newByName.get(s.name)!.push(s);
  }
  for (const p of db.listLocalPapers() as any[]) {
    if (matchedPaperIds.has(p.id)) continue;
    if (fs.existsSync(p.file_path)) continue; // 在库外磁盘位置，不算缺失
    const cands = newByName.get(path.basename(p.file_path).replace(/\.pdf$/i, ''));
    if (cands?.length === 1) {
      db.setPaperFilePath(p.id, cands[0].absPath);
      cands[0].state = 'imported';
      cands[0].paperId = p.id;
      cands[0].relinked = true;
      matchedPaperIds.add(p.id);
    } else {
      missing.push({ paperId: p.id, title: p.title, filePath: p.file_path });
    }
  }

  return {
    dir: root,
    files: scanned,
    missing,
    stats: {
      total: scanned.length,
      newCount: scanned.filter(s => s.state === 'new').length,
      imported: scanned.filter(s => s.state === 'imported').length,
      missing: missing.length,
    },
  };
}

// ---------- 应用内整理 → 磁盘真实移动 ----------
export function movePaperFile(paperId: number, root: string, relDir: string, newFolder?: string): {
  filePath: string; relDir: string;
} {
  const paper = db.getPaper(paperId) as any;
  if (!paper?.file_path) throw new Error('该论文没有登记本地文件');
  let rel = cleanRelDir(relDir);
  if (newFolder) {
    const nf = newFolder.replace(/[\\/:*?"<>|]/g, '').trim();
    if (!nf) throw new Error('文件夹名无效');
    rel = path.join(rel, nf);
  }
  const targetDir = path.join(root, rel);
  fs.mkdirSync(targetDir, { recursive: true });
  const dest = path.join(targetDir, path.basename(paper.file_path));
  if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(paper.file_path)) {
    throw new Error('目标位置已有同名文件');
  }
  fs.renameSync(paper.file_path, dest);
  db.setPaperFilePath(paperId, dest);
  return { filePath: dest, relDir: rel.split(path.sep).join('/') };
}

// 相对目录清洗（openDir / moveFile 共用）
export function cleanRelDir(relDir: string): string {
  return relDir.split('/').filter(s => s && s !== '.' && !s.startsWith('..')).join('/');
}
