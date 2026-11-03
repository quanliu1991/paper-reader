// 精炼笔记的材料：只收录读者已经留下的划线、笔记和问答，不改这些原文。

export interface LedgerHighlight {
  id: number;
  pid: number;
  text_en: string;
  note?: string;
}
export interface LedgerNote {
  id: number;
  pid: number | null;
  text: string;
}
export interface LedgerQa {
  id: number;
  pid: number | null;
  question: string;
  answer: string;
}
export interface PaperLedgerInput {
  title: string;
  arxivId: string;
  highlights: LedgerHighlight[];
  notes: LedgerNote[];
  qas: LedgerQa[];
}

export function clipText(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

// heading=false 时只输出条目，供主题笔记把多篇拼在各自的小标题下。
export function buildPaperLedger(input: PaperLedgerInput, opts?: { heading?: boolean }): string | null {
  const lines: string[] = [];
  for (const h of input.highlights.slice(0, 40)) {
    const text = clipText(h.text_en, 360);
    if (!text) continue;
    const note = clipText(h.note || '', 160);
    lines.push(`【H${h.id}】段落 ${h.pid} 划线：${text}${note ? `；备注：${note}` : ''}`);
  }
  for (const n of input.notes.slice(0, 40)) {
    const text = clipText(n.text, 400);
    if (!text) continue;
    const where = n.pid ? `段落 ${n.pid}` : '未挂段落';
    lines.push(`【N${n.id}】${where} 笔记：${text}`);
  }
  for (const q of input.qas.slice(0, 24)) {
    const answer = clipText(q.answer, 480);
    if (!answer) continue;
    const where = q.pid ? `段落 ${q.pid}` : '未挂段落';
    lines.push(`【Q${q.id}】${where} 问：${clipText(q.question, 220)}\n答：${answer}`);
  }
  if (!lines.length) return null;
  if (opts?.heading === false) return lines.join('\n');
  const head = [`论文：${input.title}`];
  if (input.arxivId) head.push(`arXiv:${input.arxivId}`);
  return [...head, ...lines].join('\n');
}

const LAYER_LABEL: Record<string, string> = {
  series: '系列正文',
  foundation: '地基',
  key: '核心',
  bridge: '桥梁',
  frontier: '前沿',
  discussion: '评测与转述',
  context: '外部参照',
  node: '节点',
};

export function layerLabel(layer: string): string {
  return LAYER_LABEL[layer] ?? '节点';
}

export interface TopicLedgerSection {
  order: number | null;
  title: string;
  layer: string;
  body: string;
}

export function buildTopicLedger(name: string, query: string, sections: TopicLedgerSection[]): string | null {
  if (!sections.length) return null;
  const parts = sections.map((s, i) => {
    const ord = s.order ?? i + 1;
    return `## ${ord}. ${s.title}（${layerLabel(s.layer)}）\n${s.body}`;
  });
  const head = [`主题：${name}`];
  if (query.trim()) head.push(`检索：${query.trim()}`);
  return [...head, '', parts.join('\n\n')].join('\n');
}
