import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { toastErr } from './Toast';
import { toast } from './Toast';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 原版对照视图：左 = 原版英文 PDF，右 = pdf2zh mono.pdf（纯中文、版式与原版逐页一致）。
// 同步根基（实测 3 篇产物 126 页）：mono 与原版逐页尺寸零偏差 → 两侧滚动栈同构
// → 滚动同步 = scrollTop 等值映射（恒等式，非估算）。
// 防回环：expectedTop 比对（≤2px 回声忽略 / >15px 用户接管放行），无时间窗——
// 吸收 DualPdfView 考古教训：纯时间窗会吞掉用户接管滚动。
export interface PdfHlRect { x: number; y: number; w: number; h: number }
export interface PdfHlRow { id: number; side: string; page: number; rects: string; text: string; pid: number | null; color: string }

type Side = 'en' | 'zh';
const HL_COLORS: Record<string, string> = {
  yellow: 'rgba(255,240,90,0.42)', green: 'rgba(120,220,130,0.42)',
  blue: 'rgba(100,170,255,0.42)', pink: 'rgba(255,140,190,0.42)',
};
const MIRROR_COLOR = 'rgba(59,130,246,0.25)';
const SEL_SPAN_LIMIT = 80;

// 选区信息（组件内通用）
interface SelInfo {
  side: Side; page: number; text: string; rects: PdfHlRect[];
  clientX: number; clientY: number;
}

// 同步注册表：side → 滚动控制句柄（组件级单例，两侧 pane 注册）
interface SyncHandle {
  // 等值同步：把对侧滚到 top；返回 false = 本侧此刻不健康（doc 未就绪）
  scrollTo: (top: number) => boolean;
  // 查询：本侧健康 + 视口高度（降级模式判断用）
  ready: () => boolean;
}
const syncReg = new Map<Side, SyncHandle>();

// ---- 单侧 PDF 面板 ----
function PdfPane({
  side, url, highlights, mirrorSel, onSelection, onUserScroll,
}: {
  side: Side;
  url: string;
  highlights: PdfHlRow[];
  mirrorSel: SelInfo | null;           // 对侧来的镜像选区（本侧渲染其浮层）
  onSelection: (sel: SelInfo | null) => void;
  onUserScroll: (side: Side, top: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [aspect, setAspect] = useState<number>(0); // 页宽高比（精确占位）
  const [error, setError] = useState('');
  const [visiblePage, setVisiblePage] = useState(1);
  const renderedRef = useRef<Set<number>>(new Set());
  // 最新数据的 ref：renderPage 异步闭包读 ref 而非 props，消除晚渲染页用过期高亮数据的竞态
  const hlRef = useRef(highlights);
  hlRef.current = highlights;
  const mirrorRef = useRef(mirrorSel);
  mirrorRef.current = mirrorSel;
  // 滚动同步状态
  const expectedTopRef = useRef<number | null>(null);   // 程序化同步的目标（回声识别）
  const rafPendingRef = useRef(false);
  const lastOwnTopRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setVisiblePage(1); setAspect(0);
    renderedRef.current.clear(); pageRefs.current.clear();
    expectedTopRef.current = null;
    (async () => {
      try {
        const d = await (pdfjsLib.getDocument({ url, useSystemFonts: true })).promise;
        if (cancelled) { d.destroy(); return; }
        const p1 = await d.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        setAspect(vp.width / vp.height);
        setDoc(d); setNumPages(d.numPages);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  // ---- 像素级滚动同步（等值映射 + expectedTop 防回环 + rAF 合帧）----
  useEffect(() => {
    const host = scrollRef.current;
    if (!host || !doc) return;
    syncReg.set(side, {
      scrollTo: (top: number) => {
        const max = Math.max(0, host.scrollHeight - host.clientHeight);
        const clamped = Math.min(Math.max(0, top), max);
        expectedTopRef.current = clamped;
        host.scrollTop = clamped; // auto 行为：滚动同步必须逐帧贴齐，禁 smooth（拖尾=失同步）
        return true;
      },
      ready: () => true,
    });
    const onScroll = () => {
      const top = host.scrollTop;
      const expected = expectedTopRef.current;
      if (expected !== null) {
        if (Math.abs(top - expected) <= 2) return;       // 自己的回声
        if (Math.abs(top - expected) > 15) {
          expectedTopRef.current = null;                  // 用户接管（大幅偏离）
        } else {
          return; // 同步动画/惯性进行中的小抖动，忽略
        }
      }
      if (top === lastOwnTopRef.current) return;          // 同值去重（橡皮筋）
      lastOwnTopRef.current = top;
      if (rafPendingRef.current) return;
      rafPendingRef.current = true;
      requestAnimationFrame(() => {
        rafPendingRef.current = false;
        onUserScroll(side, host.scrollTop);
      });
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      host.removeEventListener('scroll', onScroll);
      syncReg.delete(side);
    };
  }, [doc, side, onUserScroll]);

  // 可见页徽章（轻量：IntersectionObserver 只做页码 + 懒渲染，不做同步）
  useEffect(() => {
    if (!doc || !numPages) return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          renderPage(doc, Number((en.target as HTMLElement).dataset.page));
          setVisiblePage(Number((en.target as HTMLElement).dataset.page));
        }
      }
    }, { root: scrollRef.current, rootMargin: '0px 0px -70% 0px' });
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, numPages]);

  // 渲染一页：canvas（2x DPR）+ 透明文本层 + 高亮层 + 镜像层
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
      host.querySelectorAll('canvas, .dpv-textlayer, .spv-hllayer, .spv-mirror').forEach(el => el.remove());
      const loading = host.querySelector('.pdf-loading');
      if (loading) loading.remove();
      host.appendChild(canvas);

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

      const hl = document.createElement('div');
      hl.className = 'spv-hllayer';
      host.appendChild(hl);
      const ml = document.createElement('div');
      ml.className = 'spv-mirror';
      host.appendChild(ml);
      paintLayers(n);
    } catch {
      renderedRef.current.delete(n);
    }
  }, []);

  // 高亮 + 镜像绘制（划线双边：不筛 side；镜像：对侧选区投影）
  const paintLayers = useCallback((n: number) => {
    const highlights = hlRef.current;
    const mirrorSel = mirrorRef.current;
    const host = pageRefs.current.get(n);
    if (!host) return;
    const hlLayer = host.querySelector('.spv-hllayer') as HTMLElement | null;
    if (hlLayer) {
      hlLayer.innerHTML = '';
      const hostW = host.getBoundingClientRect().width;
      for (const h of highlights) {
        if (h.page !== n) continue;
        let rects: PdfHlRect[] = [];
        try { rects = JSON.parse(h.rects); } catch { continue; }
        for (const r of rects) {
          const b = document.createElement('div');
          b.className = 'spv-hlrect';
          b.style.background = HL_COLORS[h.color] ?? HL_COLORS.yellow;
          b.style.left = `${r.x * hostW}px`;
          b.style.top = `${r.y * 100}%`;
          b.style.width = `${r.w * hostW}px`;
          b.style.height = `${r.h * 100}%`;
          hlLayer.appendChild(b);
        }
      }
    }
    const mLayer = host.querySelector('.spv-mirror') as HTMLElement | null;
    if (mLayer) {
      mLayer.innerHTML = '';
      if (mirrorSel && mirrorSel.page === n) {
        const hostW = host.getBoundingClientRect().width;
        for (const r of mirrorSel.rects) {
          const b = document.createElement('div');
          b.className = 'spv-hlrect';
          b.style.background = MIRROR_COLOR;
          b.style.left = `${r.x * hostW}px`;
          b.style.top = `${r.y * 100}%`;
          b.style.width = `${r.w * hostW}px`;
          b.style.height = `${r.h * 100}%`;
          mLayer.appendChild(b);
        }
      }
    }
  }, []);

  // highlights/mirror 变化 → 重画已渲染页
  useEffect(() => {
    if (!doc) return;
    for (const n of renderedRef.current) paintLayers(n);
  }, [doc, paintLayers]);

  // 划词检测：mouseup 取选区（文本 + 覆盖 span 的归一化矩形）
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
    // 选区覆盖的 span（限本页；containsNode 部分选中也算）
    const spans = (Array.from(host.querySelectorAll('.dpv-textlayer span')) as HTMLElement[])
      .filter(s => sel.containsNode(s, true) && (s.textContent || '').trim());
    if (!spans.length) { onSelection(null); return; }
    if (spans.length > SEL_SPAN_LIMIT) {
      onSelection(null);
      toast('info', '选择内容过多，请缩小范围');
      return;
    }
    const rects: PdfHlRect[] = spans.map(sp => ({
      x: Number(sp.dataset.pdfX), y: Number(sp.dataset.pdfY),
      w: Number(sp.dataset.pdfW), h: Number(sp.dataset.pdfH),
    }));
    onSelection({ side, page, text, rects, clientX: e.clientX, clientY: e.clientY });
  }, [side, onSelection]);

  // 点空白（非文本层）清选区 + 关弹层
  const onPaneMouseDown = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.dpv-textlayer')) {
      onSelection(null);
    }
  }, [onSelection]);

  if (error) {
    return <div className="spv-pane" ref={scrollRef}><div className="pdf-error">{side === 'en' ? '原版 PDF' : '中文 PDF'}不可用（{error.slice(0, 60)}）</div></div>;
  }

  return (
    <div
      className={`spv-pane spv-${side}`}
      ref={scrollRef}
      onMouseUp={onMouseUp}
      onMouseDown={onPaneMouseDown}
      aria-label={side === 'en' ? '原版英文 PDF' : '中文译文 PDF'}
    >
      {!doc && <div className="pdf-loading">加载中…</div>}
      {doc && aspect > 0 && Array.from({ length: numPages }, (_, i) => (
        <div
          key={i + 1}
          className="pdf-page"
          data-page={i + 1}
          style={{ aspectRatio: String(aspect) }}
          ref={el => { if (el) pageRefs.current.set(i + 1, el); }}
        >
          <div className="pdf-loading">第 {i + 1} 页</div>
        </div>
      ))}
      <div className="spv-page-badge">{numPages ? `${visiblePage}/${numPages}` : ''}</div>
    </div>
  );
}

// ---- 主组件：左右对照 + 等值同步 + 交互 ----
export default function SplitPdfView({ paperId }: { paperId: number }) {
  const [highlights, setHighlights] = useState<PdfHlRow[]>([]);
  const [mirrorSel, setMirrorSel] = useState<SelInfo | null>(null);
  const [popover, setPopover] = useState<{ x: number; y: number; sel: SelInfo } | null>(null);
  const [quick, setQuick] = useState<{ kind: string; text: string; answer: string; loading: boolean } | null>(null);
  const scrollTopsRef = useRef<Partial<Record<Side, number>>>({});

  const loadHl = useCallback(async () => {
    try {
      if (typeof window.api.pdfhlList === 'function') {
        setHighlights(await window.api.pdfhlList(paperId) as PdfHlRow[]);
      }
    } catch { /* 高亮加载失败不阻塞阅读 */ }
  }, [paperId]);
  useEffect(() => { loadHl(); }, [loadHl]);

  // 用户滚动（任一侧）→ 等值同步对侧
  const handleUserScroll = useCallback((from: Side, top: number) => {
    scrollTopsRef.current[from] = top;
    localStorage.setItem(`paper:${paperId}:splitTop`, String(top));
    const to: Side = from === 'en' ? 'zh' : 'en';
    syncReg.get(to)?.scrollTo(top);
  }, [paperId]);

  // 双侧就绪后恢复滚动位置（切论文/重开）
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored || syncReg.size < 2) return;
    const saved = Number(localStorage.getItem(`paper:${paperId}:splitTop`) || 0);
    if (saved > 0) {
      syncReg.get('en')?.scrollTo(saved);
      syncReg.get('zh')?.scrollTo(saved);
    }
    setRestored(true);
  }, [restored, paperId]);

  // 选区 → 弹层 + 镜像（对侧渲染）
  const onSelection = useCallback((sel: SelInfo | null) => {
    if (!sel) { setPopover(null); setMirrorSel(null); return; }
    setMirrorSel(sel); // 同一份 rects 投影到对侧（几何一致）
    // 弹层防出屏（右/下翻转）
    const pw = 280, ph = 42;
    const x = Math.min(sel.clientX, window.innerWidth - pw - 12);
    const y = Math.min(sel.clientY + 10, window.innerHeight - ph - 12);
    setPopover({ x: Math.max(8, x), y: Math.max(8, y), sel });
  }, []);

  // Esc：清选区/镜像/弹层/快捷结果（不拦截传播）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPopover(null); setMirrorSel(null); setQuick(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      setMirrorSel(null);
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

  // 当前选中页的高亮清单（删除入口）
  const pageHls = popover
    ? highlights.filter(h => h.page === popover.sel.page)
    : [];

  return (
    <div className="spv-wrap">
      <div className="dpv-toolbar">
        <span className="dpv-mode-switch" style={{ color: '#ddd' }}>原版对照：左英文 · 右中文</span>
        <span className="dpv-page-indicator">{highlights.length ? `共 ${highlights.length} 条划线` : ''}</span>
      </div>
      <div className="spv-split">
        <PdfPane side="en" url={`local-pdf://p/${paperId}`} highlights={highlights} mirrorSel={mirrorSel?.side === 'zh' ? mirrorSel : null} onSelection={onSelection} onUserScroll={handleUserScroll} />
        <PdfPane side="zh" url={`local-pdf://p/${paperId}-mono`} highlights={highlights} mirrorSel={mirrorSel?.side === 'en' ? mirrorSel : null} onSelection={onSelection} onUserScroll={handleUserScroll} />
      </div>

      {popover && (
        <div className="tp-popover" style={{ left: popover.x, top: popover.y }} onMouseDown={e => e.preventDefault()}>
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
