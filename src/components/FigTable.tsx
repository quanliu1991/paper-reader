// 论文 HTML 表格还原渲染（LaTeXML ltx_tabular 提取的行列数据）
// 首行表头加粗；数学 $..$ 走 RichText；横向可滚动（宽表不破版）
import RichText from './RichText';

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
