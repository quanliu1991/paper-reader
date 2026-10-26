import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  run: () => void;
}

export default function CommandPalette() {
  const papers = useStore(s => s.papers);
  const blocks = useStore(s => s.blocks);
  const open = useStore(s => s.paletteOpen);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        useStore.setState({ paletteOpen: !useStore.getState().paletteOpen });
        setQ(''); setIdx(0);
      } else if (e.key === 'Escape') {
        useStore.setState({ paletteOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    // 快速动作
    out.push(
      { id: 'act-import', label: '导入 arXiv 论文', hint: '动作', keywords: 'import arxiv 导入', run: () => { useStore.getState().setView('list'); setTimeout(() => document.querySelector<HTMLInputElement>('.import-row input')?.focus(), 100); } },
      { id: 'act-layout-dual', label: '切换到双栏对照', hint: '布局', keywords: 'layout dual 对照 双栏', run: () => useStore.getState().setLayout('dual') },
      { id: 'act-layout-bilingual', label: '切换到双语书模式', hint: '布局', keywords: 'layout bilingual 双语 书 交错', run: () => useStore.getState().setLayout('bilingual') },
      { id: 'act-layout-en', label: '切换到仅原文', hint: '布局', keywords: 'layout en 原文', run: () => useStore.getState().setLayout('en') },
      { id: 'act-layout-zh', label: '切换到仅译文', hint: '布局', keywords: 'layout zh 译文', run: () => useStore.getState().setLayout('zh') },
      { id: 'act-ask', label: '打开问答侧栏', hint: '动作', keywords: 'ask qa 问答 提问', run: () => useStore.getState().setAskPanel(true) },
      { id: 'act-settings', label: '打开设置', hint: '动作', keywords: 'settings 设置 provider', run: () => useStore.getState().setView('settings') },
      { id: 'act-review', label: '闪卡复习', hint: '动作', keywords: 'flashcard review 复习 闪卡', run: () => useStore.getState().setView('review') },
    );
    // 论文
    for (const p of papers) {
      out.push({
        id: `paper-${p.id}`, label: p.title, hint: `论文 · ${p.arxiv_id}`,
        keywords: `${p.title} ${p.arxiv_id}`,
        run: () => useStore.getState().openPaper(p.id),
      });
    }
    // 当前论文段落（仅 reader 视图有 blocks）
    const cur = useStore.getState().currentPaper;
    if (cur) {
      for (const b of blocks) {
        if (b.type !== 'para' && b.type !== 'heading') continue;
        out.push({
          id: `blk-${b.pid}`, label: b.en.slice(0, 80), hint: `段落 #${b.seq + 1}`,
          keywords: b.en.slice(0, 120),
          run: () => {
            useStore.getState().setView('reader');
            setTimeout(() => {
              document.querySelector(`[data-pid="${b.pid}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
          },
        });
      }
    }
    return out;
  }, [papers, blocks]);

  const filtered = useMemo(() => {
    if (!q.trim()) return cmds.slice(0, 12);
    const ql = q.toLowerCase();
    return cmds.filter(c => c.keywords.toLowerCase().includes(ql) || c.label.toLowerCase().includes(ql)).slice(0, 15);
  }, [q, cmds]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelectorAll('.cp-item')[idx]?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  function exec(c: Cmd) {
    useStore.setState({ paletteOpen: false });
    c.run();
  }

  return (
    <div className="cp-mask" onClick={() => useStore.setState({ paletteOpen: false })}>
      <div className="cp-panel glass" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="搜索论文 / 段落 / 动作…"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter' && filtered[idx]) exec(filtered[idx]);
          }}
        />
        <div className="cp-list" ref={listRef}>
          {filtered.map((c, i) => (
            <div key={c.id} className={`cp-item ${i === idx ? 'active' : ''}`} onClick={() => exec(c)}>
              <span className="cp-label">{c.label}</span>
              <span className="cp-hint">{c.hint}</span>
            </div>
          ))}
          {filtered.length === 0 && <div className="cp-empty">无匹配</div>}
        </div>
      </div>
    </div>
  );
}
