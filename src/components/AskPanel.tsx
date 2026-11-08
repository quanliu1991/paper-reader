import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';
import AnswerText from './AnswerText';

interface LiveMsg { role: 'q' | 'a'; text: string; streaming?: boolean; qaId?: number; streamId?: string; feedback?: 'tooShallow' | 'tooDeep' | 'justRight' }

const FOLLOWUPS = [
  { label: '详细解释', prompt: '请更详细地解释上面提到的关键概念。' },
  { label: '举个例子', prompt: '能给一个具体例子帮助理解吗？' },
  { label: '换个说法', prompt: '请用更通俗的语言重新解释一遍。' },
  { label: '这篇的局限', prompt: '这个方法有什么局限性？论文自己提到或你能推断的。' },
];

interface Suggestion { label: string; prompt: string }

export default function AskPanel() {
  const paper = useStore(s => s.currentPaper)!;
  const blocks = useStore(s => s.blocks);
  const qaList = useStore(s => s.qaList);
  const pendingSelection = useStore(s => s.pendingSelection);
  const setAskPanel = useStore(s => s.setAskPanel);
  // v3 B4：问答 | 反向链接 双 tab
  const [tab, setTab] = useState<'ask' | 'backlinks'>('ask');
  const [backlinks, setBacklinks] = useState<Array<{ id: number; kind: 'note' | 'highlight' | 'qa'; text: string; paperTitle: string; paperId: number | null }>>([]);

  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<LiveMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestRationale, setSuggestRationale] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMsgs(prev => {
      if (prev.some(m => m.streaming)) return prev;
      const hist: LiveMsg[] = [];
      for (const q of qaList) {
        if (!q.answer) continue;
        hist.push({ role: 'q', text: q.question, qaId: q.id });
        hist.push({ role: 'a', text: q.answer, qaId: q.id });
      }
      return hist;
    });
  }, [qaList]);

  // 打开面板时拉画像驱动的建议问题（不耗 LLM）
  useEffect(() => {
    if (!paper?.id) return;
    window.api.profileSuggest(paper.id)
      .then((r: any) => { setSuggestions(r.questions ?? []); setSuggestRationale(r.rationale ?? ''); })
      .catch(() => {});
  }, [paper?.id, qaList.length]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs]);

  // B4 反向链接：全库笔记/高亮/问答里提到当前论文（[[双链]] 或标题命中）的条目
  useEffect(() => {
    if (tab !== 'backlinks' || !paper?.id) return;
    (async () => {
      const title = paper.title.trim();
      const needle = title.length > 40 ? title.slice(0, 40) : title;
      const out: typeof backlinks = [];
      try {
        const [notes, hls, qas] = await Promise.all([
          window.api.listAllNotes(), window.api.listAllHighlights(), window.api.listAllQa(),
        ]);
        for (const n of notes as any[]) {
          if (n.paper_id === paper.id) continue;
          if (n.text.includes(`[[${needle}`) || n.text.includes(needle)) {
            out.push({ id: n.id, kind: 'note', text: n.text, paperTitle: n.paper_title ?? '', paperId: n.paper_id });
          }
        }
        for (const h of hls as any[]) {
          if (h.paper_id === paper.id) continue;
          if ((h.note ?? '').includes(`[[${needle}`) || (h.note ?? '').includes(needle)) {
            out.push({ id: h.id, kind: 'highlight', text: h.note ?? h.text_en, paperTitle: h.paper_title ?? '', paperId: h.paper_id });
          }
        }
        for (const q of qas as any[]) {
          if (q.paper_id === paper.id) continue;
          const hit = q.question.includes(`[[${needle}`) || q.question.includes(needle)
            || (q.answer ?? '').includes(`[[${needle}`) || (q.answer ?? '').includes(needle);
          if (hit) out.push({ id: q.id, kind: 'qa', text: q.question, paperTitle: q.paper_title ?? '', paperId: q.paper_id });
        }
        setBacklinks(out);
      } catch { /* 拉取失败留空 */ }
    })();
  }, [tab, paper?.id, paper?.title]);

  async function ask(questionText?: string, isFollowup = false) {
    const question = (questionText ?? input).trim();
    if (!question || busy) return;
    setBusy(true); setInput('');
    if (isFollowup) window.api.profileFeedback('followup').catch(() => {});

    const pid = pendingSelection?.pid ?? blocks[0]?.pid;
    const selText = pendingSelection?.text ?? '';
    const idx = blocks.findIndex(b => b.pid === pid);
    // 上下文带段落编号（供引用定位）
    const ctx = blocks.slice(Math.max(0, idx - 2), idx + 3)
      .map(b => `【段落 #${b.seq + 1}】${b.en}`)
      .join('\n\n')
      .slice(0, 6000);

    // 先订流再发问。askQuestion 要等模型说完才返回，之后再订就收不到任何一个 delta。
    const streamId = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const qText = selText ? `【划线】${selText}\n\n${question}` : question;
    setMsgs(m => [...m, { role: 'q', text: qText }, { role: 'a', text: '', streaming: true, streamId }]);
    const off = window.api.onQaStream(streamId, (msg: any) => {
      if (msg.delta) {
        setMsgs(m => m.map(x => x.streamId === streamId && x.role === 'a' ? { ...x, text: x.text + msg.delta } : x));
      } else if (msg.error) {
        setMsgs(m => m.map(x => x.streamId === streamId && x.role === 'a' ? { ...x, text: `⚠ ${msg.error}`, streaming: false } : x));
      } else if (msg.done) {
        setMsgs(m => m.map(x => x.streamId === streamId && x.role === 'a'
          ? { ...x, qaId: msg.qaId ?? x.qaId, text: x.text || msg.answer || '', streaming: false }
          : x));
      }
    });

    try {
      const r = await window.api.askQuestion({
        paperId: paper.id,
        pid: pid!,
        question: selText ? `${question}\n（用户划线内容：${selText}）` : question,
        context: ctx,
        streamId,
      });
      const answer = (r.answer ?? '').trim();
      setMsgs(m => m.map(x => x.streamId === streamId && x.role === 'a'
        ? { ...x, qaId: r.qaId, text: (x.text || answer).trim() || '⚠ 模型没有返回内容', streaming: false }
        : x));
      if (answer) {
        const list = await window.api.listQa(paper.id);
        useStore.setState({ qaList: list });
      }
    } catch (e: any) {
      setMsgs(m => m.map(x => x.streamId === streamId && x.role === 'a' && x.streaming
        ? { ...x, text: x.text || `⚠ ${e?.message ?? e}`, streaming: false }
        : x));
      toastErr(e);
    } finally {
      off();
      setBusy(false);
    }
  }

  // 深度反馈：进画像账本，下轮回答自动调整
  async function feedback(qaId: number, kind: 'tooShallow' | 'tooDeep' | 'justRight') {
    setMsgs(m => m.map(x => x.qaId === qaId && x.role === 'a' ? { ...x, feedback: kind } : x));
    try {
      await window.api.profileFeedback(kind);
      const hint = kind === 'tooShallow' ? '已记录，后续回答会更深入' : kind === 'tooDeep' ? '已记录，后续回答会更通俗' : '已记录，保持当前深度';
      toast('info', hint);
    } catch { /* 静默 */ }
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
    if (!qa?.answer) { toast('info', '这条回答还没有内容'); return; }
    try {
      const r = await window.api.writeQa({
        arxivId: paper.arxiv_id,
        question: qa.question,
        answer: qa.answer,
        paperId: paper.id,
        pid: qa.pid,
      });
      await useStore.getState().refreshNotes(paper.id);
      toast('success', r.note ? `已写入笔记，并追加到仓库 ${r.note}` : '已写入笔记，可在「沉淀」里查看');
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

  const lastDone = msgs.length > 0 && msgs[msgs.length - 1].role === 'a' && !msgs[msgs.length - 1].streaming && msgs[msgs.length - 1].text;

  return (
    <div className="ask-panel">
      <div className="head">
        <div className="ask-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'on' : ''} onClick={() => setTab('ask')}>问答</button>
          <button role="tab" aria-selected={tab === 'backlinks'} className={tab === 'backlinks' ? 'on' : ''} onClick={() => setTab('backlinks')}>
            反链 {backlinks.length ? `(${backlinks.length})` : ''}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {tab === 'ask' && <button onClick={exportSummary} title="导出阅读摘要（高亮+问答）到知识库笔记">导出</button>}
          <button onClick={() => setAskPanel(false)}>收起</button>
        </div>
      </div>
      {tab === 'backlinks' ? (
        <div className="thread backlinks-list">
          {backlinks.length === 0 && (
            <div className="hint">
              还没有其他论文的笔记/高亮/问答提到这一篇。<br />
              在任何笔记里输入 <code>[[{paper.title.slice(0, 24)}…]]</code> 即可建立链接。
            </div>
          )}
          {backlinks.map(b => (
            <div key={`${b.kind}-${b.id}`} className="bl-item">
              <span className={`bl-kind bl-${b.kind}`}>{b.kind === 'note' ? '笔记' : b.kind === 'highlight' ? '高亮' : '问答'}</span>
              <div className="bl-body">
                <div className="bl-text">{b.text.slice(0, 160)}{b.text.length > 160 ? '…' : ''}</div>
                {b.paperId != null && (
                  <button className="bl-from" onClick={() => useStore.getState().openPaper(b.paperId!)}>来自：{b.paperTitle.slice(0, 40)}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
      {pendingSelection && (
        <div className="sel-quote">{pendingSelection.text.slice(0, 400)}</div>
      )}
      <div className="thread" ref={threadRef}>
        {msgs.length === 0 && (
          <div className="hint">
            选中论文文字点「提问」，或直接输入问题。回答会标注【段落 #N】依据，可点击跳转。
            {suggestions.length > 0 && (
              <div className="suggest-block">
                <div className="suggest-why">{suggestRationale}</div>
                {suggestions.map(s => (
                  <button key={s.label} className="chip suggest-chip" onClick={() => ask(s.prompt)}>{s.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'q'
              ? <div className="q">{m.text}</div>
              : <div className={`a ${m.streaming ? 'streaming' : ''}`}>
                  <AnswerText text={m.text} onJump={jumpToRef} />
                </div>
            }
            {m.role === 'a' && !m.streaming && m.text && !m.text.startsWith('⚠') && (
              <div className="actions">
                {!m.feedback ? (
                  <>
                    <button className="fb-btn" onClick={() => feedback(m.qaId!, 'tooShallow')} title="回答太浅，后续会更深入">太浅</button>
                    <button className="fb-btn ok" onClick={() => feedback(m.qaId!, 'justRight')} title="深度刚好，保持">刚好</button>
                    <button className="fb-btn" onClick={() => feedback(m.qaId!, 'tooDeep')} title="回答太深，后续会更通俗">太深</button>
                  </>
                ) : (
                  <span className="fb-done">{
                    m.feedback === 'tooShallow' ? '✓ 已反馈：要更深' : m.feedback === 'tooDeep' ? '✓ 已反馈：要更浅' : '✓ 深度合适'
                  }</span>
                )}
                <button onClick={() => writeBack(m.qaId!)}>写回笔记</button>
              </div>
            )}
          </div>
        ))}
        {/* 追问芯片：最后一条是完成态回答时展示 */}
        {lastDone && !busy && (
          <div className="followup-chips">
            {FOLLOWUPS.map(f => (
              <button key={f.label} className="chip" onClick={() => ask(f.prompt, true)}>{f.label}</button>
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
        </>
      )}
    </div>
  );
}

