import { useEffect, useMemo, useState } from 'react';
import { useStore, HighlightRow, NoteRow } from '../store';
import { toast, toastErr } from './Toast';
import { IconExport, IconTrash, IconSearch } from './icons';

const HL_COLOR_LABEL: Record<string, string> = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉' };

// 跳转：写入 pid 锚点（Reader 打开时按锚点恢复位置）再进论文
function jumpTo(paperId: number, pid: number | null) {
  if (pid) localStorage.setItem(`paper:${paperId}:pid`, String(pid));
  useStore.getState().openPaper(paperId);
}

export default function NotesView() {
  const openPaper = useStore(s => s.openPaper);
  const papers = useStore(s => s.papers);
  const [tab, setTab] = useState<'highlights' | 'notes'>(() => localStorage.getItem('pr:notes:tab') as any || 'highlights');
  const [hls, setHls] = useState<HighlightRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [q, setQ] = useState('');
  const [paperFilter, setPaperFilter] = useState<string>('all');
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { localStorage.setItem('pr:notes:tab', tab); }, [tab]);

  async function reload() {
    try {
      const [allHls, allNotes] = await Promise.all([
        window.api.listAllHighlights(),
        window.api.listAllNotes(),
      ]);
      setHls(allHls);
      setNotes(allNotes);
    } catch (e: any) { toastErr(e); } finally { setLoaded(true); }
  }

  useEffect(() => { reload(); }, []);

  const hasFilter = q.trim() || paperFilter !== 'all';
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());

  const filteredHls = useMemo(() => hls.filter(h =>
    (paperFilter === 'all' || String(h.paper_id) === paperFilter) &&
    (match(h.text_en) || match(h.note || '') || match(h.paper_title || '')),
  ), [hls, q, paperFilter]);
  const filteredNotes = useMemo(() => notes.filter(n =>
    (paperFilter === 'all' || String(n.paper_id) === paperFilter) &&
    (match(n.text) || match(n.paper_title || '')),
  ), [notes, q, paperFilter]);

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

  // 导出当前 tab 的筛选结果为 markdown（按论文分组，BibTeX 同款 Blob 下载）
  function exportMarkdown() {
    const items = tab === 'highlights' ? filteredHls : filteredNotes;
    if (!items.length) return;
    const byPaper = new Map<number, { title: string; arxivId: string; hls: HighlightRow[]; notes: NoteRow[] }>();
    if (tab === 'highlights') {
      for (const h of filteredHls) {
        if (!byPaper.has(h.paper_id)) byPaper.set(h.paper_id, { title: h.paper_title || `#${h.paper_id}`, arxivId: h.arxiv_id || '', hls: [], notes: [] });
        byPaper.get(h.paper_id)!.hls.push(h);
      }
    } else {
      for (const n of filteredNotes) {
        if (!byPaper.has(n.paper_id)) byPaper.set(n.paper_id, { title: n.paper_title || `#${n.paper_id}`, arxivId: n.arxiv_id || '', hls: [], notes: [] });
        byPaper.get(n.paper_id)!.notes.push(n);
      }
    }
    const lines: string[] = [
      `# Paper Reader 沉淀导出`,
      ``,
      `> 导出时间：${new Date().toLocaleString('zh-CN')}；${tab === 'highlights' ? `高亮 ${filteredHls.length} 条` : `笔记 ${filteredNotes.length} 条`}`,
      ``,
    ];
    for (const [, g] of byPaper) {
      lines.push(`## ${g.title}${g.arxivId ? `（arXiv:${g.arxivId}）` : ''}`, ``);
      if (g.hls.length) {
        lines.push(`### 高亮`, ``);
        for (const h of g.hls) {
          lines.push(`- **[${HL_COLOR_LABEL[h.color] || h.color}]** ${h.text_en}（${(h.created_at || '').slice(0, 10)}）`);
          if (h.note) lines.push(`  - 备注：${h.note}`);
        }
        lines.push(``);
      }
      if (g.notes.length) {
        lines.push(`### 笔记`, ``);
        for (const n of g.notes) lines.push(`- ${n.text}（${(n.updated_at || '').slice(0, 10)} 更新）`);
        lines.push(``);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `paper-reader-${tab === 'highlights' ? 'highlights' : 'notes'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('success', `已导出 ${items.length} 条`);
  }

  const curCount = tab === 'highlights' ? filteredHls.length : filteredNotes.length;
  const paperOptions = useMemo(() => {
    // 只列出有沉淀的论文（标题去重取最新）
    const m = new Map<number, string>();
    for (const x of [...hls, ...notes]) if (!m.has(x.paper_id)) m.set(x.paper_id, x.paper_title || `论文 #${x.paper_id}`);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [hls, notes]);

  return (
    <div className="notes-page">
      <div className="list-head">
        <h1>沉淀</h1>
        <span className="count">{tab === 'highlights' ? `高亮 ${curCount} 条` : `笔记 ${curCount} 条`}</span>
        {curCount > 0 && (
          <button className="ghost-btn" onClick={exportMarkdown} title="导出当前筛选结果为 markdown">
            <IconExport /> 导出
          </button>
        )}
      </div>

      <div className="notes-toolbar">
        <div className="mode-switch">
          <button onClick={() => setTab('highlights')} className={tab === 'highlights' ? 'active' : ''}>高亮 {hls.length}</button>
          <button onClick={() => setTab('notes')} className={tab === 'notes' ? 'active' : ''}>笔记 {notes.length}</button>
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
          <button className="fb-clear" onClick={() => { setQ(''); setPaperFilter('all'); }}>清除筛选</button>
        )}
      </div>

      {loaded && (tab === 'highlights' ? hls.length === 0 : notes.length === 0) && (
        <div className="empty-hint">
          <div className="empty-icon">{tab === 'highlights' ? '🖍' : '📝'}</div>
          {tab === 'highlights'
            ? <>还没有高亮。在阅读器里划选文字，点四色圆点即可高亮。</>
            : <>还没有笔记。在阅读器里划选文字点「笔记」，即可给段落挂一条笔记。</>}
        </div>
      )}
      {loaded && (tab === 'highlights' ? hls.length : notes.length) > 0 && curCount === 0 && (
        <div className="empty-hint">没有符合当前筛选的条目，试试「清除筛选」。</div>
      )}

      <div className="notes-list">
        {tab === 'highlights' && filteredHls.map(h => (
          <div key={h.id} className="note-card" onClick={() => jumpTo(h.paper_id, h.pid)}>
            <div className="nc-head">
              <span className={`nc-dot ${h.color}`} title={HL_COLOR_LABEL[h.color] || h.color} />
              <span className="nc-paper">{h.paper_title}</span>
              {h.arxiv_id && <span className="nc-arxiv">arXiv:{h.arxiv_id}</span>}
              <span className="nc-date">{(h.created_at || '').slice(0, 10)}</span>
              <button className="icon-danger nc-del" onClick={e => removeHighlight(e, h)} title="删除">
                <IconTrash s={14} />
              </button>
            </div>
            <div className="nc-body en">{h.text_en}</div>
            {h.note && <div className="nc-note">备注：{h.note}</div>}
          </div>
        ))}

        {tab === 'notes' && filteredNotes.map(n => (
          <div key={n.id} className="note-card" onClick={() => jumpTo(n.paper_id, n.pid)}>
            <div className="nc-head">
              <span className="nc-paper">{n.paper_title}</span>
              {n.arxiv_id && <span className="nc-arxiv">arXiv:{n.arxiv_id}</span>}
              <span className="nc-date">{(n.updated_at || '').slice(0, 10)} 更新</span>
              <button
                className="nc-edit"
                onClick={e => { e.stopPropagation(); setEditing({ id: n.id, text: n.text }); }}
                title="编辑"
              >
                编辑
              </button>
              <button className="icon-danger nc-del" onClick={e => removeNote(e, n)} title="删除">
                <IconTrash s={14} />
              </button>
            </div>
            {editing?.id === n.id ? (
              <div className="nc-edit-box" onClick={e => e.stopPropagation()}>
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
                <div className="hint">Ctrl/⌘+Enter 保存 · Esc 取消</div>
              </div>
            ) : (
              <div className="nc-body">{n.text}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
