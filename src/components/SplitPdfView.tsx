import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { toastErr } from './Toast';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 原版对照视图：左 = 原版英文 PDF，右 = pdf2zh mono.pdf（纯中文、版式与原版一致）。
// 两边页面几何相同 → 滚动同步 = 页码对齐 + 页内滚动比例，天然精确，无需文本匹配。
// 双边均有透明文本层（可滑选），划线存 pdf_highlights（页面归一化坐标，重开不跑偏）。
export interface PdfHlRect { x: number; y: number; w: number; h: number }
export interface PdfHlRow { id: number; side: string; page: number; rects: string; text: string; pid: number | null; color: string }

type Side = 'en' | 'zh';

// ---- 单侧 PDF 面板（canvas + 文本层 + 高亮层 + 懒渲染）----
function PdfPane({
  side, url, highlights, onSelection, onJumpRatio,
}: {
  side: Side;
  url: string;
  highlights: PdfHlRow[];
  onSelection: (sel: { side: Side; page: number; text: string; rects: PdfHlRect[]; clientX: number; clientY: number } | null) => void;
  onJumpRatio: (side: Side, page: number, ratio: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [visiblePage, setVisiblePage] = useState(1);
  const renderedRef = useRef<Set<number>>(new Set());
  // 程序化滚动标记（同步滚动时不回传，避免 A↔B 死循环）
  const progScrollUntil = useRef(0);
  const lastReport = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setVisiblePage(1);
    renderedRef.current.clear(); pageRefs.current.clear();
    (async () => {
      try {
        const d = await (pdfjsLib.getDocument({ url, useSystemFonts: true })).promise;
        if (cancelled) { d.destroy(); return; }
        setDoc(d); setNumPages(d.numPages);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  // 渲染一页：canvas（2x DPR）+ 透明文本层（span 精确几何）+ 高亮层
  const renderPage = useCallback(async (d: PDFDocumentProxy, n: number) => {
    const host = pageRefs.current.get(n);
    if (!host || renderedRef.current.has(n)) return;
    if (host.clientWidth < 50) return;
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
      host.querySelectorAll('canvas, .dpv-textlayer, .spv-hllayer').forEach(el => el.remove());
      const loading = host.querySelector('.pdf-loading');
      if (loading) loading.remove();
      host.appendChild(canvas);

      // 文本层：与 DualPdfView 相同策略（透明 span + scaleX 校正）
      const tl = document.createElement('div');
      tl.className = 'dpv-textlayer';
      const tc = await page.getTextContent();
      const hostW = host.getBoundingClientRect().width || vp1.width;
      const eff = hostW / vp1.width;
      for (const it of tc.items as any[]) {
        if (!it.str || !it.str.trim() || !it.width) continue;
        const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]) || 10;
        const sp = document.createElement('span');
        sp.textContent = it.str;
        sp.dataset.pdfX = String(tx[4] / vp1.width);
        sp.dataset.pdfY = String((vp1.height - tx[5]) / vp1.height);
        sp.dataset.pdfW = String(it.width / vp1.width);
        sp.dataset.pdfH = String(fh * 1.15 / vp1.height);
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

      // 高亮层：坐标矩形色块（在文本层下、canvas 上）
      const hl = document.createElement('div');
      hl.className = 'spv-hllayer';
      hl.dataset.page = String(n);
      host.appendChild(hl);
      paintHighlights(host, n);
    } catch {
      renderedRef.current.delete(n);
    }
  }, []);

  // 高亮绘制（每次 highlights 变化重画当页）
  const paintPageHl = useCallback((n: number) => {
    paintHighlights(pageRefs.current.get(n) ?? null, n);
  }, []);
  useEffect(() => {
    if (!doc) return;
    for (const n of renderedRef.current) paintPageHl(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights]);

  function paintHighlights(host: HTMLElement | null, page: number) {
    if (!host) return;
    const layer = host.querySelector('.spv-hllayer') as HTMLElement | null;
    if (!layer) return;
    layer.innerHTML = '';
    const hostW = host.getBoundingClientRect().width;
    for (const h of highlights) {
      if (h.side !== side || h.page !== page) continue;
      let rects: PdfHlRect[] = [];
      try { rects = JSON.parse(h.rects); } catch { continue; }
      const colors: Record<string, string> = {
        yellow: 'rgba(255,240,90,0.42)', green: 'rgba(120,220,130,0.42)',
        blue: 'rgba(100,170,255,0.42)', pink: 'rgba(255,140,190,0.42)',
      };
      const box = document.createElement('div');
      box.className = 'spv-hlbox';
      box.dataset.id = String(h.id);
      box.style.background = colors[h.color] ?? colors.yellow;
      // rects 已是归一化坐标：直接铺满重叠区域（用首个矩形定位，其余绝对定位其内）
      for (const r of rects) {
        const b = document.createElement('div');
        b.style.position = 'absolute';
        b.style.left = `${r.x * hostW}px`;
        b.style.top = `${r.y * 100}%`;
        b.style.width = `${r.w * hostW}px`;
        b.style.height = `${r.h * 100}%`;
        box.appendChild(b);
      }
      box.style.position = 'absolute';
      box.style.inset = '0';
      layer.appendChild(box);
    }
  }

  // 懒渲染 + 可见页追踪
  useEffect(() => {
    if (!doc || !numPages) return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = Number((en.target as HTMLElement).dataset.page);
        if (en.isIntersecting) {
          renderPage(doc, n);
          if (Date.now() > progScrollUntil.current) {
            const r = en.target.getBoundingClientRect();
            const host = scrollRef.current;
            if (host) {
              const ratio = Math.max(0, Math.min(1, (host.getBoundingClientRect().top - r.top) / Math.max(1, r.height)));
              if (Date.now() - lastReport.current > 50) {
                lastReport.current = Date.now();
                setVisiblePage(n);
                onJumpRatio(side, n, ratio);
              }
            }
          }
        }
      }
    }, { root: scrollRef.current, rootMargin: '0px 0px -70% 0px' });
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [doc, numPages, renderPage, onJumpRatio, side]);

  // 同步滚动入口（对侧调用）：第 page 页按 ratio 滚到位
  const syncTo = useCallback((page: number, ratio: number) => {
    const host = scrollRef.current;
    const el = pageRefs.current.get(page);
    if (!host || !el) return;
    progScrollUntil.current = Date.now() + 350;
    const top = el.offsetTop - (host.clientHeight - el.offsetHeight) * 0.3 + el.offsetHeight * ratio * 0.7;
    host.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }, []);
  // 暴露给父组件
  const syncRef = useRef(syncTo);
  syncRef.current = syncTo;
  useEffect(() => {
    (window as any).__spvSync?.set(side, syncRef);
  });

  // 划词检测：mouseup 时取选区（文本 + 覆盖 span 的归一化矩形）
  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { onSelection(null); return; }
    const text = sel.toString().trim();
    if (text.length < 2) { onSelection(null); return; }
    const range = sel.getRangeAt(0);
    const host = (range.startContainer.parentElement as HTMLElement)?.closest('.pdf-page') as HTMLElement | null;
    if (!host) { onSelection(null); return; }
    const page = Number(host.dataset.page);
    if (!page) { onSelection(null); return; }
    // 收集选区覆盖的文本层 span → 归一化矩形簇（按行去重）
    const spans = Array.from(range.cloneContents().querySelectorAll('span')) as HTMLElement[];
    const hostSpans: HTMLElement[] = [];
    if (spans.length) {
      const hr = host.getBoundingClientRect();
      for (const sp of spans) {
        const inHost = host.querySelector(`span[data-pdf-x="${sp.dataset.pdfX}"]`);
        if (inHost) hostSpans.push(inHost as HTMLElement);
      }
      if (!hostSpans.length) hostSpans.push(...(Array.from(host.querySelectorAll('.dpv-textlayer span')) as HTMLElement[]).filter(s => sel.containsNode(s, true) && (s.textContent || '').trim()));
    } else {
      hostSpans.push(...(Array.from(host.querySelectorAll('.dpv-textlayer span')) as HTMLElement[]).filter(s => sel.containsNode(s, true) && (s.textContent || '').trim()));
    }
    if (!hostSpans.length) { onSelection(null); return; }
    const rects: PdfHlRect[] = hostSpans.map(sp => ({
      x: Number(sp.dataset.pdfX), y: Number(sp.dataset.pdfY),
      w: Number(sp.dataset.pdfW), h: Number(sp.dataset.pdfH),
    }));
    onSelection({ side, page, text, rects, clientX: e.clientX, clientY: e.clientY });
  }, [side, onSelection]);

  if (error) {
    return <div className="spv-pane" ref={scrollRef}><div className="pdf-error">{side === 'en' ? '原版 PDF' : '中文 PDF'}不可用（{error.slice(0, 60)}）</div></div>;
  }

  return (
    <div className={`spv-pane spv-${side}`} ref={scrollRef} onMouseUp={onMouseUp} aria-label={side === 'en' ? '原版英文 PDF' : '中文译文 PDF'}>
      {!doc && <div className="pdf-loading">加载中…</div>}
      {doc && Array.from({ length: numPages }, (_, i) => (
        <div
          key={i + 1}
          className="pdf-page"
          data-page={i + 1}
          ref={el => { if (el) pageRefs.current.set(i + 1, el); }}
        >
          <div className="pdf-loading">第 {i + 1} 页</div>
        </div>
      ))}
      <div className="spv-page-badge">{numPages ? `${visiblePage}/${numPages}` : ''}</div>
    </div>
  );
}

// ---- 主组件：左右对照 + 比例同步 ----
export default function SplitPdfView({ paperId }: { paperId: number }) {
  const [highlights, setHighlights] = useState<PdfHlRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  // 选区弹层（划线/划词三键）
  const [popover, setPopover] = useState<{ x: number; y: number; sel: { side: Side; page: number; text: string; rects: PdfHlRect[] } } | null>(null);

  const loadHl = useCallback(async () => {
    try {
      if (typeof window.api.pdfhlList === 'function') {
        setHighlights(await window.api.pdfhlList(paperId) as PdfHlRow[]);
      }
    } catch { /* 高亮加载失败不阻塞阅读 */ }
  }, [paperId]);
  useEffect(() => { loadHl(); }, [loadHl]);

  // 跨面板同步注册表
  useEffect(() => {
    (window as any).__spvSync = new Map();
    return () => { delete (window as any).__spvSync; };
  }, []);

  // A 侧报告 → 驱动 B 侧（比例同步；同侧自身由 IntersectionObserver 原生滚动驱动）
  const handleJump = useCallback((from: Side, page: number, ratio: number) => {
    const reg = (window as any).__spvSync as Map<string, { current: (p: number, r: number) => void }> | undefined;
    if (!reg) return;
    const to = from === 'en' ? 'zh' : 'en';
    reg.get(to)?.current?.(page, ratio);
  }, []);

  const onSelection = useCallback((sel: { side: Side; page: number; text: string; rects: PdfHlRect[]; clientX: number; clientY: number } | null) => {
    if (!sel) { setPopover(null); return; }
    setPopover({ x: sel.clientX, y: sel.clientY, sel });
  }, []);

  const addHl = useCallback(async (color: string) => {
    if (!popover) return;
    try {
      await window.api.pdfhlAdd({
        paperId, side: popover.sel.side, page: popover.sel.page,
        rects: popover.sel.rects, text: popover.sel.text, color,
      });
      setPopover(null);
      window.getSelection()?.removeAllRanges();
      loadHl();
    } catch (e: any) {
      setPopover(null);
      toastErr(e);
    }
  }, [popover, paperId, loadHl]);

  const removeHl = useCallback(async (id: number) => {
    try {
      await window.api.pdfhlRemove(id);
      loadHl();
    } catch (e: any) {
      toastErr(e);
    }
  }, [loadHl]);

  // 划词三键（复用主进程 quick:action）
  const [quick, setQuick] = useState<{ kind: string; text: string; answer: string; loading: boolean } | null>(null);
  const quickAction = useCallback(async (kind: 'explain' | 'search' | 'translate') => {
    if (!popover) return;
    const text = popover.sel.text;
    setPopover(null);
    setQuick({ kind, text, answer: '', loading: true });
    try {
      const r = await window.api.quickAction({ kind, text });
      setQuick({ kind, text, answer: String(r), loading: false });
    } catch (e: any) {
      setQuick({ kind, text, answer: e?.message ?? String(e), loading: false });
    }
  }, [popover]);

  // 选中侧对应高亮列表（右键/面板删除用）
  const pageHls = popover
    ? highlights.filter(h => h.side === popover.sel.side && h.page === popover.sel.page)
    : [];

  return (
    <div className="spv-wrap">
      <div className="dpv-toolbar">
        <span className="dpv-mode-switch" style={{ color: '#ddd' }}>原版对照：左英文 · 右中文（版式一致）</span>
        <span className="dpv-page-indicator">共 {highlights.length} 条划线</span>
      </div>
      <div className="spv-split">
        <PdfPane key={`en-${reloadKey}`} side="en" url={`local-pdf://p/${paperId}`} highlights={highlights} onSelection={onSelection} onJumpRatio={handleJump} />
        <PdfPane key={`zh-${reloadKey}`} side="zh" url={`local-pdf://p/${paperId}-mono`} highlights={highlights} onSelection={onSelection} onJumpRatio={handleJump} />
      </div>

      {popover && (
        <div className="tp-popover" style={{ left: popover.x, top: popover.y + 10 }} onMouseDown={e => e.preventDefault()}>
          <button onClick={() => addHl('yellow')} title="黄色划线">🟡</button>
          <button onClick={() => addHl('green')} title="绿色划线">🟢</button>
          <button onClick={() => addHl('blue')} title="蓝色划线">🔵</button>
          <button onClick={() => addHl('pink')} title="粉色划线">🩷</button>
          <span className="tp-sep" />
          <button onClick={() => quickAction('explain')}>解释</button>
          <button onClick={() => quickAction('translate')}>翻译</button>
          <button onClick={() => quickAction('search')}>搜索</button>
        </div>
      )}

      {quick && (
        <div className="spv-quick">
          <div className="spv-quick-head">
            <span>{quick.kind === 'explain' ? '解释' : quick.kind === 'translate' ? '翻译' : '搜索'} · {quick.text.slice(0, 40)}{quick.text.length > 40 ? '…' : ''}</span>
            <button onClick={() => setQuick(null)}>✕</button>
          </div>
          <div className="spv-quick-body">{quick.loading ? '生成中…' : quick.answer}</div>
        </div>
      )}

      {/* 当前页高亮清单（点击删除） */}
      {popover && pageHls.length > 0 && (
        <div className="spv-hl-list">
          {pageHls.map(h => (
            <div key={h.id} className="spv-hl-item">
              <span className="spv-hl-swatch" data-color={h.color} />
              <span className="spv-hl-text" title={h.text}>{h.text.slice(0, 60)}{h.text.length > 60 ? '…' : ''}</span>
              <button onClick={() => removeHl(h.id)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
