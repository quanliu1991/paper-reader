import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';

interface LiveMsg { role: 'q' | 'a'; text: string; streaming?: boolean; qaId?: number }

const FOLLOWUPS = [
  { label: '详细解释', prompt: '请更详细地解释上面提到的关键概念，我背景是 AI Infra 方向。' },
  { label: '举个例子', prompt: '能给一个具体例子帮助理解吗？' },
  { label: '换个说法', prompt: '请用更通俗的语言重新解释一遍。' },
  { label: '这篇的局限', prompt: '这个方法有什么局限性？论文自己提到或你能推断的。' },
];

export default function AskPanel() {
  const paper = useStore(s => s.currentPaper)!;
  const blocks = useStore(s => s.blocks);
  const qaList = useStore(s => s.qaList);
  const pendingSelection = useStore(s => s.pendingSelection);
  const setAskPanel = useStore(s => s.setAskPanel);

  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<LiveMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hist: LiveMsg[] = [];
    for (const q of qaList) {
      if (!q.answer) continue;
      hist.push({ role: 'q', text: q.question, qaId: q.id });
      hist.push({ role: 'a', text: q.answer, qaId: q.id });
    }
    setMsgs(hist);
  }, [qaList]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs]);

  async function ask(questionText?: string) {
    const question = (questionText ?? input).trim();
    if (!question || busy) return;
    setBusy(true); setInput('');

    const pid = pendingSelection?.pid ?? blocks[0]?.pid;
    const selText = pendingSelection?.text ?? '';
    const idx = blocks.findIndex(b => b.pid === pid);
    // 上下文带段落编号（供引用定位）
    const ctx = blocks.slice(Math.max(0, idx - 2), idx + 3)
      .map(b => `【段落 #${b.seq + 1}】${b.en}`)
      .join('\n\n')
      .slice(0, 6000);

    setMsgs(m => [...m, { role: 'q', text: selText ? `【划线】${selText}\n\n${question}` : question }]);

    try {
      const qaId = await window.api.askQuestion({
        paperId: paper.id,
        pid: pid!,
        question: selText ? `${question}\n（用户划线内容：${selText}）` : question,
        context: ctx,
      });

      setMsgs(m => [...m, { role: 'a', text: '', streaming: true, qaId }]);
      const off = window.api.onQaStream(qaId, (msg: any) => {
        if (msg.delta) {
          setMsgs(m => m.map(x => x.qaId === qaId && x.role === 'a' ? { ...x, text: x.text + msg.delta } : x));
        } else if (msg.done || msg.error) {
          if (msg.error) setMsgs(m => m.map(x => x.qaId === qaId && x.role === 'a' ? { ...x, text: `⚠ ${msg.error}`, streaming: false } : x));
          else setMsgs(m => m.map(x => x.qaId === qaId && x.role === 'a' ? { ...x, streaming: false } : x));
          off();
          setBusy(false);
        }
      });
    } catch (e) {
      toastErr(e);
      setBusy(false);
    }
  }

  // 引用定位：【段落 #N】→ 滚动到该段并闪烁
  function jumpToRef(ref: string) {
    const m = ref.match(/#(\d+)/);
    if (!m) return;
    const seq = Number(m[1]) - 1;
    const block = blocks.find(b => b.seq === seq);
    if (!block) return;
    const el = document.querySelector(`.block-row[data-rowpid="${block.pid}"]`) || document.querySelector(`[data-pid="${block.pid}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('flash-ref');
    setTimeout(() => el?.classList.remove('flash-ref'), 1600);
  }

  async function writeBack(qaId: number) {
    const qa = qaList.find(q => q.id === qaId);
    if (!qa) return;
    try {
      const r = await window.api.writeQa({ arxivId: paper.arxiv_id, question: qa.question, answer: qa.answer });
      toast('success', `已写回笔记 ${r.note}`);
    } catch (e: any) {
      toastErr(e);
    }
  }

  async function exportSummary() {
    try {
      const r = await window.api.exportSummaryToRepo(paper.id);
      toast('success', `已导出阅读摘要到 ${r.note}`);
    } catch (e: any) {
      toastErr(e);
    }
  }

  return (
    <div className="ask-panel">
      <div className="head">
        <span>问答</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={exportSummary} title="导出阅读摘要（高亮+问答）到知识库笔记">导出</button>
          <button onClick={() => setAskPanel(false)}>收起</button>
        </div>
      </div>
      {pendingSelection && (
        <div className="sel-quote">{pendingSelection.text.slice(0, 400)}</div>
      )}
      <div className="thread" ref={threadRef}>
        {msgs.length === 0 && <div className="hint">选中论文文字点「提问」，或直接输入问题。回答会标注【段落 #N】依据，可点击跳转。</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'q'
              ? <div className="q">{m.text}</div>
              : <div className={`a ${m.streaming ? 'streaming' : ''}`}>
                  {renderWithRefs(m.text, jumpToRef)}
                </div>
            }
            {m.role === 'a' && !m.streaming && m.text && (
              <div className="actions">
                <button onClick={() => writeBack(m.qaId!)}>写回笔记</button>
              </div>
            )}
          </div>
        ))}
        {/* 追问芯片：最后一条是完成态回答时展示 */}
        {msgs.length > 0 && msgs[msgs.length - 1].role === 'a' && !msgs[msgs.length - 1].streaming && !busy && (
          <div className="followup-chips">
            {FOLLOWUPS.map(f => (
              <button key={f.label} className="chip" onClick={() => ask(f.prompt)}>{f.label}</button>
            ))}
          </div>
        )}
      </div>
      <div className="input-row">
        <textarea
          placeholder="输入问题，Enter 发送（Shift+Enter 换行）"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
          disabled={busy}
        />
        <button className="primary" onClick={() => ask()} disabled={busy || !input.trim()}>发送</button>
      </div>
    </div>
  );
}

// 渲染带【段落 #N】引用的文本：引用变成可点击 chip
function renderWithRefs(text: string, jump: (ref: string) => void) {
  const parts = text.split(/(【段落 #\d+】)/g);
  return parts.map((p, i) => {
    const m = p.match(/【段落 #(\d+)】/);
    if (m) {
      return (
        <span key={i} className="ref-chip" onClick={() => jump(p)} title="点击跳转到该段落">
          ¶{m[1]}
        </span>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
