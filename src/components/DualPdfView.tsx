import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import katex from 'katex';
import type { BlockRow } from '../store';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// PDF 阅读视图（豆包式单栏）：一列 PDF 页面，译文原位覆盖原文，
// 顶部「译文 ⇄ 原文」一键切换。划词/高亮/按需翻译/失败退避同前。
export interface TextBlockBox {
  pid: number;
  page: number;
  x: number; y: number; w: number; h: number;
  textLen: number;
  lineH: number;   // 原文行距（PDF 单位）——译文行距跟它走
}

interface PageState {
  canvas: HTMLCanvasElement | null;
  zhLayer: HTMLDivElement | null;
  hlLayer: HTMLDivElement | null;
  pageEl: HTMLDivElement | null;
}

export default function DualPdfView({
  paperId, blocks, onMouseUp,
}: {
  paperId: number;
  blocks: BlockRow[];
  onMouseUp?: (e: React.MouseEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const statesRef = useRef<Map<number, PageState>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [boxes, setBoxes] = useState<TextBlockBox[]>([]);
  const [activePid, setActivePid] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [showZh, setShowZh] = useState(true);
  const [zhScale, setZhScale] = useState(1);
  const [visiblePage, setVisiblePage] = useState(1);
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const renderedRef = useRef<Set<number>>(new Set());

  // 易变引用（effect 只依赖 doc，译文/交互更新不重建渲染管线 → 不闪）
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const activePidRef = useRef(activePid);
  activePidRef.current = activePid;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const showZhRef = useRef(showZh);
  showZhRef.current = showZh;
  const zhScaleRef = useRef(zhScale);
  zhScaleRef.current = zhScale;
  const onMouseUpRef = useRef(onMouseUp);
  onMouseUpRef.current = onMouseUp;
  const requestedTx = useRef<Set<number>>(new Set());
  const txFailCount = useRef<Map<number, number>>(new Map());   // pid → 连续失败次数（指数退避）
  const [txPending, setTxPending] = useState(0);                // 本会话按需翻译在途数
  const txPendingRef = useRef(0);

  // 1) 只在换论文时加载文档（译文更新不再触发重载 → 不闪）
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setBoxes([]); setFailedPages(new Set());
    renderedRef.current.clear();
    hostsRef.current.clear(); statesRef.current.clear();
    requestedTx.current.clear();
    txFailCount.current.clear();
    (async () => {
      try {
        const d = await (pdfjsLib.getDocument({ url: `local-pdf://p/${paperId}`, useSystemFonts: true })).promise;
        if (cancelled) { d.destroy(); return; }
        setDoc(d); setNumPages(d.numPages);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [paperId]);

  // en 文本指纹：en 不变则不重新聚类
  const enKey = useMemo(
    () => blocks.map(b => `${b.pid}.${(b.en ?? '').length}`).join(','),
    [blocks],
  );

  // block 元信息（标题/正文区分排版）
  const blockMeta = useMemo(() => {
    const m = new Map<number, { type: string; level: number }>();
    for (const b of blocks) m.set(b.pid, { type: b.type, level: b.level ?? 9 });
    return m;
  }, [blocks.map(b => b.pid).join(','), enKey]);
  const blockMetaRef = useRef(blockMeta);
  blockMetaRef.current = blockMeta;

  // 2) 文档就绪后聚类 + 匹配
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const blockNorms = blocksRef.current.filter(b => b.type !== 'fig')
        .map(b => ({ pid: b.pid, norm: normText(b.en) })).filter(x => x.norm.length >= 6);
      const all: TextBlockBox[] = [];
      for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
        const page = await doc.getPage(p);
        all.push(...clusterTextItems(await page.getTextContent(), page.getViewport({ scale: 1 }), p, blockNorms));
        if (cancelled) return;
      }
      if (!cancelled) setBoxes(all);
    })();
    return () => { cancelled = true; };
  }, [doc, enKey]);

  // pid → 译文切片（跨栏/跨页按比例句界切分）
  const zhParts = useCallback(() => {
    const byPid = new Map<number, TextBlockBox[]>();
    for (const b of boxesRef.current) {
      if (!b.pid) continue;
      const a = byPid.get(b.pid) ?? []; a.push(b); byPid.set(b.pid, a);
    }
    const out = new Map<number, string[]>();
    const zhByPid = new Map(blocksRef.current.map(b => [b.pid, b.zh ?? '']));
    for (const [pid, arr] of byPid) {
      out.set(pid, splitZh(zhByPid.get(pid) ?? '', arr.map(b => b.textLen)));
    }
    return out;
  }, []);

  // 滚到哪翻到哪 + 失败指数退避（1次→8s 屏蔽，2次→40s，3次+→本会话放弃）
  const translatePageIfNeeded = useCallback((page: number) => {
    const now = Date.now();
    const pageBoxes = boxesRef.current.filter(b => b.page === page && b.pid);
    const zhByPid = new Map(blocksRef.current.map(b => [b.pid, b.zh ?? '']));
    const need = pageBoxes
      .map(b => b.pid)
      .filter(pid => {
        if (zhByPid.get(pid)) return false;
        if (requestedTx.current.has(pid)) return false;
        const fails = txFailCount.current.get(pid) ?? 0;
        if (fails >= 3) return false;
        const bannedUntil = txFailCount.current.get(-pid) ?? 0;
        return now >= bannedUntil;
      });
    if (!need.length) return;
    need.forEach(pid => requestedTx.current.add(pid));
    const items = blocksRef.current.filter(b => need.includes(b.pid)).map(b => ({ pid: b.pid, en: b.en }));
    if (items.length) {
      txPendingRef.current += items.length;
      setTxPending(txPendingRef.current);
      window.api.translateAll({ paperId, blocks: items, scope: 'all' }).catch(() => {
        items.forEach(it => requestedTx.current.delete(it.pid));
        items.forEach(it => {
          const fails = (txFailCount.current.get(it.pid) ?? 0) + 1;
          txFailCount.current.set(it.pid, fails);
          txFailCount.current.set(-it.pid, now + (fails === 1 ? 8000 : fails === 2 ? 40000 : Infinity));
        });
      }).finally(() => {
        txPendingRef.current -= items.length;
        setTxPending(txPendingRef.current);
      });
    }
  }, [paperId]);

  // 渲染单页：canvas + 划词层 + 译文层 + 高亮层（单栏一体）——DPR 高清渲染
  const renderPage = useCallback(async (d: PDFDocumentProxy, n: number) => {
    const host = hostsRef.current.get(n);
    if (!host || renderedRef.current.has(n)) return;
    renderedRef.current.add(n);
    try {
      const page = await d.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const rv = page.getViewport({ scale: 2 * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = rv.width; canvas.height = rv.height;
      canvas.style.width = '100%'; canvas.style.display = 'block';
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: rv }).promise;
      const loading = host.querySelector('.pdf-loading');
      if (loading) loading.remove();
      host.appendChild(canvas);
      const ps: PageState = { canvas, zhLayer: null, hlLayer: null, pageEl: host };
      const pageBoxes = boxesRef.current.filter(b => b.page === n);
      // 译文层（原位覆盖）
      const zhLayer = document.createElement('div');
      zhLayer.className = 'dpv-zhlayer' + (showZhRef.current ? '' : ' hidden');
      host.appendChild(zhLayer);
      ps.zhLayer = zhLayer;
      renderZh(zhLayer, pageBoxes, canvas, vp1, zhParts(), activePidRef.current, collapsedRef.current,
        pid => { setActivePid(pid); }, zhScaleRef.current, showZhRef.current, blockMetaRef.current);
      // 划词层（透明原文，选区可见）
      const tl = document.createElement('div');
      tl.className = 'dpv-textlayer' + (showZhRef.current ? ' under-zh' : '');
      const tc = await page.getTextContent();
      const hostW = host.getBoundingClientRect().width || rv.width / (2 * dpr);
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
      // 高亮层（点击译文段落 → 原文位置示意框；译文模式下显示在译文之上）
      const hlLayer = document.createElement('div');
      hlLayer.className = 'dpv-hllayer';
      host.appendChild(hlLayer);
      ps.hlLayer = hlLayer;
      renderHl(hlLayer, pageBoxes, canvas, vp1, activePidRef.current);
      // 本页可见 → 按需翻译 + 记录可见页
      translatePageIfNeeded(n);
      if (n > 0) setVisiblePage(prev => (Math.abs(prev - n) > 2 ? n : prev));
      // 失败重试：清掉失败标记（渲染成功即恢复）
      setFailedPages(s => { if (!s.has(n)) return s; const x = new Set(s); x.delete(n); return x; });
      statesRef.current.set(n, ps);
    } catch {
      renderedRef.current.delete(n);
      setFailedPages(s => new Set(s).add(n));
    }
  }, [doc, zhParts, translatePageIfNeeded]);

  // 懒渲染（单栏）
  useEffect(() => {
    if (!doc || !numPages) return;
    const hosts = scrollRef.current?.querySelectorAll('[data-page]');
    const io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) renderPage(doc, Number((en.target as HTMLElement).dataset.page));
    }, { root: scrollRef.current, rootMargin: '600px 0px' });
    hosts?.forEach(el => io.observe(el));
    return () => { io.disconnect(); };
  }, [doc, numPages, renderPage]);

  // boxes 聚类完成后：对已渲染页重算胶囊 + 触发按需翻译
  useEffect(() => {
    if (!doc || !boxes.length) return;
    const parts = zhParts();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const [n, ps] of statesRef.current) {
      if (ps.zhLayer && ps.canvas) {
        renderZh(ps.zhLayer, boxes.filter(b => b.page === n), ps.canvas, { width: ps.canvas.width / (2 * dpr) },
          parts, activePid, collapsed, pid => setActivePid(pid), zhScale, showZh, blockMetaRef.current);
      }
      if (ps.canvas) translatePageIfNeeded(n);
    }
  }, [boxes, doc, zhParts, activePid, collapsed, zhScale, showZh, translatePageIfNeeded]);

  // activePid 变化 → 切 class + 重画高亮框（单栏内原位示意，不跨栏滚动）
  useEffect(() => {
    document.querySelectorAll('.dpv-zhcap').forEach(el => {
      el.classList.toggle('active', Number((el as HTMLElement).dataset.pid) === activePid);
    });
    if (!activePid) return;
    for (const [, ps] of statesRef.current) {
      if (ps.hlLayer && ps.canvas) {
        const n = Number(ps.canvas.closest('[data-page]')?.getAttribute('data-page'));
        renderHl(ps.hlLayer, boxesRef.current.filter(b => b.page === n), ps.canvas,
          { width: ps.canvas.width / (2 * Math.min(3, window.devicePixelRatio || 1)) }, activePid);
      }
    }
  }, [activePid, boxes]);

  // 译文/折叠/显隐/字号变化 → 重建胶囊层
  useEffect(() => {
    if (!doc) return;
    const parts = zhParts();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const [n, ps] of statesRef.current) {
      if (ps.zhLayer && ps.canvas) {
        renderZh(ps.zhLayer, boxes.filter(b => b.page === n), ps.canvas, { width: ps.canvas.width / (2 * dpr) },
          parts, activePid, collapsed, pid => setActivePid(pid), zhScale, showZh, blockMetaRef.current);
      }
    }
  }, [boxes, collapsed, doc, zhParts, activePid, zhScale, showZh]);

  // 「展开全文」事件
  // 「展开全文」事件（旧路径，现改为浮层卡片，保留事件兼容）
  useEffect(() => {
    const fn = (e: Event) => {
      const pid = (e as CustomEvent).detail as number;
      setCollapsed(s => new Set(s).add(pid));
    };
    window.addEventListener('dpv-expand', fn);
    return () => window.removeEventListener('dpv-expand', fn);
  }, []);

  // 卸载/切论文时清理浮层
  useEffect(() => () => closeZhPopup(), []);
  // Esc 关浮层
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') closeZhPopup(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  // 译文 ⇄ 原文切换：只切层的显隐，不重渲染 canvas（零闪烁）
  useEffect(() => {
    for (const [, ps] of statesRef.current) {
      if (ps.zhLayer) ps.zhLayer.classList.toggle('hidden', !showZh);
    }
  }, [showZh]);

  if (error) {
    return <div className="dpv-wrap"><div className="pdf-error">PDF 未就绪（{error.slice(0, 80)}）。后台下载完成后重开论文即可。</div></div>;
  }

  return (
    <div className="dpv-wrap">
      <div className="dpv-toolbar">
        <span>{numPages ? `${numPages} 页` : '加载中…'}</span>
        <span className="dpv-page-indicator">第 {visiblePage} 页{txPending > 0 ? ` · 翻译中 ${txPending} 段` : ''}</span>
        <div className="dpv-actions">
          <button className={`dpv-toggle ${showZh ? 'on' : ''}`} onClick={() => setShowZh(v => !v)}>
            {showZh ? '中文' : '英文'}
          </button>
          <button onClick={() => setZhScale(s => Math.max(0.6, Math.round((s - 0.1) * 10) / 10))}>A-</button>
          <button onClick={() => setZhScale(s => Math.min(1.6, Math.round((s + 0.1) * 10) / 10))}>A+</button>
        </div>
      </div>
      <div className="dpv-scroll" ref={scrollRef} onMouseUp={e => onMouseUpRef.current?.(e)}>
        {doc && Array.from({ length: numPages }, (_, i) => (
          <div key={i + 1} className="pdf-page dpv-page" data-page={i + 1} ref={el => { if (el) hostsRef.current.set(i + 1, el); }}>
            <div className="pdf-loading">第 {i + 1} 页</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 文本归一化 + 最佳匹配 ----------

function normText(s: string): string {
  return s.replace(/\$\$[^$]*\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ')
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function matchPid(clusterText: string, blockNorms: { pid: number; norm: string }[]): number {
  const cn = normText(clusterText);
  if (cn.length < 6) return 0;
  let best = 0, bestScore = 0;
  for (const b of blockNorms) {
    if (b.norm.length < 8) continue;
    let score = 0;
    if (b.norm === cn) score = 10000 + b.norm.length;
    else if (cn.length >= 20 && b.norm.includes(cn)) score = 8000 + cn.length * 2;
    else if (b.norm.length >= 20 && cn.includes(b.norm)) score = 9000 + b.norm.length;
    else if (b.norm.startsWith(cn) || cn.startsWith(b.norm)) score = 7000 + Math.min(cn.length, b.norm.length);
    else {
      for (const k of [60, 40, 28, 20, 14]) {
        const bhead = b.norm.slice(0, k);
        if (bhead.length >= 10 && cn.includes(bhead)) { score = 6000 + k * 10; break; }
        const chead = cn.slice(0, k);
        if (chead.length >= 10 && b.norm.includes(chead)) { score = 5000 + k * 10; break; }
      }
    }
    if (score > bestScore) { bestScore = score; best = b.pid; }
  }
  return best;
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
    // 原文行距：取簇内相邻行 y 差的中位数（抗单行异常）
    const ys = [...new Set(c.items.map(i => Math.round(i.transform[5])))].sort((a, b) => b - a);
    let lineH = 0;
    if (ys.length >= 2) {
      const gaps = ys.slice(1).map((y, i) => ys[i] - y).filter(g => g > 2 && g < 40);
      if (gaps.length) lineH = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    }
    if (!lineH) lineH = Math.max(...c.items.map(i => i.height ?? 10));
    const x = Math.min(...c.items.map(i => i.transform[4]));
    const right = Math.max(...c.items.map(i => i.transform[4] + i.width));
    const pdfTop = Math.max(...c.items.map(i => i.transform[5] + (i.height ?? 10)));
    const pdfBottom = Math.min(...c.items.map(i => i.transform[5]));
    out.push({ pid, page, textLen: norm.length, x, y: vpH - pdfTop, w: right - x, h: Math.max(8, pdfTop - pdfBottom), lineH: Math.max(6, lineH) });
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

// 中文正文排版：行距锁原文行距、字号从行高推导、公式 KaTeX、两端对齐、首行缩进
function renderZh(
  layer: HTMLElement, pageBoxes: TextBlockBox[], canvas: HTMLCanvasElement,
  vp1: any, zhParts: Map<number, string[]>, activePid: number, collapsed: Set<number>,
  onActive: (pid: number) => void, zhScale: number, visible: boolean,
  blockMeta: Map<number, { type: string; level: number }>,
) {
  layer.innerHTML = '';
  if (!visible) return;
  const eff = canvas.getBoundingClientRect().width / vp1.width;
  const pageBottom = canvas.getBoundingClientRect().height / eff;
  const idxMap = new Map<number, number>();
  const sorted = pageBoxes.filter(b => b.pid).sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    const box = sorted[i];
    const parts = zhParts.get(box.pid);
    if (!parts) continue;
    const idx = Math.min(idxMap.get(box.pid) ?? 0, parts.length - 1);
    idxMap.set(box.pid, idx + 1);
    const zhPart = parts[idx];
    const meta = blockMeta.get(box.pid);
    const isHeading = meta?.type === 'heading';
    // 排版基础：原文行距（屏幕像素）。多块同 pid（跨栏）共享同一 box 行距
    const srcLineH = box.lineH * eff;
    const baseFs = srcLineH * 0.78;          // 字号 ≈ 行高 78%（正文舒适比例）
    const headFs = srcLineH * 0.92;          // 标题字号更大
    const fs = (isHeading ? Math.max(headFs, baseFs) : baseFs) * zhScale;
    const left = box.x * eff - 3, top = box.y * eff - 3, width = box.w * eff + 6;
    const minH = box.h * eff + 5;
    // 本块可用最大高度：到下一块顶部为止（留 5px 呼吸）
    const nb = sorted[i + 1];
    const nextTop = nb ? nb.y * eff - 5 : pageBottom;
    const maxH = Math.max(minH, nextTop - top);
    if (zhPart === undefined || zhPart === '') {
      // 已匹配未译出：与正文同字号的浅灰占位（不打乱行距节奏）
      const pending = document.createElement('div');
      pending.className = 'dpv-pending';
      pending.style.left = `${left + 2}px`;
      pending.style.top = `${top + 2}px`;
      pending.style.fontSize = `${fs * 0.82}px`;
      pending.style.lineHeight = `${srcLineH}px`;
      pending.textContent = '翻译中…';
      layer.appendChild(pending);
      continue;
    }
    const cap = document.createElement('div');
    const isTitle = isHeading && (meta?.level ?? 9) <= 1;
    cap.className = 'dpv-zhcap' + (isHeading ? ' heading' : '') + (isTitle ? ' center' : '') + (activePid === box.pid ? ' active' : '');
    cap.dataset.pid = String(box.pid);
    cap.style.left = `${left}px`;
    cap.style.top = `${top}px`;
    cap.style.width = `${width}px`;
    cap.style.minHeight = `${minH}px`;
    cap.style.fontSize = `${fs}px`;
    cap.style.lineHeight = `${srcLineH}px`;  // 行距锁原文
    // 中文论文习惯：长正文段首行缩进两字；标题/短行（图注公式）不缩进
    if (!isHeading && zhPart.length >= 40) cap.style.textIndent = `${2 * fs}px`;
    else cap.style.textIndent = '0';
    cap.innerHTML = renderZhRich(zhPart, fs);
    cap.onclick = () => onActive(box.pid);
    layer.appendChild(cap);
    // 自适应：正文过长先压行距（最低 82%），压不动再缩字号（最低 76%），仍溢出才折叠
    let curFs = fs, curLH = srcLineH;
    let guard = 0;
    while (cap.scrollHeight > maxH && guard < 14) {
      if (guard < 6 && curLH > srcLineH * 0.82) {
        curLH *= 0.95; cap.style.lineHeight = `${curLH}px`;
      } else if (curFs > baseFs * 0.76) {
        curFs *= 0.94; cap.style.fontSize = `${curFs}px`;
        cap.style.lineHeight = `${curLH}px`;
      } else break;
      guard++;
    }
    // 用户已点「展开」→ 胶囊保持折叠，点开弹出浮层卡片看全文（不动版面，避免覆盖下方内容）
    if (cap.scrollHeight > maxH) {
      cap.classList.add('collapsed');
      cap.style.maxHeight = `${maxH}px`;
      const more = document.createElement('span');
      more.className = 'dpv-more';
      more.style.fontSize = `${Math.max(9, fs * 0.9)}px`;
      more.textContent = '展开全文';
      // 主点击：激活段落；Ctrl/长文点击：浮层完整阅读
      more.onclick = (ev) => { ev.stopPropagation(); showZhPopup(zhPart, fs, box.pid); };
      cap.appendChild(more);
    }
  }
}

// 展开浮层：屏幕居中卡片，完整译文 + KaTeX，点击遮罩关闭
function showZhPopup(fullZh: string, fs: number, pid: number) {
  closeZhPopup();
  const mask = document.createElement('div');
  mask.className = 'dpv-popup-mask';
  const card = document.createElement('div');
  card.className = 'dpv-popup-card';
  card.innerHTML = renderZhRich(fullZh, fs);
  // 长公式块在浮层里恢复自然高度
  card.querySelectorAll('.katex-display').forEach(el => (el as HTMLElement).style.margin = '0.4em 0');
  const close = document.createElement('button');
  close.className = 'dpv-popup-close';
  close.textContent = '×';
  close.onclick = closeZhPopup;
  card.appendChild(close);
  mask.appendChild(card);
  mask.onclick = e => { if (e.target === mask) closeZhPopup(); };
  document.body.appendChild(mask);
  (window as any).__dpvPopupPid = pid;
}
function closeZhPopup() {
  document.querySelector('.dpv-popup-mask')?.remove();
  delete (window as any).__dpvPopupPid;
}

// 译文富文本：$...$/$$...$$ 用 KaTeX 渲染，其余转义
function renderZhRich(s: string, fs: number): string {
  const parts: { t: string; m: boolean; d: boolean }[] = [];
  let rest = s;
  const blockRe = /\$\$([\s\S]+?)\$\$/;
  const inlineRe = /\$([^$\n]+?)\$/;
  while (rest.length) {
    const mb = rest.match(blockRe);
    const mi = rest.match(inlineRe);
    const bIdx = mb ? rest.indexOf(mb[0]) : -1;
    const iIdx = mi ? rest.indexOf(mi[0]) : -1;
    if (bIdx === -1 && iIdx === -1) { parts.push({ t: rest, m: false, d: false }); break; }
    const useBlock = bIdx !== -1 && (iIdx === -1 || bIdx <= iIdx);
    const m = useBlock ? mb! : mi!;
    const idx = useBlock ? bIdx : iIdx;
    if (idx > 0) parts.push({ t: rest.slice(0, idx), m: false, d: false });
    parts.push({ t: m[1], m: true, d: useBlock });
    rest = rest.slice(idx + m[0].length);
  }
  let html = '';
  for (const p of parts) {
    if (!p.m) { html += escapeZh(p.t); continue; }
    try {
      html += katex.renderToString(p.t, {
        displayMode: p.d, throwOnError: false, strict: false,
        trust: false, output: 'html',
      });
    } catch {
      html += `<code>${escapeZh(p.t)}</code>`;
    }
  }
  return html;
}

function setCollapsedGlobal(pid: number) {
  window.dispatchEvent(new CustomEvent('dpv-expand', { detail: pid }));
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
