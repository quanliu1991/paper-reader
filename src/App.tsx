import { useEffect, useState } from 'react';
import { useStore } from './store';
import PaperList from './components/PaperList';
import Reader from './components/Reader';
import Settings from './components/Settings';
import Review from './components/Review';
import TopicView from './components/TopicView';
import NotesView from './components/NotesView';
import CommandPalette from './components/CommandPalette';
import ToastHost from './components/Toast';
import Welcome, { WELCOME_SEEN_KEY } from './components/Welcome';
import TabBar from './components/TabBar';
import KnowledgeView from './components/KnowledgeView';
import { IconLibrary, IconSettings, IconSearch, IconGraph, IconNotes } from './components/icons';
import { modKeyLabel } from './platform';

export default function App() {
  const view = useStore(s => s.view);
  const currentPaper = useStore(s => s.currentPaper);
  const loadPapers = useStore(s => s.loadPapers);
  // v3 A4：首启向导——未见过向导且未配 Provider 时弹出（E2E 环境跳过：测试自己控制流程）
  const [welcome, setWelcome] = useState(false);

  useEffect(() => {
    (async () => {
      if (localStorage.getItem(WELCOME_SEEN_KEY)) return;
      try {
        const providers = await window.api.listProviders();
        if ((window as any).__E2E) return; // 测试驱动中：欢迎向导由测试自行控制
        if (!providers.length) setWelcome(true);
        else localStorage.setItem(WELCOME_SEEN_KEY, '1'); // 已有配置不再打扰
      } catch { localStorage.setItem(WELCOME_SEEN_KEY, '1'); }
    })();
  }, []);

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
            <span className="nav-label">论文库</span>
          </button>
          <button
            className={`nav-btn ${view === 'topics' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('topics')}
            title="图谱：主题依赖库（引用图谱导航）"
          >
            <IconGraph />
            <span className="nav-label">图谱</span>
          </button>
          <button
            className={`nav-btn ${view === 'knowledge' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('knowledge')}
            title="知识：沉淀（高亮/笔记/问答）与闪卡复习"
          >
            <IconNotes />
            <span className="nav-label">知识</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-btn ${view === 'settings' ? 'on' : ''}`}
            onClick={() => useStore.getState().setView('settings')}
            title="设置"
          >
            <IconSettings />
            <span className="nav-label">设置</span>
          </button>
        </div>
      </aside>

      <div className="main-col">
        {/* 顶栏：全局搜索入口 + 阅读时隐藏（沉浸） */}
        {!inReader ? (
          <header className="topbar">
            <div className="topbar-search" onClick={() => useStore.setState({ paletteOpen: true })}>
              <IconSearch s={15} />
              <span>搜索论文、执行命令…</span>
              <kbd>{modKeyLabel} K</kbd>
            </div>
          </header>
        ) : (
          <TabBar />
        )}
        {!inReader && <TabBar />}
        <main className="content">
          {view === 'list' && <PaperList />}
          {view === 'reader' && currentPaper && <Reader />}
          {view === 'settings' && <Settings />}
          {view === 'review' && <Review embedded />}
          {view === 'topics' && <TopicView />}
          {view === 'notes' && <NotesView />}
          {view === 'knowledge' && <KnowledgeView />}
        </main>
      </div>

      <CommandPalette />
      <ToastHost />
      {welcome && <Welcome onClose={() => setWelcome(false)} />}
      <DropZone />
    </div>
  );
}

// v3 A5：App 级拖拽层——PDF/文件夹拖到窗口任意处即导入；首次拖文件夹提示设为本地论文库
function DropZone() {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget) return; // 离开窗口
      setOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length || busy) return;
      setBusy(true);
      try {
        const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
        const dirs = files.filter(f => !f.name.toLowerCase().endsWith('.pdf'));
        if (pdfs.length) {
          const rs = await window.api.libImportFiles(pdfs.map(f => f.path));
          const ok = rs.filter((r: any) => r.ok).length;
          if (ok) {
            useStore.getState().toast({ type: 'success', msg: `已导入 ${ok} 篇 PDF（解析/摘要后台进行）` });
            await useStore.getState().loadPapers();
          } else {
            useStore.getState().toast({ type: 'error', msg: `导入失败：${rs[0]?.error ?? '未知错误'}` });
          }
        }
        // 首次拖入文件夹（Electron 目录拖入通常表现为无扩展名文件）→ 提示设为本地库
        if (dirs.length && !pdfs.length) {
          const dir = dirs[0].path;
          const cur = await window.api.libGetDir();
          if (!cur) {
            useStore.getState().toast({
              type: 'info', msg: '把整个文件夹设为本地论文库？可批量导入并自动整理',
              action: {
                label: '设为本地库',
                run: async () => {
                  try {
                    await window.api.libSetDir(dir);
                    useStore.getState().toast({ type: 'success', msg: '本地库已连接，去论文库页扫描导入' });
                  } catch (e: any) { useStore.getState().toast({ type: 'error', msg: String(e?.message ?? e) }); }
                },
              },
            });
          }
        }
      } finally { setBusy(false); }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [busy]);

  if (!over) return null;
  return (
    <div className="dropzone-overlay">
      <div className="dropzone-card">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <div>松开导入 · PDF 直接进论文库</div>
        <div className="dz-sub">文件夹可作为本地论文库连接</div>
      </div>
    </div>
  );
}
