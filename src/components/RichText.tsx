import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// 富文本渲染：扫描 $...$ / $$...$$ 拆片段，公式用 KaTeX，文本原样
// 输入已经过 escapeHtml 处理（Reader 侧），公式片段重新转义
export default function RichText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => splitMath(text), [text]);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.math
          ? <MathSpan key={i} tex={p.text} display={p.display} />
          : <span key={i}>{p.text}</span>
      )}
    </span>
  );
}

function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        trust: false,
        output: 'html',
      });
    } catch {
      return `<code>${escapeHtml(tex)}</code>`;
    }
  }, [tex, display]);
  return <span className={display ? 'math-block' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Part { text: string; math: boolean; display: boolean }

// 拆分：先 $$...$$（块级，含跨行），再 $...$（行内，非贪婪、不允许裸换行）
function splitMath(s: string): Part[] {
  const parts: Part[] = [];
  let rest = s;
  // 块级 $$...$$
  const blockRe = /\$\$([\s\S]+?)\$\$/;
  // 行内 $...$：内容不含 $ 和换行，长度>0
  const inlineRe = /\$([^$\n]+?)\$/;
  while (rest.length) {
    const mb = rest.match(blockRe);
    const mi = rest.match(inlineRe);
    const bIdx = mb ? rest.indexOf(mb[0]) : -1;
    const iIdx = mi ? rest.indexOf(mi[0]) : -1;
    // 谁先出现处理谁（都没有则收尾）
    if (bIdx === -1 && iIdx === -1) { parts.push({ text: rest, math: false, display: false }); break; }
    const useBlock = bIdx !== -1 && (iIdx === -1 || bIdx <= iIdx);
    const m = useBlock ? mb! : mi!;
    const idx = useBlock ? bIdx : iIdx;
    if (idx > 0) parts.push({ text: rest.slice(0, idx), math: false, display: false });
    parts.push({ text: m[1], math: true, display: useBlock });
    rest = rest.slice(idx + m[0].length);
  }
  return parts.filter(p => p.text.length > 0);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
