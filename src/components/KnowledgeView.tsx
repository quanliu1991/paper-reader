import { useState } from 'react';
import { useStore } from '../store';
import NotesView from './NotesView';
import Review from './Review';

// v3 A6：知识页——「沉淀」（高亮/笔记/问答）与「复习」（闪卡 SM-2）合并为一个入口。
// tab 壳包两个既有视图，内部逻辑零改动；tab 记忆在 localStorage。
export default function KnowledgeView() {
  const [tab, setTab] = useState<'notes' | 'review'>(() =>
    localStorage.getItem('pr:knowledge:tab') === 'review' ? 'review' : 'notes'
  );
  const openPaper = useStore(s => s.openPaper);

  function pick(t: 'notes' | 'review') {
    setTab(t);
    localStorage.setItem('pr:knowledge:tab', t);
  }

  return (
    <div className="knowledge-page">
      <div className="list-head">
        <h1>知识</h1>
        <div className="mode-switch" role="tablist" aria-label="知识类型">
          <button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'on' : ''} onClick={() => pick('notes')}>沉淀</button>
          <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'on' : ''} onClick={() => pick('review')}>复习</button>
        </div>
      </div>
      {tab === 'notes'
        ? <NotesView embedded />
        : <Review embedded />}
    </div>
  );
}
