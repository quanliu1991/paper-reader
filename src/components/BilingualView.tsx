import { memo, Fragment } from 'react';
import RichText from './RichText';
import { highlightHtml } from '../highlights';
import ParaNotes from './ParaNotes';
import FigTable from './FigTable';
import type { BlockRow, NoteRow } from '../store';
import { figSrc } from '../figsrc';

// 双语书模式：单栏流式，每段英文原文下方紧跟中文译文（段落交错，像双语书籍排版）。
// 与左右对照（TranslateView）互补：窄窗口/长段落连读场景更自然，视线不用左右横跳。
// 复用 Reader 的划词（onMouseUp 冒泡）与高亮标记管线。
export default function BilingualView({
  blocks, fontSize, hlByPid, paperId, notesByPid,
}: {
  blocks: BlockRow[];
  fontSize: number;
  hlByPid: Map<number, Array<{ text: string; color: string }>>;
  paperId: number;
  notesByPid: Map<number, NoteRow[]>;
}) {
  return (
    <div className="bilingual-view" style={{ fontSize: `${fontSize}px` }}>
      {blocks.map(b => (
        <Fragment key={b.pid}>
          <BiRow b={b} hlItems={hlByPid.get(b.pid) ?? []} />
          <ParaNotes notes={notesByPid.get(b.pid) ?? []} paperId={paperId} />
        </Fragment>
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
    const figUrl = figSrc(b.fig_path); // 仅本地落地形态出图，防死链
    return (
      <figure className="bi-row bi-fig" data-pid={b.pid}>
        {figUrl
          ? <img src={figUrl} alt={b.en.slice(0, 60)} loading="lazy" />
          : b.fig_table_rows
            ? <FigTable rows={JSON.parse(b.fig_table_rows)} />
            : b.fig_html_table || (b.fig_kind === 'table' && !b.fig_path)
              ? <div className="bi-fig-ph">📊 表格 · 见原文 PDF</div>
              : <div className="bi-fig-ph">🖼 图片下载中</div>}
        <figcaption>
          <span className="cap-en"><RichText text={b.en} /></span>
          {b.zh && <span className="cap-zh"><RichText text={b.zh} /></span>}
        </figcaption>
      </figure>
    );
  }
  // 正文段落：英文段 → 中文段（书页式交错）
  const enHtml = highlightHtml(b.en, hlItems);
  const zhHtml = b.zh ? highlightHtml(b.zh, hlItems) : null;
  return (
    <div className="bi-row bi-para" data-pid={b.pid}>
      <p className="bi-en"
        dangerouslySetInnerHTML={enHtml ? { __html: enHtml } : undefined}>
        {enHtml ? undefined : <RichText text={b.en} />}
      </p>
      {b.zh
        ? zhHtml
          ? <p className="bi-zh" dangerouslySetInnerHTML={{ __html: zhHtml }} />
          : <p className="bi-zh"><RichText text={b.zh} /></p>
        : <div className="bi-pending"><span className="dot" /><span className="dot" /><span className="dot" /><span>待翻译</span></div>}
    </div>
  );
});
