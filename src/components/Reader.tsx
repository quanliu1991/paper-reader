import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useStore } from '../store';
import RichText from './RichText';
import AskPanel from './AskPanel';
import CommandPalette from './CommandPalette';
import TranslatedPanel from './TranslatedPanel';
import TranslateView from './TranslateView';
import BilingualView from './BilingualView';
import DualPdfView from './DualPdfView';
import { IconBack, IconExport, IconImmersive } from './icons';

const HL_COLORS = [
  { id: 'yellow', label: '黄', bg: '#fff3b0' },
  { id: 'green', label: '绿', bg: '#c8e6c9' },
  { id: 'blue', label: '蓝', bg: '#bbdefb' },
  { id: 'pink', label: '粉', bg: '#f8bbd0' },
];

export default function Reader() {
  const paper = useStore(s => s.currentPaper)!;
  const blocks = useStore(s => s.blocks);
  const highlights = useStore(s => s.highlights);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const translating = useStore(s => s.translating);
  const progress = useStore(s => s.translateProgress);
  const updateBlockZh = useStore(s => s.updateBlockZh);
  const askPanelOpen = useStore(s => s.askPanelOpen);
  const fontSize = useStore(s => s.fontSize);
  const columnWidth = useStore(s => s.columnWidth);
  const immersive = useStore(s => s.immersive);

  const [popover, setPopover] = useState<{ x: number; y: number; text: string; pid: number } | null>(null);
  // 豆包式划词快捷结果（解释/搜索/翻译）
  const [quickResult, setQuickResult] = useState<{ x: number; y: number; kind: 'explain' | 'search' | 'translate'; text: string; answer: string; loading: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRatioRef = useRef(0);
  const suppressSaveRef = useRef(false);

  // ---------- PDF 原版模式状态 ----------
  const [pdfReady, setPdfReady] = useState(false);
  const [pageMap, setPageMap] = useState<Record<number, number> | null>(null);
  // 豆包式段落联动：选中的译文段落（保留给后续联动功能）
  const [, setSelectedPid] = useState<number | null>(null);
  // 翻译版 PDF 导出
  const [exporting, setExporting] = useState(false);
  const isPdfLayout = layout === 'pdf-layout';

  // 打开论文时探测 PDF + 构建 pageMap
  useEffect(() => {
    if (!isPdfLayout) return;
    let off: (() => void) | undefined;
    (async () => {
      const r = await window.api.ensurePdf(paper.id);
      if (r.exists) {
        setPdfReady(true);
        const pm = await window.api.pdfPageMap(paper.id);
        if (pm.exists && pm.map && Object.keys(pm.map).length) setPageMap(pm.map);
      } else {
        // 等后台下载
        off = window.api.onPdfReady(async (p: any) => {
          if (p.paperId !== paper.id) return;
          setPdfReady(true);
          const pm = await window.api.pdfPageMap(paper.id);
          if (pm.exists && pm.map && Object.keys(pm.map).length) setPageMap(pm.map);
        });
      }
    })();
    return () => { off?.(); };
  }, [paper.id, isPdfLayout]);

  // 翻译进度推送
  useEffect(() => {
    const off = window.api.onTrProgress((p: any) => {
      updateBlockZh(p.pid, p.zh ?? '');
      useStore.getState().setTranslating(true, { done: p.done, total: p.total });
    });
    return off;
  }, [updateBlockZh]);

  // 进度记忆：滚动防抖保存 + 打开恢复
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = localStorage.getItem(`paper:${paper.id}:scroll`);
    if (saved) {
      requestAnimationFrame(() => { el.scrollTop = Number(saved); });
    }
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      scrollRatioRef.current = max > 0 ? el.scrollTop / max : 0;
      clearTimeout(timer);
      timer = setTimeout(() => {
        localStorage.setItem(`paper:${paper.id}:scroll`, String(el.scrollTop));
      }, 500);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timer); };
  }, [paper.id]);

  // 布局切换时按比例恢复滚动位置
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || suppressSaveRef.current) return;
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = scrollRatioRef.current * max;
    });
  }, [layout]);

  // 快捷键（含 PDF 模式循环）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        const cycle = ['translate', 'bilingual', 'pdf-layout', 'zh'] as const;
        const cur = useStore.getState().layout;
        const idx = cycle.indexOf(cur as any);
        useStore.getState().setLayout(cycle[(idx + 1) % cycle.length] as any);
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault();
        const st = useStore.getState();
        st.setAskPanel(!st.askPanelOpen);
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        useStore.getState().setImmersive(!useStore.getState().immersive);
      } else if (e.key === 'Escape') {
        setPopover(null);
        if (useStore.getState().immersive) useStore.getState().setImmersive(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function translateAll() {
    const untranslated = blocks.filter(b => b.type === 'para' && !b.zh);
    const targets = untranslated.length ? untranslated : blocks.filter(b => b.type === 'para');
    if (!targets.length) return;
    useStore.getState().setTranslating(true, { done: 0, total: targets.length });
    try {
      await window.api.translateAll({
        paperId: paper.id,
        blocks: targets.map(b => ({ pid: b.pid, en: b.en })),
        scope: untranslated.length ? 'untranslated' : 'all',
      });
    } finally {
      useStore.getState().setTranslating(false, null);
    }
  }

  async function translateOne(pid: number, en: string) {
    await window.api.translateAll({ paperId: paper.id, blocks: [{ pid, en }], scope: 'all' });
    useStore.getState().setTranslating(false, null);
  }

  // 划词
  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || sel.isCollapsed || text.length < 2) { setPopover(null); return; }
    let node: Node | null = sel.anchorNode;
    let pid: number | null = null;
    while (node && node !== (scrollRef.current as any)) {
      const el = node as HTMLElement;
      if (el.dataset && el.dataset.pid) { pid = Number(el.dataset.pid); break; }
      node = node.parentNode;
    }
    if (pid == null) { setPopover(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setPopover({ x: rect.left + rect.width / 2, y: rect.top - 48, text, pid });
  }, []);

  async function saveHighlight(color: string) {
    if (!popover) return;
    await window.api.addHighlight({ paperId: paper.id, pid: popover.pid, textEn: popover.text, color });
    setPopover(null);
    const hls = await window.api.listHighlights(paper.id);
    useStore.setState({ highlights: hls });
    window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'success', msg: '已高亮' } }));
  }

  function askSelection() {
    if (!popover) return;
    useStore.getState().setAskPanel(true, { pid: popover.pid, text: popover.text });
    setPopover(null);
  }

  // 豆包式划词三键：解释 / 搜索 / 翻译（行内浮层出结果，不打断阅读）
  async function runQuick(kind: 'explain' | 'search' | 'translate') {
    if (!popover) return;
    const { x, y, text } = popover;
    setPopover(null);
    setQuickResult({ x, y, kind, text, answer: '', loading: true });
    try {
      const answer = await window.api.quickAction({ kind, text, context: paper.title });
      setQuickResult(q => q && { ...q, answer, loading: false });
    } catch (e: any) {
      setQuickResult(q => q && { ...q, answer: `⚠ ${e?.message ?? '失败'}`, loading: false });
    }
  }

  // 导出翻译版 PDF（学术排版，图表内联）
  async function exportTranslatedPdf() {
    if (exporting) return;
    const translated = blocks.filter(b => b.zh || b.type === 'fig');
    if (!translated.some(b => b.zh)) {
      window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'info', msg: '还没有译文，先点「翻译全文」' } }));
      return;
    }
    setExporting(true);
    try {
      const parts: string[] = [`<h1 class="doc-title">${escHtml(paper.title)}</h1>`, `<div class="doc-meta">${escHtml(paper.authors ?? '')} · arXiv ${escHtml(paper.arxiv_id ?? '')} · Paper Reader 中译版</div>`];
      for (const b of translated) {
        if (b.type === 'heading') {
          parts.push(`<h${Math.min(3, b.level + 1)}>${escHtml(b.zh ?? b.en)}</h${Math.min(3, b.level + 1)}>`);
        } else if (b.type === 'fig') {
          if (b.fig_path) parts.push(`<figure><img src="local-figure://${b.fig_path}"><figcaption>${escHtml((b.fig_kind === 'table' ? '表：' : '图：') + (b.zh ?? b.en))}</figcaption></figure>`);
        } else {
          parts.push(`<p>${zhToHtml(b.zh ?? '')}</p>`);
        }
      }
      const r = await window.api.exportTranslatedPdf({ paperId: paper.id, html: parts.join('\n'), title: paper.title });
      if (r.saved) window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'success', msg: `已导出：${r.filePath}` } }));
    } catch (e: any) {
      window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'error', msg: `导出失败：${e?.message ?? e}` } }));
    } finally {
      setExporting(false);
    }
  }

  async function saveFlashcard() {
    if (!popover) return;
    await window.api.saveFlashcard({ paperId: paper.id, pid: popover.pid, front: popover.text, back: '' });
    setPopover(null);
    window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'success', msg: '已存闪卡（可在复习页补答案，或让 AI 生成）' } }));
  }

  function copySelection() {
    if (!popover) return;
    navigator.clipboard.writeText(popover.text);
    setPopover(null);
    window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'success', msg: '已复制' } }));
  }

  const hlByPid = new Map<number, Array<{ text: string; color: string }>>();
  for (const h of highlights) {
    if (!hlByPid.has(h.pid)) hlByPid.set(h.pid, []);
    hlByPid.get(h.pid)!.push({ text: h.text_en, color: h.color });
  }

  const readPct = Math.round(scrollRatioRef.current * 100);

  return (
    <div className={`reader-page ${immersive ? 'immersive' : ''}`}>
      {/* 翻译进度细条 */}
      {translating && (
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${progress?.total ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div>
      )}
      {!immersive && (
        <div className="reader-toolbar">
          <button className="icon-btn" onClick={() => useStore.getState().setView('list')} title="返回论文库"><IconBack /></button>
          <span className="title">{paper.title}</span>
          <div className="mode-switch">
            <button onClick={() => setLayout('translate')} className={layout === 'translate' ? 'active' : ''} title="左右对照：段落逐行双语">对照</button>
            <button onClick={() => setLayout('bilingual')} className={layout === 'bilingual' ? 'active' : ''} title="双语书：一段英文下紧跟一段中文">双语</button>
            <button onClick={() => setLayout('pdf-layout')} className={layout === 'pdf-layout' ? 'active' : ''} title="PDF 阅读：原版排版，译文原位覆盖">PDF 阅读</button>
            <button onClick={() => setLayout('zh')} className={layout === 'zh' ? 'active' : ''} title="纯中文译文">译文</button>
          </div>
          <div className="toolbar-actions">
            {layout !== 'pdf-layout' && (
              <>
                <button onClick={() => useStore.getState().setFontSize(fontSize - 1)} title="缩小字号">A-</button>
                <button onClick={() => useStore.getState().setFontSize(fontSize + 1)} title="放大字号">A+</button>
                <button onClick={() => useStore.getState().setColumnWidth(columnWidth === 'wide' ? 'standard' : 'wide')} title="切换栏宽">
                  {columnWidth === 'wide' ? '⇤⇥' : '⇤ ⇥'}
                </button>
              </>
            )}
            <button className="icon-btn" onClick={() => useStore.getState().setImmersive(true)} title="沉浸模式 Ctrl+Shift+F"><IconImmersive /></button>
            <button className="icon-btn" onClick={exportTranslatedPdf} title="导出翻译版 PDF" disabled={exporting}>
              {exporting ? '…' : <IconExport />}
            </button>
            <button className="primary" onClick={translateAll} disabled={translating}>
              {translating ? `翻译中 ${progress?.done ?? 0}/${progress?.total ?? 0}` : '翻译全文'}
            </button>
          </div>
        </div>
      )}
      {layout === 'pdf-layout' ? (
        pdfReady
          ? <DualPdfView paperId={paper.id} blocks={blocks} onMouseUp={onMouseUp} />
          : <div className="reader-scroll"><div className="pdf-loading" style={{ padding: '120px 0', textAlign: 'center' }}>PDF 下载中…（首次导入论文时后台自动下载，稍后重开）</div></div>
      ) : layout === 'translate' ? (
        <div
          className="reader-scroll translate-host"
          ref={scrollRef}
          onMouseUp={onMouseUp}
        >
          <TranslateView
            blocks={blocks}
            fontSize={fontSize}
            hlByPid={hlByPid}
            translating={translating}
          />
        </div>
      ) : layout === 'bilingual' ? (
        <div
          className={`reader-scroll bilingual-host ${columnWidth === 'standard' ? 'narrow' : ''}`}
          ref={scrollRef}
          onMouseUp={onMouseUp}
          style={{ fontSize: `${fontSize}px` }}
        >
          <BilingualView
            blocks={blocks}
            fontSize={fontSize}
            hlByPid={hlByPid}
          />
        </div>
      ) : (
        <div
          className={`reader-scroll ${columnWidth === 'standard' ? 'narrow' : ''} fs-${fontSize}`}
          ref={scrollRef}
          onMouseUp={onMouseUp}
          style={{ fontSize: `${fontSize}px` }}
        >
          {blocks.map(b => (
            <BlockRowView key={b.pid} b={b} layout={layout} hlItems={hlByPid.get(b.pid) ?? []} />
          ))}
        </div>
      )}
      {immersive && (
        <div className="immersive-hint">Esc 退出沉浸模式 · 已读 {readPct}%</div>
      )}
      {askPanelOpen && <AskPanel />}
      {popover && (
        <div className="sel-popover glass" style={{ left: Math.max(70, popover.x - 150), top: Math.max(8, popover.y) }}>
          <button className="ai-btn" onClick={() => runQuick('explain')} title="AI 解释这个概念">解释</button>
          <button className="ai-btn" onClick={() => runQuick('search')} title="联网搜索相关背景">搜索</button>
          <button className="ai-btn" onClick={() => runQuick('translate')} title="翻译选中的句子">翻译</button>
          <span className="pop-sep" />
          {HL_COLORS.map(c => (
            <button key={c.id} className="hl-color-btn" style={{ background: c.bg }} onClick={() => saveHighlight(c.id)} title={`高亮-${c.label}`} />
          ))}
          <span className="pop-sep" />
          <button onClick={copySelection} title="复制">⧉</button>
          <button className="primary" onClick={askSelection} title="提问">提问</button>
          <button onClick={saveFlashcard} title="存为闪卡">闪卡</button>
        </div>
      )}
      {quickResult && (
        <div className="quick-result glass" style={{ left: Math.max(70, quickResult.x - 220), top: quickResult.y + 36 }}>
          <div className="qr-head">
            <span className={`qr-kind ${quickResult.kind}`}>{quickResult.kind === 'explain' ? '解释' : quickResult.kind === 'search' ? '搜索' : '翻译'}</span>
            <span className="qr-text">{quickResult.text.slice(0, 60)}{quickResult.text.length > 60 ? '…' : ''}</span>
            <button className="qr-close" onClick={() => setQuickResult(null)}>×</button>
          </div>
          <div className="qr-body">
            {quickResult.loading
              ? <span className="qr-loading">思考中…</span>
              : <RichText text={quickResult.answer} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 段落行（memo 化：blocks 千段不卡）----------
const BlockRowView = memo(function BlockRowView({ b, layout, hlItems }: {
  b: import('../store').BlockRow;
  layout: string;
  hlItems: Array<{ text: string; color: string }>;
}) {
  const showEn = layout === 'dual' || layout === 'en';
  const showZh = layout === 'dual' || layout === 'zh';
  const single = layout !== 'dual';

  const enHtml = hlItems.length ? markHighlights(b.en, hlItems) : undefined;

  return (
    <div className="block-row" data-rowpid={b.pid} data-pid={b.pid}>
      <div className={`block-pair ${single ? 'single' : ''}`}>
        {showEn && (
          <div className={`blk en ${b.type}`} data-pid={b.pid}>
            {b.type === 'heading'
              ? <div className="en-text heading"><RichText text={b.en} /></div>
              : b.type === 'fig'
                ? <FigureView b={b} side="en" />
                : <p className="en-text">{enHtml ? <span dangerouslySetInnerHTML={{ __html: enHtml }} /> : <RichText text={b.en} />}</p>
            }
          </div>
        )}
        {showZh && (
          <div className={`blk zh ${b.type}`}>
            {b.type === 'heading'
              ? <div className="zh-text">{b.zh ?? '—'}</div>
              : b.type === 'fig'
                ? <FigureView b={b} side="zh" />
                : b.zh
                  ? <p className="zh-text"><RichText text={b.zh} /></p>
                  : <p className="zh-pending">待翻译</p>
            }
          </div>
        )}
      </div>
    </div>
  );
});

function FigureView({ b, side }: { b: import('../store').BlockRow; side: 'en' | 'zh' }) {
  const [zoom, setZoom] = useState(false);
  const figUrl = b.fig_path ? `local-figure://${b.fig_path}` : null;
  const caption = side === 'zh' && b.zh ? b.zh : b.en;
  return (
    <figure className="paper-fig">
      {figUrl
        ? <img src={figUrl} alt={b.en.slice(0, 60)} loading="lazy" onClick={() => setZoom(true)} />
        : <div className="fig-placeholder">{b.fig_kind === 'table' ? '📊' : '🖼'} {b.fig_kind === 'table' ? '表格' : '图'}</div>}
      <figcaption><RichText text={caption} /></figcaption>
      {zoom && figUrl && (
        <div className="fig-zoom-mask" onClick={() => setZoom(false)}>
          <img src={figUrl} alt="" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </figure>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 导出用：转义 + 公式占位（printToPDF 无 KaTeX，保留 $...$ 原文）
function zhToHtml(s: string): string {
  return escapeHtml(s);
}
const escHtml = escapeHtml;

function markHighlights(en: string, items: Array<{ text: string; color: string }>): string {
  let html = escapeHtml(en);
  for (const it of items) {
    const esc = escapeHtml(it.text.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      html = html.replace(new RegExp(esc), m =>
        `<mark class="hl" style="background:${colorOf(it.color)}">${m}</mark>`);
    } catch { /* skip */ }
  }
  return html;
}

function colorOf(id: string): string {
  return HL_COLORS.find(c => c.id === id)?.bg ?? '#fff3b0';
}
