import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';

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
      <div className="import-row">
        <input
          type="text"
          placeholder="输入 arXiv ID 或 URL（如 2609.34683），回车导入"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && importArxiv()}
          disabled={busy}
        />
        <button className="primary" onClick={importArxiv} disabled={busy || !input.trim()}>
          {busy ? '导入中…' : '导入'}
        </button>
      </div>

      {papers.length > 0 && (
        <div className="list-actions">
          <span className="hint">{papers.length} 篇</span>
          <button onClick={exportBibtex}>导出 BibTeX</button>
        </div>
      )}

      {busy && <div className="skeleton-card" />}

      {papers.length === 0 && !busy && (
        <div className="empty-hint">
          还没有论文。输入上方 arXiv ID 导入第一篇；
          <br />或在「设置 → 仓库连接」从知识库 .fulltext 缓存导入。
        </div>
      )}

      {papers.map(p => {
        let triage: any = null;
        try { triage = p.summary ? JSON.parse(p.summary) : null; } catch {}
        return (
          <div key={p.id} className="paper-card" onClick={() => openPaper(p.id)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="t">{p.title}</div>
              {triage
                ? <div className="triage-line">{triage.oneLiner}</div>
                : <div className="triage-line pending">{p.arxiv_id ? `arXiv:${p.arxiv_id}` : ''}{triage === null && p.summary === null ? ' · AI 摘要待生成（需配置 Provider）' : ''}</div>}
              <div className="m">
                {p.import_type === 'text' && <span className="badge">文本模式</span>}
                {p.translated_count > 0 && <span className="badge ok">已译 {p.translated_count}</span>}
                {p.highlight_count > 0 && <span className="badge ok">划线 {p.highlight_count}</span>}
                {p.read_pct ? <span className="badge">读至 {p.read_pct}%</span> : null}
              </div>
            </div>
            <div className="card-actions">
              {p.read_pct ? (
                <div className="mini-progress"><div style={{ width: `${p.read_pct}%` }} /></div>
              ) : null}
              <button className="danger" onClick={e => removePaper(e, p.id, p.title)}>删除</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
