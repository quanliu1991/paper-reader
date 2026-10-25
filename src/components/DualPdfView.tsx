import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BlockRow } from '../store';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 双页联动视图（对标豆包）：左原文 PDF，右同版式译文页。
// 双向同步滚动 + 段落点击联动高亮 + 原文划词 + 滚到哪翻到哪。
export interface TextBlockBox {
  pid: number;
  page: number;
  x: number; y: number; w: number; h: number;
  textLen: number;
}

interface PageState {
  canvas: HTMLCanvasElement | null;
  zhLayer: HTMLDivElement | null;
  hlLayer: HTMLDivElement | null;
}

const COLLAPSE_LEN = 420;

export default function DualPdfView({
  paperId, blocks, onMouseUp,
}: {
  paperId: number;
  blocks: BlockRow[];
  onMouseUp?: (e: React.MouseEvent) => void;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
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
  const syncLockUntil = useRef(0);

  // 易变引用（避免 effect 因回调/译文更新反复重建）
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const activePidRef = useRef(activePid);
  activePidRef.current = activePid;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const onMouseUpRef = useRef(onMouseUp);
  onMouseUpRef.current = onMouseUp;
  // 已发起翻译的 pid（避免重复请求）
  const requestedTx = useRef<Set<number>>(new Set());

  // 1) 只在换论文时加载文档（译文更新不再触发重载 → 修闪烁）
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setBoxes([]);
    renderedL.current.clear(); renderedR.current.clear();
    leftHosts.current.clear(); rightHosts.current.clear();
    leftStates.current.clear(); rightStates.current.clear();
    requestedTx.current.clear();
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

  // en 文本指纹（长度+pid）——en 不变则不重新聚类（翻译中 zh 更新不会走到这）
  const enKey = useMemo(
    () => blocks.map(b => `${b.pid}.${(b.en ?? '').length}`).join(','),
    [blocks],
  );

  // 2) 文档就绪后聚类 + 匹配（依赖 enKey 而非 blocks）
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const blockNorms = blocksRef.current.filter(b => b.type !== 'fig')
        .map(b => ({ pid: b.pid, norm: normText(b.en) })).filter(x => x.norm.length >= 6);
      const all: TextBlockBox[] = [];
      for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
        const page = await doc.getPage(p);
        const boxes = clusterTextItems(await page.getTextContent(), page.getViewport({ scale: 1 }), p, blockNorms);
        all.push(...boxes);
        if (cancelled) return;
      }
      if (!cancelled) setBoxes(all);
    })();
    return () => { cancelled = true; };
  }, [doc, enKey]);

  // pid → 译文切片
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

  // 滚到哪翻到哪：页面渲染后，对无译文且未请求过的 pid 发起翻译
  const translatePageIfNeeded = useCallback((page: number) => {
    const pageBoxes = boxesRef.current.filter(b => b.page === page && b.pid);
    const zhByPid = new Map(blocksRef.current.map(b => [b.pid, b.zh ?? '']));
    const need = pageBoxes
      .map(b => b.pid)
      .filter(pid => !(zhByPid.get(pid) ?? '') && !requestedTx.current.has(pid));
    if (!need.length) return;
    need.forEach(pid => requestedTx.current.add(pid));
    const items = blocksRef.current.filter(b => need.includes(b.pid)).map(b => ({ pid: b.pid, en: b.en }));
    if (items.length) {
      window.api.translateAll({ paperId, blocks: items, scope: 'all' }).catch(() => {
        need.forEach(pid => requestedTx.current.delete(pid));
      });
    }
  }, [paperId]);

  // 渲染单页（side: 'en' 左 | 'zh' 右）——引用全走 ref，依赖只有 doc
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
      const ps: PageState = { canvas, zhLayer: null, hlLayer: null };
      const pageBoxes = boxesRef.current.filter(b => b.page === n);
      if (side === 'zh') {
        const zhLayer = document.createElement('div');
        zhLayer.className = 'dpv-zhlayer';
        host.appendChild(zhLayer);
        ps.zhLayer = zhLayer;
        renderZh(zhLayer, pageBoxes, canvas, vp1, zhParts(), activePidRef.current, collapsedRef.current,
          pid => { setActivePid(pid); });
      } else {
        // 透明划词层
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
        ps.hlLayer = hlLayer;
        renderHl(hlLayer, pageBoxes, canvas, vp1, activePidRef.current);
        // 本页可见 → 触发按需翻译
        translatePageIfNeeded(n);
      }
      states.current.set(n, ps);
    } catch { renderedRef.current.delete(n); }
  }, [doc, zhParts, translatePageIfNeeded]);

  // 懒渲染（renderSide 稳定 → IO 只建一次）
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

  // 3) activePid 变化 → 只切 class（不重建 DOM → 无闪烁）
  useEffect(() => {
    document.querySelectorAll('.dpv-zhcap').forEach(el => {
      el.classList.toggle('active', Number((el as HTMLElement).dataset.pid) === activePid);
    });
    for (const [, ps] of leftStates.current) {
      if (ps.hlLayer && ps.canvas) {
        const vp1 = { width: ps.canvas.width / 2 };
        const n = Number(ps.canvas.closest('[data-page]')?.getAttribute('data-page'));
        renderHl(ps.hlLayer, boxes.filter(b => b.page === n), ps.canvas, vp1, activePid);
      }
    }
  }, [activePid, boxes]);

  // 4) 译文/折叠变化 → 重建右侧胶囊层（纯覆盖层，canvas 不动，单帧完成）
  useEffect(() => {
    if (!doc) return;
    const parts = zhParts();
    for (const [n, ps] of rightStates.current) {
      if (ps.zhLayer && ps.canvas) {
        renderZh(ps.zhLayer, boxes.filter(b => b.page === n), ps.canvas, { width: ps.canvas.width / 2 },
          parts, activePid, collapsed, pid => setActivePid(pid));
      }
    }
  }, [boxes, collapsed, doc, zhParts]);

  // 「展开全文」事件 → 加入折叠集合（触发上面的重建 effect）
  useEffect(() => {
    const fn = (e: Event) => {
      const pid = (e as CustomEvent).detail as number;
      setCollapsed(s => new Set(s).add(pid));
    };
    window.addEventListener('dpv-expand', fn);
    return () => window.removeEventListener('dpv-expand', fn);
  }, []);

  // 滚动同步：程序滚动期间的回声事件全部忽略（超时兜底 → 修乒乓闪烁）
  const syncFrom = (src: 'L' | 'R') => {
    const now = Date.now();
    if (now < syncLockUntil.current) return;
    const a = src === 'L' ? leftRef.current : rightRef.current;
    const b = src === 'L' ? rightRef.current : leftRef.current;
    if (a && b && a.scrollHeight > a.clientHeight) {
      const ratio = a.scrollTop / (a.scrollHeight - a.clientHeight);
      syncLockUntil.current = now + 120;
      b.scrollTop = ratio * (b.scrollHeight - b.clientHeight);
    }
  };

  if (error) {
    return <div className="dpv-wrap"><div className="pdf-error">PDF 未就绪（{error.slice(0, 80)}）。后台下载完成后重开论文即可。</div></div>;
  }

  return (
    <div className="dpv-wrap">
      <div className="dpv-toolbar">
        <span>{numPages ? `${numPages} 页 · 原文/译文对照` : '加载中…'}</span>
        <span className="dpv-hint">点击译文定位原文 · 滚动自动翻译 · 左右同步</span>
      </div>
      <div className="dpv-body">
        <div className="dpv-pane" ref={leftRef} onScroll={() => syncFrom('L')} onMouseUp={e => onMouseUpRef.current?.(e)}>
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

// ---------- 文本归一化 + 最佳匹配（修对照不上）----------

function normText(s: string): string {
  return s.replace(/\$\$[^$]*\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ')
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

// 评分制最佳匹配：整段相等 > 双向包含 > 头部窗口模糊；跨页续段（簇=块尾部）靠「簇⊂块」全包含得分
function matchPid(clusterText: string, blockNorms: { pid: number; norm: string }[]): number {
  const cn = normText(clusterText);
  if (cn.length < 6) return 0;
  let best = 0, bestScore = 0;
  for (const b of blockNorms) {
    if (b.norm.length < 8) continue;
    let score = 0;
    if (b.norm === cn) score = 10000 + b.norm.length;
    else if (cn.length >= 20 && b.norm.includes(cn)) score = 8000 + cn.length * 2;       // 簇⊂块（续段/碎片）
    else if (b.norm.length >= 20 && cn.includes(b.norm)) score = 9000 + b.norm.length;   // 簇⊃块（聚类合并）
    else if (b.norm.startsWith(cn) || cn.startsWith(b.norm)) score = 7000 + Math.min(cn.length, b.norm.length);
    else {
      // 头部窗口：块头 60/40/28/20/14 字出现在簇中，或簇头出现在块中
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
  onActive: (pid: number) => void,
) {
  layer.innerHTML = '';
  const eff = canvas.getBoundingClientRect().width / vp1.width;
  const idxMap = new Map<number, number>();
  // 先按视觉位置排序，再做碰撞下移（译文比原文长时不遮下一块）
  const sorted = pageBoxes.slice().sort((a, b) => a.y - b.y);
  let maxBottom = 0;
  for (const box of sorted) {
    if (!box.pid) continue;
    const parts = zhParts.get(box.pid);
    if (!parts?.length) continue;
    const idx = Math.min(idxMap.get(box.pid) ?? 0, parts.length - 1);
    idxMap.set(box.pid, idx + 1);
    const zhPart = parts[idx];
    if (!zhPart) continue;
    const cap = document.createElement('div');
    const isLong = zhPart.length > COLLAPSE_LEN;
    const isCollapsed = isLong && !collapsed.has(box.pid);
    cap.className = 'dpv-zhcap' + (activePid === box.pid ? ' active' : '') + (isCollapsed ? ' collapsed' : '');
    cap.dataset.pid = String(box.pid);
    let top = box.y * eff - 2;
    if (top < maxBottom - 2) top = maxBottom + 2;   // 碰撞下移
    cap.style.left = `${box.x * eff - 2}px`;
    cap.style.top = `${top}px`;
    cap.style.width = `${box.w * eff + 4}px`;
    cap.style.minHeight = `${box.h * eff}px`;
    cap.innerHTML = escapeZh(zhPart);
    cap.onclick = () => onActive(box.pid);
    if (isCollapsed) {
      const more = document.createElement('div');
      more.className = 'dpv-more';
      more.textContent = '展开全文';
      more.onclick = (ev) => {
        ev.stopPropagation();
        setCollapsedGlobal(box.pid);
      };
      cap.appendChild(more);
    }
    layer.appendChild(cap);
    maxBottom = top + cap.offsetHeight + 4;
  }
}

// 折叠集合由组件 useEffect 依赖 collapsed 重建，这里通过自定义事件通知
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
