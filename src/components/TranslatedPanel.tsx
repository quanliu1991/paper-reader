import { memo } from 'react';
import RichText from './RichText';
import type { BlockRow } from '../store';

// 学术样式译文面板：按论文原始结构（章节层级/段落/图表标题）排版
// pageMap 存在时按页分组，与 PDF 分页一致；不存在时连续排版
export default function TranslatedPanel({
  blocks, pageMap, visiblePage, onJumpPage,
}: {
  blocks: BlockRow[];
  pageMap: Record<number, number> | null;
  visiblePage: number;
  onJumpPage: (p: number) => void;
}) {
  // 有页映射时按页分组渲染
  const groups: Array<{ page: number | null; items: BlockRow[] }> = [];
  if (pageMap) {
    let cur: { page: number | null; items: BlockRow[] } | null = null;
    for (const b of blocks) {
      const p = pageMap[b.pid] ?? null;
      if (!cur || cur.page !== p) { cur = { page: p, items: [] }; groups.push(cur); }
      cur.items.push(b);
    }
  } else {
    groups.push({ page: null, items: blocks });
  }

  return (
    <div className="translated-panel academic">
      {groups.map((g, gi) => (
        <PageGroup
          key={gi}
          page={g.page}
          items={g.items}
          active={g.page !== null && g.page === visiblePage}
          onJumpPage={onJumpPage}
          showPageHeader={pageMap !== null}
        />
      ))}
    </div>
  );
}

const PageGroup = memo(function PageGroup({
  page, items, active, onJumpPage, showPageHeader,
}: {
  page: number | null;
  items: BlockRow[];
  active: boolean;
  onJumpPage: (p: number) => void;
  showPageHeader: boolean;
}) {
  return (
    <section className={`tp-page ${active ? 'active' : ''}`}>
      {showPageHeader && page !== null && (
        <div className="tp-page-header" onClick={() => onJumpPage(page)}>
          — 第 {page} 页 —
        </div>
      )}
      {items.map(b => <TranslatedBlock key={b.pid} b={b} />)}
    </section>
  );
});

function TranslatedBlock({ b }: { b: BlockRow }) {
  if (b.type === 'heading') {
    return (
      <h2 className="tp-heading" style={{ fontSize: `${1.5 - b.level * 0.12}em` }}>
        {b.zh ?? <span className="tp-pending">{b.en}</span>}
      </h2>
    );
  }
  if (b.type === 'fig') {
    return (
      <figure className="tp-fig">
        {b.fig_path && <img src={`local-figure://${b.fig_path}`} alt={b.en.slice(0, 50)} loading="lazy" />}
        <figcaption className="tp-figcap">
          {b.fig_kind === 'table' ? '表' : '图'} · {b.zh ?? b.en}
        </figcaption>
      </figure>
    );
  }
  return (
    <p className="tp-para">
      {b.zh
        ? <RichText text={b.zh} />
        : <span className="tp-pending">{b.en.slice(0, 120)}{b.en.length > 120 ? '…' : ''}</span>}
    </p>
  );
}
