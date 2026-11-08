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
      <AppearanceSection />
      <AccountSection />
      <ProfileSection />
      <ProviderSection />
      <LibrarySection />
      <VaultSection />
      <RepoSection />
    </div>
  );
}

// 账户与团队（自托管服务端）：服务器地址 + 登录/注册/退出 + 团队切换 + 进度上报开关
function AccountSection() {
  const [info, setInfo] = useState<any>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [teams, setTeams] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const i = await window.api.accountGetInfo();
      setInfo(i);
      setServerUrl(i.serverUrl ?? '');
      if (i.loggedIn) {
        try { setTeams(await window.api.teamList()); } catch { /* 服务器不可达 */ setTeams([]); }
      } else setTeams([]);
    } catch { /* 静默 */ }
  }
  useEffect(() => {
    load();
    const off = window.api.onAccountChanged(() => load()); // 401 过期/登出统一刷新
    return () => { off(); };
  }, []);

  async function saveServer() {
    try {
      setBusy(true);
      await window.api.accountSetServer(serverUrl);
      await load();
      toast('success', '服务器地址已保存');
    } catch (e: any) { toastErr(e); } finally { setBusy(false); }
  }

  async function submit() {
    try {
      setBusy(true);
      if (mode === 'login') await window.api.accountLogin({ username, password });
      else await window.api.accountRegister({ username, password, displayName });
      setPassword('');
      await load();
      toast('success', mode === 'login' ? '登录成功' : '注册成功');
    } catch (e: any) { toastErr(e); } finally { setBusy(false); }
  }

  async function pickTeam(teamId: string) {
    try {
      await window.api.accountSetActiveTeam(teamId || null);
      await load();
    } catch (e: any) { toastErr(e); }
  }

  const activeTeam = teams.find((t: any) => t.id === info?.activeTeamId);

  return (
    <section className="settings-section">
      <h3>账户与团队</h3>
      <div className="import-row">
        <input
          type="text"
          value={serverUrl}
          placeholder="团队服务器地址（如 http://192.168.1.10:8787，实验室自托管）"
          onChange={e => setServerUrl(e.target.value)}
        />
        <button className="ghost-btn" disabled={busy} onClick={saveServer}>保存</button>
      </div>

      {!info?.loggedIn ? (
        <>
          <div className="mode-switch" style={{ marginTop: 10, width: 'fit-content' }}>
            <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>登录</button>
            <button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>注册</button>
          </div>
          <div className="import-row" style={{ marginTop: 10 }}>
            <input type="text" placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} />
            <input type="password" placeholder={mode === 'register' ? '密码（至少 8 位）' : '密码'} value={password}
              onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
            {mode === 'register' && (
              <input type="text" placeholder="显示名（可选，师门里怎么称呼你）" value={displayName} onChange={e => setDisplayName(e.target.value)} />
            )}
            <button className="ghost-btn" disabled={busy || !username || !password} onClick={submit}>
              {mode === 'login' ? '登录' : '注册'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="more-row" style={{ marginTop: 10 }}>
            <span>已登录：<b>{info.user?.username}</b>{teams.length ? ` · ${activeTeam?.name ?? '未选择团队'}` : ''}</span>
            <button onClick={async () => { await window.api.accountLogout(); load(); }}>退出登录</button>
          </div>
          {teams.length > 0 && (
            <div className="import-row" style={{ marginTop: 8 }}>
              <select value={info.activeTeamId ?? ''} onChange={e => pickTeam(e.target.value)} style={{ flex: 1 }}>
                <option value="">选择当前团队（进度上报与术语同步目标）</option>
                {teams.map((t: any) => (
                  <option key={t.id} value={t.id}>{t.name}（{t.member_count} 人 · {t.role === 'owner' ? '导师/创建者' : '成员'}）</option>
                ))}
              </select>
            </div>
          )}
          <div className="more-row" style={{ marginTop: 8 }}>
            <span>上报阅读进度到团队</span>
            <button onClick={async () => {
              await window.api.accountSetProgressReport(!info.progressReport);
              load();
            }}>{info.progressReport ? '已开启' : '已关闭'}</button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            只上报论文标题与进度百分比到实验室自建服务器；划线/笔记/译文等 vault 资产永远留在本机。
          </div>
        </>
      )}
    </section>
  );
}

// vault 知识库（P1）：本地文件夹作为事实源，双写 sidecar 文件
function VaultSection() {
  const [dir, setDir] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [syncCfg, setSyncCfg] = useState<any>(null);
  const [syncState, setSyncState] = useState<any>(null);
  const [remoteUrl, setRemoteUrl] = useState('');

  async function load() {
    try {
      const d = await window.api.vaultGetDir();
      setDir(d ?? '');
      setStatus(await window.api.vaultStatus());
      const c = await window.api.syncGetConfig();
      setSyncCfg(c);
      setRemoteUrl(c.remoteUrl ?? '');
      setSyncState(await window.api.syncStatus());
    } catch { /* 静默 */ }
  }
  useEffect(() => {
    load();
    const off = (window.api as any).onSyncState?.((s: any) => {
      setSyncState((prev: any) => {
        if (s?.firstPushSucceeded && !prev?.firstPushSucceeded && s.firstPushSucceeded !== prev?.toastShown) {
          toast('success', '首次推送成功——同步链路已验证，可关闭「干跑模式」正式推送');
        }
        return s;
      });
    });
    return () => { off?.(); };
  }, []);

  async function pick() {
    try {
      const d = await window.api.vaultPickDir();
      if (!d) return;
      await window.api.vaultSetDir(d);
      setDir(d);
      setStatus(await window.api.vaultStatus());
      toast('success', 'vault 知识库已连接——此后划线/笔记/问答/译文会同步写入该文件夹');
    } catch (e: any) { toastErr(e); }
  }

  async function saveSync(patch: any) {
    try {
      const c = await window.api.syncSetConfig(patch);
      setSyncCfg(c);
      toast('success', '同步配置已保存');
    } catch (e: any) { toastErr(e); }
  }

  const errors = status?.errors ?? 0;
  const stateLabel: Record<string, string> = {
    unconfigured: '未配置', idle: '已同步', dirty: '待提交', syncing: '同步中',
    conflict: '有冲突（已自动留档）', offline: '离线',
  };
  return (
    <section className="settings-section">
      <h2>vault 知识库</h2>
      <p className="section-desc">把全部沉淀资产（划线/笔记/问答/精炼/译文/闪卡）以人类可读文件写入本地文件夹——文件即事实源，可用任何编辑器打开；配置 Git 远端后多设备同步。</p>
      <div className="repo-status">
        <span>{status?.enabled ? `✓ 已连接：${dir}` : '未连接'}</span>
        {status?.enabled && errors > 0 && <span className="dim" style={{ marginLeft: 8 }}>（{errors} 次写入失败）</span>}
      </div>
      <div className="import-row">
        <input type="text" value={dir} placeholder="选择 vault 文件夹…" readOnly onClick={pick} style={{ cursor: 'pointer' }} />
        <button className="primary" onClick={pick}>选择文件夹</button>
      </div>
      {status?.enabled && (
        <div className="import-row" style={{ marginTop: 10 }}>
          <button className="ghost-btn" onClick={async () => {
            try {
              const r = await window.api.vaultMigrate();
              if (r.report.lfsHint) toast('error', `PDF 总量 ${(r.report.pdfBytes / 1024 / 1024 / 1024).toFixed(1)}GB 超过 5GB——建议启用 Git LFS（见 README）`);
              else toast('success', `迁移完成：${r.report.papers} 篇论文 / ${r.report.files} 个文件${r.report.errors.length ? `（${r.report.errors.length} 条提示）` : ''}`);
            } catch (e: any) { toastErr(e); }
          }}>全量迁移到 vault</button>
          <button className="ghost-btn" onClick={async () => {
            try {
              const r = await window.api.vaultReconcile();
              if (r.ok) toast('success', '对账通过：vault 与数据库一致');
              else toast('error', '对账有差异：' + r.report.checks.filter((c: any) => !c.pass).map((c: any) => c.name).join('、'));
            } catch (e: any) { toastErr(e); }
          }}>一致性对账</button>
          <button className="ghost-btn" onClick={async () => {
            try {
              const r = await window.api.vaultRebuild();
              toast('success', `索引重建完成：${r.report.papers} 篇论文 / ${r.report.highlights} 条划线 / ${r.report.flashcards} 张闪卡`);
            } catch (e: any) { toastErr(e); }
          }}>重建索引</button>
        </div>
      )}
      {status?.enabled && (
        <div style={{ marginTop: 14, borderTop: '1px solid rgba(128,128,128,.2)', paddingTop: 12 }}>
          <div className="repo-status">
            <span>Git 同步：{stateLabel[syncState?.state] ?? '未配置'}</span>
            <button className="ghost-btn" onClick={async () => {
              try { await window.api.syncNow(); toast('success', '同步已执行'); } catch (e: any) { toastErr(e); }
            }}>立即同步</button>
          </div>
          <div className="import-row" style={{ marginTop: 8 }}>
            <input type="text" value={remoteUrl} placeholder="git 远端 URL（如 git@gitlab.com:user/papers.git）" onChange={e => setRemoteUrl(e.target.value)} />
            <button className="ghost-btn" onClick={() => saveSync({ remoteUrl })}>保存</button>
          </div>
          <div className="import-row" style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={!!syncCfg?.pushEnabled} onChange={e => saveSync({ pushEnabled: e.target.checked })} />
              推送到远端
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 14 }}>
              <input type="checkbox" checked={syncCfg?.dryRun !== false} onChange={e => saveSync({ dryRun: e.target.checked })} />
              干跑模式（只本地提交不推送，验证稳定后关闭）
            </label>
          </div>
          {syncState?.lastResult?.conflicts?.length ? (
            <div className="hint" style={{ marginTop: 8 }}>
              冲突文件已自动以远端为准，本地副本存为 .conflict.* 文件（vault 目录内可查）。
            </div>
          ) : null}
        </div>
      )}
      <div className="hint" style={{ marginTop: 10 }}>
        连接后每篇论文一个子文件夹（PDF + meta + 标注 + 笔记 + 问答 + 译文）；App 数据库退化为可重建索引——换设备时从 vault 恢复全部资产。
      </div>
    </section>
  );
}

// v3 B1：外观——主题切换（暗色默认）+ 原版对照自动生成开关（A3 设置项）
function AppearanceSection() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('pr:theme') === 'light' ? 'light' : 'dark')
  );
  const [autoP2z, setAutoP2z] = useState<boolean>(
    () => localStorage.getItem('pr:p2z:auto') !== '0'
  );

  function applyTheme(t: 'dark' | 'light') {
    setTheme(t);
    localStorage.setItem('pr:theme', t);
    document.documentElement.dataset.theme = t;
  }

  function applyAuto(v: boolean) {
    setAutoP2z(v);
    localStorage.setItem('pr:p2z:auto', v ? '1' : '0');
  }

  return (
    <div className="settings-section">
      <h3>外观</h3>
      <div className="more-row" role="group" aria-label="主题">
        <span>主题</span>
        <div className="mode-switch">
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => applyTheme('dark')}>暗色</button>
          <button className={theme === 'light' ? 'on' : ''} onClick={() => applyTheme('light')}>亮色</button>
        </div>
      </div>
      <div className="more-row" role="group" aria-label="自动生成原版对照">
        <span>深度阅读时自动生成原版对照</span>
        <button onClick={() => applyAuto(!autoP2z)}>{autoP2z ? '已开启' : '已关闭'}</button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        自动生成条件：已安装 pdf2zh CLI + 论文正文 ≤30 页 + 深度阅读（超过 3 分钟或读过 30%）。生成在后台进行，不影响文本阅读。
      </div>
    </div>
  );
}

// 本地论文库：连接本地文件夹（批量导入 / 目录整理的根目录）
function LibrarySection() {
  const [dir, setDir] = useState('');

  useEffect(() => {
    window.api.libGetDir().then((d: string) => setDir(d ?? ''));
  }, []);

  async function pick() {
    try {
      const d = await window.api.libPickDir();
      if (!d) return;
      await window.api.libSetDir(d);
      setDir(d);
      toast('success', '本地论文库已连接，去「论文库 → 本地库」扫描导入');
    } catch (e: any) { toastErr(e); }
  }

  return (
    <div className="settings-section">
      <h3>本地论文库</h3>
      <div className="repo-status">
        <span>{dir ? `✓ 已连接：${dir}` : '未连接'}</span>
        {dir && (
          <button className="ghost-btn" onClick={() => window.api.libOpenDir('').catch((e: any) => toastErr(e))}>
            打开文件夹
          </button>
        )}
      </div>
      <div className="import-row">
        <input type="text" value={dir} placeholder="选择本地论文文件夹…" readOnly onClick={pick} style={{ cursor: 'pointer' }} />
        <button className="primary" onClick={pick}>选择文件夹</button>
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        连接后可批量导入文件夹里的 PDF（全文解析，翻译/划线/闪卡全链路可用）；应用内移动论文会真实移动磁盘文件，外部改动扫描时自动重新关联。
      </div>
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
        连接后可导入全文缓存、翻译时注入术语表。问答「写回笔记」总会进入「沉淀」；已连接仓库时再追加一份到笔记 Q&A 节（只追加，不重写）。
      </div>
    </div>
  );
}
