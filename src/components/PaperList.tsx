import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';
import { IconPlus, IconTrash, IconBib } from './icons';

// 论文状态四档：未读 / 在读 / 已读 / 精读（与 db.ts PAPER_STATUSES 对应）
const STATUS = [
  { id: 'unread', label: '未读' },
  { id: 'reading', label: '在读' },
  { id: 'done', label: '已读' },
  { id: 'deep', label: '精读' },
] as const;

function parseTags(raw?: string | null): string[] {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

function fmtSize(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// 本地文件的相对文件夹（'' = 根；非库内路径返回 null）
function relFolder(filePath: string, libDir: string): string | null {
  if (!libDir || !filePath.startsWith(libDir)) return null;
  const rel = filePath.slice(libDir.length).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]/);
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/');
}

export default function PaperList() {
  const papers = useStore(s => s.papers);
  const openPaper = useStore(s => s.openPaper);
  const loadPapers = useStore(s => s.loadPapers);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // ---------- 组织：筛选 / 排序（localStorage 持久化）----------
  const [fStatus, setFStatus] = useState<string>(() => localStorage.getItem('pr:filter:status') || 'all');
  const [fTags, setFTags] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('pr:filter:tags') || '[]'); } catch { return []; } });
  const [fDir, setFDir] = useState(() => localStorage.getItem('pr:filter:dir') || '');
  const [sort, setSort] = useState<'imported' | 'opened'>(() => (localStorage.getItem('pr:filter:sort') as any) || 'imported');
  useEffect(() => { localStorage.setItem('pr:filter:status', fStatus); }, [fStatus]);
  useEffect(() => { localStorage.setItem('pr:filter:tags', JSON.stringify(fTags)); }, [fTags]);
  useEffect(() => { localStorage.setItem('pr:filter:dir', fDir); }, [fDir]);
  useEffect(() => { localStorage.setItem('pr:filter:sort', sort); }, [sort]);

  // 状态菜单 / 标签编辑（fixed 定位浮层，坐标取点击位置——卡片 overflow:hidden 不裁切）
  const [statusMenu, setStatusMenu] = useState<{ id: number; cur: string; x: number; y: number } | null>(null);
  const [tagEdit, setTagEdit] = useState<{ id: number; value: string; x: number; y: number } | null>(null);

  // ---------- 本地论文库（v0.4）----------
  const [libDir, setLibDir] = useState('');
  const [libOpen, setLibOpen] = useState(false);
  const [scan, setScan] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<{ done: number; total: number; title?: string } | null>(null);
  const [moveDlg, setMoveDlg] = useState<{ id: number; title: string; curDir: string } | null>(null);
  const [newFolder, setNewFolder] = useState('');

  useEffect(() => {
    window.api.libGetDir().then((d: string) => {
      setLibDir(d ?? '');
      if (d) runScan();
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const off = window.api.onLibProgress((p: any) => setImporting(p));
    return off;
  }, []);

  async function runScan() {
    if (scanning) return;
    setScanning(true);
    try { setScan(await window.api.libScan()); }
    catch (e: any) { toastErr(e); }
    finally { setScanning(false); }
  }

  async function connectLib() {
    try {
      const d = await window.api.libPickDir();
      if (!d) return;
      await window.api.libSetDir(d);
      setLibDir(d);
      setLibOpen(true);
      await runScan();
    } catch (e: any) { toastErr(e); }
  }

  async function importFiles(paths: string[]) {
    if (!paths.length || importing) return;
    setImporting({ done: 0, total: paths.length });
    try {
      const rs = await window.api.libImportFiles(paths);
      const okN = rs.filter((r: any) => r.ok).length;
      const firstErr = rs.find((r: any) => !r.ok);
      toast(okN === rs.length ? 'success' : 'info', `本地导入完成：${okN}/${rs.length} 成功${firstErr ? `（${firstErr.error}）` : ''}`);
      setSel(new Set());
      await loadPapers();
      await runScan();
    } catch (e: any) { toastErr(e); }
    finally { setImporting(null); }
  }

  async function doMove(dir: string, newFolderName?: string) {
    if (!moveDlg) return;
    try {
      const r = await window.api.libMoveFile({ paperId: moveDlg.id, dir, newFolder: newFolderName });
      toast('success', `已移动到「${r.relDir || '根目录'}」`);
      setMoveDlg(null);
      setNewFolder('');
      await loadPapers();
      if (libDir) await runScan();
    } catch (e: any) { toastErr(e); }
  }

  // 全库标签聚合：名称 → 使用篇数
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of papers) for (const t of parseTags(p.tags)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [papers]);

  // 本地库文件夹聚合（论文卡片过滤 + 移动对话框目标列表共用）
  const folders = useMemo(() => {
    if (!libDir) return [] as Array<[string, number]>;
    const m = new Map<string, number>();
    for (const p of papers) {
      const f = p.file_path ? relFolder(p.file_path, libDir) : null;
      if (f === null) continue;
      m.set(f, (m.get(f) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])));
  }, [papers, libDir]);

  // 扫描结果按文件夹分组
  const scanGroups = useMemo(() => {
    if (!scan?.files?.length) return [] as Array<[string, any[]]>;
    const m = new Map<string, any[]>();
    for (const f of scan.files) {
      if (!m.has(f.dir)) m.set(f.dir, []);
      m.get(f.dir)!.push(f);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])));
  }, [scan]);

  const newFiles = useMemo(() => (scan?.files ?? []).filter((f: any) => f.state === 'new'), [scan]);

  const filtered = useMemo(() => {
    let list = papers;
    if (fStatus !== 'all') list = list.filter(p => (p.status || 'unread') === fStatus);
    if (fTags.length) list = list.filter(p => { const ts = parseTags(p.tags); return fTags.every(t => ts.includes(t)); });
    if (fDir !== '' && libDir) {
      list = list.filter(p => p.file_path && relFolder(p.file_path, libDir) === fDir);
    }
    if (sort === 'opened') {
      // 最近打开优先；从未打开的按导入时间垫底
      list = [...list].sort((a, b) => (b.last_opened_at || '').localeCompare(a.last_opened_at || ''));
    }
    return list;
  }, [papers, fStatus, fTags, fDir, libDir, sort]);

  const filterActive = fStatus !== 'all' || fTags.length > 0 || fDir !== '';

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
    if (!confirm(`删除论文「${title.slice(0, 40)}…」？\n译文缓存、高亮、问答将一并删除，不可恢复。\n（本地文件不会被删除）`)) return;
    await window.api.deletePaper(id);
    await loadPapers();
    toast('info', '已删除（本地文件保留）');
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

  async function applyStatus(id: number, status: string) {
    setStatusMenu(null);
    try {
      await window.api.setStatus({ id, status });
      await loadPapers();
    } catch (e: any) { toastErr(e); }
  }

  async function saveTags() {
    if (!tagEdit) return;
    const tags = tagEdit.value.split(/[,，]/);
    try {
      await window.api.setTags({ id: tagEdit.id, tags });
      setTagEdit(null);
      await loadPapers();
    } catch (e: any) { toastErr(e); }
  }

  function toggleTagFilter(t: string) {
    setFTags(v => v.includes(t) ? v.filter(x => x !== t) : [...v, t]);
  }

  function toggleSel(absPath: string) {
    setSel(v => {
      const n = new Set(v);
      if (n.has(absPath)) n.delete(absPath); else n.add(absPath);
      return n;
    });
  }

  return (
    <div className="list-page">
      <div className="list-head">
        <h1>论文库</h1>
        <span className="count">{filterActive ? `${filtered.length} / ${papers.length} 篇` : `${papers.length} 篇`}</span>
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

      {/* ---------- 本地论文库面板 ---------- */}
      {libDir ? (
        <div className="lib-panel">
          <div className="lib-head">
            <button className="lib-toggle" onClick={() => { const v = !libOpen; setLibOpen(v); if (v && !scan) runScan(); }}>
              <span className={`lib-caret ${libOpen ? 'open' : ''}`}>▸</span> 📁 本地库
              {scan && scan.stats.newCount > 0 && <span className="lib-new-badge">{scan.stats.newCount} 个新文件</span>}
              {scan && scan.stats.missing > 0 && <span className="lib-miss-badge">{scan.stats.missing} 缺失</span>}
            </button>
            <span className="lib-dir" title={libDir}>{libDir.split(/[\\/]/).filter(Boolean).pop()}</span>
            <button className="ghost-btn" onClick={runScan} disabled={scanning}>{scanning ? '扫描中…' : '扫描'}</button>
            <button className="ghost-btn" onClick={() => window.api.libOpenDir('').catch((e: any) => toastErr(e))} title="在系统中打开">打开</button>
          </div>

          {libOpen && scan && (
            <div className="lib-body">
              {scan.files.length === 0 && (
                <div className="lib-hint">该文件夹里还没有 PDF。把论文 PDF 放进来（支持子文件夹），再点「扫描」。</div>
              )}

              {scanGroups.map(([dir, items]) => (
                <div key={dir} className="lib-folder">
                  <div className="lib-folder-head">
                    <span className="lf-name">{dir === '' ? '（根目录）' : `📁 ${dir}`}</span>
                    <span className="n">{items.length}</span>
                    <button title="打开此文件夹" onClick={() => window.api.libOpenDir(dir).catch((e: any) => toastErr(e))}>↗</button>
                  </div>
                  {items.map((f: any) => (
                    <div key={f.absPath} className={`lib-file ${f.state === 'imported' ? 'imported' : ''}`}>
                      {f.state === 'new' ? (
                        <input type="checkbox" checked={sel.has(f.absPath)} onChange={() => toggleSel(f.absPath)} />
                      ) : (
                        <span className="lf-ok" title="已导入">✓</span>
                      )}
                      <span className="lf-name" title={f.relPath}>{f.name}</span>
                      {f.arxivId && <span className="lf-arxiv">arXiv:{f.arxivId}</span>}
                      {f.relinked && <span className="lf-relink" title="文件在外部被移动/重命名，已自动重新关联">↻</span>}
                      <span className="lf-size">{fmtSize(f.size)}</span>
                      {f.state === 'imported' && f.paperId ? (
                        <button className="lf-btn" onClick={() => openPaper(f.paperId)}>打开论文</button>
                      ) : (
                        <button className="lf-btn" onClick={() => importFiles([f.absPath])} disabled={!!importing}>导入</button>
                      )}
                    </div>
                  ))}
                </div>
              ))}

              {scan.missing?.length > 0 && (
                <div className="lib-folder miss">
                  <div className="lib-folder-head">
                    <span className="lf-name">⚠ 文件缺失（外部被移动或删除）</span>
                    <span className="n">{scan.missing.length}</span>
                  </div>
                  {scan.missing.map((m: any) => (
                    <div key={m.paperId} className="lib-file">
                      <span className="lf-warn">!</span>
                      <span className="lf-name" title={m.filePath}>{m.title}</span>
                      <button className="lf-btn" onClick={() => openPaper(m.paperId)}>打开论文</button>
                    </div>
                  ))}
                </div>
              )}

              {newFiles.length > 0 && (
                <div className="lib-actions">
                  <button className="primary" disabled={!!importing} onClick={() => importFiles([...sel])}>
                    导入选中{sel.size ? ` (${sel.size})` : ''}
                  </button>
                  <button disabled={!!importing} onClick={() => importFiles(newFiles.map((f: any) => f.absPath))}>
                    全部导入新文件 ({newFiles.length})
                  </button>
                </div>
              )}

              {importing && (
                <div className="lib-progress">
                  <div className="bar"><div style={{ width: `${Math.round((importing.done / importing.total) * 100)}%` }} /></div>
                  <span>{importing.done}/{importing.total} · {importing.title?.slice(0, 48)}{importing.title && importing.title.length > 48 ? '…' : ''}</span>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="lib-panel lib-empty">
          <span>📁 把本地论文文件夹接入为论文库——批量导入 PDF、整理目录（真实同步磁盘）</span>
          <button onClick={connectLib}>选择文件夹</button>
        </div>
      )}

      {(papers.length > 0 || filterActive) && (
        <div className="filter-bar">
          <div className="fb-status" role="group" aria-label="按状态筛选">
            <button className={fStatus === 'all' ? 'on' : ''} onClick={() => setFStatus('all')}>全部</button>
            {STATUS.map(s => (
              <button key={s.id} className={fStatus === s.id ? 'on' : ''} onClick={() => setFStatus(s.id)}>{s.label}</button>
            ))}
          </div>
          {allTags.length > 0 && (
            <div className="fb-tags" role="group" aria-label="按标签筛选">
              {allTags.slice(0, 12).map(([t, n]) => (
                <button key={t} className={fTags.includes(t) ? 'on' : ''} onClick={() => toggleTagFilter(t)} title={`${n} 篇`}>
                  {t} <span className="n">{n}</span>
                </button>
              ))}
            </div>
          )}
          {folders.length > 0 && (
            <div className="fb-tags" role="group" aria-label="按文件夹筛选">
              {folders.map(([d, n]) => (
                <button key={d || '__root'} className={fDir === d ? 'on' : ''} onClick={() => setFDir(v => v === d ? '' : d)} title={`${n} 篇`}>
                  {d === '' ? '根目录' : d} <span className="n">{n}</span>
                </button>
              ))}
            </div>
          )}
          <button className="fb-sort" onClick={() => setSort(v => v === 'imported' ? 'opened' : 'imported')}
            title="切换排序：最近导入 / 最近打开">
            {sort === 'imported' ? '最近导入' : '最近打开'}
          </button>
          {filterActive && (
            <button className="fb-clear" onClick={() => { setFStatus('all'); setFTags([]); setFDir(''); }}>清除筛选</button>
          )}
        </div>
      )}

      {busy && <div className="skeleton-card" />}

      {papers.length === 0 && !busy && (
        <div className="empty-hint">
          <div className="empty-icon">📄</div>
          还没有论文。输入上方 arXiv ID 导入第一篇；
          <br />或连接本地文件夹批量导入 PDF。
        </div>
      )}

      {papers.length > 0 && filtered.length === 0 && (
        <div className="empty-hint">没有符合当前筛选的论文，试试「清除筛选」。</div>
      )}

      <div className="paper-grid">
        {filtered.map(p => {
          let triage: any = null;
          try { triage = p.summary ? JSON.parse(p.summary) : null; } catch {}
          const st = p.status || 'unread';
          const stLabel = STATUS.find(s => s.id === st)?.label ?? '未读';
          const tags = parseTags(p.tags);
          const folder = p.file_path && libDir ? relFolder(p.file_path, libDir) : null;
          return (
            <div key={p.id} className="paper-card" onClick={() => openPaper(p.id)}>
              <div className="card-top">
                {p.arxiv_id && !p.arxiv_id.startsWith('local:') && <span className="arxiv-id">arXiv:{p.arxiv_id}</span>}
                {p.import_type === 'text' && <span className="chip-plain">文本模式</span>}
                {p.import_type === 'pdf' && <span className="chip-plain">本地 PDF</span>}
                {p.file_path && (
                  <span
                    className="file-badge"
                    title={`${p.file_path}\n点击整理文件位置`}
                    onClick={e => {
                      e.stopPropagation();
                      setMoveDlg({ id: p.id, title: p.title, curDir: folder ?? '' });
                    }}
                  >
                    📎{folder !== null && folder !== '' ? ` ${folder}` : ''}
                  </span>
                )}
                <button
                  className={`st-badge ${st}`}
                  onClick={e => { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setStatusMenu({ id: p.id, cur: st, x: r.left, y: r.bottom + 6 }); }}
                  title="点击切换阅读状态"
                >
                  {st === 'unread' ? '○ ' : ''}{stLabel}
                </button>
              </div>
              <div className="t">{p.title}</div>
              <div className={`triage-line ${triage ? '' : 'pending'}`}>
                {triage
                  ? triage.oneLiner
                  : (p.summary === null ? 'AI 摘要待生成（需配置 Provider）' : (p.arxiv_id ? '' : ''))
                }
              </div>
              <div className="card-tags">
                {tags.map(t => (
                  <span key={t} className="tg" onClick={e => { e.stopPropagation(); toggleTagFilter(t); }} title="点击按此标签筛选">{t}</span>
                ))}
                <span
                  className="tg add"
                  onClick={e => { e.stopPropagation(); setTagEdit({ id: p.id, value: tags.join(', '), x: e.clientX, y: e.clientY }); }}
                  title="编辑标签"
                >
                  {tags.length ? '＋' : '＋ 标签'}
                </span>
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

      {/* 状态切换菜单（fixed 浮层，Esc/遮罩关闭） */}
      {statusMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setStatusMenu(null)} />
          <div className="st-menu glass" style={{ left: Math.min(statusMenu.x, window.innerWidth - 110), top: Math.min(statusMenu.y, window.innerHeight - 160) }} role="menu">
            {STATUS.map(s => (
              <button key={s.id} role="menuitem" className={s.id === statusMenu.cur ? 'cur' : ''}
                onClick={() => applyStatus(statusMenu.id, s.id)}>
                {s.label}{s.id === statusMenu.cur ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </>
      )}

      {/* 标签编辑浮层 */}
      {tagEdit && (
        <>
          <div className="menu-backdrop" onClick={() => setTagEdit(null)} />
          <div className="tag-edit glass" style={{ left: Math.min(tagEdit.x, window.innerWidth - 280), top: Math.min(tagEdit.y, window.innerHeight - 140) }}>
            <div className="te-title">编辑标签</div>
            <input
              autoFocus
              type="text"
              value={tagEdit.value}
              placeholder="如：serving, kv-cache"
              onChange={e => setTagEdit(v => v! && { ...v, value: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter') saveTags();
                if (e.key === 'Escape') setTagEdit(null);
              }}
            />
            <div className="hint">逗号分隔，最多 20 个；Enter 保存</div>
            <div className="te-actions">
              <button className="primary" onClick={saveTags}>保存</button>
              <button className="ghost-btn" onClick={() => setTagEdit(null)}>取消</button>
            </div>
          </div>
        </>
      )}

      {/* 整理文件位置（本地库双向同步：真实移动磁盘文件） */}
      {moveDlg && (
        <>
          <div className="menu-backdrop" onClick={() => { setMoveDlg(null); setNewFolder(''); }} />
          <div className="move-dlg glass">
            <div className="te-title">整理文件位置</div>
            <div className="md-paper">{moveDlg.title}</div>
            <div className="md-cur">当前：{moveDlg.curDir === '' ? '（根目录）' : `📁 ${moveDlg.curDir}`}</div>
            <div className="md-list">
              {folders.filter(([d]) => d !== moveDlg.curDir).map(([d, n]) => (
                <button key={d || '__root'} onClick={() => doMove(d)}>
                  {d === '' ? '（根目录）' : `📁 ${d}`} <span className="n">{n} 篇</span>
                </button>
              ))}
              <div className="md-new">
                <input
                  type="text"
                  placeholder="新建文件夹名…"
                  value={newFolder}
                  onChange={e => setNewFolder(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newFolder.trim()) doMove(moveDlg.curDir, newFolder.trim()); }}
                />
                <button className="primary" disabled={!newFolder.trim()} onClick={() => doMove(moveDlg.curDir, newFolder.trim())}>移动</button>
              </div>
            </div>
            <div className="md-actions">
              <button className="ghost-btn" onClick={() => window.api.libRevealFile(moveDlg.id).catch((e: any) => toastErr(e))}>
                在 Finder 中显示
              </button>
              <button className="ghost-btn" onClick={() => { setMoveDlg(null); setNewFolder(''); }}>关闭</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
