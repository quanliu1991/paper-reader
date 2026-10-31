import { memo, useEffect, useRef, useState, Fragment } from 'react';
import RichText from './RichText';
import ParaNotes from './ParaNotes';
import type { BlockRow, NoteRow } from '../store';
import { figSrc } from '../figsrc';

// 豆包式「翻译全文」双栏同构对照视图：
// - 行级网格：每行左英文格 + 右中文格，天然空间对应（无需滚动同步算法）
// - 段落联动：点击任一格 → 整行高亮，两侧同亮
// - 长内容淡化折叠（豆包细节）：超长段落 max-height + 渐变 mask + 点击展开
// - 划词：左栏文本可选中，onMouseUp 冒泡到 Reader 划词工具条
export default function TranslateView({
  blocks, fontSize, hlByPid, translating, paperId, notesByPid,
}: {
  blocks: BlockRow[];
  fontSize: number;
  hlByPid: Map<number, Array<{ text: string; color: string }>>;
  translating: boolean;
  paperId: number;
  notesByPid: Map<number, NoteRow[]>;
}) {
  const [activePid, setActivePid] = useState<number | null>(null);
  const activeRef = useRef<number | null>(null);
  activeRef.current = activePid;

  // 翻译流式刷新时的「跟读」体验：只在翻译刚开始时把第一个待翻译段带入视口，
  // 之后不再劫持滚动（用户可能已经在读别处）。用户一旦手动滚动立即放弃。
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  useEffect(() => {
    if (!translating) { userScrolledRef.current = false; return; }
    const host = containerRef.current;
    if (!host || userScrolledRef.current) return;
    const firstPending = host.querySelector('.tv-pending-bar');
    if (firstPending) {
      const hostRect = host.getBoundingClientRect();
      const tRect = firstPending.getBoundingClientRect();
      if (tRect.top < hostRect.top || tRect.bottom > hostRect.bottom - 80) {
        (firstPending as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [blocks, translating]);
  useEffect(() => {
    const host = containerRef.current?.parentElement;
    if (!host) return;
    const onScroll = () => { userScrolledRef.current = true; };
    host.addEventListener('wheel', onScroll, { passive: true, once: true });
    host.addEventListener('touchmove', onScroll, { passive: true, once: true });
    return () => { host.removeEventListener('wheel', onScroll); host.removeEventListener('touchmove', onScroll); };
  }, []);

  return (
    <div className={`translate-view fs-${fontSize}`} ref={containerRef} style={{ fontSize: `${fontSize}px` }}>
      {blocks.map(b => (
        <Fragment key={b.pid}>
          <TvRow
            b={b}
            active={activePid === b.pid}
            hlItems={hlByPid.get(b.pid) ?? []}
            onActivate={() => setActivePid(cur => (cur === b.pid ? null : b.pid))}
          />
          <ParaNotes notes={notesByPid.get(b.pid) ?? []} paperId={paperId} />
        </Fragment>
      ))}
    </div>
  );
}

const TvRow = memo(function TvRow({
  b, active, hlItems, onActivate,
}: {
  b: BlockRow;
  active: boolean;
  hlItems: Array<{ text: string; color: string }>;
  onActivate: () => void;
}) {
  // 标题行：跨双栏整行显示（左右同高，标题居各自格）
  if (b.type === 'heading') {
    return (
      <div className={`tv-row tv-heading-row ${active ? 'active' : ''}`} data-pid={b.pid} onClick={onActivate}>
        <div className={`tv-cell en tv-heading l${b.level}`}>
          <RichText text={b.en} />
        </div>
        <div className={`tv-cell zh tv-heading l${b.level}`}>
          {b.zh ? <RichText text={b.zh} /> : <span className="tv-heading-pending">—</span>}
        </div>
      </div>
    );
  }
  // 图表行：同一张图跨中缝居中 + 双语标题
  if (b.type === 'fig') {
    const figUrl = figSrc(b.fig_path); // 仅本地落地形态出图，防死链
    return (
      <div className={`tv-row tv-fig-row ${active ? 'active' : ''}`} data-pid={b.pid} onClick={onActivate}>
        <figure className="tv-fig">
          {figUrl
            ? <img src={figUrl} alt={b.en.slice(0, 60)} loading="lazy" />
            : <div className="tv-fig-placeholder">{b.fig_kind === 'table' ? '📊' : '🖼'} 图片下载中</div>}
          <figcaption>
            <span className="cap-en"><RichText text={b.en} /></span>
            {b.zh && <span className="cap-zh"><RichText text={b.zh} /></span>}
          </figcaption>
        </figure>
      </div>
    );
  }
  // 段落行：左英右中，天然对齐
  return (
    <div className={`tv-row tv-para-row ${active ? 'active' : ''}`} data-pid={b.pid} onClick={onActivate}>
      <CellEn b={b} hlItems={hlItems} />
      <CellZh b={b} />
    </div>
  );
});

function CellEn({ b, hlItems }: { b: BlockRow; hlItems: Array<{ text: string; color: string }> }) {
  const enHtml = hlItems.length ? markHighlights(b.en, hlItems) : undefined;
  return (
    <div className="tv-cell en">
      {enHtml
        ? <p className="tv-p" dangerouslySetInnerHTML={{ __html: enHtml }} />
        : <CollapsibleText className="tv-p"><RichText text={b.en} /></CollapsibleText>}
    </div>
  );
}

function CellZh({ b }: { b: BlockRow }) {
  if (!b.zh) {
    return (
      <div className="tv-cell zh">
        <div className="tv-pending-bar"><span className="dot" /><span className="dot" /><span className="dot" /> 待翻译</div>
      </div>
    );
  }
  return (
    <div className="tv-cell zh">
      <CollapsibleText className="tv-p"><RichText text={b.zh} /></CollapsibleText>
    </div>
  );
}

// 长内容淡化折叠（豆包细节）：超长时收起 + 渐变 mask + 点击展开
const COLLAPSE_MAX = 260; // px
function CollapsibleText({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOver(el.scrollHeight > COLLAPSE_MAX + 24);
  }, [children]);

  return (
    <div
      ref={ref}
      className={`${className ?? ''} ${over && !expanded ? 'tv-collapsed' : ''}`}
      onClick={e => { if (over && !expanded) { e.stopPropagation(); setExpanded(true); } }}
    >
      {children}
      {over && !expanded && <div className="tv-expand-hint">展开全部 ▾</div>}
    </div>
  );
}

function markHighlights(en: string, items: Array<{ text: string; color: string }>): string {
  let html = escapeHtml(en);
  for (const it of items) {
    const esc = escapeHtml(it.text.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      html = html.replace(new RegExp(esc), m =>
        `<mark class="hl" style="background:${COLORS[it.color] ?? '#fff3b0'}">${m}</mark>`);
    } catch { /* skip */ }
  }
  return html;
}

const COLORS: Record<string, string> = {
  yellow: '#fff3b0', green: '#c8e6c9', blue: '#bbdefb', pink: '#f8bbd0',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
