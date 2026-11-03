import { Fragment } from 'react';
import RichText, { splitMath } from './RichText';

// 问答回复是 markdown + 公式。气泡里按标题、列表、代码、加粗和 $...$ 渲染，
// 【段落 #N】以及精炼笔记里的【H12】【N3】【Q5】是可点击的引用。

type Block =
  | { type: 'code'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'p'; text: string };

export function parseAnswer(src: string): Block[] {
  const lines = src.split(/\r?\n/);
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: 'p', text: para.join('\n') });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      flushPara();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: buf.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    const ul = /^[-*•]\s+(.+)$/.exec(line);
    const ol = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      const items: string[] = [];
      while (i < lines.length) {
        const u = /^[-*•]\s+(.+)$/.exec(lines[i]);
        const o = /^\d+[.)]\s+(.+)$/.exec(lines[i]);
        if (ordered ? !o : !u) break;
        items.push((ordered ? o : u)![1]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}

function normalizeTex(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `$$${tex}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => `$${tex}$`);
}

function MathAndLines({ text }: { text: string }) {
  const parts = splitMath(text);
  return parts.map((p, i) => {
    if (p.math) {
      const wrapped = p.display ? `$$${p.text}$$` : `$${p.text}$`;
      return <RichText key={i} text={wrapped} />;
    }
    const lines = p.text.split('\n');
    return lines.map((line, li) => (
      <Fragment key={`${i}-${li}`}>
        {li > 0 && <br />}
        {line}
      </Fragment>
    ));
  });
}

function citeLabel(kind: string): string {
  switch (kind) {
    case 'H': return '划线';
    case 'N': return '笔记';
    case 'Q': return '提问';
    default: return '记录';
  }
}

function Formatted({ text, onJump }: { text: string; onJump: (ref: string) => void }) {
  const tokens = normalizeTex(text).split(/(\*\*[\s\S]+?\*\*|`[^`\n]+`|【段落 #\d+】|【[HNQ]\d+】)/g);
  return tokens.map((tok, i) => {
    if (!tok) return null;
    const ref = /^【段落 #(\d+)】$/.exec(tok);
    if (ref) {
      return (
        <span key={i} className="ref-chip" onClick={() => onJump(tok)} title="点击跳转到该段落">
          ¶{ref[1]}
        </span>
      );
    }
    const cite = /^【([HNQ])(\d+)】$/.exec(tok);
    if (cite) {
      const label = citeLabel(cite[1]);
      return (
        <span key={i} className="ref-chip" onClick={() => onJump(tok)} title="回到这条记录">
          {label}
        </span>
      );
    }
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length >= 4) {
      return <strong key={i}><MathAndLines text={tok.slice(2, -2)} /></strong>;
    }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length >= 2) {
      return <code key={i} className="qa-code">{tok.slice(1, -1)}</code>;
    }
    return <MathAndLines key={i} text={tok} />;
  });
}

export default function AnswerText({ text, onJump }: { text: string; onJump: (ref: string) => void }) {
  if (!text) return null;
  const blocks = parseAnswer(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'code') return <pre key={i} className="qa-pre"><code>{b.text}</code></pre>;
        if (b.type === 'heading') return <div key={i} className="qa-h"><Formatted text={b.text} onJump={onJump} /></div>;
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className="qa-list">
              {b.items.map((item, j) => <li key={j}><Formatted text={item} onJump={onJump} /></li>)}
            </Tag>
          );
        }
        return <p key={i} className="qa-p"><Formatted text={b.text} onJump={onJump} /></p>;
      })}
    </>
  );
}
