import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';

// v3 A4 首启向导：无 Provider 时首启弹出，3 步完成——选预设 → 粘贴 Key → 导入第一篇。
// 无 Key 可跳过（可读英文原文；触发翻译/问答时 toast 引导回设置）。
// 复用 Settings 的 PRESETS 定义（此处独立声明避免循环依赖，两者保持同步）。
const PRESETS: Array<{ name: string; protocol: 'openai' | 'anthropic'; baseUrl: string; model: string }> = [
  { name: 'GLM (智谱)', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Qwen (阿里)', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { name: 'Ollama 本地', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

export const WELCOME_SEEN_KEY = 'pr:welcome:seen';

export default function Welcome({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PRESETS[0].model);
  const [arxivInput, setArxivInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => { setModel(preset.model); }, [preset]);

  async function saveProvider() {
    if (!apiKey.trim() && preset.name !== 'Ollama 本地') {
      toast('error', '请粘贴 API Key（Ollama 本地无需 Key）');
      return;
    }
    setTesting(true);
    try {
      await window.api.saveProvider({
        name: preset.name, protocol: preset.protocol,
        baseUrl: preset.baseUrl, apiKey: apiKey.trim(), model, isDefault: true,
      });
      setStep(2);
    } catch (e: any) { toastErr(e); }
    finally { setTesting(false); }
  }

  async function importFirst() {
    const input = arxivInput.trim();
    if (!input) { onClose(); return; }
    setImporting(true);
    try {
      const r = await window.api.importArxiv(input);
      await useStore.getState().loadPapers();
      toast('success', '导入成功，正在打开…');
      if (r?.id) await useStore.getState().openPaper(r.id);
      finish();
    } catch (e: any) {
      toastErr(e);
    } finally { setImporting(false); }
  }

  function finish() {
    localStorage.setItem(WELCOME_SEEN_KEY, '1');
    onClose();
  }

  function skip() {
    toast('info', '可先读英文原文；翻译/问答时会提示配置 AI');
    finish();
  }

  return (
    <div className="welcome-mask" role="dialog" aria-label="欢迎使用 Paper Reader">
      <div className="welcome-card">
        <div className="welcome-logo">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M12 2 3 7v10l9 5 9-5V7l-9-5z" fill="var(--accent)" opacity="0.9"/>
            <path d="M12 2 3 7l9 5 9-5-9-5z" fill="var(--accent-deep)"/>
            <path d="M3 17l9-5v10l-9-5z" fill="var(--accent-deep)" opacity="0.75"/>
          </svg>
          <h2>Paper Reader</h2>
        </div>
        <p className="welcome-sub">「一个下午读完一篇论文」——中英对照 · 划线提问 · 知识沉淀</p>

        <div className="welcome-steps">
          <span className={step >= 0 ? 'on' : ''}>① 连接 AI</span>
          <span className={step >= 1 ? 'on' : ''}>② 粘贴 Key</span>
          <span className={step >= 2 ? 'on' : ''}>③ 导入第一篇</span>
        </div>

        {step === 0 && (
          <div className="welcome-body">
            <p>选择翻译与问答使用的 AI 服务（之后可随时在设置中更改）：</p>
            <div className="welcome-presets">
              {PRESETS.map(p => (
                <button key={p.name} className={preset.name === p.name ? 'on' : ''} onClick={() => setPreset(p)}>
                  <span className="p-name">{p.name}</span>
                  <span className="p-model">{p.model}</span>
                </button>
              ))}
            </div>
            <div className="welcome-actions">
              <button className="ghost-btn" onClick={skip}>暂不配置，先逛逛</button>
              <button className="primary" onClick={() => setStep(1)}>下一步</button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="welcome-body">
            <p>在 <b>{preset.name}</b> 获取 API Key 并粘贴（数据只保存在本机）：</p>
            <input
              className="welcome-key"
              type="password"
              autoFocus
              placeholder={preset.name === 'Ollama 本地' ? '本地服务无需 Key，直接下一步' : '粘贴 API Key…'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveProvider(); }}
            />
            <label className="welcome-model-row">
              模型
              <input type="text" value={model} onChange={e => setModel(e.target.value)} />
            </label>
            <div className="welcome-actions">
              <button className="ghost-btn" onClick={() => setStep(0)}>上一步</button>
              <button className="primary" onClick={saveProvider} disabled={testing}>
                {testing ? '验证中…' : '保存并继续'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="welcome-body">
            <p>✓ AI 已就绪。粘贴一个 arXiv ID 或链接，开始读第一篇（如 <code>2609.34683</code>）：</p>
            <input
              className="welcome-arxiv"
              type="text"
              autoFocus
              placeholder="arXiv ID 或链接…"
              value={arxivInput}
              onChange={e => setArxivInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !importing) importFirst(); }}
              disabled={importing}
            />
            <div className="welcome-actions">
              <button className="ghost-btn" onClick={finish} disabled={importing}>稍后再导</button>
              <button className="primary" onClick={importFirst} disabled={importing}>
                {importing ? '导入中…' : '导入并开始阅读'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
