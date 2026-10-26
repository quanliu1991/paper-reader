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
  text: string;   // 簇原文（审计用）
  norm: string;   // 归一化文本（匹配用）
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

  // 2) 文档就绪 → 全页聚类 + 全局单调 DP 匹配。
  // 匹配必须全局做：顺序约束（块下标单调）只有跨整篇 PDF 才成立，逐页独立匹配必然段落穿越。
  // 性能：14 页 ×100 簇 ×90 块的 DP 在主线程 <50ms；聚类（PDF.js getTextContent）才是大头。
  // 右栏渐进上屏：聚类每完成一页就先按「页内簇阅读序」渲染该页（pid 待 DP 完成后校正），
  // 这里简单起见：先逐页聚类收集（不渲染），DP 完成后一次性 setBoxes——首屏等待 ≈ 聚类总耗时，
  // 对 14 页论文约 1-2s，可接受；长文优化（流水线 DP）后续再做。
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const blockNorms = blocksRef.current.filter(b => b.type !== 'fig')
        .map(b => ({ pid: b.pid, norm: normText(b.en) })).filter(x => x.norm.length >= 6);
      const all: TextBlockBox[] = [];
      const clusterNorms: Array<{ norm: string }> = [];
      for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
        const page = await doc.getPage(p);
        const boxes = clusterTextItems(await page.getTextContent(), page.getViewport({ scale: 1 }), p);
        for (const b of boxes) clusterNorms.push({ norm: b.norm });
        all.push(...boxes);
        if (cancelled) return;
      }
      const pids = matchPidsMonotonic(clusterNorms, blockNorms);
      all.forEach((b, i) => { b.pid = pids[i] || 0; });
      setBoxes(all);
      setClusterDone(true);
      (window as any).__dpvClusterDone = { pages: Math.min(doc.numPages, 60), matched: all.filter(b => b.pid).length };
      (window as any).__dpvBoxesPids = all.filter(b => b.pid).map(b => b.pid);
      // 映射审计：每页首个匹配簇的 PDF 原文 vs 对应 block 原文（前 80 字符），控制台可查
      const audit: any = {};
      for (const box of all) {
        if (!box.pid || audit[box.page]) continue;
        const blk = blocksRef.current.find(x => x.pid === box.pid);
        if (blk) audit[box.page] = { pdfHead: box.text.slice(0, 80), blockHead: (blk.en ?? '').replace(/\s+/g, ' ').slice(0, 80), pid: box.pid };
      }
      (window as any).__dpvMapAudit = audit;
      console.log('[dpv] 页↔段映射审计（每页首个匹配）', audit);
    })();
    return () => { cancelled = true; };
  }, [doc, enKey]);

  // 页 → pid 列表（右栏分组依据）；pid → 首次出现页（左→右定位依据）。
  // 页内顺序 = 文档顺序（seq），不是簇发现顺序——右栏永远按原文行文渲染。
  // 未匹配的段落：不再全部沉底（旧版把摘要/致谢整块丢文末，正文断层），
  // 按 seq 邻近原则插入：取它前一个已映射块的页，紧跟其后渲染。
  const { pidsByPage, unmappedSet } = useMemo(() => {
    const pidFirstPage = new Map<number, number>();
    for (const b of boxes) {
      if (!b.pid) continue;
      if (!pidFirstPage.has(b.pid)) pidFirstPage.set(b.pid, b.page);
    }
    const pageOfPid = new Map<number, number>(); // pid → 渲染页（含未映射的邻近归页）
    const unmappedPids: number[] = [];
    let lastPage = 1; // 前一个已映射块的页（seq 顺序推进）
    for (const b of blocks) {
      if (b.type === 'fig') continue;
      const mapped = pidFirstPage.get(b.pid);
      if (mapped !== undefined) {
        pageOfPid.set(b.pid, mapped);
        lastPage = mapped;
      } else {
        pageOfPid.set(b.pid, lastPage); // 邻近归页：跟前一个块同页渲染
        unmappedPids.push(b.pid);
      }
    }
    const byPage = new Map<number, number[]>();
    for (const b of blocks) {
      if (b.type === 'fig') continue;
      const pg = pageOfPid.get(b.pid);
      if (pg === undefined) continue;
      const a = byPage.get(pg) ?? []; a.push(b.pid); byPage.set(pg, a);
    }
    return { pidsByPage: byPage, unmappedSet: new Set(unmappedPids) };
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

  // 6) 滚动同步（互斥锁 + 程序化滚动标记防回环）：
  // 左→右：IntersectionObserver 找视口交集最大页，右栏滚到 data-page 首段（已在视口则不动）。
  // 右→左：右栏发生「非程序化」滚动 → 找视口顶部段落所属页 → 左栏滚到该页。
  // 防回环：程序化 scrollTo 前记录目标位置，右栏 scroll 事件命中该位置（±3px）→ 判定为联动滚动，忽略。
  const syncingRef = useRef(false);
  const progScrollRef = useRef<{ side: 'left' | 'right'; top: number } | null>(null);
  const visiblePageRef = useRef(visiblePage);
  visiblePageRef.current = visiblePage;
  const rightSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      // 右栏跟随：连续段落流模式——找 data-page=best 的第一个段落，不在视口则平滑滚过去
      withSyncLock(() => {
        const right = rightScrollRef.current;
        if (!right) return;
        const g = right.querySelector(`[data-page="${best}"]`) as HTMLElement | null;
        if (!g) return;
        const rr = right.getBoundingClientRect();
        const gr = g.getBoundingClientRect();
        if (gr.top < rr.top + 40 || gr.bottom > rr.bottom - 40) {
          const top = Math.max(0, g.offsetTop - right.offsetTop - 12);
          progScrollRef.current = { side: 'right', top };
          right.scrollTo({ top, behavior: 'smooth' });
        }
      });
    }, { root: leftScrollRef.current, threshold: [0, 0.25, 0.6] });
    hosts.forEach(el => io.observe(el));
    return () => { io.disconnect(); };
  }, [doc, numPages, mode]);

  // 6b) 右→左 滚动跟随：右栏发生用户滚动（非程序化）→ 视口顶部段落所属页 → 左栏滚到该页。
  // 防抖 200ms；程序化滚动（左栏联动/复位）通过 progScrollRef 目标位置比对排除。
  useEffect(() => {
    const right = rightScrollRef.current;
    if (!right || mode === 'en') return;
    const onScroll = () => {
      const prog = progScrollRef.current;
      if (prog && prog.side === 'right' && Math.abs(right.scrollTop - prog.top) < 4) return; // 联动滚动，忽略
      if (rightSyncTimerRef.current) clearTimeout(rightSyncTimerRef.current);
      rightSyncTimerRef.current = setTimeout(() => {
        const prog2 = progScrollRef.current;
        if (prog2 && prog2.side === 'right' && Math.abs(right.scrollTop - prog2.top) < 4) return;
        // 视口顶部往下第一个可见的带 data-page 段落
        const rr = right.getBoundingClientRect();
        const paras = right.querySelectorAll<HTMLElement>('.dpv-zhpara[data-page]');
        let target: HTMLElement | null = null;
        for (const p of paras) {
          const r = p.getBoundingClientRect();
          if (r.bottom > rr.top + 30) { target = p; break; }
        }
        const pg = target ? Number(target.dataset.page) : 0;
        if (!pg || pg === visiblePageRef.current) return;
        withSyncLock(() => {
          const left = leftScrollRef.current;
          if (!left) return;
          const t = left.querySelector(`[data-page="${pg}"]`) as HTMLElement | null;
          if (t) {
            const top = Math.max(0, t.offsetTop - left.offsetTop - 8);
            progScrollRef.current = { side: 'left', top };
            left.scrollTo({ top, behavior: 'smooth' });
          }
        });
      }, 200);
    };
    right.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      right.removeEventListener('scroll', onScroll);
      if (rightSyncTimerRef.current) clearTimeout(rightSyncTimerRef.current);
    };
  }, [mode]);

  // 7) 右→左 点击定位（方案 B 辅）：点段落 → 左栏滚到对应页
  const jumpToPage = useCallback((page: number) => {
    const left = leftScrollRef.current;
    if (!left) return;
    withSyncLock(() => {
      const t = left.querySelector(`[data-page="${page}"]`) as HTMLElement | null;
      if (t) {
        const top = Math.max(0, t.offsetTop - left.offsetTop - 8);
        progScrollRef.current = { side: 'left', top };
        left.scrollTo({ top, behavior: 'smooth' });
      }
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
              unmappedSet={unmappedSet}
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

// ---------- 右栏译文流（连续段落流：不按页切块） ----------
// 段落按文档 seq 顺序排成一条顺滑的流；每段带 data-pid + data-page（首个匹配页）。
// 左栏滚动同步：找 data-page 的第一个段落平滑滚过去，不依赖组头。

const ZhFlow = memo(function ZhFlow({
  blocks, pidsByPage, unmappedSet, numPages, activePid, activePage, clusterDone, onJumpPage, onJumpPid, onRetry,
}: {
  blocks: BlockRow[];
  pidsByPage: Map<number, number[]>;
  unmappedSet: Set<number>;
  numPages: number;
  activePid: number;
  activePage: number;
  clusterDone: boolean;
  onJumpPage: (p: number) => void;
  onJumpPid: (pid: number) => void;
  onRetry: (pid: number) => void;
}) {
  const byPid = useMemo(() => new Map(blocks.map(b => [b.pid, b])), [blocks]);
  // pid → 首个匹配页（左→右同步的锚点）
  const pageOfPid = useMemo(() => {
    const m = new Map<number, number>();
    for (const [pg, arr] of pidsByPage) for (const pid of arr) if (!m.has(pid)) m.set(pid, pg);
    return m;
  }, [pidsByPage]);

  return (
    <div className="dpv-zhflow">
      {blocks.map((b, i) => {
        if (b.type === 'fig') {
          const cap = b.zh ? b.zh.slice(0, 40) : (b.en ?? '').slice(0, 40);
          return (
            <div key={`f${b.pid}`} className="dpv-zhfigph" data-pid={b.pid}>
              📊 {cap ? `[${cap}…] ` : ''}图表 · 请看左栏原版
            </div>
          );
        }
        const pg = pageOfPid.get(b.pid);
        return (
          <ZhBlock
            key={b.pid}
            b={b}
            page={pg}
            active={activePid === b.pid}
            onJump={onJumpPid}
            onRetry={onRetry}
            unmapped={unmappedSet.has(b.pid)}
          />
        );
      })}
      {clusterDone && unmappedSet.size > 0 && (
        <div className="dpv-unmapped-hint">
          ⚠ {unmappedSet.size} 段未与 PDF 精确定位（含左侧细线的段落），已按上下文就近插入
        </div>
      )}
    </div>
  );
});

const ZhBlock = memo(function ZhBlock({
  b, page, active, onJump, onRetry, unmapped,
}: {
  b: BlockRow;
  page?: number;
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
      <p className={cls} data-pid={b.pid} data-page={page} onClick={() => onJump(b.pid)} title="点击定位左栏原文页">
        <RichText text={b.en} />
      </p>
    );
  }
  if (!showZh) {
    return (
      <p
        className={cls}
        data-pid={b.pid}
        data-page={page}
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
      data-page={page}
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

// ---------- 文本归一化 + 聚类匹配 ----------
// 连字展开：PDF 里 fi/fl/ff 等是单码位连字（ﬁ U+FB01），HTML 里是两个字符。
// 不展开则 "specific" 永远匹配不上 "speciﬁc"——前缀匹配全灭，摘要整块失配。
const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl',
  '\uFB05': 'st', '\uFB06': 'st', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-',
};

function normText(s: string): string {
  let out = s.replace(/\$\$[^$]*\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ');
  out = out.replace(/[\uFB00-\uFB06\u2010-\u2014\u2212]/g, (ch) => LIGATURES[ch] ?? ch);
  return out.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

// 簇 norm 与块 norm 的相似分（0-1）。
// 双向锚点：长簇取头部 40 字符在块中搜索（段落被切成多簇时，第 2+ 簇的文本是段落中段，
// 纯前缀比对必然 0 分——这正是旧版匹配率 15% 的原因）。
// 锚点用「滑窗匹配」：在块里找簇头出现的位置，容忍少量字符差异。
function anchorIn(hay: string, needle: string): boolean {
  if (!needle.length || hay.length < needle.length) return false;
  const n = needle.length;
  for (let i = 0; i + n <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function simScore(cn: string, bn: string): number {
  if (!cn.length || !bn.length) return 0;
  // 整块等于整簇 / 前缀一致：满分
  let prefix = 0;
  const pn = Math.min(cn.length, bn.length);
  while (prefix < pn && cn[prefix] === bn[prefix]) prefix++;
  if (prefix === cn.length && prefix === bn.length) return 1;
  if (prefix >= Math.min(cn.length, 30)) return 0.85 + prefix / Math.max(cn.length, bn.length) * 0.15;
  // 簇是块的子串（中段簇）：高置信
  if (cn.length >= 24 && bn.includes(cn)) return 0.9;
  if (cn.length >= 40 && bn.includes(cn.slice(0, 40))) return 0.85;
  // 锚点探测：簇头 24 字符在块中出现
  if (cn.length >= 24 && anchorIn(bn, cn.slice(0, 24))) return 0.75;
  // 簇尾锚点：跨栏切割的尾簇，尾部对齐块尾
  if (cn.length >= 24 && anchorIn(bn, cn.slice(-24))) return 0.7;
  // 短簇（标题类）：要求几乎全等
  if (cn.length < 24 && bn.length < 24) {
    return cn === bn ? 0.95 : prefix / Math.max(cn.length, bn.length) < 0.5 ? 0 : prefix / Math.max(cn.length, bn.length);
  }
  return prefix / Math.max(cn.length, bn.length) >= 0.5 ? 0.5 * prefix / Math.max(cn.length, bn.length) : 0;
}

// 单调 DP 匹配：簇（PDF 阅读顺序）× 块（文档顺序）。
// 核心不变量：分配给簇的块下标单调不减。末尾章节在数学上不可能被映射到第 1 页——
// 它前面的所有簇必须先消耗掉前面的块（分数不够就跳过簇，绝不回头）。
// dp[ci][bi] = 处理完前 ci 个簇、块指针在 bi 的最大总分；转移 = 跳过簇 / 跳过块 / 匹配。
function matchPidsMonotonic(
  clusters: Array<{ norm: string }>,
  blockNorms: Array<{ pid: number; norm: string }>,
): number[] {
  const C = clusters.length, B = blockNorms.length;
  const result = new Array<number>(C).fill(0);
  if (!C || !B) return result;

  // 相似度（只对达标的组合记分）
  const TH = 0.45;
  const W = B + 1;
  const sim = new Float64Array(C * B);
  for (let ci = 0; ci < C; ci++) {
    const cn = clusters[ci].norm;
    if (cn.length < 6) continue;
    for (let bi = 0; bi < B; bi++) {
      const bn = blockNorms[bi].norm;
      if (bn.length < 6) continue;
      sim[ci * B + bi] = simScore(cn, bn);
    }
  }

  const NEG = -1e9;
  const dp = new Float64Array((C + 1) * W).fill(NEG);
  const move = new Int8Array((C + 1) * W); // 0=跳过簇 1=跳过块 2=匹配(块前进) 3=续簇(块不前进)
  dp[0] = 0;
  for (let ci = 0; ci <= C; ci++) {
    for (let bi = 0; bi <= B; bi++) {
      const cur = dp[ci * W + bi];
      if (cur === NEG) continue;
      if (ci < C && cur > dp[(ci + 1) * W + bi]) { dp[(ci + 1) * W + bi] = cur; move[(ci + 1) * W + bi] = 0; }
      if (bi < B && cur > dp[ci * W + bi + 1]) { dp[ci * W + bi + 1] = cur; move[ci * W + bi + 1] = 1; }
      if (ci < C && bi < B) {
        const s = sim[ci * B + bi];
        if (s >= TH) {
          const v = cur + s * 2 - 0.02; // 低相似匹配是负收益（s<0.01 时 v<cur）
          if (v > dp[(ci + 1) * W + bi + 1]) { dp[(ci + 1) * W + bi + 1] = v; move[(ci + 1) * W + bi + 1] = 2; }
          // 续簇：PDF 把一个段落物理切成多簇（跨列/跨页），后续簇继续挂同一块，块指针不前进
          const v2 = cur + s * 1.2 - 0.05;
          if (v2 > dp[(ci + 1) * W + bi]) { dp[(ci + 1) * W + bi] = v2; move[(ci + 1) * W + bi] = 3; }
        }
      }
    }
  }
  // 回溯：从 (C, B) 走回 (0, 0)
  let ci = C, bi = B;
  while (ci > 0 || bi > 0) {
    const mv = move[ci * W + bi];
    if (mv === 2) { result[ci - 1] = blockNorms[bi - 1].pid; ci--; bi--; }
    else if (mv === 3) { result[ci - 1] = blockNorms[bi - 1].pid; ci--; }
    else if (mv === 1) bi--;
    else if (mv === 0) ci--;
    else break; // 不可达
  }
  return result;
}

function clusterTextItems(tc: any, vp1: any, page: number): TextBlockBox[] {
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
  // 阅读序：单栏页（行中点全在一侧）按 y 降序；双栏页先左列（col 0）y 降序、再右列 y 降序
  const colOf = (l: { items: any[] }) => Math.min(...l.items.map(i => i.transform[4])) < vpW / 2 ? 0 : 1;
  const twoCol = new Set(splitLines.map(colOf)).size > 1;
  const lines2 = splitLines.slice().sort((a, b) => {
    const ca = colOf(a), cb = colOf(b);
    if (twoCol && ca !== cb) return ca - cb;
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
    out.push({ pid: 0, page, textLen: norm.length, x, y: vpH - pdfTop, w: right - x, h: Math.max(8, pdfTop - pdfBottom), pageW: vpW, pageH: vpH, lineH: Math.max(6, lineH), text, norm });
  }
  return out;
}
