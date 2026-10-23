import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';

interface Flashcard {
  id: number; paper_id: number; pid: number; front: string; back: string;
  interval_days: number; ease: number; due: string; reps: number; lapses: number;
  paper_title?: string;
}

export default function Review() {
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [cur, setCur] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [gening, setGening] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      setCards(await window.api.listDueFlashcards());
      setCur(0); setShowBack(false); setDoneCount(0);
    } catch (e) { toastErr(e); }
  }

  async function grade(q: number) {
    const c = cards[cur];
    await window.api.gradeFlashcard(c.id, q);
    setDoneCount(n => n + 1);
    setShowBack(false);
    setCur(i => i + 1);
  }

  async function genBack() {
    const c = cards[cur];
    setGening(true);
    try {
      const back = await window.api.genFlashcardBack({ paperId: c.paper_id, pid: c.pid, front: c.front, id: c.id });
      setCards(cs => cs.map(x => x.id === c.id ? { ...x, back } : x));
      toast('success', '答案已生成');
    } catch (e: any) { toastErr(e); }
    finally { setGening(false); }
  }

  if (cards.length === 0 || cur >= cards.length) {
    return (
      <div className="review-page">
        <div className="empty-hint">
          {doneCount > 0 ? `今日复习完成（${doneCount} 张）` : '今日没有到期闪卡。'}
          <div className="hint" style={{ marginTop: 8 }}>
            阅读时选中内容 → 工具条「闪卡」即可创建；存卡后可点「AI 生成答案」。
          </div>
        </div>
      </div>
    );
  }

  const c = cards[cur];
  return (
    <div className="review-page">
      <div className="review-meta">第 {cur + 1}/{cards.length} 张 · 来自 {c.paper_title ?? `论文#${c.paper_id}`}</div>
      <div className="flashcard" onClick={() => setShowBack(true)}>
        <div className="fc-front">{c.front}</div>
        {showBack
          ? <div className="fc-back">{c.back || '（未填答案）'}</div>
          : <div className="fc-hint">点击显示答案</div>}
      </div>
      {showBack && (
        <div className="grade-row">
          <button className="grade forgot" onClick={() => grade(0)}>忘了</button>
          <button className="grade hard" onClick={() => grade(2)}>困难</button>
          <button className="grade good" onClick={() => grade(3)}>良好</button>
          <button className="grade easy" onClick={() => grade(4)}>简单</button>
        </div>
      )}
      {!c.back && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button onClick={genBack} disabled={gening}>{gening ? '生成中…' : 'AI 生成答案'}</button>
        </div>
      )}
    </div>
  );
}
