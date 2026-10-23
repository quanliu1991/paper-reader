import { create } from 'zustand';

export interface PaperRow {
  id: number; arxiv_id: string; title: string; authors: string;
  source_url: string; import_type: string; created_at: string;
  block_count: number; translated_count: number; highlight_count: number;
  summary?: string | null;
  read_pct?: number | null;
}

export interface BlockRow {
  pid: number; seq: number; type: 'heading' | 'para' | 'fig'; level: number;
  en: string; fig_path: string | null; fig_kind?: 'figure' | 'table'; zh: string | null;
}

export interface HighlightRow {
  id: number; paper_id: number; pid: number; text_en: string; note: string;
  color: string; created_at: string;
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

type View = 'list' | 'reader' | 'settings' | 'review';

interface Store {
  view: View;
  papers: PaperRow[];
  currentPaper: PaperRow | null;
  blocks: BlockRow[];
  highlights: HighlightRow[];
  qaList: QaRow[];
  // 阅读状态
  layout: 'dual' | 'en' | 'zh' | 'pdf-dual' | 'pdf';
  translating: boolean;
  translateProgress: { done: number; total: number } | null;
  fontSize: number;
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
  setLayout: (l: Store['layout']) => void;
  setFontSize: (n: number) => void;
  setColumnWidth: (w: 'wide' | 'standard') => void;
  setImmersive: (b: boolean) => void;
  setTranslating: (b: boolean, p?: { done: number; total: number } | null) => void;
  updateBlockZh: (pid: number, zh: string) => void;
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
  qaList: [],
  layout: 'dual',
  translating: false,
  translateProgress: null,
  fontSize: 15,
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
    const qaList = await window.api.listQa(id);
    set({ currentPaper: paper, blocks, highlights, qaList, view: 'reader', paletteOpen: false });
  },
  setLayout: (l) => set({ layout: l }),
  setFontSize: (n) => set({ fontSize: Math.max(12, Math.min(22, n)) }),
  setColumnWidth: (w) => set({ columnWidth: w }),
  setImmersive: (b) => set({ immersive: b }),
  setTranslating: (b, p = null) => set({ translating: b, translateProgress: p }),
  updateBlockZh: (pid, zh) => set(s => ({
    blocks: s.blocks.map(b => b.pid === pid ? { ...b, zh } : b),
  })),
  setAskPanel: (open, sel = null) => set({ askPanelOpen: open, pendingSelection: sel }),
  toast: (t) => {
    const id = Date.now() + Math.random();
    set(s => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.type === 'error' ? 6000 : 3000);
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
}));
