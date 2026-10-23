import { contextBridge, ipcRenderer } from 'electron';

// 统一 IPC 返回 {ok, data, error, hint} —— unwrap 后抛错（带 hint）
async function call<T = any>(channel: string, ...args: any[]): Promise<T> {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && typeof r === 'object' && 'ok' in r) {
    if (r.ok) return r.data;
    const err: any = new Error(r.error);
    err.hint = r.hint;
    throw err;
  }
  return r as T;
}

const api = {
  // papers
  listPapers: (): Promise<any[]> => call('papers:list'),
  getPaper: (id: number) => call('papers:get', id),
  deletePaper: (id: number) => call('papers:delete', id),
  getBlocks: (id: number) => call('papers:getBlocks', id),
  importArxiv: (input: string) => call('papers:importArxiv', input),
  importText: (arg: { arxivId: string; title: string; text: string }) => call('papers:importText', arg),
  // summaries
  getSummary: (paperId: number) => call('summary:get', paperId),
  regenSummary: (paperId: number) => call('summary:regen', paperId),
  sectionSummaries: (paperId: number) => call('summary:sections', paperId),
  onSummaryReady: (cb: (p: any) => void): (() => void) => {
    const l = (_e: any, p: any) => cb(p);
    ipcRenderer.on('summary:ready', l);
    return () => { ipcRenderer.removeListener('summary:ready', l); };
  },
  // translations
  onTrProgress: (cb: (p: any) => void): (() => void) => {
    const l = (_e: any, p: any) => cb(p);
    ipcRenderer.on('tr:progress', l);
    return () => { ipcRenderer.removeListener('tr:progress', l); };
  },
  translateAll: (arg: { paperId: number; blocks: Array<{ pid: number; en: string }>; scope: 'untranslated' | 'all' }) =>
    call('tr:translateAll', arg),
  cancelTranslate: (paperId: number) => call('tr:cancel', paperId),
  checkTerms: (paperId: number) => call('tr:checkTerms', paperId),
  onFigUpdated: (cb: (p: any) => void): (() => void) => {
    const l = (_e: any, p: any) => cb(p);
    ipcRenderer.on('fig:updated', l);
    return () => { ipcRenderer.removeListener('fig:updated', l); };
  },
  // pdf
  ensurePdf: (paperId: number) => call('pdf:ensure', paperId),
  pdfPageMap: (paperId: number) => call('pdf:pageMap', paperId),
  onPdfReady: (cb: (p: any) => void): (() => void) => {
    const l = (_e: any, p: any) => cb(p);
    ipcRenderer.on('pdf:ready', l);
    return () => { ipcRenderer.removeListener('pdf:ready', l); };
  },
  // highlights & qa
  addHighlight: (h: { paperId: number; pid: number; textEn: string; note?: string; color?: string }) => call('hl:add', h),
  listHighlights: (paperId: number) => call('hl:list', paperId),
  removeHighlight: (id: number) => call('hl:remove', id),
  askQuestion: (arg: { paperId: number; pid: number; question: string; context: string; highlightId?: number }) =>
    call('qa:ask', arg),
  onQaStream: (qaId: number, cb: (m: any) => void): (() => void) => {
    const ch = `qa:stream:${qaId}`;
    const l = (_e: any, m: any) => cb(m);
    ipcRenderer.on(ch, l);
    return () => { ipcRenderer.removeListener(ch, l); };
  },
  listQa: (paperId: number) => call('qa:list', paperId),
  // flashcards
  saveFlashcard: (f: { paperId: number; pid: number; front: string; back: string }) => call('fc:save', f),
  updateFlashcardBack: (id: number, back: string) => call('fc:updateBack', id, back),
  listDueFlashcards: () => call('fc:listDue'),
  gradeFlashcard: (id: number, q: number) => call('fc:grade', id, q),
  genFlashcardBack: (f: { paperId: number; pid: number; front: string; id: number }) => call('fc:genBack', f),
  // providers
  listProviders: () => call('pv:list'),
  saveProvider: (p: any) => call('pv:save', p),
  deleteProvider: (id: number) => call('pv:delete', id),
  testProvider: (p: any) => call('pv:test', p),
  // bibtex
  exportBibtex: () => call('bibtex:export'),
  // github
  setRepo: (p: string) => call('gh:setRepo', p),
  getRepo: () => call('gh:getRepo'),
  listFulltext: () => call('gh:listFulltext'),
  importFulltext: (arxivId: string) => call('gh:importFulltext', arxivId),
  listNotes: () => call('gh:listNotes'),
  readNote: (name: string) => call('gh:readNote', name),
  writeQa: (arg: { arxivId: string; question: string; answer: string }) => call('gh:writeQa', arg),
  exportSummaryToRepo: (paperId: number) => call('gh:exportSummary', paperId),
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
