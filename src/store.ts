import { create } from 'zustand';

export interface PaperRow {
  id: number; arxiv_id: string; title: string; authors: string;
  source_url: string; import_type: string; created_at: string;
  last_opened_at?: string | null;
  block_count: number; translated_count: number; highlight_count: number;
  summary?: string | null;
  read_pct?: number | null;
  status?: string;   // unread | reading | done | deep（默认 unread）
  tags?: string;     // JSON 数组字符串，如 ["serving","kv-cache"]
  file_path?: string | null;  // 本地论文库登记的 PDF 绝对路径（NULL = 非本地导入）
}

export interface BlockRow {
  pid: number; seq: number; type: 'heading' | 'para' | 'fig'; level: number;
  en: string; fig_path: string | null; fig_kind?: 'figure' | 'table'; zh: string | null;
  fig_html_table?: 0 | 1 | boolean; // HTML 表格实体（无图可下）：渲染层只展示图注，不显示「下载中」占位
  fig_table_rows?: string | null;   // 表格数据 JSON [row][cell]（ltx_tabular 提取），渲染层还原真表格
}

export interface HighlightRow {
  id: number; paper_id: number; pid: number; text_en: string; note: string;
  color: string; created_at: string;
  paper_title?: string; arxiv_id?: string;
}

export interface NoteRow {
  id: number; paper_id: number; pid: number | null; text: string;
  created_at: string; updated_at: string;
  paper_title?: string; arxiv_id?: string;
}

export interface QaRow {
  id: number; paper_id: number; highlight_id: number | null; pid: number | null;
  question: string; answer: string; provider: string; model: string; created_at: string;
  paper_title?: string; arxiv_id?: string;
}

export interface ProviderRow {
  id: number; name: string; protocol: 'openai' | 'anthropic';
  base_url: string; api_key: string; model: string; is_default: number;
}

export interface ToastMsg { id: number; type: 'success' | 'error' | 'info'; msg: string; action?: { label: string; run: () => void } }

type View = 'list' | 'reader' | 'settings' | 'review' | 'topics' | 'notes' | 'knowledge';

// v3 B2 标签页：每篇论文一个标签；数据按 paperId 分桶缓存（切标签零重载）
export interface TabInfo { id: number; title: string }
interface PaperBucket { paper: PaperRow; blocks: BlockRow[]; highlights: HighlightRow[]; notes: NoteRow[]; qaList: QaRow[] }

interface Store {
  view: View;
  papers: PaperRow[];
  // ---- 标签页工作区（B2）：currentPaper/blocks/... 为活动标签的派生视图，兼容既有组件 ----
  tabs: TabInfo[];
  activeTabId: number | null;
  paperBuckets: Record<number, PaperBucket>;
  currentPaper: PaperRow | null;
  blocks: BlockRow[];
  highlights: HighlightRow[];
  notes: NoteRow[];
  qaList: QaRow[];
  // 阅读状态
  // v3 布局收敛：smart（智能对照，默认）/ zh（纯中文）/ en（纯英文）
  // 旧 10 布局一次性迁移：任何旧值（translate/bilingual/dual/pdf-dual/pdf/pdf-layout/pdf2zh/pdf-split）→ smart
  layout: 'smart' | 'zh' | 'en';
  translating: boolean;
  translateProgress: { done: number; total: number } | null;
  fontSize: number;
  lineHeight: number;   // 1.4–2.4，作用于文档流视图（translate/bilingual/zh）
  columnWidth: 'wide' | 'standard';
  immersive: boolean;
  paletteOpen: boolean;
  toasts: ToastMsg[];
  // 侧栏问答
  askPanelOpen: boolean;
  pendingSelection: { pid: number; text: string } | null;
  // 从主题库或沉淀页打开论文后，返回键回到来处
  readerBack: View | null;
  openTopicId: number | null;
  // actions
  setView: (v: View) => void;
  loadPapers: () => Promise<void>;
  openPaper: (id: number) => Promise<void>;
  // B2 标签页：已有标签→聚焦；无→开新标签（加载后入桶）
  openTab: (id: number) => Promise<void>;
  activateTab: (id: number) => void;
  closeTab: (id: number) => void;
  refreshNotes: (paperId: number) => Promise<void>;
  setLayout: (l: Store['layout']) => void;
  setFontSize: (n: number) => void;
  setLineHeight: (n: number) => void;
  setColumnWidth: (w: 'wide' | 'standard') => void;
  setImmersive: (b: boolean) => void;
  setTranslating: (b: boolean, p?: { done: number; total: number } | null) => void;
  updateBlockZh: (pid: number, zh: string) => void;
  updateBlockFig: (pid: number, figPath: string) => void;
  updateBlockFigRows: (pid: number, figRows: string) => void;
  _patchBlocks: (fn: (blocks: BlockRow[]) => BlockRow[]) => void;
  setAskPanel: (open: boolean, sel?: { pid: number; text: string } | null) => void;
  toast: (t: Omit<ToastMsg, 'id'>) => void;
  dismissToast: (id: number) => void;
}

export const useStore = create<Store>((set, get) => ({
  view: 'list',
  papers: [],
  // ---- B2 标签页工作区 ----
  tabs: [],
  activeTabId: null,
  paperBuckets: {},
  currentPaper: null,
  blocks: [],
  highlights: [],
  notes: [],
  qaList: [],
  // 布局选择持久化：smart 智能对照（文本网格秒开 → mono.pdf 就绪后升级原版对照）；旧值一次性迁移
  layout: ((v: string | null): Store['layout'] => (v === 'zh' || v === 'en') ? v : 'smart')(localStorage.getItem('pr:layout')),
  translating: false,
  translateProgress: null,
  fontSize: 15,
  lineHeight: Number(localStorage.getItem('pr:lineHeight')) || 1.8,
  columnWidth: 'wide',
  immersive: false,
  paletteOpen: false,
  toasts: [],
  askPanelOpen: false,
  pendingSelection: null,
  readerBack: null,
  openTopicId: null,

  setView: (v) => set({ view: v, immersive: false }),
  loadPapers: async () => {
    const papers = await window.api.listPapers();
    set({ papers });
  },
  openPaper: async (id) => { await get().openTab(id); },
  // B2：打开论文 = 已有标签聚焦，否则开新标签（数据入桶后激活）
  openTab: async (id) => {
    const st = get();
    if (st.tabs.some(t => t.id === id)) { st.activateTab(id); return; }
    const paper = await window.api.getPaper(id);
    if (!paper) {
      get().toast({ type: 'error', msg: '论文不存在或已被删除' });
      return;
    }
    // 返回键记忆：从图谱/知识页进入时记住来处（与旧 openPaper 行为一致）
    const from = get().view;
    const readerBack = from === 'reader'
      ? get().readerBack
      : (from === 'topics' || from === 'knowledge' || from === 'notes' ? from : null);
    // 分桶缓存：命中则零重载直接激活
    let bucket = st.paperBuckets[id];
    if (!bucket) {
      const blocks = await window.api.getBlocks(id);
      const highlights = await window.api.listHighlights(id);
      const notes = await window.api.listPaperNotes(id);
      const qaList = await window.api.listQa(id);
      bucket = { paper, blocks, highlights, notes, qaList };
    } else {
      bucket = { ...bucket, paper }; // 元信息刷新（进度/状态）
    }
    const tabs = [...st.tabs, { id, title: paper.title }];
    // 标签数上限 8（Obsidian 式克制，防内存失控）
    let paperBuckets = { ...st.paperBuckets, [id]: bucket };
    if (tabs.length > 8) {
      const dropped = tabs.slice(0, tabs.length - 8).map(t => t.id)
        .filter(did => did !== id && !get().tabs.some(t => t.id === did && t.id === get().activeTabId));
      for (const d of dropped) delete paperBuckets[d];
    }
    set({
      tabs: tabs.slice(-8), paperBuckets, activeTabId: id,
      currentPaper: bucket.paper, blocks: bucket.blocks,
      highlights: bucket.highlights, notes: bucket.notes, qaList: bucket.qaList,
      view: 'reader', paletteOpen: false, readerBack,
    });
    localStorage.setItem('pr:tabs', JSON.stringify(tabs.slice(-8)));
    localStorage.setItem('pr:tabs:active', String(id));
  },
  activateTab: (id) => {
    const st = get();
    const b = st.paperBuckets[id];
    if (!b) return;
    set({
      activeTabId: id, view: 'reader',
      currentPaper: b.paper, blocks: b.blocks,
      highlights: b.highlights, notes: b.notes, qaList: b.qaList,
    });
    localStorage.setItem('pr:tabs:active', String(id));
  },
  closeTab: (id) => {
    const st = get();
    const idx = st.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tabs = st.tabs.filter(t => t.id !== id);
    const paperBuckets = { ...st.paperBuckets };
    delete paperBuckets[id];
    if (st.activeTabId === id) {
      // 关闭活动标签：聚焦相邻标签；无标签回列表
      const next = tabs[Math.min(idx, tabs.length - 1)];
      if (next) {
        const b = paperBuckets[next.id];
        set({
          tabs, paperBuckets, activeTabId: next.id,
          currentPaper: b?.paper ?? null, blocks: b?.blocks ?? [],
          highlights: b?.highlights ?? [], notes: b?.notes ?? [], qaList: b?.qaList ?? [],
          view: 'reader',
        });
        localStorage.setItem('pr:tabs:active', String(next.id));
      } else {
        set({ tabs, paperBuckets, activeTabId: null, currentPaper: null, blocks: [], highlights: [], notes: [], qaList: [], view: 'list' });
        localStorage.removeItem('pr:tabs:active');
      }
    } else {
      set({ tabs, paperBuckets });
    }
    localStorage.setItem('pr:tabs', JSON.stringify(tabs));
  },
  refreshNotes: async (paperId) => {
    const notes = await window.api.listPaperNotes(paperId);
    const st = get();
    const paperBuckets = { ...st.paperBuckets };
    if (paperBuckets[paperId]) paperBuckets[paperId] = { ...paperBuckets[paperId], notes };
    set({ notes, paperBuckets });
  },
  setLayout: (l) => { localStorage.setItem('pr:layout', l); set({ layout: l }); },
  setFontSize: (n) => set({ fontSize: Math.max(12, Math.min(22, n)) }),
  setLineHeight: (n) => { const v = Math.max(1.4, Math.min(2.4, Math.round(n * 10) / 10)); localStorage.setItem('pr:lineHeight', String(v)); set({ lineHeight: v }); },
  setColumnWidth: (w) => set({ columnWidth: w }),
  setImmersive: (b) => set({ immersive: b }),
  setTranslating: (b, p = null) => set({ translating: b, translateProgress: p }),
  // B2：块级更新同步写入活动标签的桶（切标签不丢翻译/图表进度）
  _patchBlocks: (fn: (blocks: BlockRow[]) => BlockRow[]) => {
    set(s => {
      const blocks = fn(s.blocks);
      const aid = s.activeTabId;
      const paperBuckets = aid && s.paperBuckets[aid]
        ? { ...s.paperBuckets, [aid]: { ...s.paperBuckets[aid], blocks } }
        : s.paperBuckets;
      return { blocks, paperBuckets };
    });
  },
  updateBlockZh: (pid, zh) => {
    get()._patchBlocks(bs => bs.map(b => b.pid === pid ? { ...b, zh } : b));
  },
  updateBlockFig: (pid, figPath) => {
    // 图表下载完成推送（fig:updated）：内存 blocks 同步，否则各视图一直拿旧 fig_path 显示占位框
    get()._patchBlocks(bs => bs.map(b => b.pid === pid ? { ...b, fig_path: figPath } : b));
  },
  updateBlockFigRows: (pid, figRows) => {
    get()._patchBlocks(bs => bs.map(b => b.pid === pid ? { ...b, fig_table_rows: figRows } : b));
  },
  setAskPanel: (open, sel = null) => set({ askPanelOpen: open, pendingSelection: sel }),
  toast: (t) => {
    const id = Date.now() + Math.random();
    set(s => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.type === 'error' ? 6000 : 3000);
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
}));
