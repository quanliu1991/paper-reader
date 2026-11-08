import { useEffect, useRef, useState, useCallback, memo, Fragment } from 'react';
import { useStore } from '../store';
import RichText from './RichText';
import { FigBlockBody, LocalFig } from './FigTable';
import { figAwaiting, figSrc } from '../figsrc';
import AskPanel from './AskPanel';
import CommandPalette from './CommandPalette';
import TranslatedPanel from './TranslatedPanel';
import TranslateView from './TranslateView';
import SplitPdfView from './SplitPdfView';
import ParaNotes from './ParaNotes';
import type { NoteRow } from '../store';
import { wikilinkSuggest } from '../wikilink';
import { IconBack, IconExport, IconImmersive, IconMore } from './icons';
import { toast, toastErr } from './Toast';
import { highlightHtml } from '../highlights';
import { modKeyLabel } from '../platform';
// v3 布局收敛：DualPdfView / Pdf2zhView / BilingualView 已删除（原 pdf-layout / pdf2zh / bilingual 模式）
// zh/en 单栏由 BlockRowView 直接渲染；smart = TranslateView 秒开 → mono.pdf 就绪升级 SplitPdfView

const HL_COLORS = [ // ux-lint-allow: 高亮功能色板（走 CSS 变量，随主题切换）
  { id: 'yellow', label: '黄', bg: 'var(--hl-c-yellow)' },
  { id: 'green', label: '绿', bg: 'var(--hl-c-green)' },
  { id: 'blue', label: '蓝', bg: 'var(--hl-c-blue)' },
  { id: 'pink', label: '粉', bg: 'var(--hl-c-pink)' },
];

export default function Reader() {
  const paper = useStore(s => s.currentPaper)!;
  const allBlocks = useStore(s => s.blocks);
  const blocks = allBlocks.filter(b => !(b.type === 'para' && /^\d{1,4}$/.test((b.en || '').trim())));
  const highlights = useStore(s => s.highlights);
  const notes = useStore(s => s.notes);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const translating = useStore(s => s.translating);
  const progress = useStore(s => s.translateProgress);
  const updateBlockZh = useStore(s => s.updateBlockZh);
  const updateBlockFig = useStore(s => s.updateBlockFig);
  const updateBlockFigRows = useStore(s => s.updateBlockFigRows);
  const askPanelOpen = useStore(s => s.askPanelOpen);
  const readerBack = useStore(s => s.readerBack);
  const fontSize = useStore(s => s.fontSize);
  const lineHeight = useStore(s => s.lineHeight);
  const columnWidth = useStore(s => s.columnWidth);
  const immersive = useStore(s => s.immersive);

  const [popover, setPopover] = useState<{ x: number; y: number; text: string; pid: number } | null>(null);
  // 豆包式划词快捷结果（解释/搜索/翻译）
  const [quickResult, setQuickResult] = useState<{ x: number; y: number; kind: 'explain' | 'search' | 'translate'; text: string; answer: string; loading: boolean } | null>(null);
  // 划词写笔记：浮层输入，挂靠划选所在段落
  const [noteComposer, setNoteComposer] = useState<{ x: number; y: number; pid: number; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRatioRef = useRef(0);
  const suppressSaveRef = useRef(false);

  // ---------- smart 模式：mono.pdf 就绪状态（v3 分阶，无 CLI 日志面板） ----------
  const [p2zStatus, setP2zStatus] = useState<{ cliOk: boolean; cliHint: string; exists: boolean; monoExists: boolean; generating: boolean; numPages?: number } | null>(null);
  const [p2zPct, setP2zPct] = useState<number | null>(null); // 生成进度百分比（解析子进程输出）
  const [p2zReloadKey, setP2zReloadKey] = useState(0);
  // 用户显式切换过布局则不再自动升级（尊重选择）
  const userPickedLayoutRef = useRef(false);
  useEffect(() => {
    if (typeof window.api.pdf2zhStatus !== 'function') return; // 旧 preload 兜底
    let off1: (() => void) | undefined, off2: (() => void) | undefined, off3: (() => void) | undefined;
    (async () => {
      try {
        const st = await window.api.pdf2zhStatus(paper.id);
        setP2zStatus(st);
        // 页数缓存：自动触发门控（≤30 页）与 CTA 耗时估计（约 35s/页）
        if (st?.numPages) localStorage.setItem(`paper:${paper.id}:pages`, String(st.numPages));
      } catch { /* 状态探测失败不阻塞阅读 */ }
    })();
    // 进度：仅解析子进程输出中的百分比（如 "45%"），驱动状态条，不展示日志
    off1 = window.api.onPdf2zhProgress?.((p: any) => {
      if (p.paperId !== paper.id) return;
      const m = String(p.line ?? '').match(/(\d{1,3})\s*%/);
      if (m) setP2zPct(Math.min(100, Number(m[1])));
    });
    // 完成：smart 模式且用户未手动切换 → 无缝升级原版对照（pid 锚点保位置）
    off2 = window.api.onPdf2zhDone?.((p: any) => {
      if (p.paperId !== paper.id) return;
      setP2zStatus(s => s ? { ...s, exists: true, monoExists: true, generating: false } : s);
      setP2zPct(100);
      toast('success', '原版对照已就绪');
      setP2zReloadKey(k => k + 1);
    });
    off3 = window.api.onPdf2zhError?.((p: any) => {
      if (p.paperId !== paper.id) return;
      setP2zStatus(s => s ? { ...s, generating: false } : s);
      setP2zPct(null);
      toastErr(new Error('原版对照生成失败，可稍后从工具栏重试；文本对照不受影响'));
    });
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [paper.id]);

  // ---------- A3 分阶触发：深度阅读信号（>3分钟 或 滚过30%）+ 三条件门控 → 自动生成 mono ----------
  // 门控：CLI 已装 + 正文 ≤30 页 + 设置未关（默认开）。否则仅工具栏 CTA。
  const deepReadFiredRef = useRef(false);
  useEffect(() => {
    if (deepReadFiredRef.current) return;
    const t = setTimeout(() => fireIfEligible(), 3 * 60 * 1000); // 3 分钟深度阅读
    return () => clearTimeout(t);
  }, [paper.id]);
  function fireIfEligible() {
    if (deepReadFiredRef.current) return;
    const st = useStore.getState();
    if (st.layout !== 'smart') return;
    if (localStorage.getItem('pr:p2z:auto') === '0') return; // 用户关闭自动生成
    const p2z = p2zStatus;
    if (!p2z?.cliOk || p2z.monoExists || p2z.generating) return;
    // 页数门控：论文卡 block 数粗略对应页数不可靠 → 用「读过的论文无 PDF 页数」简化：
    // 自动触发只对已确认 ≤30 页的论文放行；页数未知时不自动（CTA 兜底，避免 50 页长文静默烧 20 分钟）
    const pagesHint = Number(localStorage.getItem(`paper:${paper.id}:pages`) || 0);
    if (!pagesHint || pagesHint > 30) return;
    deepReadFiredRef.current = true;
    startPdf2zh();
  }

  const startPdf2zh = useCallback(async () => {
    if (p2zStatus?.generating) return;
    setP2zStatus(s => s ? { ...s, generating: true } : s);
    setP2zPct(null);
    try {
      await window.api.pdf2zhTranslate({ paperId: paper.id });
    } catch (e: any) {
      setP2zStatus(s => s ? { ...s, generating: false } : s);
      setP2zPct(null);
      toastErr(e);
    }
  }, [paper.id]);
  // 豆包式段落联动：选中的译文段落（保留给后续联动功能）
  const [, setSelectedPid] = useState<number | null>(null);
  // 翻译版 PDF 导出
  const [exporting, setExporting] = useState(false);
  const [digestBusy, setDigestBusy] = useState(false);
  // 工具栏「更多」菜单
  const [moreOpen, setMoreOpen] = useState(false);
  // smart 模式下 mono.pdf 已就绪 → 渲染原版对照；否则文本对照网格秒开
  const showSplit = layout === 'smart' && !!p2zStatus?.monoExists;

  // smart 模式：确保原版 PDF 可用（SplitPdfView 需要），后台自动下载不打扰
  useEffect(() => {
    if (!showSplit) return;
    let off: (() => void) | undefined;
    (async () => {
      const r = await window.api.ensurePdf(paper.id);
      if (!r.exists) {
        off = window.api.onPdfReady((p: any) => { if (p.paperId === paper.id) { /* SplitPdfView 自行探测 */ } });
      }
    })();
    return () => { off?.(); };
  }, [paper.id, showSplit]);

  // 翻译进度推送
  useEffect(() => {
    const off = window.api.onTrProgress((p: any) => {
      // err 事件（length-guard/echo-guard/skipped 等）只带 pid 不带 zh：
      // 绝不能把已有译文覆盖成空串——此前 p.zh ?? '' 的写法让 err 事件清空段落译文
      //（UI 表现为「翻译内容不全的段落」）。err 时保持现状（待翻译占位由 zh=null 决定）。
      if (p.zh && String(p.zh).trim()) {
        updateBlockZh(p.pid, p.zh);
      }
      useStore.getState().setTranslating(true, { done: p.done, total: p.total });
    });
    return off;
  }, [updateBlockZh]);

  // ---------- A2 打开即译：已配 Provider 且有未译段落 → 自动启动翻译（一次/每论文） ----------
  // 与「翻译全文」共用同一 IPC；translating 状态由进度推送驱动。失败静默（无 Provider 时用户点划词/翻译才引导）。
  const autoTrTriedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (showSplit) return; // 已在原版对照（有 mono.pdf 必有译文），无需自动翻译
    if (autoTrTriedRef.current.has(paper.id)) return;
    const st = useStore.getState();
    const untranslated = st.blocks.filter(b => b.type === 'para' && !b.zh);
    if (!untranslated.length || st.translating) return;
    autoTrTriedRef.current.add(paper.id);
    (async () => {
      st.setTranslating(true, { done: 0, total: untranslated.length });
      try {
        await window.api.translateAll({
          paperId: paper.id,
          blocks: untranslated.map(b => ({ pid: b.pid, en: b.en })),
          scope: 'untranslated',
        });
      } catch (e: any) {
        // 无 Provider：一次引导去设置；其他错误静默（TranslateView「待翻译」占位兜底）
        if (String(e?.message ?? '').includes('Provider')) {
          useStore.getState().toast({
            type: 'info', msg: '尚未配置 AI 服务，暂无法自动翻译',
            action: { label: '去设置', run: () => useStore.getState().setView('settings') },
          });
        }
      }
      finally { useStore.getState().setTranslating(false, null); }
    })();
  }, [paper.id, showSplit, blocks.length]);

  // 图表下载完成推送：主进程 downloadFiguresFor 每存一张图 send('fig:updated')。
  // 此前无人订阅 → 内存 blocks.fig_path 永不更新 → 各视图一直显示占位框（除非重开论文）。
  useEffect(() => {
    const off = window.api.onFigUpdated((p: any) => {
      if (p?.pid && p?.figPath) updateBlockFig(p.pid, p.figPath);
      if (p?.pid && p?.figRows) updateBlockFigRows(p.pid, p.figRows);
    });
    return off;
  }, [updateBlockFig, updateBlockFigRows]);

  // 进度记忆（pid 锚点，跨布局通用）：
  // 保存视口内最靠上的段落 pid；切换布局后按 pid 找到对应元素滚回去。
  // 旧的 scrollTop 方案在 PDF 模式（.dpv-scroll）与其他布局（.reader-scroll）容器不同、
  // 高度差异巨大时必然跳到错误位置。
  const anchorPidRef = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current ?? document.querySelector('.spv-pane') as HTMLElement | null;
    if (!el) return;
    // 打开恢复：优先 pid 锚点，回退旧 scrollTop
    const savedPid = Number(localStorage.getItem(`paper:${paper.id}:pid`) || 0);
    const savedTop = localStorage.getItem(`paper:${paper.id}:scroll`);
    requestAnimationFrame(() => {
      if (savedPid) {
        const t = el.querySelector(`[data-pid="${savedPid}"], [data-rowpid="${savedPid}"]`) as HTMLElement | null;
        if (t) { el.scrollTop = t.offsetTop - el.clientHeight / 3; return; }
      }
      if (savedTop) el.scrollTop = Number(savedTop);
    });
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      scrollRatioRef.current = max > 0 ? el.scrollTop / max : 0;
      clearTimeout(timer);
      timer = setTimeout(() => {
        localStorage.setItem(`paper:${paper.id}:scroll`, String(el.scrollTop));
        // 找视口内最靠上的块 pid（data-pid 或 data-rowpid）
        let topPid: number | null = null, topY = Infinity;
        el.querySelectorAll<HTMLElement>('[data-pid], [data-rowpid]').forEach(n => {
          const r = n.getBoundingClientRect();
          if (r.bottom > 60 && r.top < topY) { topY = r.top; topPid = Number(n.dataset.pid ?? n.dataset.rowpid); }
        });
        if (topPid) {
          anchorPidRef.current = topPid;
          localStorage.setItem(`paper:${paper.id}:pid`, String(topPid));
        }
        // 进度百分比入库（只增不减：回头翻不算退步）——列表页「读至 X%」数据源
        const pct = Math.round(scrollRatioRef.current * 100);
        const prev = Number(localStorage.getItem(`paper:${paper.id}:pct`) || 0);
        if (pct > prev) {
          localStorage.setItem(`paper:${paper.id}:pct`, String(pct));
          window.api.setReadPct(paper.id, pct).catch(() => { /* 进度失败不打扰阅读 */ });
          // A3 深度阅读信号：滚过 30% 且满足门控 → 自动生成原版对照（每论文一次）
          if (pct >= 30) fireIfEligible();
        }
      }, 500);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll); clearTimeout(timer);
      // 论文关闭/切换：立即上报团队进度（主进程侧 flush 缓冲；未登录时 no-op）
      const pct = Number(localStorage.getItem(`paper:${paper.id}:pct`) || 0);
      if (pct > 0) window.api.teamReportProgress({ paperId: paper.id, pct }).catch(() => {});
    };
  }, [paper.id]);

  // 布局切换时按 pid 锚点恢复阅读位置（PDF 容器异步挂载 → 轮询等待最多 3s）
  // v3：showSplit（SplitPdfView）时跳过——splitTop 由 SplitPdfView 自恢复（等值 scrollTop），
  // 此处若按文本比例再滚一次会覆盖 splitTop（写入路径 handleUserScroll）→ 恢复互相打架。
  useEffect(() => {
    if (suppressSaveRef.current || showSplit) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tryRestore = () => {
      const el = scrollRef.current ?? document.querySelector('.spv-pane') as HTMLElement | null;
      if (!el) { if (++tries < 20) timer = setTimeout(tryRestore, 150); return; }
      const pid = anchorPidRef.current ?? Number(localStorage.getItem(`paper:${paper.id}:pid`) || 0);
      if (pid) {
        const target = el.querySelector(`[data-pid="${pid}"], [data-rowpid="${pid}"]`) as HTMLElement | null;
        if (target) { el.scrollTop = target.offsetTop - el.clientHeight / 3; return; }
      }
      // SplitPdfView 无 data-pid：按滚动比例恢复（mono 与原版逐页同构，比例近似成立）
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = scrollRatioRef.current * max;
    };
    timer = setTimeout(tryRestore, 50);
    return () => clearTimeout(timer);
  }, [layout, showSplit, paper.id]);

  // 快捷键（含 PDF 模式循环）。mod = Ctrl（Win/Linux）或 Cmd（mac，metaKey）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        const cycle = ['smart', 'zh', 'en'] as const;
        const cur = useStore.getState().layout;
        const idx = cycle.indexOf(cur as any);
        useStore.getState().setLayout(cycle[(idx + 1) % cycle.length] as any);
      } else if (mod && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault();
        const st = useStore.getState();
        st.setAskPanel(!st.askPanelOpen);
      } else if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        useStore.getState().setImmersive(!useStore.getState().immersive);
      } else if (e.key === 'Escape') {
        setPopover(null);
        setMoreOpen(false);
        setNoteComposer(null);
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

  function cancelTranslate() {
    window.api.cancelTranslate(paper.id).catch(() => {});
    useStore.getState().setTranslating(false, null);
    useStore.getState().toast({ type: 'info', msg: '已取消翻译' });
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
    const text = popover.text.trim();
    const pid = popover.pid;
    const existing = useStore.getState().highlights.filter(h => h.pid === pid);
    const overlapping = existing.filter(h => {
      const prev = (h.text_en || '').trim();
      return prev.length >= 2 && (text.includes(prev) || prev.includes(text));
    });
    if (overlapping.some(h => h.text_en.trim().length > text.length)) {
      setPopover(null);
      window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'info', msg: '这段已经有更完整的划线' } }));
      return;
    }
    for (const h of overlapping) await window.api.removeHighlight(h.id);
    await window.api.addHighlight({ paperId: paper.id, pid, textEn: text, color });
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

  // 划词写笔记：打开浮层（挂靠段落）
  function openNoteComposer() {
    if (!popover) return;
    const { x, y, pid } = popover;
    setPopover(null);
    setNoteComposer({ x, y, pid, text: '' });
  }

  async function saveNote() {
    if (!noteComposer) return;
    const text = noteComposer.text.trim();
    if (!text) { setNoteComposer(null); return; }
    try {
      await window.api.addNote({ paperId: paper.id, pid: noteComposer.pid, text });
      setNoteComposer(null);
      await useStore.getState().refreshNotes(paper.id);
      window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'success', msg: '已存笔记' } }));
    } catch (e: any) {
      window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type: 'error', msg: `笔记保存失败：${e?.message ?? e}` } }));
    }
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
          if (b.fig_path && figSrc(b.fig_path)) parts.push(`<figure><img src="${figSrc(b.fig_path)}"><figcaption>${escHtml((b.fig_kind === 'table' ? '表：' : '图：') + (b.zh ?? b.en))}</figcaption></figure>`);
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

  const notesByPid = new Map<number, NoteRow[]>();
  for (const n of notes) {
    if (n.pid == null) continue;
    if (!notesByPid.has(n.pid)) notesByPid.set(n.pid, []);
    notesByPid.get(n.pid)!.push(n);
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
          <button
            className="icon-btn"
            onClick={() => {
              const st = useStore.getState();
              if (readerBack) st.setView(readerBack);
              else if (st.tabs.length > 1) st.closeTab(paper.id);
              else st.setView('list');
            }}
            title={readerBack === 'topics' ? '返回图谱' : readerBack === 'notes' || readerBack === 'knowledge' ? '返回知识' : useStore.getState().tabs.length > 1 ? '关闭此标签' : '返回论文库'}
          ><IconBack /></button>
          <span className="title">{paper.title}</span>
          {p2zStatus?.generating ? (
            <span className="p2z-chip" title="正在后台生成与原版版式一致的中文 PDF，完成后可无缝切换（阅读位置保留）">
              <span className="p2z-spin" /> 原版对照 {p2zPct != null ? `${p2zPct}%` : '生成中'}…
              <button className="link-btn" onClick={() => window.api.pdf2zhCancel?.(paper.id)}>取消</button>
            </span>
          ) : p2zStatus?.monoExists ? (
            layout === 'smart' ? (
              <span className="p2z-chip ok" title="左右版式一致，逐像素滚动同步">✓ 原版对照</span>
            ) : null
          ) : p2zStatus?.cliOk ? (
            <button className="primary slim" onClick={startPdf2zh} title="后台生成与原版版式一致的中文 PDF（自动跳过参考文献，完成后可无缝切换）">
              生成原版对照{p2zStatus.numPages ? `（约 ${Math.max(1, Math.round(p2zStatus.numPages * 35 / 60))} 分钟）` : ''}
            </button>
          ) : p2zStatus ? (
            <span className="p2z-chip" title={p2zStatus.cliHint}>原版对照需安装 pdf2zh（可选，设置页有引导）</span>
          ) : null}
          <div className="toolbar-actions">
            {!showSplit && (
              <div className="font-stepper" role="group" aria-label="字号">
                <button onClick={() => useStore.getState().setFontSize(fontSize - 1)} title="缩小字号">A−</button>
                <span className="font-val" title="当前字号（点击复位）" onClick={() => useStore.getState().setFontSize(16)}>{fontSize}</span>
                <button onClick={() => useStore.getState().setFontSize(fontSize + 1)} title="放大字号">A+</button>
              </div>
            )}
            {/* v3 三段开关：中/双/英 */}
            <div className="mode-switch" role="group" aria-label="阅读模式">
              <button className={layout === 'zh' ? 'on' : ''} onClick={() => { userPickedLayoutRef.current = true; useStore.getState().setLayout('zh'); }} title="只看中文译文">中</button>
              <button className={layout === 'smart' ? 'on' : ''} onClick={() => { userPickedLayoutRef.current = true; useStore.getState().setLayout('smart'); }} title="智能对照：文本对照秒开，原版 PDF 就绪后自动升级">双</button>
              <button className={layout === 'en' ? 'on' : ''} onClick={() => { userPickedLayoutRef.current = true; useStore.getState().setLayout('en'); }} title="只看英文原文">英</button>
            </div>
            <div className={`more-menu ${moreOpen ? 'open' : ''}`}>
              <button className="icon-btn" onClick={() => setMoreOpen(v => !v)} title="更多操作" aria-haspopup="menu" aria-expanded={moreOpen}>
                <IconMore />
              </button>
              {moreOpen && (
                <>
                  <div className="more-backdrop" onClick={() => setMoreOpen(false)} />
                  <div className="more-popover" role="menu">
                    <button role="menuitem" onClick={() => { setMoreOpen(false); useStore.getState().setImmersive(true); }}>
                      <IconImmersive /> 沉浸模式 <span className="kbd">{modKeyLabel}+Shift+F</span>
                    </button>
                    <div className="more-sep" />
                    {translating ? (
                      <button role="menuitem" onClick={() => { setMoreOpen(false); cancelTranslate(); }}>
                        取消翻译（{progress?.done ?? 0}/{progress?.total ?? 0}）
                      </button>
                    ) : (
                      <button role="menuitem" onClick={() => { setMoreOpen(false); translateAll(); }}>
                        重新翻译全文
                      </button>
                    )}
                    <div className="more-sep" />
                    <button role="menuitem" onClick={() => { setMoreOpen(false); exportTranslatedPdf(); }} disabled={exporting}>
                      <IconExport /> {exporting ? '导出中…' : '导出翻译版 PDF'}
                    </button>
                    <button role="menuitem" disabled={digestBusy} onClick={async () => {
                      setMoreOpen(false);
                      if (typeof window.api.genPaperDigest !== 'function') {
                        toast('info', '请先停掉并重新运行 npm run electron:dev，再生成精炼笔记');
                        return;
                      }
                      setDigestBusy(true);
                      try {
                        await window.api.genPaperDigest(paper.id);
                        toast('success', '已生成本篇精炼笔记，可在「沉淀」查看');
                      } catch (e: any) { toastErr(e); } finally { setDigestBusy(false); }
                    }}>
                      {digestBusy ? '生成中…' : '生成本篇精炼笔记'}
                    </button>
                    {!showSplit && (
                      <>
                        <div className="more-sep" />
                        <div className="more-row" role="group" aria-label="行距">
                          <span>行距</span>
                          <button onClick={() => useStore.getState().setLineHeight(useStore.getState().lineHeight - 0.2)} title="收紧行距">−</button>
                          <button onClick={() => useStore.getState().setLineHeight(useStore.getState().lineHeight + 0.2)} title="放宽行距">+</button>
                        </div>
                        <div className="more-row" role="group" aria-label="栏宽">
                          <span>栏宽</span>
                          <button onClick={() => useStore.getState().setColumnWidth(columnWidth === 'wide' ? 'standard' : 'wide')}>
                            {columnWidth === 'wide' ? '标准' : '加宽'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 内容 + 问答侧栏：横向 flex——AskPanel 占右侧 420px，不再叠压/挤压正文（视觉审计 03-ask-panel 修复） */}
      <div className={`reader-body-row ${askPanelOpen ? 'with-ask' : ''}`}>
        {/* v3 渲染收敛：smart(mono就绪→SplitPdfView，否则文本对照) / zh / en */}
        {showSplit ? (
          <SplitPdfView key={`split-${p2zReloadKey}`} paperId={paper.id} />
        ) : layout === 'smart' ? (
          <div
            className="reader-scroll translate-host"
            ref={scrollRef}
            onMouseUp={onMouseUp}
            style={{ fontSize: `${fontSize}px`, '--reading-lh': lineHeight } as React.CSSProperties}
          >
            <TranslateView
              blocks={blocks}
              fontSize={fontSize}
              hlByPid={hlByPid}
              translating={translating}
              paperId={paper.id}
              notesByPid={notesByPid}
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
              <Fragment key={b.pid}>
                <BlockRowView b={b} layout={layout} hlItems={hlByPid.get(b.pid) ?? []} />
                <ParaNotes notes={notesByPid.get(b.pid) ?? []} paperId={paper.id} />
              </Fragment>
            ))}
          </div>
        )}
        {askPanelOpen && <AskPanel />}
      </div>
      {immersive && (
        <div className="immersive-hint">Esc 退出沉浸模式 · 已读 {readPct}%</div>
      )}
      {popover && (
        <div
          className="sel-popover glass"
          style={{
            left: Math.min(Math.max(70, popover.x - 150), window.innerWidth - 320),
            top: Math.max(8, popover.y),
          }}
        >
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
          <button onClick={openNoteComposer} title="给这段写一条笔记">笔记</button>
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
      {noteComposer && (
        <NoteComposer
          value={noteComposer}
          onChange={setNoteComposer}
          onClose={() => setNoteComposer(null)}
          onSave={saveNote}
        />
      )}
    </div>
  );
}

// v3 B4：笔记浮层——支持 [[论文标题]] 双链自动补全
function NoteComposer({ value, onChange, onClose, onSave }: {
  value: { x: number; y: number; pid: number; text: string };
  onChange: (v: { x: number; y: number; pid: number; text: string }) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [suggest, setSuggest] = useState<{ query: string; start: number } | null>(null);
  const [selIdx, setSelIdx] = useState(0);
  const papers = useStore(s => s.papers);
  const picks = suggest ? wikilinkSuggestList(suggest.query, papers) : [];

  function applySuggest(title: string) {
    if (!suggest) return;
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? 0;
    const after = value.text.slice(caret);
    const next = `${value.text.slice(0, suggest.start)}${title}]]${after}`;
    onChange({ ...value, text: next });
    setSuggest(null);
    requestAnimationFrame(() => { ta.selectionEnd = suggest.start + title.length + 2; ta.focus(); });
  }

  return (
    <div className="note-composer glass" style={{ left: Math.max(70, Math.min(value.x - 160, window.innerWidth - 380)), top: Math.max(8, value.y + 36) }}>
      <div className="ncp-title">📝 写笔记（挂在划选所在段落）</div>
      <textarea
        ref={taRef}
        autoFocus
        value={value.text}
        placeholder="用自己的话记一句…输入 [[ 可链接其他论文"
        onChange={e => {
          onChange({ ...value, text: e.target.value });
          setSuggest(wikilinkSuggest(e.target.value, e.target.selectionStart ?? 0));
          setSelIdx(0);
        }}
        onKeyDown={e => {
          if (suggest && picks.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSelIdx(i => (i + 1) % picks.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx(i => (i - 1 + picks.length) % picks.length); return; }
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); applySuggest(picks[selIdx].title); return; }
            if (e.key === 'Escape') { setSuggest(null); return; }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave();
          if (e.key === 'Escape') onClose();
        }}
      />
      {suggest && picks.length > 0 && (
        <div className="wl-suggest">
          {picks.map((p, i) => (
            <button key={p.id} className={i === selIdx ? 'on' : ''} onMouseDown={e => { e.preventDefault(); applySuggest(p.title); }}>
              <span className="wl-title">{p.title}</span>
              <span className="wl-arxiv">{p.arxiv_id}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ncp-actions">
        <span className="hint">Ctrl/⌘+Enter 保存 · [[ 双链 · Esc 取消</span>
        <button className="ghost-btn" onClick={onClose}>取消</button>
        <button className="primary" onClick={onSave} disabled={!value.text.trim()}>保存</button>
      </div>
    </div>
  );
}

// [[query → 已导入论文建议（标题包含匹配）
function wikilinkSuggestList(query: string, papers: Array<{ id: number; title: string; arxiv_id: string }>) {
  const q = query.trim().toLowerCase();
  const src = q ? papers.filter(p => p.title.toLowerCase().includes(q)) : papers;
  return src.slice(0, 6);
}

// ---------- 段落行（memo 化：blocks 千段不卡）----------
// v3：仅 zh / en 单栏（smart 用 TranslateView，双栏对照逻辑已收敛进去）
const BlockRowView = memo(function BlockRowView({ b, layout, hlItems }: {
  b: import('../store').BlockRow;
  layout: string;
  hlItems: Array<{ text: string; color: string }>;
}) {
  const showEn = layout === 'en';
  const showZh = layout === 'zh';
  const single = true;

  const enHtml = highlightHtml(b.en, hlItems);
  const zhHtml = b.zh ? highlightHtml(b.zh, hlItems) : null;

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
                  ? zhHtml
                    ? <p className="zh-text" dangerouslySetInnerHTML={{ __html: zhHtml }} />
                    : <p className="zh-text"><RichText text={b.zh} /></p>
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
  const figUrl = figSrc(b.fig_path); // 仅本地落地形态出图，防死链
  const caption = side === 'zh' && b.zh ? b.zh : b.en;
  return (
    <figure className="paper-fig">
      {figUrl
        ? <LocalFig src={figUrl} alt={b.en.slice(0, 60)} onClick={() => setZoom(true)} />
        : b.fig_table_rows
          ? <FigBlockBody kind={b.fig_kind} rowsJson={b.fig_table_rows} />
          : b.fig_html_table || (b.fig_kind === 'table' && !b.fig_path)
            ? <div className="fig-placeholder">📊 表格 · 见原文 PDF</div>
            : figAwaiting(b.fig_path)
              ? <div className="fig-placeholder">🖼 {b.fig_kind === 'table' ? '表格' : '图'} · 图片下载中</div>
              : null}
      {caption.trim() && <figcaption><RichText text={caption} /></figcaption>}
      {zoom && figUrl && (
        <div className="fig-zoom-mask" onClick={() => setZoom(false)}>
          <LocalFig src={figUrl} alt="" onClick={e => e.stopPropagation()} />
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
