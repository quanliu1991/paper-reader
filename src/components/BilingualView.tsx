import { memo } from 'react';
import RichText from './RichText';
import type { BlockRow } from '../store';

// 双语书模式：单栏流式，每段英文原文下方紧跟中文译文（段落交错，像双语书籍排版）。
// 与左右对照（TranslateView）互补：窄窗口/长段落连读场景更自然，视线不用左右横跳。
// 复用 Reader 的划词（onMouseUp 冒泡）与高亮标记管线。
export default function BilingualView({
  blocks, fontSize, hlByPid,
}: {
  blocks: BlockRow[];
  fontSize: number;
  hlByPid: Map<number, Array<{ text: string; color: string }>>;
}) {
  return (
    <div className="bilingual-view" style={{ fontSize: `${fontSize}px` }}>
      {blocks.map(b => (
        <BiRow key={b.pid} b={b} hlItems={hlByPid.get(b.pid) ?? []} />
      ))}
    </div>
  );
}

const BiRow = memo(function BiRow({
  b, hlItems,
}: {
  b: BlockRow;
  hlItems: Array<{ text: string; color: string }>;
}) {
  // 标题：英文标题 + 中文小字副题紧随
  if (b.type === 'heading') {
    return (
      <div className="bi-row bi-heading" data-pid={b.pid}>
        <div className={`bi-en heading l${b.level}`}><RichText text={b.en} /></div>
        {b.zh && <div className={`bi-zh heading-sub l${b.level}`}><RichText text={b.zh} /></div>}
      </div>
    );
  }
  // 图表：图 + 双语图注（英文在上中文在下）
  if (b.type === 'fig') {
    const figUrl = b.fig_path ? `local-figure://${b.fig_path}` : null;
    return (
      <figure className="bi-row bi-fig" data-pid={b.pid}>
        {figUrl
          ? <img src={figUrl} alt={b.en.slice(0, 60)} loading="lazy" />
          : <div className="bi-fig-ph">{b.fig_kind === 'table' ? '📊' : '🖼'}</div>}
        <figcaption>
          <span className="cap-en"><RichText text={b.en} /></span>
          {b.zh && <span className="cap-zh"><RichText text={b.zh} /></span>}
        </figcaption>
      </figure>
    );
  }
  // 正文段落：英文段 → 中文段（书页式交错）
  const enHtml = hlItems.length ? markHighlights(b.en, hlItems) : undefined;
  return (
    <div className="bi-row bi-para" data-pid={b.pid}>
      <p className="bi-en"
        dangerouslySetInnerHTML={enHtml ? { __html: enHtml } : undefined}>
        {enHtml ? undefined : <RichText text={b.en} />}
      </p>
      {b.zh
        ? <p className="bi-zh"><RichText text={b.zh} /></p>
        : <div className="bi-pending"><span className="dot" /><span className="dot" /><span className="dot" /><span>待翻译</span></div>}
    </div>
  );
});

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
