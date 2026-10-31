import { useEffect } from 'react';
import { useStore } from './store';
import PaperList from './components/PaperList';
import Reader from './components/Reader';
import Settings from './components/Settings';
import Review from './components/Review';
import TopicView from './components/TopicView';
import NotesView from './components/NotesView';
import CommandPalette from './components/CommandPalette';
import ToastHost from './components/Toast';
import { IconLibrary, IconReview, IconSettings, IconSearch, IconGraph, IconNotes } from './components/icons';

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

  const inReader = view === 'reader';

  return (
    <div className={`app ${inReader ? 'in-reader' : ''}`}>
      {/* 左侧图标导航栏 */}
      <aside className="sidebar">
        <div className="brand" onClick={() => useStore.getState().setView('list')} title="Paper Reader">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 2 3 7v10l9 5 9-5V7l-9-5z" fill="var(--accent)" opacity="0.9"/>
            <path d="M12 2 3 7l9 5 9-5-9-5z" fill="var(--accent-deep)"/>
            <path d="M3 17l9-5v10l-9-5z" fill="var(--accent-deep)" opacity="0.75"/>
          </svg>
        </div>
        <nav>
          <button
            className={`nav-btn ${view === 'list' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('list')}
            title="论文库"
          >
            <IconLibrary />
          </button>
          <button
            className={`nav-btn ${view === 'topics' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('topics')}
            title="主题依赖库"
          >
            <IconGraph />
          </button>
          <button
            className={`nav-btn ${view === 'notes' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('notes')}
            title="沉淀：高亮与笔记"
          >
            <IconNotes />
          </button>
          <button
            className={`nav-btn ${view === 'review' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('review')}
            title="闪卡复习"
          >
            <IconReview />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-btn ${view === 'settings' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('settings')}
            title="设置"
          >
            <IconSettings />
          </button>
        </div>
      </aside>

      <div className="main-col">
        {/* 顶栏：全局搜索入口 + 阅读时隐藏（沉浸） */}
        {!inReader && (
          <header className="topbar">
            <div className="topbar-search" onClick={() => useStore.setState({ paletteOpen: true })}>
              <IconSearch s={15} />
              <span>搜索论文、执行命令…</span>
              <kbd>Ctrl K</kbd>
            </div>
          </header>
        )}
        <main className="content">
          {view === 'list' && <PaperList />}
          {view === 'reader' && <Reader />}
          {view === 'settings' && <Settings />}
          {view === 'review' && <Review />}
          {view === 'topics' && <TopicView />}
          {view === 'notes' && <NotesView />}
        </main>
      </div>

      <CommandPalette />
      <ToastHost />
    </div>
  );
}
