import { useEffect, useState } from 'react';
import { toast, toastErr } from './Toast';

const PRESETS: Array<{ name: string; protocol: 'openai' | 'anthropic'; baseUrl: string; model: string }> = [
  { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'GLM (智谱)', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { name: 'Qwen (阿里)', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { name: 'Ollama 本地', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

export default function Settings() {
  return (
    <div className="settings-page">
      <ProfileSection />
      <ProviderSection />
      <RepoSection />
    </div>
  );
}

// 读者画像：背景自述 + 提问/反馈信号 + 当前问答策略
function ProfileSection() {
  const [bg, setBg] = useState('');
  const [saved, setSaved] = useState(false);
  const [profile, setProfile] = useState<any>(null);

  async function load() {
    try {
      const p = await window.api.getProfile();
      setProfile(p);
      setBg(p.bg ?? '');
    } catch { /* 静默 */ }
  }
  useEffect(() => {
    load();
    // 反馈信号变化 → 实时刷新策略卡（阅读页点「太浅/太深」这里立即跟上）
    const off = (window.api as any).onProfileChanged?.(() => load());
    return () => { off?.(); };
  }, []);

  async function save() {
    try {
      await window.api.setProfileBg(bg);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      load();
    } catch (e: any) { toastErr(e); }
  }

  const s = profile?.strategy;
  const sig = profile?.signals ?? {};
  const sigRows: Array<[string, string, number]> = [
    ['concept', '概念类提问', sig.concept ?? 0],
    ['method', '方法类提问', sig.method ?? 0],
    ['result', '结果类提问', sig.result ?? 0],
    ['tooShallow', '反馈「太浅」', sig.tooShallow ?? 0],
    ['tooDeep', '反馈「太深」', sig.tooDeep ?? 0],
    ['justRight', '反馈「刚好」', sig.justRight ?? 0],
  ];
  const sigTotal = sigRows.reduce((a, r) => a + r[2], 0);

  return (
    <section className="settings-section">
      <h2>读者画像</h2>
      <p className="section-desc">告诉助手你的背景，它会据此调整回答深度和术语用法；你的提问类型与「太浅/太深」反馈也会持续校准它。</p>
      <div className="profile-box">
        <textarea
          placeholder="例：AI Infra 方向，熟悉 serving 和 KV cache，不熟悉编译优化；中文回答"
          value={bg}
          onChange={e => setBg(e.target.value)}
          rows={3}
        />
        <div className="profile-save-row">
          <button className="primary" onClick={save} disabled={!bg.trim() && !(profile?.bg ?? '').length}>
            {saved ? '✓ 已保存' : '保存背景'}
          </button>
          {bg.trim() !== (profile?.bg ?? '') && bg.trim().length > 0 && <span className="dirty-hint">未保存</span>}
        </div>
      </div>
      {s && (
        <div className="strategy-card">
          <div className="strategy-title">当前问答策略（自动派生）</div>
          <div className="strategy-line">{s.depthRule}</div>
          <div className="strategy-line">{s.vocabRule}</div>
          {sigTotal > 0 && (
            <div className="signal-grid">
              {sigRows.filter(r => r[2] > 0).map(([k, label, n]) => (
                <span key={k} className="signal-pill">{label} <b>{n}</b></span>
              ))}
            </div>
          )}
          {sigTotal === 0 && <div className="strategy-line dim">还没有信号——提问几次、给回答点点反馈，策略会随之进化。</div>}
        </div>
      )}
    </section>
  );
}

function ProviderSection() {
  const [providers, setProviders] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function refresh() { setProviders(await window.api.listProviders()); }
  useEffect(() => { refresh(); }, []);

  async function save() {
    await window.api.saveProvider(editing);
    setEditing(null);
    await refresh();
  }

  async function test() {
    setTesting(true); setTestResult(null);
    setTestResult(await window.api.testProvider(editing));
    setTesting(false);
  }

  return (
    <div className="settings-section">
      <h3>LLM Provider（翻译与问答都走这里）</h3>
      {providers.map(p => (
        <div key={p.id} className="provider-row">
          <div>
            <span className="name">{p.name}</span>
            {p.is_default ? <span className="badge">默认</span> : null}
            <div className="meta">{p.protocol} · {p.base_url} · {p.model} · {p.api_key}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setEditing({ ...p, apiKey: '' })}>编辑</button>
            <button onClick={async () => {
              if (confirm(`删除 Provider「${p.name}」？`)) { await window.api.deleteProvider(p.id); refresh(); }
            }}>删除</button>
          </div>
        </div>
      ))}

      {editing ? (
        <div style={{ marginTop: 16 }}>
          <div className="form-grid">
            <label>预设</label>
            <select onChange={e => {
              const preset = PRESETS.find(x => x.name === e.target.value);
              if (preset) setEditing({ ...editing, ...preset });
            }}>
              <option value="">选择预设…</option>
              {PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <label>名称</label>
            <input type="text" value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            <label>协议</label>
            <select value={editing.protocol ?? 'openai'} onChange={e => setEditing({ ...editing, protocol: e.target.value })}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic 原生</option>
            </select>
            <label>Base URL</label>
            <input type="text" value={editing.baseUrl ?? ''} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} />
            <label>API Key</label>
            <input type="password" placeholder={editing.id ? '留空则保留原 Key' : ''} value={editing.apiKey ?? ''} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} />
            <label>模型</label>
            <input type="text" value={editing.model ?? ''} onChange={e => setEditing({ ...editing, model: e.target.value })} />
            <label>设为默认</label>
            <input type="checkbox" checked={!!editing.isDefault} onChange={e => setEditing({ ...editing, isDefault: e.target.checked })} />
          </div>
          <div className="form-actions">
            <button className="primary" onClick={save}>保存</button>
            <button onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连通'}</button>
            <button onClick={() => setEditing(null)}>取消</button>
          </div>
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
            </div>
          )}
        </div>
      ) : (
        <button className="primary" onClick={() => setEditing({ protocol: 'openai', isDefault: providers.length === 0 })}>+ 添加 Provider</button>
      )}
      <div className="hint" style={{ marginTop: 10 }}>
        自部署服务（Ollama / vLLM）选 OpenAI 兼容协议，Base URL 填 http://localhost:11434/v1 等。API Key 用本机密钥加密存储。
      </div>
    </div>
  );
}

function RepoSection() {
  const [repo, setRepo] = useState<{ path: string | null; connected: boolean } | null>(null);
  const [pathInput, setPathInput] = useState('D:\\paper');
  const [fulltext, setFulltext] = useState<any[]>([]);
  const [msg, setMsg] = useState('');

  async function refresh() {
    setRepo(await window.api.getRepo());
    setFulltext(await window.api.listFulltext());
  }
  useEffect(() => { refresh(); }, []);

  async function connect() {
    const r = await window.api.setRepo(pathInput);
    if (r.ok) { setMsg('已连接'); await refresh(); }
    else setMsg(r.error ?? '连接失败');
  }

  async function importOne(arxivId: string) {
    try {
      const r = await window.api.importFulltext(arxivId);
      setMsg(`已导入 ${arxivId}（${r.count} 段）`);
    } catch (e: any) { setMsg(e?.message ?? String(e)); }
  }

  return (
    <div className="settings-section">
      <h3>知识库仓库连接（可选）</h3>
      <div className="repo-status">
        <span>{repo?.connected ? `✓ 已连接：${repo.path}` : '未连接'}</span>
      </div>
      <div className="import-row">
        <input type="text" value={pathInput} onChange={e => setPathInput(e.target.value)} />
        <button className="primary" onClick={connect}>连接</button>
      </div>
      {msg && <div className="hint" style={{ marginBottom: 10 }}>{msg}</div>}
      {repo?.connected && fulltext.length > 0 && (
        <>
          <div className="hint" style={{ margin: '10px 0' }}>.fulltext 缓存（点击导入论文库）：</div>
          <div className="fulltext-list">
            {fulltext.map(f => (
              <div key={f.arxivId} className="item">
                <span>{f.arxivId}</span>
                <button onClick={() => importOne(f.arxivId)}>导入</button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="hint" style={{ marginTop: 10 }}>
        连接后可导入全文缓存、翻译时注入术语表、问答一键写回笔记 Q&A 节（只追加，不重写）。
      </div>
    </div>
  );
}
