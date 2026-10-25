import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BlockRow } from '../store';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 双页联动视图（对标豆包）：左原文 PDF，右同版式译文页（PDF 底 + 译文原位替换）。
// 双向同步滚动 + 段落点击联动高亮 + 原文划词。
export interface TextBlockBox {
  pid: number;
  page: number;
  x: number; y: number; w: number; h: number;
  textLen: number;
}

interface PageState {
  canvas: HTMLCanvasElement | null;
  zhLayer: HTMLDivElement | null;
}

export default function DualPdfView({
  paperId, blocks, onMouseUp, onAskPid,
}: {
  paperId: number;
  blocks: BlockRow[];
  onMouseUp?: (e: React.MouseEvent) => void;
  onAskPid?: (pid: number) => void;
}) {
  const leftRef = useRef<HTMLDivElement>(null);    // 原文滚动容器
  const rightRef = useRef<HTMLDivElement>(null);   // 译文滚动容器
  const leftHosts = useRef<Map<number, HTMLDivElement>>(new Map());
  const rightHosts = useRef<Map<number, HTMLDivElement>>(new Map());
  const leftStates = useRef<Map<number, PageState>>(new Map());
  const rightStates = useRef<Map<number, PageState>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [boxes, setBoxes] = useState<TextBlockBox[]>([]);
  const [activePid, setActivePid] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const renderedL = useRef<Set<number>>(new Set());
  const renderedR = useRef<Set<number>>(new Set());
  // 滚动同步：锁防止回环（A 滚 → 触发 B 滚 → 又触发 A）
  const syncLock = useRef<'none' | 'L' | 'R'>('none');

  // 加载 PDF + 文本块几何
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setBoxes([]);
    renderedL.current.clear(); renderedR.current.clear();
    leftHosts.current.clear(); rightHosts.current.clear();
    leftStates.current.clear(); rightStates.current.clear();
    (async () => {
      try {
        const d = await (pdfjsLib.getDocument({ url: `local-pdf://p/${paperId}`, useSystemFonts: true })).promise;
        if (cancelled) { d.destroy(); return; }
        setDoc(d); setNumPages(d.numPages);
        const blockNorms = blocks.filter(b => b.type !== 'fig')
          .map(b => ({ pid: b.pid, norm: normText(b.en) })).filter(x => x.norm.length >= 6);
        const all: TextBlockBox[] = [];
        for (let p = 1; p <= Math.min(d.numPages, 60); p++) {
          const page = await d.getPage(p);
          all.push(...clusterTextItems(await page.getTextContent(), page.getViewport({ scale: 1 }), p, blockNorms));
        }
        if (!cancelled) setBoxes(all);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [paperId, blocks]);

  // pid → 译文切片（跨栏按比例句界切分）
  const zhParts = useCallback(() => {
    const byPid = new Map<number, TextBlockBox[]>();
    for (const b of boxes) {
      if (!b.pid) continue;
      const a = byPid.get(b.pid) ?? []; a.push(b); byPid.set(b.pid, a);
    }
    const out = new Map<number, string[]>();
    const zhByPid = new Map(blocks.map(b => [b.pid, b.zh ?? '']));
    for (const [pid, arr] of byPid) {
      out.set(pid, splitZh(zhByPid.get(pid) ?? '', arr.map(b => b.textLen)));
    }
    return out;
  }, [boxes, blocks]);

  // 渲染单页（side: 'en' 左 | 'zh' 右）
  const renderSide = useCallback(async (d: PDFDocumentProxy, n: number, side: 'en' | 'zh') => {
    const hosts = side === 'en' ? leftHosts : rightHosts;
    const states = side === 'en' ? leftStates : rightStates;
    const renderedRef = side === 'en' ? renderedL : renderedR;
    const host = hosts.current.get(n);
    if (!host || renderedRef.current.has(n)) return;
    renderedRef.current.add(n);
    try {
      const page = await d.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const rv = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = rv.width; canvas.height = rv.height;
      canvas.style.width = '100%'; canvas.style.display = 'block';
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: rv }).promise;
      const loading = host.querySelector('.pdf-loading');
      if (loading) loading.remove();
      host.appendChild(canvas);
      const ps: PageState = { canvas, zhLayer: null };
      if (side === 'zh') {
        // 右侧：译文覆盖层 + 可选原文淡层（用于对照定位）
        const zhLayer = document.createElement('div');
        zhLayer.className = 'dpv-zhlayer';
        host.appendChild(zhLayer);
        ps.zhLayer = zhLayer;
        renderZh(zhLayer, boxes.filter(b => b.page === n), canvas, vp1, zhParts(), activePid, collapsed,
          pid => { setActivePid(pid); onAskPid?.(pid); },
          pid => setCollapsed(s => new Set(s).add(pid)));
      } else {
        // 左侧：透明划词文本层 + 联动高亮框层
        const tl = document.createElement('div');
        tl.className = 'dpv-textlayer';
        const tc = await page.getTextContent();
        const hostW = host.getBoundingClientRect().width || rv.width / 2;
        const eff = hostW / vp1.width;
        for (const it of tc.items as any[]) {
          if (!it.str || !it.str.trim() || !it.width) continue;
          const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
          const fh = Math.hypot(tx[2], tx[3]) || 10;
          const sp = document.createElement('span');
          sp.textContent = it.str;
          sp.style.fontSize = `${fh * eff}px`;
          sp.style.left = `${tx[4] * eff}px`;
          sp.style.top = `${(tx[5] - fh * 0.85) * eff}px`;
          tl.appendChild(sp);
          const target = it.width * eff, measured = sp.getBoundingClientRect().width;
          if (measured > 4 && Math.abs(target - measured) / target > 0.06) {
            sp.style.transformOrigin = '0 0';
            sp.style.transform = `scaleX(${target / measured})`;
          }
        }
        host.appendChild(tl);
        const hlLayer = document.createElement('div');
        hlLayer.className = 'dpv-hllayer';
        host.appendChild(hlLayer);
        renderHl(hlLayer, boxes.filter(b => b.page === n), canvas, vp1, activePid);
      }
      states.current.set(n, ps);
    } catch { renderedRef.current.delete(n); }
  }, [boxes, zhParts, activePid, collapsed, onAskPid]);

  // 懒渲染（左右各自观察）
  useEffect(() => {
    if (!doc || !numPages) return;
    const hostsL = leftRef.current?.querySelectorAll('[data-page]');
    const hostsR = rightRef.current?.querySelectorAll('[data-page]');
    const ioL = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) renderSide(doc, Number((en.target as HTMLElement).dataset.page), 'en');
    }, { root: leftRef.current, rootMargin: '600px 0px' });
    hostsL?.forEach(el => ioL.observe(el));
    const ioR = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) renderSide(doc, Number((en.target as HTMLElement).dataset.page), 'zh');
    }, { root: rightRef.current, rootMargin: '600px 0px' });
    hostsR?.forEach(el => ioR.observe(el));
    return () => { ioL.disconnect(); ioR.disconnect(); };
  }, [doc, numPages, renderSide]);

  // 滚动同步（百分比联动）
  const syncFrom = (src: 'L' | 'R') => {
    if (syncLock.current !== 'none') return;
    syncLock.current = src;
    const a = src === 'L' ? leftRef.current : rightRef.current;
    const b = src === 'L' ? rightRef.current : leftRef.current;
    if (a && b) {
      const ratio = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
      b.scrollTop = ratio * (b.scrollHeight - b.clientHeight);
    }
    requestAnimationFrame(() => { syncLock.current = 'none'; });
  };

  // activePid/折叠 变化 → 重画两侧联动层
  useEffect(() => {
    if (!doc) return;
    const parts = zhParts();
    for (const [n, ps] of leftStates.current) {
      const hl = (ps.canvas?.parentElement as HTMLElement)?.querySelector('.dpv-hllayer') as HTMLElement | null;
      if (hl && ps.canvas) {
        const vp1 = { width: ps.canvas.width / 2 };
        renderHl(hl, boxes.filter(b => b.page === n), ps.canvas, vp1 as any, activePid);
      }
    }
    for (const [n, ps] of rightStates.current) {
      if (ps.zhLayer && ps.canvas) {
        doc.getPage(n).then(pg => {
          const v1 = pg.getViewport({ scale: 1 });
          renderZh(ps.zhLayer!, boxes.filter(b => b.page === n), ps.canvas!, v1, parts, activePid, collapsed,
            pid => { setActivePid(pid); onAskPid?.(pid); },
            pid => setCollapsed(s => new Set(s).add(pid)));
        });
      }
    }
  }, [activePid, boxes, collapsed, doc, zhParts, onAskPid]);

  if (error) {
    return <div className="dpv-wrap"><div className="pdf-error">PDF 未就绪（{error.slice(0, 80)}）。后台下载完成后重开论文即可。</div></div>;
  }

  return (
    <div className="dpv-wrap">
      <div className="dpv-toolbar">
        <span>{numPages ? `${numPages} 页 · 原文/译文对照` : '加载中…'}</span>
        <span className="dpv-hint">点击译文段落可定位原文 · 左右同步滚动</span>
      </div>
      <div className="dpv-body">
        <div className="dpv-pane" ref={leftRef} onScroll={() => syncFrom('L')} onMouseUp={onMouseUp}>
          {doc && Array.from({ length: numPages }, (_, i) => (
            <div key={i + 1} className="pdf-page dpv-page" data-page={i + 1} ref={el => { if (el) leftHosts.current.set(i + 1, el); }}>
              <div className="pdf-loading">第 {i + 1} 页</div>
            </div>
          ))}
        </div>
        <div className="dpv-divider" />
        <div className="dpv-pane" ref={rightRef} onScroll={() => syncFrom('R')}>
          {doc && Array.from({ length: numPages }, (_, i) => (
            <div key={i + 1} className="pdf-page dpv-page" data-page={i + 1} ref={el => { if (el) rightHosts.current.set(i + 1, el); }}>
              <div className="pdf-loading">第 {i + 1} 页</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 与 PdfLayoutView 相同的聚类/匹配/切分逻辑 ----------

function normText(s: string): string {
  return s.replace(/\$\$[^$]*\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ')
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function matchPid(clusterText: string, blockNorms: { pid: number; norm: string }[]): number {
  const cn = normText(clusterText);
  if (cn.length < 6) return 0;
  const cHead = cn.slice(0, 28);
  for (const b of blockNorms) {
    if (b.norm.length < 14) {
      if (cn === b.norm) return b.pid;
    } else {
      if (cn.includes(b.norm.slice(0, 28)) || b.norm.includes(cHead)) return b.pid;
    }
  }
  return 0;
}

function clusterTextItems(tc: any, vp1: any, page: number, blockNorms: { pid: number; norm: string }[]): TextBlockBox[] {
  const items = (tc.items as any[]).filter(i => i.str && i.str.trim() && i.width > 0);
  if (!items.length) return [];
  const vpW = vp1.width, vpH = vp1.height;
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
        if (sorted[i].transform[4] - (prev.transform[4] + prev.width) > colGap) {
          splitLines.push({ y: l.y, items: seg }); seg = [];
        }
      }
      seg.push(sorted[i]);
    }
    if (seg.length) splitLines.push({ y: l.y, items: seg });
  }
  const colOf = (l: { items: any[] }) => Math.min(...l.items.map(i => i.transform[4])) < vpW / 2 ? 0 : 1;
  const lines2 = splitLines.slice().sort((a, b) => {
    const ca = colOf(a), cb = colOf(b);
    if (ca !== cb) return ca - cb;
    return b.y - a.y;
  });
  type Cluster = { items: any[]; col: number };
  const clusters: Cluster[] = [];
  let cur: Cluster | null = null, prevY: number | null = null;
  for (const l of lines2) {
    const col = colOf(l);
    const lineH = Math.max(8, ...l.items.map(i => i.height ?? 10));
    if (cur && prevY !== null) {
      const gap = prevY - l.y;
      if (col !== cur.col || gap > lineH * 1.7 || gap < -lineH * 2) { clusters.push(cur); cur = null; }
    }
    if (!cur) cur = { items: [], col };
    cur.items.push(...l.items);
    prevY = l.y;
  }
  if (cur) clusters.push(cur);
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
    out.push({ pid, page, textLen: norm.length, x, y: vpH - pdfTop, w: right - x, h: Math.max(8, pdfTop - pdfBottom) });
  }
  return out;
}

function splitZh(zh: string, parts: number[]): string[] {
  if (parts.length <= 1 || !zh) return parts.length === 1 ? [zh] : [];
  const total = parts.reduce((a, b) => a + b, 0) || 1;
  const ends: number[] = [];
  const re = /[。！？!?；;]|\.\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(zh))) ends.push(m.index + m[0].length);
  if (!ends.length || ends[ends.length - 1] < zh.length) ends.push(zh.length);
  const out: string[] = [];
  let start = 0, acc = 0;
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i];
    if (i === parts.length - 1) { out.push(zh.slice(start).trim()); break; }
    const target = Math.round(acc / total * zh.length);
    const best = ends.find(e => e >= target && e > start) ?? zh.length;
    out.push(zh.slice(start, best).trim());
    start = best;
  }
  return out;
}

// ---------- 渲染 ----------

function renderZh(
  layer: HTMLElement, pageBoxes: TextBlockBox[], canvas: HTMLCanvasElement,
  vp1: any, zhParts: Map<number, string[]>, activePid: number, collapsed: Set<number>,
  onActive: (pid: number) => void, onExpand: (pid: number) => void,
) {
  layer.innerHTML = '';
  const eff = canvas.getBoundingClientRect().width / vp1.width;
  const idxMap = new Map<number, number>();
  for (const box of pageBoxes) {
    if (!box.pid) continue;
    const parts = zhParts.get(box.pid);
    if (!parts?.length) continue;
    const idx = Math.min(idxMap.get(box.pid) ?? 0, parts.length - 1);
    idxMap.set(box.pid, idx + 1);
    const zhPart = parts[idx];
    if (!zhPart) continue;
    const cap = document.createElement('div');
    const isLong = zhPart.length > 420;
    const isCollapsed = isLong && !collapsed.has(box.pid);
    cap.className = 'dpv-zhcap' + (activePid === box.pid ? ' active' : '') + (isCollapsed ? ' collapsed' : '');
    cap.style.left = `${box.x * eff - 2}px`;
    cap.style.top = `${box.y * eff - 2}px`;
    cap.style.width = `${box.w * eff + 4}px`;
    cap.style.minHeight = `${box.h * eff}px`;
    cap.innerHTML = escapeZh(zhPart);
    cap.onclick = () => onActive(box.pid);
    if (isCollapsed) {
      const more = document.createElement('div');
      more.className = 'dpv-more';
      more.textContent = '展开全文';
      more.onclick = (ev) => { ev.stopPropagation(); onExpand(box.pid); };
      cap.appendChild(more);
    }
    layer.appendChild(cap);
  }
}

function renderHl(layer: HTMLElement, pageBoxes: TextBlockBox[], canvas: HTMLCanvasElement, vp1: any, activePid: number) {
  layer.innerHTML = '';
  const eff = canvas.getBoundingClientRect().width / vp1.width;
  for (const box of pageBoxes) {
    if (box.pid !== activePid) continue;
    const el = document.createElement('div');
    el.className = 'dpv-hlbox';
    el.style.left = `${box.x * eff - 4}px`;
    el.style.top = `${box.y * eff - 4}px`;
    el.style.width = `${box.w * eff + 8}px`;
    el.style.height = `${box.h * eff + 8}px`;
    layer.appendChild(el);
  }
}

function escapeZh(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
