import { useEffect } from 'react';
import { useStore } from './store';
import PaperList from './components/PaperList';
import Reader from './components/Reader';
import Settings from './components/Settings';
import Review from './components/Review';
import CommandPalette from './components/CommandPalette';
import ToastHost from './components/Toast';

export default function App() {
  const view = useStore(s => s.view);
  const loadPapers = useStore(s => s.loadPapers);

  useEffect(() => { loadPapers(); }, []);

  // text 降级论文升级完成后刷新列表 + 当前阅读中的论文
  useEffect(() => {
    return window.api.onPaperUpgraded(async (p: any) => {
      await loadPapers();
      const st = useStore.getState();
      if (st.currentPaper?.id === p.paperId) {
        await st.openPaper(p.paperId);
        st.toast({ type: 'success', msg: '论文已升级为结构化版本（含图表与 PDF）' });
      }
    });
  }, [loadPapers]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => useStore.getState().setView('list')}>
          Paper Reader <span className="sub">中英对照 · 划线提问</span>
        </div>
        <nav>
          <button onClick={() => useStore.setState({ paletteOpen: true })} title="命令面板 Ctrl+K">⌘K</button>
          <button onClick={() => useStore.getState().setView('review')}>复习</button>
          <button onClick={() => useStore.getState().setView('list')}>论文库</button>
          <button onClick={() => useStore.getState().setView('settings')}>设置</button>
        </nav>
      </header>
      <main className="content">
        {view === 'list' && <PaperList />}
        {view === 'reader' && <Reader />}
        {view === 'settings' && <Settings />}
        {view === 'review' && <Review />}
      </main>
      <CommandPalette />
      <ToastHost />
    </div>
  );
}
