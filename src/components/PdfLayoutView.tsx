import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BlockRow } from '../store';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 原版式对照视图：PDF 页面为底（版式/图表/分栏 100% 原样），透明文本层可划词，
// 译文以原位胶囊替换显示。跨栏/跨页段落按簇切分，译文按比例在句界分配。
export interface TextBlockBox {
  pid: number;
  page: number;
  x: number; y: number; w: number; h: number;   // scale=1 视口坐标（pt，原点左上）
  textLen: number;                               // 该簇归一化文本长度（译文按比例分配）
  found: boolean;
}

export default function PdfLayoutView({
  paperId, blocks, mode, onMouseUp,
}: {
  paperId: number;
  blocks: BlockRow[];
  mode: 'dual' | 'zh' | 'en';
  onMouseUp?: (e: React.MouseEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [boxes, setBoxes] = useState<TextBlockBox[]>([]);
  const renderedRef = useRef<Set<number>>(new Set());
  const [zhScale, setZhScale] = useState(1);
  const [showZh, setShowZh] = useState(true);

  // 加载 PDF + 全页文本块几何
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setBoxes([]);
    renderedRef.current.clear();
    (async () => {
      try {
        const task = pdfjsLib.getDocument({ url: `local-pdf://p/${paperId}`, useSystemFonts: true });
        const d = await task.promise;
        if (cancelled) { d.destroy(); return; }
        setDoc(d);
        setNumPages(d.numPages);
        const blockNorms = blocks
          .filter(b => b.type !== 'fig')
          .map(b => ({ pid: b.pid, norm: normText(b.en) }))
          .filter(x => x.norm.length >= 6);
        const allBoxes: TextBlockBox[] = [];
        for (let p = 1; p <= Math.min(d.numPages, 60); p++) {
          const page = await d.getPage(p);
          const vp1 = page.getViewport({ scale: 1 });
          const tc = await page.getTextContent();
          allBoxes.push(...clusterTextItems(tc, vp1, p, blockNorms));
        }
        if (!cancelled) setBoxes(allBoxes);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [paperId, blocks]);

  // pid → 各簇的译文切片（按簇原文长度比例，句界对齐）
  const zhParts = useCallback(() => {
    const byPid = new Map<number, TextBlockBox[]>();
    for (const b of boxes) {
      if (!b.pid) continue;
      const arr = byPid.get(b.pid) ?? [];
      arr.push(b);
      byPid.set(b.pid, arr);
    }
    const parts = new Map<number, string[]>();
    const zhByPid = new Map(blocks.map(b => [b.pid, b.zh ?? '']));
    for (const [pid, arr] of byPid) {
      const zh = zhByPid.get(pid) ?? '';
      parts.set(pid, splitZh(zh, arr.map(b => b.textLen)));
    }
    return parts;
  }, [boxes, blocks]);

  // 渲染指定页：canvas 底图 + 透明文本层 + 胶囊层
  const renderPage = useCallback(async (d: PDFDocumentProxy, n: number) => {
    const host = pageRefs.current.get(n);
    if (!host || renderedRef.current.has(n)) return;
    renderedRef.current.add(n);
    try {
      const page = await d.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const renderVp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = renderVp.width;
      canvas.height = renderVp.height;
      canvas.style.width = '100%';
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport: renderVp }).promise;
      const loading = host.querySelector('.pdf-loading');
      if (loading) loading.remove();
      host.appendChild(canvas);
      const hostW = host.getBoundingClientRect().width || renderVp.width / 2;
      const effScale = hostW / vp1.width;
      // 透明文本层（划词）
      const tc = await page.getTextContent();
      const tl = document.createElement('div');
      tl.className = 'plv-textlayer';
      for (const it of tc.items as any[]) {
        if (!it.str || !it.str.trim() || !it.width) continue;
        const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
        const fontH = Math.hypot(tx[2], tx[3]) || 10;
        const sp = document.createElement('span');
        sp.textContent = it.str;
        sp.style.fontSize = `${fontH * effScale}px`;
        sp.style.left = `${tx[4] * effScale}px`;
        sp.style.top = `${(tx[5] - fontH * 0.85) * effScale}px`;
        tl.appendChild(sp);
        // 宽度补偿：让选择高亮贴合原文（append 后才可测量）
        const target = it.width * effScale;
        const measured = sp.getBoundingClientRect().width;
        if (measured > 4 && Math.abs(target - measured) / target > 0.06) {
          sp.style.transformOrigin = '0 0';
          sp.style.transform = `scaleX(${target / measured})`;
        }
      }
      host.appendChild(tl);
      // 译文胶囊层
      const zhLayer = document.createElement('div');
      zhLayer.className = 'plv-zhlayer';
      host.appendChild(zhLayer);
      renderZhCapsules(zhLayer, boxes.filter(b => b.page === n), effScale, zhParts(), showZh && mode !== 'en', zhScale);
    } catch {
      renderedRef.current.delete(n);
    }
  }, [boxes, mode, zhScale, showZh, zhParts]);

  // 懒渲染
  useEffect(() => {
    if (!doc || !numPages) return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const n = Number((en.target as HTMLElement).dataset.page);
        renderPage(doc, n);
      }
    }, { root: containerRef.current, rootMargin: '600px 0px' });
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [doc, numPages, renderPage]);

  // 胶囊显隐/缩放/译文变化 → 只重画胶囊层（canvas 不动）
  useEffect(() => {
    if (!doc) return;
    const parts = zhParts();
    for (const [n, host] of pageRefs.current) {
      const zhLayer = host.querySelector('.plv-zhlayer');
      const canvas = host.querySelector('canvas');
      if (!zhLayer || !canvas) continue;
      doc.getPage(n).then(page => {
        const vp1 = page.getViewport({ scale: 1 });
        const effScale = canvas.getBoundingClientRect().width / vp1.width;
        renderZhCapsules(zhLayer as HTMLElement, boxes.filter(b => b.page === n), effScale, parts, showZh && mode !== 'en', zhScale);
      });
    }
  }, [mode, boxes, zhScale, showZh, doc, zhParts]);

  if (error) {
    return (
      <div className="plv-wrap" ref={containerRef}>
        <div className="pdf-error">
          PDF 未就绪（{error.slice(0, 80)}）。后台下载完成后重开论文即可；或用「对照」文本视图阅读。
        </div>
      </div>
    );
  }

  return (
    <div className="plv-wrap" ref={containerRef} onMouseUp={onMouseUp}>
      <div className="plv-toolbar">
        <span className="plv-count">{numPages ? `${numPages} 页 · 原版式` : '加载中…'}</span>
        <div className="plv-actions">
          <button className={showZh ? 'on' : ''} onClick={() => setShowZh(v => !v)}>{showZh ? '隐藏译文' : '显示译文'}</button>
          <button onClick={() => setZhScale(s => Math.max(0.6, Math.round((s - 0.1) * 10) / 10))}>A-</button>
          <button onClick={() => setZhScale(s => Math.min(1.6, Math.round((s + 0.1) * 10) / 10))}>A+</button>
        </div>
      </div>
      {!doc && <div className="pdf-loading">PDF 加载中…</div>}
      {doc && Array.from({ length: numPages }, (_, i) => (
        <div
          key={i + 1}
          className="pdf-page plv-page"
          data-page={i + 1}
          ref={el => { if (el) pageRefs.current.set(i + 1, el); }}
        >
          <div className="pdf-loading">第 {i + 1} 页</div>
        </div>
      ))}
    </div>
  );
}

// ---------- 文本归一化 + pid 匹配 ----------

function normText(s: string): string {
  return s.replace(/\$\$[^$]*\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ')
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

// 匹配：短块（标题，如 "abstract"）要求簇与块近似等值；长块用双向子串
function matchPid(clusterText: string, blockNorms: { pid: number; norm: string }[]): number {
  const cn = normText(clusterText);
  if (cn.length < 6) return 0;
  const cHead = cn.slice(0, 28);
  for (const b of blockNorms) {
    if (b.norm.length < 14) {
      // 标题：簇文本短且与块同（允许尾部少量多余，如编号）
      if (cn === b.norm) return b.pid;
    } else {
      if (cn.includes(b.norm.slice(0, 28)) || b.norm.includes(cHead)) return b.pid;
    }
  }
  return 0;
}

// ---------- 文本聚类（PDF 用户空间：原点左下）----------

function clusterTextItems(tc: any, vp1: any, page: number, blockNorms: { pid: number; norm: string }[]): TextBlockBox[] {
  const items = (tc.items as any[]).filter(i => i.str && i.str.trim() && i.width > 0);
  if (!items.length) return [];
  const vpW = vp1.width, vpH = vp1.height;
  // 1. 按 baseline 聚行，行内再按水平大间隙切栏（双栏论文左右行同基线）
  const lines: { y: number; items: any[] }[] = [];
  for (const it of items) {
    const y = it.transform[5];
    const hit = lines.find(l => Math.abs(l.y - y) <= 3);
    if (hit) hit.items.push(it); else lines.push({ y, items: [it] });
  }
  type Line = { y: number; items: any[] };
  const splitLines: Line[] = [];
  const colGap = Math.max(12, vpW * 0.03);
  for (const l of lines) {
    const sorted = l.items.slice().sort((a, b) => a.transform[4] - b.transform[4]);
    let seg: any[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (seg.length) {
        const prev = sorted[i - 1];
        const gap = sorted[i].transform[4] - (prev.transform[4] + prev.width);
        if (gap > colGap) { splitLines.push({ y: l.y, items: seg }); seg = []; }
      }
      seg.push(sorted[i]);
    }
    if (seg.length) splitLines.push({ y: l.y, items: seg });
  }
  // 2. 阅读顺序：先左栏后右栏、栏内自上而下（PDF y 向上 → 视觉顶部 y 大）
  const colOf = (l: { items: any[] }) => Math.min(...l.items.map(i => i.transform[4])) < vpW / 2 ? 0 : 1;
  const lines2 = splitLines.slice().sort((a, b) => {
    const ca = colOf(a), cb = colOf(b);
    if (ca !== cb) return ca - cb;
    return b.y - a.y;
  });
  // 3. 纵向间距 > 1.7 行高 / 栏切换 / 回跳（跨栏续段）→ 断段
  type Cluster = { items: any[]; col: number };
  const clusters: Cluster[] = [];
  let cur: Cluster | null = null;
  let prevY: number | null = null;
  for (const l of lines2) {
    const col = colOf(l);
    const lineH = Math.max(8, ...l.items.map(i => i.height ?? 10));
    if (cur && prevY !== null) {
      const gap = prevY - l.y;   // 视觉向下移动量
      if (col !== cur.col || gap > lineH * 1.7 || gap < -lineH * 2) { clusters.push(cur); cur = null; }
    }
    if (!cur) cur = { items: [], col };
    cur.items.push(...l.items);
    prevY = l.y;
  }
  if (cur) clusters.push(cur);
  // 4. 每簇独立成盒（不合并——跨栏/跨页段落按簇分胶囊，译文按比例切分）
  const out: TextBlockBox[] = [];
  for (const c of clusters) {
    const text = c.items.map(i => i.str).join(' ');
    const norm = normText(text);
    if (norm.length < 6) continue;
    const pid = matchPid(text, blockNorms);
    const x = Math.min(...c.items.map(i => i.transform[4]));
    const right = Math.max(...c.items.map(i => i.transform[4] + i.width));
    const pdfTop = Math.max(...c.items.map(i => i.transform[5] + (i.height ?? 10)));
    const pdfBottom = Math.min(...c.items.map(i => i.transform[5]));
    out.push({
      pid, page, textLen: norm.length,
      x, y: vpH - pdfTop, w: right - x, h: Math.max(8, pdfTop - pdfBottom),
      found: pid > 0,
    });
  }
  return out;
}

// ---------- 译文按比例切分（句界对齐）----------

function splitZh(zh: string, parts: number[]): string[] {
  if (parts.length <= 1 || !zh) return parts.length === 1 ? [zh] : [];
  const total = parts.reduce((a, b) => a + b, 0) || 1;
  const ends: number[] = [];
  const re = /[。！？!?；;]|\.\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(zh))) ends.push(m.index + m[0].length);
  if (!ends.length || ends[ends.length - 1] < zh.length) ends.push(zh.length);
  const out: string[] = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i];
    if (i === parts.length - 1) { out.push(zh.slice(start).trim()); break; }
    const target = Math.round(acc / total * zh.length);
    let best = ends.find(e => e >= target && e > start) ?? zh.length;
    out.push(zh.slice(start, best).trim());
    start = best;
  }
  return out;
}

// ---------- 译文胶囊（原位替换）----------

function renderZhCapsules(
  layer: HTMLElement, pageBoxes: TextBlockBox[], effScale: number,
  zhParts: Map<number, string[]>, visible: boolean, zhScale: number,
) {
  layer.innerHTML = '';
  if (!visible) return;
  const partIdx = new Map<number, number>(); // pid → 已渲染簇序号
  for (const box of pageBoxes) {
    if (!box.pid) continue;
    const parts = zhParts.get(box.pid);
    if (!parts?.length) continue;
    const idx = Math.min(partIdx.get(box.pid) ?? 0, parts.length - 1);
    partIdx.set(box.pid, idx + 1);
    const zhPart = parts[idx];
    if (!zhPart) continue;
    const cap = document.createElement('div');
    cap.className = 'plv-zhcap';
    cap.style.left = `${box.x * effScale - 2}px`;
    cap.style.top = `${box.y * effScale - 2}px`;
    cap.style.width = `${box.w * effScale + 4}px`;
    cap.style.minHeight = `${box.h * effScale}px`;
    cap.style.fontSize = `${9.5 * zhScale}px`;
    cap.dataset.pid = String(box.pid);
    cap.innerHTML = escapeZh(zhPart);
    layer.appendChild(cap);
  }
}

function escapeZh(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
