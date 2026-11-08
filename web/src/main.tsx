import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadConfig, saveConfig, verifyConfig, listPaperDirs, fetchRaw, commitFile, rawPdfUrl, clearCache, type GitLabConfig } from './gitlab';
import { parseMeta, parseNotes, parseQa, parseTranslations, parseDigest, parseAnnotations, serializeAnnotations } from './vault-format';

// ---------- 认证首屏（Task 24）----------
function Login({ onOk }: { onOk: () => void }) {
  const [host, setHost] = useState('gitlab.com');
  const [token, setToken] = useState('');
  const [projectId, setProjectId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true); setErr('');
    try {
      const c: GitLabConfig = { host: host.replace(/^https?:\/\//, ''), token: token.trim(), projectId: projectId.trim() };
      const v = await verifyConfig(c);
      saveConfig(c);
      clearCache();
      alert(`已连接：${v.userName} @ ${v.projectName}`);
      onOk();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 420, margin: '80px auto', fontFamily: 'system-ui' }}>
      <h1>Paper Reader Web</h1>
      <p style={{ color: '#666' }}>连接你的 vault 知识库（GitLab 项目），随时随地阅读论文沉淀。</p>
      <div style={{ display: 'grid', gap: 10 }}>
        <input placeholder="GitLab host（如 gitlab.com）" value={host} onChange={e => setHost(e.target.value)} />
        <input placeholder="Personal Access Token（read_api + write_repository）" type="password" value={token} onChange={e => setToken(e.target.value)} />
        <input placeholder="项目 ID（Settings → General，纯数字）" value={projectId} onChange={e => setProjectId(e.target.value)} />
        <button onClick={go} disabled={busy || !token || !projectId}>{busy ? '验证中…' : '连接'}</button>
        {err && <div style={{ color: '#c33' }}>{err}</div>}
        <div style={{ color: '#999', fontSize: 13 }}>
          Token 只存在本浏览器（localStorage），不上传任何服务器。需要 read_api 权限读、write_repository 权限写标注。
        </div>
      </div>
    </div>
  );
}

// ---------- 论文列表（Task 25）----------
function PaperList({ cfg, onOpen }: { cfg: GitLabConfig; onOpen: (key: string) => void }) {
  const [papers, setPapers] = useState<any[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const dirs = await listPaperDirs(cfg);
        // 并行拉 meta（限并发 6）
        const metas: any[] = [];
        const queue = [...dirs];
        async function worker() {
          while (queue.length) {
            const d = queue.shift()!;
            try {
              const meta = parseMeta(await fetchRaw(cfg, `papers/${d}/meta.yaml`));
              metas.push({ key: d, meta });
            } catch { /* 缺 meta 的目录跳过 */ }
          }
        }
        await Promise.all([...Array(6)].map(worker));
        metas.sort((a, b) => String(b.meta.created_at).localeCompare(String(a.meta.created_at)));
        setPapers(metas);
      } catch (e: any) { setErr(e.message ?? String(e)); }
    })();
  }, [cfg]);

  if (err) return <div style={{ color: '#c33', padding: 20 }}>加载失败：{err}</div>;
  if (!papers.length) return <div style={{ padding: 20, color: '#999' }}>加载中…</div>;
  return (
    <div style={{ display: 'grid', gap: 10, padding: 16 }}>
      {papers.map(({ key, meta }) => (
        <div key={key} onClick={() => onOpen(key)} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, cursor: 'pointer' }}>
          <div style={{ fontWeight: 600 }}>{meta.title ?? key}</div>
          <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>
            {meta.arxiv_id ?? '本地'} · {meta.status ?? 'unread'} · 读至 {meta.read_pct ?? 0}%
            {(meta.tags ?? []).map((t: string) => ` · ${t}`).join('')}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- 阅读页（Task 26 + 27）----------
function Reader({ cfg, paperKey, onBack }: { cfg: GitLabConfig; paperKey: string; onBack: () => void }) {
  const [data, setData] = useState<null | {
    meta: any; translations: any[]; notes: any[]; qa: any[]; digest: any; annotations: any[];
  }>(null);
  const [err, setErr] = useState('');
  const [writeState, setWriteState] = useState<'idle' | 'writing' | 'ok' | 'fail'>('idle');
  const [selectedEn, setSelectedEn] = useState('');

  const notesBySeq = useMemo(() => {
    const m = new Map<number, any[]>();
    for (const n of data?.notes ?? []) if (n.seq != null) { const a = m.get(n.seq) ?? []; a.push(n); m.set(n.seq, a); }
    return m;
  }, [data?.notes]);
  const qaBySeq = useMemo(() => {
    const m = new Map<number, any[]>();
    for (const q of data?.qa ?? []) if (q.seq != null) { const a = m.get(q.seq) ?? []; a.push(q); m.set(q.seq, a); }
    return m;
  }, [data?.qa]);

  useEffect(() => {
    (async () => {
      try {
        const base = `papers/${paperKey}`;
        const [metaT, trT, noteT, qaT, dgT, annoT] = await Promise.all([
          fetchRaw(cfg, `${base}/meta.yaml`).catch(() => ''),
          fetchRaw(cfg, `${base}/translations.jsonl`).catch(() => ''),
          fetchRaw(cfg, `${base}/notes.md`).catch(() => ''),
          fetchRaw(cfg, `${base}/qa.jsonl`).catch(() => ''),
          fetchRaw(cfg, `${base}/digest.md`).catch(() => ''),
          fetchRaw(cfg, `${base}/annotations.json`).catch(() => '{"version":1,"items":[]}'),
        ]);
        setData({
          meta: parseMeta(metaT),
          translations: parseTranslations(trT),
          notes: parseNotes(noteT),
          qa: parseQa(qaT),
          digest: parseDigest(dgT),
          annotations: parseAnnotations(annoT),
        });
      } catch (e: any) { setErr(e.message ?? String(e)); }
    })();
  }, [cfg, paperKey]);

  // 标注回写（Task 27）：划选 → merge → commit（乐观 UI + 失败回滚）
  async function saveHighlight() {
    if (!data || !selectedEn.trim()) return;
    const prevItems = data.annotations;
    const maxLegacy = Math.max(0, ...prevItems.map(x => x.legacy_id ?? 0));
    const newItem = {
      sid: `h${prevItems.length + 1}`, legacy_id: maxLegacy + 1, kind: 'text', seq: null,
      text_en: selectedEn, note: '', color: 'yellow', created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    const nextItems = [...prevItems, newItem];
    setData({ ...data, annotations: nextItems }); // 乐观
    setWriteState('writing');
    try {
      await commitFile(cfg, `papers/${paperKey}/annotations.json`, serializeAnnotations(nextItems), `deposit: web 标注 ${paperKey}`);
      setWriteState('ok');
      setSelectedEn('');
    } catch (e: any) {
      setData({ ...data, annotations: prevItems }); // 回滚
      setWriteState('fail');
      alert(`回写失败（已回滚本地显示）：${e.message}`);
    }
  }

  if (err) return <div style={{ padding: 20, color: '#c33' }}>加载失败：{err} <button onClick={onBack}>返回</button></div>;
  if (!data) return <div style={{ padding: 20, color: '#999' }}>加载中…</div>;

  const notesAt = (seq: number) => notesBySeq.get(seq) ?? [];
  const qaAt = (seq: number) => qaBySeq.get(seq) ?? [];

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <button onClick={onBack}>← 返回</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{data.meta.title ?? paperKey}</h2>
        <a href={rawPdfUrl(cfg, `papers/${paperKey}/paper.pdf`)} target="_blank" rel="noreferrer">PDF ↗</a>
      </div>

      {data.digest?.body && (
        <div style={{ background: '#f6f8fa', border: '1px solid #e1e4e8', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <b>精炼笔记</b>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontSize: 14 }}><DigestBody body={data.digest.body} /></div>
        </div>
      )}

      {!!data.annotations.length && (
        <div style={{ marginBottom: 16 }}>
          <b style={{ fontSize: 14 }}>划线（{data.annotations.length}）</b>
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {data.annotations.map(a => (
              <div key={a.sid} id={`hl-${(a.sid ?? '').replace(/^h/, '')}`} style={{ borderLeft: '3px solid #faad14', background: '#fffbe6', padding: '6px 10px', fontSize: 13.5 }}>
                {a.text_en ?? a.text}
                {a.note ? <div style={{ color: '#888' }}>注：{a.note}</div> : null}
              </div>
            ))}
          </div>
        </div>
      )}

      <div onMouseUp={() => setSelectedEn(String(window.getSelection() ?? ''))}>
        {data.translations.map(t => (
          <div key={t.seq} id={`seq-${t.seq}`} style={{ marginBottom: 18 }}>
            <div style={{ color: '#333' }}>{t.en}</div>
            <div style={{ color: '#0b5394', marginTop: 4 }}>{t.zh}</div>
            {[...notesAt(t.seq).map(n => ({ kind: 'note' as const, x: n })), ...qaAt(t.seq).map(q => ({ kind: 'qa' as const, x: q }))].map(({ kind, x }, i) => (
              <div key={i} style={{ background: kind === 'note' ? '#fffbe6' : '#f0f7ff', borderLeft: `3px solid ${kind === 'note' ? '#faad14' : '#1677ff'}`, padding: '6px 10px', marginTop: 6, fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
                {kind === 'qa' ? <b>Q: {x.question}</b> : null}
                <div>{kind === 'qa' ? x.answer : x.text}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!data.translations.length && <div style={{ color: '#999' }}>该论文暂无译文（需在桌面端翻译后同步）。</div>}

      {selectedEn.trim().length > 2 && (
        <div style={{ position: 'sticky', bottom: 12, background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 13, color: '#666', maxHeight: 60, overflow: 'hidden' }}>选中：{selectedEn.slice(0, 120)}…</div>
          <button onClick={saveHighlight} disabled={writeState === 'writing'}>
            {writeState === 'writing' ? '回写中…' : writeState === 'ok' ? '✓ 已回写' : '划线并回写'}
          </button>
        </div>
      )}
    </div>
  );
}

// 精炼令牌渲染：【H#】跳 annotations；【N#】【Q#】按 sid 序号——
// sid 与 seq 的对应需 annotations/notes/qa 数据，这里做文本→锚点跳转（同文件内）
function DigestBody({ body }: { body: string }) {
  const parts = body.split(/(【[HNQ]\d+】)/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/【([HNQ])(\d+)】/);
        if (!m) return <span key={i}>{p}</span>;
        const [, kind, n] = m;
        const target = kind === 'H' ? `hl-${n}` : `seq-${n}`; // H → 标注卡锚点；N/Q → 双语流段落锚点（近似）
        return (
          <a key={i} href={`#${target}`} style={{ color: '#1677ff', textDecoration: 'none', fontWeight: 600 }} onClick={e => {
            e.preventDefault();
            document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}>{p}</a>
        );
      })}
    </>
  );
}

// ---------- App ----------
function App() {
  const [cfg, setCfg] = useState<GitLabConfig | null>(() => loadConfig());
  const [paperKey, setPaperKey] = useState<string | null>(null);

  if (!cfg) return <Login onOk={() => setCfg(loadConfig())} />;
  if (paperKey) return <Reader cfg={cfg} paperKey={paperKey} onBack={() => { setPaperKey(null); clearCache(); }} />;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: 12, borderBottom: '1px solid #eee' }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Paper Reader Web</h1>
        <button onClick={() => { localStorage.removeItem('pr-web:gitlab'); setCfg(null); }}>断开连接</button>
      </div>
      <PaperList cfg={cfg} onOpen={setPaperKey} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
