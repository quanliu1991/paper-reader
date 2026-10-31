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
}

export interface ProviderRow {
  id: number; name: string; protocol: 'openai' | 'anthropic';
  base_url: string; api_key: string; model: string; is_default: number;
}

export interface ToastMsg { id: number; type: 'success' | 'error' | 'info'; msg: string; action?: { label: string; run: () => void } }

type View = 'list' | 'reader' | 'settings' | 'review' | 'topics' | 'notes';

interface Store {
  view: View;
  papers: PaperRow[];
  currentPaper: PaperRow | null;
  blocks: BlockRow[];
  highlights: HighlightRow[];
  notes: NoteRow[];
  qaList: QaRow[];
  // 阅读状态
  layout: 'translate' | 'bilingual' | 'dual' | 'en' | 'zh' | 'pdf-dual' | 'pdf' | 'pdf-layout';
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
  // actions
  setView: (v: View) => void;
  loadPapers: () => Promise<void>;
  openPaper: (id: number) => Promise<void>;
  refreshNotes: (paperId: number) => Promise<void>;
  setLayout: (l: Store['layout']) => void;
  setFontSize: (n: number) => void;
  setLineHeight: (n: number) => void;
  setColumnWidth: (w: 'wide' | 'standard') => void;
  setImmersive: (b: boolean) => void;
  setTranslating: (b: boolean, p?: { done: number; total: number } | null) => void;
  updateBlockZh: (pid: number, zh: string) => void;
  updateBlockFig: (pid: number, figPath: string) => void;
  setAskPanel: (open: boolean, sel?: { pid: number; text: string } | null) => void;
  toast: (t: Omit<ToastMsg, 'id'>) => void;
  dismissToast: (id: number) => void;
}

export const useStore = create<Store>((set, get) => ({
  view: 'list',
  papers: [],
  currentPaper: null,
  blocks: [],
  highlights: [],
  notes: [],
  qaList: [],
  // 布局选择持久化：默认豆包式翻译全文对照，记住用户切换
  layout: (localStorage.getItem('pr:layout') as Store['layout']) || 'translate',
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

  setView: (v) => set({ view: v, immersive: false }),
  loadPapers: async () => {
    const papers = await window.api.listPapers();
    set({ papers });
  },
  openPaper: async (id) => {
    const paper = await window.api.getPaper(id);
    const blocks = await window.api.getBlocks(id);
    const highlights = await window.api.listHighlights(id);
    const notes = await window.api.listPaperNotes(id);
    const qaList = await window.api.listQa(id);
    set({ currentPaper: paper, blocks, highlights, notes, qaList, view: 'reader', paletteOpen: false });
  },
  refreshNotes: async (paperId) => {
    const notes = await window.api.listPaperNotes(paperId);
    set({ notes });
  },
  setLayout: (l) => { localStorage.setItem('pr:layout', l); set({ layout: l }); },
  setFontSize: (n) => set({ fontSize: Math.max(12, Math.min(22, n)) }),
  setLineHeight: (n) => { const v = Math.max(1.4, Math.min(2.4, Math.round(n * 10) / 10)); localStorage.setItem('pr:lineHeight', String(v)); set({ lineHeight: v }); },
  setColumnWidth: (w) => set({ columnWidth: w }),
  setImmersive: (b) => set({ immersive: b }),
  setTranslating: (b, p = null) => set({ translating: b, translateProgress: p }),
  updateBlockZh: (pid, zh) => set(s => ({
    blocks: s.blocks.map(b => b.pid === pid ? { ...b, zh } : b),
  })),
  updateBlockFig: (pid, figPath) => set(s => ({
    // 图表下载完成推送（fig:updated）：内存 blocks 同步，否则各视图一直拿旧 fig_path 显示占位框
    blocks: s.blocks.map(b => b.pid === pid ? { ...b, fig_path: figPath } : b),
  })),
  setAskPanel: (open, sel = null) => set({ askPanelOpen: open, pendingSelection: sel }),
  toast: (t) => {
    const id = Date.now() + Math.random();
    set(s => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.type === 'error' ? 6000 : 3000);
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
}));
