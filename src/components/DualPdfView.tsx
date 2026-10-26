import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import RichText from './RichText';
import type { BlockRow } from '../store';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// PDF 双语对照视图（方案 A）：左栏原版 PDF canvas 分页（原汁原味），
// 右栏 HTML 译文流（纯文档流，按页分组）。两栏独立滚动 + 页级同步（互斥锁防回环）。
// 三态：en（仅原文）/ both（双语对照，默认）/ zh（仅译文）。窄屏（≤760px）自动上下分屏。
// 禁止任何绝对定位文字排版：译文在独立滚动容器中，结构上不可能覆盖 PDF。
export interface TextBlockBox {
  pid: number;
  page: number;
  x: number; y: number; w: number; h: number;
  pageW: number; pageH: number;
  textLen: number;
  lineH: number;
}

type PdfMode = 'en' | 'both' | 'zh';

export default function DualPdfView({
  paperId, blocks, onMouseUp,
}: {
  paperId: number;
  blocks: BlockRow[];
  onMouseUp?: (e: React.MouseEvent) => void;
}) {
  // ---- 左栏（PDF）状态 ----
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const hostsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [boxes, setBoxes] = useState<TextBlockBox[]>([]);
  const [clusterDone, setClusterDone] = useState(false);
  const [visiblePage, setVisiblePage] = useState(1);
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const renderedRef = useRef<Set<number>>(new Set());

  // ---- 右栏（译文）状态 ----
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<PdfMode>('both');
  const [zhScale, setZhScale] = useState(1);
  const [activePid, setActivePid] = useState(0);

  // ---- 按需翻译 ----
  const requestedTx = useRef<Set<number>>(new Set());
  const txFailCount = useRef<Map<number, number>>(new Map());
  const [txPending, setTxPending] = useState(0);
  const txPendingRef = useRef(0);

  // 易变引用
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const onMouseUpRef = useRef(onMouseUp);
  onMouseUpRef.current = onMouseUp;
  const activePidRef = useRef(activePid);
  activePidRef.current = activePid;

  // 1) 换论文时加载 PDF 文档
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setBoxes([]); setClusterDone(false); setFailedPages(new Set());
    renderedRef.current.clear();
    hostsRef.current.clear();
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

  // en 指纹：不变则不重新聚类
  const enKey = useMemo(
    () => blocks.map(b => `${b.pid}.${(b.en ?? '').length}`).join(','),
    [blocks],
  );

  // 2) 文档就绪 → 聚类匹配（pid → page 映射）。逐页增量 setBoxes：
  // 右栏页组渐进出现，不等全部页聚类完（长文首屏更快，E2E 不再受全量耗时抖动）。
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const blockNorms = blocksRef.current.filter(b => b.type !== 'fig')
        .map(b => ({ pid: b.pid, norm: normText(b.en) })).filter(x => x.norm.length >= 6);
      let all: TextBlockBox[] = [];
      for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
        const page = await doc.getPage(p);
        all = all.concat(clusterTextItems(await page.getTextContent(), page.getViewport({ scale: 1 }), p, blockNorms));
        if (cancelled) return;
        setBoxes(all);
      }
      setClusterDone(true);
      (window as any).__dpvClusterDone = { pages: Math.min(doc.numPages, 60), matched: all.filter(b => b.pid).length };
      (window as any).__dpvBoxesPids = all.filter(b => b.pid).map(b => b.pid);
    })();
    return () => { cancelled = true; };
  }, [doc, enKey]);

  // 页 → pid 列表（右栏分组依据）；pid → 首次出现页（左→右定位依据）。
  // 未匹配到 boxes 的段落归入「未映射」组，不丢弃（保证右栏文字连贯）。
  const { pidsByPage, unmapped } = useMemo(() => {
    const pidFirstPage = new Map<number, number>();
    for (const b of boxes) {
      if (!b.pid) continue;
      if (!pidFirstPage.has(b.pid)) pidFirstPage.set(b.pid, b.page);
    }
    const byPage = new Map<number, number[]>();
    const unmappedPids: number[] = [];
    for (const b of blocks) {
      if (b.type === 'fig') continue; // 图表用占位块，不占 pid 组
      const pg = pidFirstPage.get(b.pid);
      if (pg === undefined) { unmappedPids.push(b.pid); continue; }
      const a = byPage.get(pg) ?? []; a.push(b.pid); byPage.set(pg, a);
    }
    return { pidsByPage: byPage, unmapped: unmappedPids };
  }, [boxes, blocks.map(b => b.pid).join(','), enKey]);

  const pidsByPageRef = useRef(pidsByPage);
  pidsByPageRef.current = pidsByPage;

  // 3) 按需翻译 + 失败指数退避（滚到哪翻到哪）
  const translatePageIfNeeded = useCallback((page: number) => {
    const now = Date.now();
    const pagePids = pidsByPageRef.current.get(page) ?? [];
    const zhByPid = new Map(blocksRef.current.map(b => [b.pid, b.zh ?? '']));
    const need = pagePids.filter(pid => {
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
        setTxPending(Math.max(0, txPendingRef.current));
      });
    }
  }, [paperId]);

  // 手动重试
  const retryTranslate = useCallback((pid: number) => {
    requestedTx.current.delete(pid);
    txFailCount.current.delete(pid);
    txFailCount.current.delete(-pid);
    const b = blocksRef.current.find(x => x.pid === pid);
    if (!b || b.zh) return;
    requestedTx.current.add(pid);
    txPendingRef.current += 1;
    setTxPending(txPendingRef.current);
    window.api.translateAll({ paperId, blocks: [{ pid, en: b.en }], scope: 'all' }).catch(() => {
      requestedTx.current.delete(pid);
      txFailCount.current.set(pid, (txFailCount.current.get(pid) ?? 0) + 1);
    }).finally(() => {
      txPendingRef.current -= 1;
      setTxPending(Math.max(0, txPendingRef.current));
    });
  }, [paperId]);

  // 4) 渲染单页 canvas + 透明选择层（PDF.js 标准做法，无可见渲染，不覆盖任何文字）
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
      const tl = document.createElement('div');
      tl.className = 'dpv-textlayer';
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
      translatePageIfNeeded(n);
      setFailedPages(s => { if (!s.has(n)) return s; const x = new Set(s); x.delete(n); return x; });
    } catch {
      renderedRef.current.delete(n);
      setFailedPages(s => new Set(s).add(n));
    }
  }, [translatePageIfNeeded]);

  // 5) 左栏懒渲染：只观察视口 ±2 页（rootMargin 控制），canvas 已渲染页不重复。
  // mode 从 zh 切回时左栏 DOM 重挂载（旧 canvas 丢失），必须清 renderedRef 让全部页重渲染。
  useEffect(() => {
    if (!doc || !numPages || mode === 'zh') return;
    renderedRef.current.clear();
    const hosts = leftScrollRef.current?.querySelectorAll('[data-page]');
    if (!hosts?.length) return;
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (en.isIntersecting) renderPage(doc, Number((en.target as HTMLElement).dataset.page));
      }
    }, { root: leftScrollRef.current, rootMargin: '1200px 0px' });
    hosts.forEach(el => io.observe(el));
    return () => { io.disconnect(); };
  }, [doc, numPages, renderPage, mode]);

  // 6) 滚动同步（互斥锁防回环）：
  // 左→右：IntersectionObserver 找视口交集最大页，右栏滚到对应页组（已在视口则不动）。
  // 右→左：仅点击触发（页头/段落），不自动跟随——避免两侧抢方向盘。
  const syncingRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const withSyncLock = (fn: () => void) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    fn();
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => { syncingRef.current = false; }, 150);
  };

  // 右→左 段落级闪烁定位框：在左栏 canvas 上按 boxes 几何百分比画一个 800ms 渐隐高亮
  // （半透明背景 + 呼吸边框，不遮挡文字——纯视觉反馈层）
  const flashBoxAt = useCallback((pid: number) => {
    const box = boxesRef.current.find(b => b.pid === pid);
    const host = box ? hostsRef.current.get(box.page) : null;
    if (!box || !host) return false;
    host.querySelectorAll('.dpv-flash').forEach(el => el.remove());
    const vp1W = box.pageW, vp1H = box.pageH;
    if (!vp1W || !vp1H) return false;
    const fl = document.createElement('div');
    fl.className = 'dpv-flash';
    fl.style.left = `${(box.x / vp1W) * 100}%`;
    fl.style.top = `${(box.y / vp1H) * 100}%`;
    fl.style.width = `${(box.w / vp1W) * 100}%`;
    fl.style.height = `${(box.h / vp1H) * 100}%`;
    host.appendChild(fl);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => fl.remove(), 900);
    return true;
  }, []);

  // 左栏可见页追踪 + 驱动右栏跟随 + 按需翻译
  useEffect(() => {
    if (!doc || !numPages || mode === 'en') return;
    const hosts = leftScrollRef.current?.querySelectorAll('.pdf-page');
    if (!hosts?.length) return;
    const io = new IntersectionObserver(entries => {
      let best = 0, bestRatio = 0;
      for (const en of entries) {
        if (en.isIntersecting && en.intersectionRatio > bestRatio) {
          bestRatio = en.intersectionRatio;
          best = Number((en.target as HTMLElement).dataset.page);
        }
      }
      if (!best) return;
      // 直接跟随主导可见页（此前的 |prev-best|<=2 钳位会让逐页滚动时锚点永远停在旧页——正是失焦的根源）
      setVisiblePage(best);
      if (mode !== 'both') return;
      // 右栏跟随：目标页组不在视口时滚过去（在视口则不动，防抖动）
      withSyncLock(() => {
        const right = rightScrollRef.current;
        if (!right) return;
        const g = right.querySelector(`[data-zhpage="${best}"]`) as HTMLElement | null;
        if (!g) return;
        const rr = right.getBoundingClientRect();
        const gr = g.getBoundingClientRect();
        if (gr.top < rr.top + 40 || gr.bottom > rr.bottom - 40) {
          right.scrollTo({ top: g.offsetTop - right.offsetTop - 12, behavior: 'smooth' });
        }
      });
    }, { root: leftScrollRef.current, threshold: [0, 0.25, 0.6] });
    hosts.forEach(el => io.observe(el));
    return () => { io.disconnect(); };
  }, [doc, numPages, mode]);

  // 7) 右→左 点击定位（方案 B 辅）：点页头/段落 → 左栏滚到对应页
  const jumpToPage = useCallback((page: number) => {
    const left = leftScrollRef.current;
    if (!left) return;
    withSyncLock(() => {
      const t = left.querySelector(`[data-page="${page}"]`) as HTMLElement | null;
      if (t) left.scrollTo({ top: t.offsetTop - left.offsetTop - 8, behavior: 'smooth' });
    });
  }, []);
  const jumpToPid = useCallback((pid: number) => {
    const box = boxesRef.current.find(b => b.pid === pid);
    if (box) {
      jumpToPage(box.page);
      flashBoxAt(pid);
    }
    setActivePid(pid);
  }, [jumpToPage, flashBoxAt]);

  // activePid 高亮：作用于右栏段落本身（背景色 + 左线，非悬浮层）
  useEffect(() => {
    rightScrollRef.current?.querySelectorAll('.dpv-zhpara').forEach(el => {
      el.classList.toggle('active', Number((el as HTMLElement).dataset.pid) === activePid);
    });
  }, [activePid, blocks]);

  if (error) {
    return <div className="dpv-wrap"><div className="pdf-error">PDF 未就绪（{error.slice(0, 80)}）。后台下载完成后重开论文即可。</div></div>;
  }

  const showLeft = mode !== 'zh';
  const showRight = mode !== 'en';

  return (
    <div className="dpv-wrap">
      <div className="dpv-toolbar">
        <div className="dpv-mode-switch" role="tablist" aria-label="阅读模式">
          <button role="tab" aria-selected={mode === 'en'} className={mode === 'en' ? 'active' : ''} onClick={() => setMode('en')}>仅原文</button>
          <button role="tab" aria-selected={mode === 'both'} className={mode === 'both' ? 'active' : ''} onClick={() => setMode('both')}>双语对照</button>
          <button role="tab" aria-selected={mode === 'zh'} className={mode === 'zh' ? 'active' : ''} onClick={() => setMode('zh')}>仅译文</button>
        </div>
        <span className="dpv-page-indicator">{numPages ? `第 ${visiblePage}/${numPages} 页` : '加载中…'}{txPending > 0 ? ` · 翻译中 ${txPending} 段` : ''}</span>
        <div className="dpv-actions">
          <button onClick={() => setZhScale(s => Math.max(0.7, Math.round((s - 0.1) * 10) / 10))} title="缩小译文（仅右栏）">A-</button>
          <button onClick={() => setZhScale(s => Math.min(1.6, Math.round((s + 0.1) * 10) / 10))} title="放大译文（仅右栏）">A+</button>
        </div>
      </div>
      <div className={`dpv-split ${mode}`}>
        {showLeft && (
          <div className="dpv-left" ref={leftScrollRef} onMouseUp={e => onMouseUpRef.current?.(e)} aria-label="原版 PDF">
            {doc && Array.from({ length: numPages }, (_, i) => (
              <div key={i + 1} className="pdf-page dpv-page" data-page={i + 1} ref={el => { if (el) hostsRef.current.set(i + 1, el); }}>
                <div className="pdf-loading">第 {i + 1} 页</div>
              </div>
            ))}
            {!doc && <div className="pdf-loading">PDF 加载中…</div>}
          </div>
        )}
        {showRight && (
          <div
            className="dpv-right"
            ref={rightScrollRef}
            onMouseUp={e => onMouseUpRef.current?.(e)}
            style={{ fontSize: `${14 * zhScale}px` }}
            aria-label="中文译文"
          >
            <ZhFlow
              blocks={blocks}
              pidsByPage={pidsByPage}
              unmapped={unmapped}
              numPages={numPages}
              activePid={activePid}
              activePage={mode === 'both' ? visiblePage : 0}
              clusterDone={clusterDone}
              onJumpPage={jumpToPage}
              onJumpPid={jumpToPid}
              onRetry={retryTranslate}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 右栏译文流（纯文档流） ----------

const ZhFlow = memo(function ZhFlow({
  blocks, pidsByPage, unmapped, numPages, activePid, activePage, clusterDone, onJumpPage, onJumpPid, onRetry,
}: {
  blocks: BlockRow[];
  pidsByPage: Map<number, number[]>;
  unmapped: number[];
  numPages: number;
  activePid: number;
  activePage: number;
  clusterDone: boolean;
  onJumpPage: (p: number) => void;
  onJumpPid: (pid: number) => void;
  onRetry: (pid: number) => void;
}) {
  const byPid = useMemo(() => new Map(blocks.map(b => [b.pid, b])), [blocks]);
  const figBlocks = useMemo(() => blocks.filter(b => b.type === 'fig'), [blocks]);
  const figByPage = useMemo(() => {
    const m = new Map<number, BlockRow[]>();
    // 图表无精确页映射时按邻近文本块粗略归页：这里简单挂在 unmapped 前后；
    // 已有 fig 路径的走左栏原生图，右栏只放占位提示
    for (const f of figBlocks) {
      // 找到 fig 前最近的已映射 pid 所在页
      const idx = blocks.findIndex(b => b.pid === f.pid);
      let page: number | null = null;
      for (let i = idx - 1; i >= 0; i--) {
        for (const [pg, arr] of pidsByPage) if (arr.includes(blocks[i].pid)) { page = pg; break; }
        if (page) break;
      }
      const key = page ?? 0;
      const a = m.get(key) ?? []; a.push(f); m.set(key, a);
    }
    return m;
  }, [figBlocks, blocks, pidsByPage]);

  return (
    <div className="dpv-zhflow">
      {Array.from({ length: Math.max(numPages, 1) }, (_, i) => i + 1).map(pg => {
        const pids = pidsByPage.get(pg) ?? [];
        const figs = figByPage.get(pg) ?? [];
        if (!pids.length && !figs.length) return null;
        return (
          <section key={pg} className={`dpv-zhgroup${pg === activePage ? ' page-active' : ''}`} data-zhpage={pg}>
            <div className="dpv-zhgroup-head" onClick={() => onJumpPage(pg)} role="button" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') onJumpPage(pg); }} title="点击定位左栏该页">
              — 第 {pg} 页 —
            </div>
            {pids.map(pid => {
              const b = byPid.get(pid);
              if (!b) return null;
              return <ZhBlock key={pid} b={b} active={activePid === pid} onJump={onJumpPid} onRetry={onRetry} />;
            })}
            {figs.map(f => (
              <div key={f.pid} className="dpv-zhfigph" data-pid={f.pid}>
                📊 [图表 · {f.zh ? f.zh.slice(0, 40) : f.en.slice(0, 40)}…] 请看左栏原版
              </div>
            ))}
          </section>
        );
      })}
      {/* 未映射段落：聚类全部完成后统一收尾展示（过程中段落还在页组间迁移，先不渲染避免闪烁） */}
      {clusterDone && unmapped.length > 0 && (
        <section className="dpv-zhgroup unmapped-group">
          <div className="dpv-zhgroup-head">— 未定位页码的段落 —</div>
          {unmapped.map(pid => {
            const b = byPid.get(pid);
            if (!b) return null;
            return <ZhBlock key={pid} b={b} active={activePid === pid} onJump={onJumpPid} onRetry={onRetry} unmapped />;
          })}
        </section>
      )}
    </div>
  );
});

const ZhBlock = memo(function ZhBlock({
  b, active, onJump, onRetry, unmapped,
}: {
  b: BlockRow;
  active: boolean;
  onJump: (pid: number) => void;
  onRetry: (pid: number) => void;
  unmapped?: boolean;
}) {
  // 渲染兜底：客套话/拒答类脏译文不当正文渲染（heading 回退原文，正文隐藏保干净）
  const dirty = b.zh ? looksLikeChitchatZh(b.zh) : false;
  const showZh = b.zh && !dirty;
  const cls = `dpv-zhpara ${b.type === 'heading' ? 'heading' : ''} ${active ? 'active' : ''} ${unmapped ? 'unmapped' : ''}`;
  if (dirty && b.type === 'heading') {
    return (
      <p className={cls} data-pid={b.pid} onClick={() => onJump(b.pid)} title="点击定位左栏原文页">
        <RichText text={b.en} />
      </p>
    );
  }
  if (!showZh) {
    return (
      <p
        className={cls}
        data-pid={b.pid}
        onClick={() => onJump(b.pid)}
        title={unmapped ? '该段未与 PDF 建立精准映射' : '点击定位左栏原文页'}
      >
        <span className="dpv-zhpending" onClick={e => { e.stopPropagation(); onRetry(b.pid); }}
          role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onRetry(b.pid); } }}
          title="点击重试翻译">
          <span className="dot" /><span className="dot" /><span className="dot" />待翻译
        </span>
      </p>
    );
  }
  return (
    <p
      className={cls}
      data-pid={b.pid}
      onClick={() => onJump(b.pid)}
      title={unmapped ? '该段未与 PDF 建立精准映射' : '点击定位左栏原文页'}
    >
      <RichText text={b.zh ?? ''} />
    </p>
  );
});

// 客套话检测（与 main.ts 守卫同规则的前端兜底）
const ZH_CHITCHAT_RE = [
  /请(?:提供|发送|输入)(?:您)?(?:需要翻译|要翻译|的英文)/,
  /请(?:提供|发送)(?:需要|要)?翻译的?(?:英文|段落|文本|内容)/,
  /没有(?:提供|输入|收到).{0,12}(?:英文|文本|段落|内容)/,
  /^(?:好的|当然|抱歉|明白了)[，,。].{0,25}(?:翻译|英文|段落)/,
  /nothing to translate|no (?:english )?text (?:provided|to translate)/i,
];
function looksLikeChitchatZh(zh: string): boolean {
  const t = zh.trim();
  if (!t) return true;
  return ZH_CHITCHAT_RE.some(re => re.test(t));
}

// ---------- 文本归一化 + 聚类匹配（沿用既有算法） ----------

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
    out.push({ pid, page, textLen: norm.length, x, y: vpH - pdfTop, w: right - x, h: Math.max(8, pdfTop - pdfBottom), pageW: vpW, pageH: vpH, lineH: Math.max(6, lineH) });
  }
  return out;
}
