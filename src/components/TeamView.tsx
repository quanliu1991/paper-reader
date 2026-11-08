// TeamView：实验室团队页（四区：阅读清单 / 组会排期 / 动态 / 成员）。
// 数据全部走 team:* IPC（自托管服务端）；未登录/未选团队显示引导态。
// CSS 前缀 tm-（设计 token 复用 --bg/--panel/--card/--accent/--border）。
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';
import { IconPlus } from './icons';

type Tab = 'list' | 'meetings' | 'feed' | 'members';

export default function TeamView() {
  const [info, setInfo] = useState<any>(null);
  const [teams, setTeams] = useState<any[]>([]);
  const [team, setTeam] = useState<any>(null); // 详情（含成员+邀请码）
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('tm:tab') as Tab) || 'list');
  const [busy, setBusy] = useState(false);
  const openPaper = useStore(s => s.openPaper);
  const loadPapers = useStore(s => s.loadPapers);

  useEffect(() => { localStorage.setItem('tm:tab', tab); }, [tab]);

  async function load(silent = false) {
    if (!silent) setBusy(true);
    try {
      const i = await window.api.accountGetInfo();
      setInfo(i);
      if (!i.loggedIn) return;
      const ts = await window.api.teamList();
      setTeams(ts);
      if (i.activeTeamId) {
        try { setTeam(await window.api.teamGet(i.activeTeamId)); } catch { setTeam(null); }
      }
    } catch { /* 静默 */ } finally { setBusy(false); }
  }
  useEffect(() => {
    load();
    const off = window.api.onAccountChanged(() => load(true));
    return () => { off(); };
  }, []);

  // ---------- 引导态 ----------
  if (!info || busy && !team) return <div className="tm-page"><div className="tm-empty">加载中…</div></div>;
  if (!info.loggedIn) {
    return (
      <div className="tm-page">
        <div className="tm-empty">
          <div className="tm-empty-icon">👥</div>
          <div>团队功能需要登录实验室自建服务器</div>
          <div className="tm-empty-sub">到 设置 → 账户与团队 填写服务器地址并登录</div>
          <button className="primary" onClick={() => useStore.getState().setView('settings')}>去设置</button>
        </div>
      </div>
    );
  }
  if (!info.activeTeamId || !team) {
    return <NoTeam info={info} teams={teams} onJoined={() => load()} />;
  }

  return (
    <div className="tm-page">
      <header className="tm-head">
        <div className="tm-title">
          <h2>{team.name}</h2>
          {teams.length > 1 && (
            <select value={info.activeTeamId} onChange={async e => {
              await window.api.accountSetActiveTeam(e.target.value);
              load();
            }}>
              {teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>
        <div className="tm-invite" title="点击复制邀请码，发给师兄弟" onClick={() => {
          navigator.clipboard.writeText(team.invite_code).then(
            () => toast('success', `邀请码 ${team.invite_code} 已复制`),
            () => toast('error', '复制失败，请手动选择'),
          );
        }}>
          邀请码 <b>{team.invite_code}</b> ⇧
        </div>
      </header>

      <nav className="tm-tabs" role="tablist">
        {([['list', '阅读清单'], ['meetings', '组会排期'], ['feed', '动态'], ['members', '成员']] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} role="tab" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {tab === 'list' && <ReadingListTab teamId={team.id} openPaper={openPaper} loadPapers={loadPapers} />}
      {tab === 'meetings' && <MeetingsTab teamId={team.id} />}
      {tab === 'feed' && <FeedTab teamId={team.id} />}
      {tab === 'members' && <MembersTab team={team} onChanged={() => load(true)} />}
    </div>
  );
}

// ---------- 未入团队：创建 / 凭码加入 ----------
function NoTeam({ info, teams, onJoined }: { info: any; teams: any[]; onJoined: () => void }) {
  const [mode, setMode] = useState<'join' | 'create'>('join');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    try {
      setBusy(true);
      if (mode === 'join') {
        const t = await window.api.teamJoin(code);
        await window.api.accountSetActiveTeam(t.id);
        toast('success', `已加入 ${t.name}`);
      } else {
        const t = await window.api.teamCreate(name);
        await window.api.accountSetActiveTeam(t.id);
        toast('success', `团队已创建，邀请码 ${t.invite_code}（设置里可随时查看）`);
      }
      onJoined();
    } catch (e: any) { toastErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="tm-page">
      <div className="tm-empty">
        <div className="tm-empty-icon">👥</div>
        <div>{teams.length ? '你还没选择当前团队' : '加入或创建一个实验室团队'}</div>
        <div className="tm-empty-sub">共享阅读清单 · 组会排期 · 团队动态 · 共享术语表</div>
        <div className="mode-switch" style={{ margin: '14px auto 0', width: 'fit-content' }}>
          <button className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>凭邀请码加入</button>
          <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>创建团队</button>
        </div>
        {teams.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {teams.map(t => (
              <button key={t.id} className="ghost-btn" style={{ margin: 4 }} onClick={async () => {
                await window.api.accountSetActiveTeam(t.id);
                onJoined();
              }}>{t.name}（{t.member_count} 人）</button>
            ))}
          </div>
        )}
        <div className="import-row" style={{ marginTop: 12, maxWidth: 420 }}>
          {mode === 'join' ? (
            <input type="text" placeholder="8 位邀请码（如 K7M2QP9X）" value={code}
              onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          ) : (
            <input type="text" placeholder="团队名（如 LLM 师门）" value={name}
              onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          )}
          <button className="primary" disabled={busy || (mode === 'join' ? code.length !== 8 : !name.trim())} onClick={submit}>
            {mode === 'join' ? '加入' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 阅读清单 ----------
function ReadingListTab({ teamId, openPaper, loadPapers }: { teamId: string; openPaper: (id: number) => Promise<void>; loadPapers: () => Promise<void> }) {
  const [items, setItems] = useState<any[]>([]);
  const [papers, setPapers] = useState<any[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [pickPaperId, setPickPaperId] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    try { setItems(await window.api.teamReadingList(teamId)); } catch (e: any) { toastErr(e); } finally { setLoading(false); }
  }
  useEffect(() => { load(); setPapers(useStore.getState().papers); }, [teamId]);
  // 论文库加载（分享下拉需要）
  useEffect(() => { (async () => { await loadPapers(); setPapers(useStore.getState().papers); })(); }, []);

  async function act(item: any, action: 'claim' | 'unclaim' | 'done') {
    try {
      await window.api.teamItemAction(item.id, action);
      load();
    } catch (e: any) { toastErr(e); }
  }

  async function add() {
    const p = papers.find(x => String(x.id) === pickPaperId);
    if (!p?.arxiv_id) { toast('error', '本地导入的 PDF 没有 arXiv ID，暂不支持分享（可手动在团队清单录入）'); return; }
    try {
      await window.api.teamAddItem({ teamId, arxivId: p.arxiv_id, title: p.title, note });
      setAddOpen(false); setPickPaperId(''); setNote('');
      toast('success', '已分享到团队清单');
      load();
    } catch (e: any) { toastErr(e); }
  }

  const open = items.filter(i => i.status !== 'done');
  const done = items.filter(i => i.status === 'done');

  return (
    <div className="tm-panel">
      <div className="tm-toolbar">
        <button className="primary" onClick={() => setAddOpen(v => !v)}><IconPlus s={14} /> 分享论文到清单</button>
        <span className="tm-count">{open.length} 待读 · {done.length} 已完成</span>
      </div>

      {addOpen && (
        <div className="tm-add glass">
          <div className="te-title">从我的论文库选择</div>
          <div className="import-row">
            <select value={pickPaperId} onChange={e => setPickPaperId(e.target.value)} style={{ flex: 2 }}>
              <option value="">选择论文（仅 arXiv 导入的论文可分享）</option>
              {papers.filter((p: any) => p.arxiv_id).map((p: any) => (
                <option key={p.id} value={p.id}>{p.title.slice(0, 60)}</option>
              ))}
            </select>
            <button className="primary" disabled={!pickPaperId} onClick={add}>分享</button>
          </div>
          <input type="text" className="tm-note-input" placeholder="为什么值得读（可选，如：组会候选 / 新 SOTA）" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      )}

      {loading && <div className="tm-empty">加载中…</div>}
      {!loading && items.length === 0 && <div className="tm-empty">清单是空的——把值得师门共读的论文分享进来</div>}

      {open.length > 0 && (
        <div className="tm-items">
          {open.map(it => (
            <div key={it.id} className={`tm-item ${it.status}`}>
              <div className="tm-item-main">
                <div className="tm-item-title">{it.title}</div>
                <div className="tm-item-meta">
                  arXiv:{it.arxiv_id} · {it.added_by_name} 添加{it.note ? ` · ${it.note}` : ''}
                </div>
              </div>
              <div className="tm-item-actions">
                {it.status === 'open' && <button onClick={() => act(it, 'claim')}>认领</button>}
                {it.status === 'claimed' && (
                  <>
                    <span className="tm-claim" title={it.claimed_by_name ?? ''}>{it.claimed_by_name || '?'} 在读</span>
                    <button onClick={() => act(it, 'unclaim')}>取消</button>
                    <button className="primary" onClick={() => act(it, 'done')}>读完</button>
                  </>
                )}
                <button className="icon-btn" title="导入到我的论文库" onClick={async () => {
                  try {
                    await window.api.importArxiv(it.arxiv_id);
                    await loadPapers();
                    toast('success', '导入已开始（解析/摘要后台进行）');
                  } catch (e: any) { toastErr(e); }
                }}>⇩</button>
                <ImportedBadge arxivId={it.arxiv_id} papers={papers} openPaper={openPaper} />
              </div>
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <details className="tm-done">
          <summary>已完成（{done.length}）</summary>
          {done.map(it => (
            <div key={it.id} className="tm-item done">
              <div className="tm-item-main">
                <div className="tm-item-title">{it.title}</div>
                <div className="tm-item-meta">arXiv:{it.arxiv_id}</div>
              </div>
              <ImportedBadge arxivId={it.arxiv_id} papers={papers} openPaper={openPaper} />
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// 论文已在自己库中 → 直接打开；否则一键导入
function ImportedBadge({ arxivId, papers, openPaper }: { arxivId: string; papers: any[]; openPaper: (id: number) => Promise<void> }) {
  const mine = useMemo(() => papers.find((p: any) => p.arxiv_id === arxivId), [papers, arxivId]);
  if (!mine) return null;
  return <button className="icon-btn" title="已在库中，点击打开" onClick={() => openPaper(mine.id)}>📖</button>;
}

// ---------- 组会排期 ----------
function MeetingsTab({ teamId }: { teamId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [paperId, setPaperId] = useState('');
  const [papers, setPapers] = useState<any[]>([]);
  const [notesEdit, setNotesEdit] = useState<{ id: string; value: string } | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try { setItems(await window.api.teamMeetings(teamId)); } catch (e: any) { toastErr(e); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [teamId]);
  useEffect(() => { (async () => { await useStore.getState().loadPapers(); setPapers(useStore.getState().papers); })(); }, []);

  async function add() {
    const p = papers.find(x => String(x.id) === paperId);
    try {
      await window.api.teamAddMeeting({
        teamId, title, scheduledAt: new Date(when).toISOString(),
        paperArxivId: p?.arxiv_id, paperTitle: p?.title,
      });
      setAddOpen(false); setTitle('');
      toast('success', '组会已排期');
      load();
    } catch (e: any) { toastErr(e); }
  }

  async function act(m: any, action: 'claim' | 'unclaim') {
    try { await window.api.teamMeetingAction(m.id, { action }); load(); } catch (e: any) { toastErr(e); }
  }

  async function saveNotes() {
    if (!notesEdit) return;
    try {
      await window.api.teamMeetingAction(notesEdit.id, { notes: notesEdit.value });
      setNotesEdit(null);
      load();
    } catch (e: any) { toastErr(e); }
  }

  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  return (
    <div className="tm-panel">
      <div className="tm-toolbar">
        <button className="primary" onClick={() => setAddOpen(v => !v)}><IconPlus s={14} /> 排一次组会</button>
        <span className="tm-count">{items.length} 次记录</span>
      </div>

      {addOpen && (
        <div className="tm-add glass">
          <div className="te-title">新组会</div>
          <div className="import-row">
            <input type="text" placeholder="标题（如 第 43 次组会）" value={title} onChange={e => setTitle(e.target.value)} style={{ flex: 2 }} />
            <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
          </div>
          <div className="import-row">
            <select value={paperId} onChange={e => setPaperId(e.target.value)}>
              <option value="">领读论文（可选，从我的库选）</option>
              {papers.filter((p: any) => p.arxiv_id).map((p: any) => (
                <option key={p.id} value={p.id}>{p.title.slice(0, 60)}</option>
              ))}
            </select>
            <button className="primary" disabled={!title.trim()} onClick={add}>排期</button>
          </div>
        </div>
      )}

      {loading && <div className="tm-empty">加载中…</div>}
      {!loading && items.length === 0 && <div className="tm-empty">还没有组会记录</div>}

      <div className="tm-meetings">
        {items.map(m => (
          <div key={m.id} className="tm-meeting">
            <div className="tm-meeting-head">
              <span className="tm-when">{fmt(m.scheduled_at)}</span>
              <span className="tm-meeting-title">{m.title}</span>
              {m.presenter_id
                ? <span className="tm-claim">领读：{m.presenter_display}</span>
                : <button onClick={() => act(m, 'claim')}>我来领读</button>}
            </div>
            {m.paper_arxiv_id && (
              <div className="tm-meeting-paper">📄 {m.paper_title}（arXiv:{m.paper_arxiv_id}）</div>
            )}
            <div className="tm-meeting-notes">
              {notesEdit && notesEdit.id === m.id && (
                <NotesEditor value={notesEdit.value}
                  onChange={v => setNotesEdit({ id: m.id, value: v })}
                  onSave={() => void saveNotes()} onCancel={() => setNotesEdit(null)} />
              )}
              {!(notesEdit && notesEdit.id === m.id) && (
                <div className="tm-notes-line" onClick={() => setNotesEdit({ id: m.id, value: m.notes ?? '' })}>
                  {m.notes ? m.notes : '＋ 会议笔记（点击编辑）'}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 动态流 ----------
// 笔记行内编辑（子组件隔离受控状态，收窄 null 判断）
function NotesEditor({ value, onChange, onSave, onCancel }: {
  value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  return (
    <div className="import-row">
      <input type="text" value={value} autoFocus onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} />
      <button className="primary" onClick={onSave}>存</button>
      <button className="ghost-btn" onClick={onCancel}>取消</button>
    </div>
  );
}

function FeedTab({ teamId }: { teamId: string }) {
  const [feed, setFeed] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try { setFeed(await window.api.teamFeed(teamId, 80)); } catch (e: any) { toastErr(e); } finally { setLoading(false); }
    })();
  }, [teamId]);

  const ICONS: Record<string, string> = {
    progress: '📖', claim: '✋', done: '✅', unclaim: '↩️', add: '➕', item_remove: '🗑️',
    meeting: '📅', term: '🔤', join: '👋', leave: '👋',
  };

  function line(f: any): string {
    const who = f.user?.display_name || f.user?.username || '?';
    const p = f.payload ?? {};
    switch (f.type) {
      case 'progress': return `${who} 读《${(p.title ?? '').slice(0, 40)}》至 ${p.pct}%`;
      case 'claim': return `${p.name ?? who} 认领了《${(p.title ?? '').slice(0, 40)}》`;
      case 'done': return `${p.name ?? who} 读完《${(p.title ?? '').slice(0, 40)}》`;
      case 'unclaim': return `《${(p.title ?? '').slice(0, 40)}》回到待读`;
      case 'add': return `${who} 分享了《${(p.title ?? '').slice(0, 40)}》`;
      case 'item_remove': return `${who} 移除了《${(p.title ?? '').slice(0, 40)}》`;
      case 'meeting': {
        if (p.action === 'create') return `${who} 排了组会「${p.title}」`;
        if (p.action === 'claim_presenter') return `${p.name ?? who} 认领领读「${p.title}」`;
        if (p.action === 'remove') return `${who} 取消了「${p.title}」`;
        return `${who} 更新了「${p.title}」`;
      }
      case 'term': return `${p.name ?? who} 同步了术语表（+${p.added} 改 ${p.updated}）`;
      case 'join': return p.transferred ? `创建者转让给 ${p.name}` : `${p.name ?? who} 加入了团队`;
      case 'leave': return p.removed ? `${p.name} 被移出团队` : `${p.name ?? who} 退出了团队`;
      default: return JSON.stringify(p).slice(0, 60);
    }
  }

  const fmt = (iso: string) => {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60_000) return '刚刚';
      if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
      return new Date(iso).toLocaleDateString('zh-CN');
    } catch { return iso; }
  };

  return (
    <div className="tm-panel">
      {loading && <div className="tm-empty">加载中…</div>}
      {!loading && feed.length === 0 && <div className="tm-empty">还没有动态——读篇论文试试</div>}
      <div className="tm-feed">
        {feed.map((f: any) => (
          <div key={f.id} className="tm-feed-item">
            <span className="tm-feed-icon">{ICONS[f.type] ?? '·'}</span>
            <span className="tm-feed-line">{line(f)}</span>
            <span className="tm-feed-time">{fmt(f.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 成员 ----------
function MembersTab({ team, onChanged }: { team: any; onChanged: () => void }) {
  const [myId, setMyId] = useState('');

  useEffect(() => {
    window.api.accountGetInfo().then((i: any) => setMyId(i.user?.id ?? ''));
  }, []);

  const isOwner = team.members?.some((m: any) => m.id === myId && m.role === 'owner');

  async function remove(uid: string, name: string) {
    if (!confirm(`移除成员 ${name}？`)) return;
    try {
      await window.api.teamRemoveMember(team.id, uid);
      toast('success', '已移除');
      onChanged();
    } catch (e: any) { toastErr(e); }
  }

  async function transfer(uid: string, name: string) {
    if (!confirm(`把创建者转让给 ${name}？转让后你变为普通成员`)) return;
    try {
      await window.api.teamTransfer(team.id, uid);
      toast('success', '已转让');
      onChanged();
    } catch (e: any) { toastErr(e); }
  }

  return (
    <div className="tm-panel">
      <div className="tm-toolbar">
        <span className="tm-count">{team.members?.length ?? 0} 位成员 · 点击右上邀请码分享给师兄弟</span>
      </div>
      <div className="tm-members">
        {team.members?.map((m: any) => (
          <div key={m.id} className="tm-member">
            <div className="tm-avatar">{(m.display_name || m.username).slice(0, 1)}</div>
            <div className="tm-member-main">
              <div className="tm-member-name">{m.display_name || m.username}</div>
              <div className="tm-item-meta">@{m.username} · {m.role === 'owner' ? '导师/创建者' : '成员'}</div>
            </div>
            {isOwner && m.id !== myId && (
              <div className="tm-item-actions">
                <button onClick={() => transfer(m.id, m.display_name || m.username)}>转让</button>
                <button className="danger" onClick={() => remove(m.id, m.display_name || m.username)}>移除</button>
              </div>
            )}
            {m.id === myId && m.role !== 'owner' && (
              <button className="ghost-btn" onClick={() => remove(myId, '自己')}>退出团队</button>
            )}
          </div>
        ))}
      </div>
      <div className="tm-toolbar" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <button className="ghost-btn" onClick={async () => {
          try {
            const r = await window.api.teamSyncTerms();
            const c = r.pulled.conflicts.length;
            toast('success', `术语同步完成：推送 +${r.pushed.added}/改${r.pushed.updated}，拉取 +${r.pulled.added}${c ? `，${c} 条冲突已保留本地版本` : ''}`);
          } catch (e: any) { toastErr(e); }
        }}>同步共享术语表</button>
        <span className="tm-count">把 vault 术语表推给团队，并拉取师门积累（同名冲突保留本地）</span>
      </div>
    </div>
  );
}
