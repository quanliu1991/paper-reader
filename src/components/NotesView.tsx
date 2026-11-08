import { useEffect, useMemo, useState } from 'react';
import { useStore, HighlightRow, NoteRow, QaRow } from '../store';
import { toast, toastErr } from './Toast';
import { IconExport, IconTrash, IconSearch } from './icons';
import DigestCard, { DigestDoc, toDigestDoc } from './DigestCard';
import AnswerText from './AnswerText';

const HL_COLOR_LABEL: Record<string, string> = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉' };
const HL_BAR: Record<string, string> = { // 走主题变量（B1 暗色适配）
  yellow: 'var(--hl-c-yellow)', green: 'var(--hl-c-green)',
  blue: 'var(--hl-c-blue)', pink: 'var(--hl-c-pink)',
};

type Scope = 'all' | 'highlights' | 'notes';

interface Passage {
  pid: number | null;
  highlights: HighlightRow[];
  notes: NoteRow[];
  qas: QaRow[];
}
interface PaperGroup {
  paperId: number;
  title: string;
  arxivId: string;
  passages: Passage[];
  highlightCount: number;
  noteCount: number;
  qaCount: number;
  latest: string;
}

function initialScope(): Scope {
  const saved = localStorage.getItem('pr:notes:scope');
  if (saved === 'all' || saved === 'highlights' || saved === 'notes') return saved;
  const old = localStorage.getItem('pr:notes:tab');
  if (old === 'highlights' || old === 'notes') return old;
  return 'all';
}

// 按论文成组，组内按段落 pid 升序（阅读顺序）。同一段的高亮和笔记放在一起。
export function buildSettleGroups(hls: HighlightRow[], notes: NoteRow[], scope: Scope, qas: QaRow[] = []): PaperGroup[] {
  const showH = scope !== 'notes';
  const showN = scope !== 'highlights';
  const showQ = scope === 'all';
  const map = new Map<number, {
    paperId: number; title: string; arxivId: string;
    passages: Map<string, Passage>;
    highlightCount: number; noteCount: number; qaCount: number; latest: string;
  }>();
  const ensure = (paperId: number, title?: string, arxiv?: string) => {
    let g = map.get(paperId);
    if (!g) {
      g = {
        paperId, title: title || `论文 #${paperId}`, arxivId: arxiv || '',
        passages: new Map(), highlightCount: 0, noteCount: 0, qaCount: 0, latest: '',
      };
      map.set(paperId, g);
    } else {
      if (title && g.title.startsWith('论文 #')) g.title = title;
      if (arxiv && !g.arxivId) g.arxivId = arxiv;
    }
    return g;
  };
  const passage = (g: NonNullable<ReturnType<typeof map.get>>, pid: number | null) => {
    const key = pid == null ? 'none' : String(pid);
    let p = g.passages.get(key);
    if (!p) { p = { pid, highlights: [], notes: [], qas: [] }; g.passages.set(key, p); }
    return p;
  };
  const touch = (g: NonNullable<ReturnType<typeof map.get>>, t: string) => {
    if (t > g.latest) g.latest = t;
  };
  if (showH) {
    for (const h of hls) {
      const g = ensure(h.paper_id, h.paper_title, h.arxiv_id);
      passage(g, h.pid).highlights.push(h);
      g.highlightCount += 1;
      touch(g, h.created_at || '');
    }
  }
  if (showN) {
    for (const n of notes) {
      const g = ensure(n.paper_id, n.paper_title, n.arxiv_id);
      passage(g, n.pid).notes.push(n);
      g.noteCount += 1;
      touch(g, n.updated_at || n.created_at || '');
    }
  }
  if (showQ) {
    for (const q of qas) {
      const g = ensure(q.paper_id, q.paper_title, q.arxiv_id);
      passage(g, q.pid).qas.push(q);
      g.qaCount += 1;
      touch(g, q.created_at || '');
    }
  }
  return [...map.values()]
    .map(g => ({
      paperId: g.paperId,
      title: g.title,
      arxivId: g.arxivId,
      highlightCount: g.highlightCount,
      noteCount: g.noteCount,
      qaCount: g.qaCount,
      latest: g.latest,
      passages: [...g.passages.values()].sort((a, b) => {
        if (a.pid == null) return 1;
        if (b.pid == null) return -1;
        return a.pid - b.pid;
      }),
    }))
    .sort((a, b) => b.latest.localeCompare(a.latest) || a.title.localeCompare(b.title));
}

function jumpTo(paperId: number, pid: number | null) {
  if (pid) localStorage.setItem(`paper:${paperId}:pid`, String(pid));
  useStore.getState().openPaper(paperId);
}

export default function NotesView({ embedded = false }: { embedded?: boolean }) {
  const [scope, setScope] = useState<Scope>(initialScope);
  const [hls, setHls] = useState<HighlightRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [qas, setQas] = useState<QaRow[]>([]);
  const [digests, setDigests] = useState<Record<number, DigestDoc>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [paperFilter, setPaperFilter] = useState<string>('all');
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { localStorage.setItem('pr:notes:scope', scope); }, [scope]);

  async function reload() {
    try {
      const [allHls, allNotes, allQa, allDigests] = await Promise.all([
        window.api.listAllHighlights(),
        window.api.listAllNotes(),
        typeof window.api.listAllQa === 'function' ? window.api.listAllQa() : Promise.resolve([]),
        typeof window.api.listPaperDigests === 'function' ? window.api.listPaperDigests() : Promise.resolve([]),
      ]);
      setHls(allHls);
      setNotes(allNotes);
      setQas(allQa);
      const map: Record<number, DigestDoc> = {};
      for (const row of allDigests) {
        const doc = toDigestDoc(row);
        if (doc) map[row.ref_id] = doc;
      }
      setDigests(map);
    } catch (e: any) { toastErr(e); } finally { setLoaded(true); }
  }

  useEffect(() => { reload(); }, []);

  const hasFilter = q.trim() || paperFilter !== 'all' || scope !== 'all';
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());

  const filteredHls = useMemo(() => hls.filter(h =>
    (paperFilter === 'all' || String(h.paper_id) === paperFilter) &&
    (match(h.text_en) || match(h.note || '') || match(h.paper_title || '')),
  ), [hls, q, paperFilter]);
  const filteredNotes = useMemo(() => notes.filter(n =>
    (paperFilter === 'all' || String(n.paper_id) === paperFilter) &&
    (match(n.text) || match(n.paper_title || '')),
  ), [notes, q, paperFilter]);
  const filteredQas = useMemo(() => qas.filter(item =>
    (paperFilter === 'all' || String(item.paper_id) === paperFilter) &&
    (match(item.question) || match(item.answer) || match(item.paper_title || '')),
  ), [qas, q, paperFilter]);

  const groups = useMemo(
    () => buildSettleGroups(filteredHls, filteredNotes, scope, filteredQas),
    [filteredHls, filteredNotes, filteredQas, scope],
  );

  async function removeHighlight(e: React.MouseEvent, h: HighlightRow) {
    e.stopPropagation();
    if (!confirm('删除这条高亮？')) return;
    await window.api.removeHighlight(h.id);
    await reload();
    toast('info', '已删除高亮');
  }

  async function removeNote(e: React.MouseEvent, n: NoteRow) {
    e.stopPropagation();
    if (!confirm('删除这条笔记？')) return;
    await window.api.deleteNote(n.id);
    await reload();
    toast('info', '已删除笔记');
  }

  async function saveNote() {
    if (!editing) return;
    try {
      await window.api.updateNote({ id: editing.id, text: editing.text });
      setEditing(null);
      await reload();
      toast('success', '笔记已保存');
    } catch (e: any) { toastErr(e); }
  }

  function exportMarkdown() {
    if (!groups.length) return;
    const lines: string[] = [
      '# Paper Reader 沉淀导出',
      '',
      `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
    ];
    let n = 0;
    for (const g of groups) {
      lines.push(`## ${g.title}${g.arxivId ? `（arXiv:${g.arxivId}）` : ''}`, '');
      const digest = digests[g.paperId];
      if (digest) lines.push(digest.body, '');
      g.passages.forEach((p, i) => {
        const where = p.pid == null ? '未挂段落' : `文中第 ${i + 1} 处`;
        lines.push(`### ${where}`, '');
        for (const h of p.highlights) {
          n += 1;
          lines.push(`- **高亮 [${HL_COLOR_LABEL[h.color] || h.color}]** ${h.text_en}`);
          if (h.note) lines.push(`  - 备注：${h.note}`);
        }
        for (const note of p.notes) {
          n += 1;
          lines.push(`- **笔记** ${note.text}`);
        }
        for (const item of p.qas) {
          n += 1;
          lines.push(`- **提问** ${item.question}`, `  - 答：${item.answer}`);
        }
        lines.push('');
      });
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'paper-reader-notes.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('success', `已导出 ${n} 条`);
  }

  const paperOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const x of [...hls, ...notes, ...qas]) if (!m.has(x.paper_id)) m.set(x.paper_id, x.paper_title || `论文 #${x.paper_id}`);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [hls, notes, qas]);

  const totalH = filteredHls.length;
  const totalN = filteredNotes.length;
  const totalQ = filteredQas.length;
  const emptyAll = loaded && hls.length === 0 && notes.length === 0 && qas.length === 0;

  async function genPaper(paperId: number) {
    if (typeof window.api.genPaperDigest !== 'function') {
      toast('info', '请先停掉并重新运行 npm run electron:dev，再生成精炼笔记');
      return;
    }
    setBusyId(paperId);
    try {
      const row = await window.api.genPaperDigest(paperId);
      const doc = toDigestDoc(row);
      if (doc) setDigests(prev => ({ ...prev, [paperId]: doc }));
      toast('success', '已生成本篇精炼笔记');
    } catch (e: any) { toastErr(e); } finally { setBusyId(null); }
  }

  function togglePaper(id: number) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="notes-page">
      {!embedded && (
      <div className="list-head">
        <h1>沉淀</h1>
        <span className="count">{groups.length} 篇 · 高亮 {totalH} · 笔记 {totalN} · 提问 {totalQ}</span>
        {groups.length > 0 && (
          <button className="ghost-btn" onClick={exportMarkdown} title="按论文与文中顺序导出 markdown">
            <IconExport /> 导出
          </button>
        )}
      </div>
      )}

      <div className="notes-toolbar">
        <div className="mode-switch">
          <button onClick={() => setScope('all')} className={scope === 'all' ? 'active' : ''}>全部</button>
          <button onClick={() => setScope('highlights')} className={scope === 'highlights' ? 'active' : ''}>高亮 {hls.length}</button>
          <button onClick={() => setScope('notes')} className={scope === 'notes' ? 'active' : ''}>笔记 {notes.length}</button>
        </div>
        <div className="notes-search">
          <IconSearch s={14} />
          <input type="text" placeholder="搜索内容 / 论文…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {paperOptions.length > 1 && (
          <select className="notes-paper-select" value={paperFilter} onChange={e => setPaperFilter(e.target.value)}>
            <option value="all">全部论文</option>
            {paperOptions.map(([id, title]) => <option key={id} value={String(id)}>{title}</option>)}
          </select>
        )}
        {hasFilter && (
          <button className="fb-clear" onClick={() => { setQ(''); setPaperFilter('all'); setScope('all'); }}>清除筛选</button>
        )}
      </div>

      <p className="settle-lead">点「精炼」会按这篇的划线、笔记和提问写一页笔记。展开后是按阅读顺序留下的原文记录，点一条就能回到文中。重新生成只改这一页。</p>

      {emptyAll && (
        <div className="empty-hint">
          <div className="empty-icon">📝</div>
          还没有沉淀。阅读时划选文字可以高亮，或点「笔记」记下一句自己的话。
        </div>
      )}
      {loaded && !emptyAll && groups.length === 0 && (
        <div className="empty-hint">没有符合当前筛选的条目，试试「清除筛选」。</div>
      )}

      {groups.map(g => {
        const closed = collapsed.has(g.paperId);
        let place = 0;
        return (
          <section key={g.paperId} className="settle-paper">
            <header className="settle-head">
              <button className="settle-toggle" onClick={() => togglePaper(g.paperId)} aria-expanded={!closed}>
                <span className={`lib-caret ${closed ? '' : 'open'}`}>▸</span>
                <span className="settle-title">{g.title}</span>
              </button>
              <div className="settle-meta">
                {g.arxivId && <span>arXiv:{g.arxivId}</span>}
                {g.highlightCount > 0 && <span>{g.highlightCount} 处高亮</span>}
                {g.noteCount > 0 && <span>{g.noteCount} 条笔记</span>}
                {g.qaCount > 0 && <span>{g.qaCount} 个提问</span>}
              </div>
              {!digests[g.paperId] && (
                <button className="ghost-btn" onClick={() => genPaper(g.paperId)} disabled={busyId === g.paperId}>
                  {busyId === g.paperId ? '生成中…' : '精炼'}
                </button>
              )}
              <button className="ghost-btn" onClick={() => jumpTo(g.paperId, g.passages.find(p => p.pid != null)?.pid ?? null)}>打开</button>
            </header>
            {!closed && digests[g.paperId] && (
              <DigestCard
                kicker="这篇我带走的"
                doc={digests[g.paperId]}
                busy={busyId === g.paperId}
                emptyHint=""
                onGenerate={() => genPaper(g.paperId)}
                onOpen={jumpTo}
              />
            )}
            {!closed && g.passages.map(p => {
              if (p.pid != null) place += 1;
              const label = p.pid == null ? '篇' : String(place);
              return (
                <article key={p.pid ?? 'none'} className="settle-passage" onClick={() => jumpTo(g.paperId, p.pid)}>
                  <div className="settle-index" title={p.pid == null ? '没有挂到具体段落' : '按论文中的先后'}>{label}</div>
                  <div className="settle-main">
                    {p.highlights.map(h => (
                      <div key={`h${h.id}`} className="settle-hl">
                        <div className="settle-row">
                          <span className={`nc-dot ${h.color}`} title={HL_COLOR_LABEL[h.color] || h.color} />
                          <span className="settle-kind">原文</span>
                          <span className="nc-date">{(h.created_at || '').slice(0, 10)}</span>
                          <button className="icon-danger nc-del" onClick={e => removeHighlight(e, h)} title="删除高亮"><IconTrash s={14} /></button>
                        </div>
                        <div className="settle-quote" style={{ borderLeftColor: HL_BAR[h.color] || 'var(--border)' }}>{h.text_en}</div>
                        {h.note && <div className="nc-note">备注：{h.note}</div>}
                      </div>
                    ))}
                    {p.notes.map(n => (
                      <div key={`n${n.id}`} className="settle-note" onClick={e => e.stopPropagation()}>
                        <div className="settle-row">
                          <span className="settle-kind">我的笔记</span>
                          <span className="nc-date">{(n.updated_at || n.created_at || '').slice(0, 10)}</span>
                          <button className="nc-edit" onClick={() => setEditing({ id: n.id, text: n.text })} title="编辑">编辑</button>
                          <button className="icon-danger nc-del" onClick={e => removeNote(e, n)} title="删除笔记"><IconTrash s={14} /></button>
                        </div>
                        {editing?.id === n.id ? (
                          <div className="nc-edit-box">
                            <textarea
                              autoFocus
                              value={editing.text}
                              onChange={e => setEditing(v => v! && { ...v, text: e.target.value })}
                              onKeyDown={e => {
                                if (e.key === 'Escape') setEditing(null);
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote();
                              }}
                            />
                            <div className="te-actions">
                              <button className="primary" onClick={saveNote}>保存</button>
                              <button className="ghost-btn" onClick={() => setEditing(null)}>取消</button>
                            </div>
                          </div>
                        ) : (
                          <div className="nc-body">{n.text}</div>
                        )}
                      </div>
                    ))}
                    {p.qas.map(item => (
                      <div key={`q${item.id}`} className="settle-qa" onClick={e => e.stopPropagation()}>
                        <div className="settle-row">
                          <span className="settle-kind">提问</span>
                          <span className="nc-date">{(item.created_at || '').slice(0, 10)}</span>
                        </div>
                        <div className="nc-body">{item.question}</div>
                        {item.answer && <AnswerText text={item.answer} onJump={() => jumpTo(item.paper_id, item.pid)} />}
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
