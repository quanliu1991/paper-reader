import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';
import { IconPlus, IconTrash, IconBib } from './icons';

export default function PaperList() {
  const papers = useStore(s => s.papers);
  const openPaper = useStore(s => s.openPaper);
  const loadPapers = useStore(s => s.loadPapers);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // 摘要后台生成完成 → 刷新列表
  useEffect(() => {
    const off = window.api.onSummaryReady(() => { loadPapers(); });
    return off;
  }, [loadPapers]);

  async function importArxiv() {
    if (!input.trim() || busy) return;
    setBusy(true);
    try {
      const r = await window.api.importArxiv(input.trim());
      toast('success', `导入成功（${r.count} 段）${r.paperId ? '，AI 摘要生成中…' : ''}`);
      setInput('');
      await loadPapers();
    } catch (e: any) {
      toastErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function removePaper(e: React.MouseEvent, id: number, title: string) {
    e.stopPropagation();
    if (!confirm(`删除论文「${title.slice(0, 40)}…」？\n译文缓存、高亮、问答将一并删除，不可恢复。`)) return;
    await window.api.deletePaper(id);
    await loadPapers();
    toast('info', '已删除');
  }

  async function exportBibtex() {
    const bib = await window.api.exportBibtex();
    const blob = new Blob([bib], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'papers.bib';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('success', `已导出 ${papers.length} 条 BibTeX`);
  }

  return (
    <div className="list-page">
      <div className="list-head">
        <h1>论文库</h1>
        <span className="count">{papers.length} 篇</span>
        {papers.length > 0 && (
          <button className="ghost-btn" onClick={exportBibtex} title="导出全部 BibTeX">
            <IconBib /> BibTeX
          </button>
        )}
      </div>

      <div className="import-box">
        <IconPlus s={16} />
        <input
          type="text"
          placeholder="输入 arXiv ID 或链接，回车导入（如 2609.34683）"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && importArxiv()}
          disabled={busy}
        />
        <button className="primary" onClick={importArxiv} disabled={busy || !input.trim()}>
          {busy ? '导入中…' : '导入'}
        </button>
      </div>

      {busy && <div className="skeleton-card" />}

      {papers.length === 0 && !busy && (
        <div className="empty-hint">
          <div className="empty-icon">📄</div>
          还没有论文。输入上方 arXiv ID 导入第一篇；
          <br />或在「设置 → 仓库连接」从知识库 .fulltext 缓存导入。
        </div>
      )}

      <div className="paper-grid">
        {papers.map(p => {
          let triage: any = null;
          try { triage = p.summary ? JSON.parse(p.summary) : null; } catch {}
          return (
            <div key={p.id} className="paper-card" onClick={() => openPaper(p.id)}>
              <div className="card-top">
                {p.arxiv_id && <span className="arxiv-id">arXiv:{p.arxiv_id}</span>}
                {p.import_type === 'text' && <span className="chip-plain">文本模式</span>}
              </div>
              <div className="t">{p.title}</div>
              <div className={`triage-line ${triage ? '' : 'pending'}`}>
                {triage
                  ? triage.oneLiner
                  : (p.summary === null ? 'AI 摘要待生成（需配置 Provider）' : (p.arxiv_id ? '' : ''))}
              </div>
              <div className="card-bottom">
                <div className="m">
                  {p.translated_count > 0 && <span>已译 {p.translated_count}</span>}
                  {p.highlight_count > 0 && <span>划线 {p.highlight_count}</span>}
                  {p.read_pct ? <span>读至 {p.read_pct}%</span> : null}
                </div>
                <button className="icon-danger" onClick={e => removePaper(e, p.id, p.title)} title="删除">
                  <IconTrash s={15} />
                </button>
              </div>
              {p.read_pct ? (
                <div className="read-progress"><div style={{ width: `${p.read_pct}%` }} /></div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
