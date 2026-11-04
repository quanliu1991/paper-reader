// 论文 HTML 表格还原渲染（LaTeXML ltx_tabular 提取的行列数据）
// 首行表头加粗；数学 $..$ 走 RichText；横向可滚动（宽表不破版）
import { useEffect, useState } from 'react';
import RichText from './RichText';

// 内联 SVG（LaTeXML 的 pgf 图）用 <img> 时没有 xmlns，foreignObject 里的坐标文字也不画。
// 拉回文本嵌进页面，图才能完整显示。脚本和事件属性去掉。
export function LocalFig({ src, alt, onClick }: { src: string; alt: string; onClick?: (e: { stopPropagation: () => void }) => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const isSvg = /\.svg($|\?)/i.test(src);
  useEffect(() => {
    if (!isSvg) { setSvg(null); return; }
    let cancel = false;
    fetch(src).then(r => r.ok ? r.text() : '').then(t => {
      if (cancel || !t.includes('<svg')) return;
      let s = t.replace(/<script[\s\S]*?<\/script>/gi, '');
      s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
      if (!/xmlns=/.test(s)) s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      setSvg(s);
    }).catch(() => { /* 退回 img */ });
    return () => { cancel = true; };
  }, [src, isSvg]);
  if (svg) return <span className="fig-svg" onClick={onClick} dangerouslySetInnerHTML={{ __html: svg }} />;
  return <img src={src} alt={alt} loading="lazy" onClick={onClick} />;
}

// 算法块是单列逐行；表格才走表头。kind=figure 且每行只有一格时按伪代码排。
export function FigBlockBody({ kind, rowsJson }: { kind?: string | null; rowsJson: string }) {
  let rows: string[][] = [];
  try { rows = JSON.parse(rowsJson); } catch { return null; }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (kind !== 'table' && rows.every(r => Array.isArray(r) && r.length <= 1)) {
    const texts = rows.map(r => r.join(' '));
    // 长段落是生成样本 / 说明文字，不是伪代码。编号列表会把正文变成步骤。
    if (texts.some(t => t.length > 180)) {
      return (
        <div className="fig-prose">
          {texts.map((t, i) => <p key={i}><RichText text={t} /></p>)}
        </div>
      );
    }
    return (
      <ol className="fig-listing">
        {texts.map((t, i) => <li key={i}><RichText text={t} /></li>)}
      </ol>
    );
  }
  return <FigTable rows={rows} />;
}

export default function FigTable({ rows, className }: { rows: string[][]; className?: string }) {
  if (!rows || rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div className={`fig-table-wrap ${className ?? ''}`} role="table">
      <table className="fig-table">
        <thead>
          <tr>{head.map((c, i) => <th key={i} scope="col"><RichText text={c} /></th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => <td key={ci}><RichText text={c} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
