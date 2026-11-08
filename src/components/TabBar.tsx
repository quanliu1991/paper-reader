import { useEffect } from 'react';
import { useStore } from '../store';
import { modKeyLabel } from '../platform';

// v3 B2 标签栏：多论文并读（Obsidian 式）。Cmd/Ctrl+W 关闭、Cmd/Ctrl+1..9 切换、中键关闭。
// 标题截断 + 关闭按钮；无标签时不渲染（列表页等视图全宽）。

// 会话恢复只在应用启动时执行一次：TabBar 随视图切换会挂载/卸载（App.tsx 条件渲染），
// 若每次挂载都恢复，会把刚切到列表/知识/图谱页的用户硬拉回阅读器。
let sessionRestored = false;

export default function TabBar() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const view = useStore(s => s.view);
  const activateTab = useStore(s => s.activateTab);
  const closeTab = useStore(s => s.closeTab);
  const openTab = useStore(s => s.openTab);

  // 全局快捷键：Cmd/Ctrl+W 关当前、Cmd/Ctrl+1..8 切换、Cmd/Ctrl+9 最后一个
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const st = useStore.getState();
      if ((e.key === 'w' || e.key === 'W') && st.activeTabId != null) {
        e.preventDefault();
        st.closeTab(st.activeTabId);
      } else if (/^[1-9]$/.test(e.key) && st.tabs.length) {
        e.preventDefault();
        const idx = e.key === '9' ? st.tabs.length - 1 : Number(e.key) - 1;
        const t = st.tabs[idx];
        if (t) st.activateTab(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 启动会话恢复：上次打开的标签组（仅恢复存在的论文）
  useEffect(() => {
    if (sessionRestored) return;
    sessionRestored = true;
    (async () => {
      try {
        const raw = localStorage.getItem('pr:tabs');
        if (!raw) return;
        const saved: Array<{ id: number; title: string }> = JSON.parse(raw);
        if (!Array.isArray(saved) || !saved.length) return;
        const papers = await window.api.listPapers();
        const ids = new Set(papers.map((p: any) => p.id));
        const valid = saved.filter(t => ids.has(t.id));
        if (!valid.length) return;
        const activeRaw = Number(localStorage.getItem('pr:tabs:active') || 0);
        const openSeq = async () => {
          for (const t of valid) await openTab(t.id); // 逐个开（数据入桶）
          const target = valid.find(t => t.id === activeRaw) ?? valid[valid.length - 1];
          if (target) useStore.getState().activateTab(target.id);
        };
        openSeq();
      } catch { /* 恢复失败静默 */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tabs.length || view === 'settings') return null;

  return (
    <div className="tabbar" role="tablist" aria-label="打开的论文">
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeTabId}
          className={`tab ${t.id === activeTabId ? 'active' : ''}`}
          onClick={() => activateTab(t.id)}
          onMouseDown={e => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
          title={`${t.title}\n${modKeyLabel}+${i + 1} 切换 · 中键/Cmd+W 关闭`}
        >
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            aria-label="关闭标签"
            onClick={e => { e.stopPropagation(); closeTab(t.id); }}
          >×</button>
        </div>
      ))}
    </div>
  );
}
