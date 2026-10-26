import { memo, useEffect, useRef, useState } from 'react';
import RichText from './RichText';
import type { BlockRow } from '../store';
import { figSrc } from '../figsrc';

// 学术样式译文面板：按论文原始结构（章节层级/段落/图表标题）排版
// 豆包式交互：点击译文段落 → 高亮并联动 PDF 跳到对应页；页头点击反向跳 PDF
export default function TranslatedPanel({
  blocks, pageMap, visiblePage, onJumpPage, onSelectPid, activePid,
}: {
  blocks: BlockRow[];
  pageMap: Record<number, number> | null;
  visiblePage: number;
  onJumpPage: (p: number) => void;
  onSelectPid?: (pid: number, page: number | null) => void;
  activePid?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 跟随 PDF 当前页滚动（页分组变化时）
  useEffect(() => {
    if (!pageMap || !visiblePage) return;
    const host = containerRef.current;
    if (!host) return;
    const target = host.querySelector(`[data-tpage="${visiblePage}"]`) as HTMLElement | null;
    if (target) {
      // 已在视口内不滚动，避免抖动
      const hostRect = host.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      if (tRect.top < hostRect.top + 40 || tRect.bottom > hostRect.bottom - 40) {
        host.scrollTo({ top: target.offsetTop - host.offsetTop - 16, behavior: 'smooth' });
      }
    }
  }, [visiblePage, pageMap]);

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
    <div className="translated-panel academic" ref={containerRef}>
      {groups.map((g, gi) => (
        <PageGroup
          key={gi}
          page={g.page}
          items={g.items}
          active={g.page !== null && g.page === visiblePage}
          onJumpPage={onJumpPage}
          showPageHeader={pageMap !== null}
          onSelectPid={onSelectPid}
          activePid={activePid}
        />
      ))}
    </div>
  );
}

const PageGroup = memo(function PageGroup({
  page, items, active, onJumpPage, showPageHeader, onSelectPid, activePid,
}: {
  page: number | null;
  items: BlockRow[];
  active: boolean;
  onJumpPage: (p: number) => void;
  showPageHeader: boolean;
  onSelectPid?: (pid: number, page: number | null) => void;
  activePid?: number | null;
}) {
  return (
    <section className={`tp-page ${active ? 'active' : ''}`} data-tpage={page ?? undefined}>
      {showPageHeader && page !== null && (
        <div className="tp-page-header" onClick={() => onJumpPage(page)}>
          — 第 {page} 页 —
        </div>
      )}
      {items.map(b => (
        <TranslatedBlock
          key={b.pid}
          b={b}
          selected={activePid === b.pid}
          onClick={() => onSelectPid?.(b.pid, page)}
        />
      ))}
    </section>
  );
});

function TranslatedBlock({ b, selected, onClick }: {
  b: BlockRow;
  selected: boolean;
  onClick: () => void;
}) {
  if (b.type === 'heading') {
    return (
      <h2
        className={`tp-heading ${selected ? 'tp-selected' : ''}`}
        style={{ fontSize: `${1.5 - b.level * 0.12}em` }}
        onClick={onClick}
      >
        {b.zh ?? <span className="tp-pending">{b.en}</span>}
      </h2>
    );
  }
  if (b.type === 'fig') {
    const figUrl = figSrc(b.fig_path); // 仅本地落地形态出图，防死链
    return (
      <figure className={`tp-fig ${selected ? 'tp-selected' : ''}`} onClick={onClick}>
        {figUrl && <img src={figUrl} alt={b.en.slice(0, 50)} loading="lazy" />}
        <figcaption className="tp-figcap">
          {b.fig_kind === 'table' ? '表' : '图'} · {b.zh ?? b.en}
        </figcaption>
      </figure>
    );
  }
  return (
    <p className={`tp-para ${selected ? 'tp-selected' : ''}`} onClick={onClick}>
      {b.zh
        ? <RichText text={b.zh} />
        : <span className="tp-pending">{b.en}</span>}
    </p>
  );
}
