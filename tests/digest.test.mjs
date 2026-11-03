// 精炼笔记材料：空记录不生成，主题按阅读顺序拼接，问答没有答案的不收
import { build } from 'esbuild';
await build({
  entryPoints: ['electron/digest.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-digest/digest.js', logLevel: 'silent',
});
const { buildPaperLedger, buildTopicLedger, layerLabel } = await import('../tests/.tmp-digest/digest.js');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

const empty = buildPaperLedger({ title: 'T', arxivId: '1', highlights: [], notes: [], qas: [] });
assert(empty === null, '没有划线、笔记、问答时不生成材料');

const skipped = buildPaperLedger({
  title: 'T', arxivId: '',
  highlights: [{ id: 1, pid: 3, text_en: '   ', note: '' }],
  notes: [{ id: 2, pid: null, text: '' }],
  qas: [{ id: 3, pid: 3, question: '为什么', answer: '  ' }],
});
assert(skipped === null, '空白划线和没有答案的提问被跳过');

const paper = buildPaperLedger({
  title: 'DeepSeek', arxivId: '2609.19969',
  highlights: [{ id: 12, pid: 4, text_en: 'attention stays sparse', note: '我的理解' }],
  notes: [{ id: 7, pid: 4, text: '这里是关键' }],
  qas: [{ id: 5, pid: 9, question: '和 V3 差在哪', answer: '多了一个压缩头' }],
});
assert(paper.startsWith('论文：DeepSeek'), '单篇材料以论文标题开头');
assert(paper.includes('arXiv:2609.19969'), '单篇材料带 arxiv id');
assert(paper.includes('【H12】段落 4 划线：attention stays sparse；备注：我的理解'), '划线标记保留 id 和备注');
assert(paper.includes('【N7】段落 4 笔记：这里是关键'), '笔记标记保留 id');
assert(paper.includes('【Q5】段落 9 问：和 V3 差在哪'), '提问标记保留 id');
assert(paper.indexOf('【H12】') < paper.indexOf('【N7】') && paper.indexOf('【N7】') < paper.indexOf('【Q5】'), '顺序是划线、笔记、提问');

const bare = buildPaperLedger({
  title: 'DeepSeek', arxivId: '1',
  highlights: [], notes: [],
  qas: [{ id: 5, pid: null, question: '问', answer: '答' }],
}, { heading: false });
assert(bare === '【Q5】未挂段落 问：问\n答：答', '主题里的单篇材料不重复标题');

const topic = buildTopicLedger('DeepSeek', 'deepseek', [
  { order: 2, title: '后一篇', layer: 'frontier', body: '【H2】段落 1 划线：b' },
  { order: 1, title: '先一篇', layer: 'foundation', body: '【H1】段落 1 划线：a' },
]);
assert(topic.startsWith('主题：DeepSeek\n检索：deepseek'), '主题材料带头');
assert(topic.indexOf('## 2. 后一篇（前沿）') < topic.indexOf('## 1. 先一篇（地基）'), '保持传入的阅读顺序，不按编号重排');
assert(layerLabel('bridge') === '桥梁' && layerLabel('other') === '节点', '未知层级记为节点');
assert(buildTopicLedger('x', '', []) === null, '主题里没有任何已读材料时不生成');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
await build({
  entryPoints: ['src/components/NotesView.tsx'],
  bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  outfile: 'tests/.tmp-digest/notes.js', logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.eot': 'empty', '.otf': 'empty' },
});
const { buildSettleGroups } = await import('../tests/.tmp-digest/notes.js');
const groups = buildSettleGroups(
  [{ id: 12, paper_id: 4, pid: 30, text_en: 'sparse', note: '', color: 'yellow', created_at: '2026-11-01', paper_title: 'V4', arxiv_id: '2609.19969' }],
  [{ id: 7, paper_id: 4, pid: 10, text: '关键', created_at: '2026-11-02', updated_at: '2026-11-03', paper_title: 'V4', arxiv_id: '2609.19969' }],
  'all',
  [{ id: 5, paper_id: 4, highlight_id: null, pid: 10, question: '差在哪', answer: '压缩头', provider: '', model: '', created_at: '2026-11-04', paper_title: 'V4' }],
);
assert(groups.length === 1 && groups[0].qaCount === 1, '提问和划线、笔记进同一篇');
assert(groups[0].passages.map(p => p.pid).join(',') === '10,30', '段落按文中顺序，提问跟所在段');
assert(groups[0].passages[0].notes.length === 1 && groups[0].passages[0].qas.length === 1, '同一段的笔记和提问在一起');
const onlyQ = buildSettleGroups([], [], 'notes', [
  { id: 5, paper_id: 4, highlight_id: null, pid: 10, question: 'q', answer: 'a', provider: '', model: '', created_at: '2026-11-04' },
]);
assert(onlyQ.length === 0, '筛选笔记时不把提问单独列出来');

await build({
  entryPoints: ['src/components/DigestCard.tsx'],
  bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  outfile: 'tests/.tmp-digest/card.js', logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.eot': 'empty', '.otf': 'empty' },
});
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: DigestCard } = await import('../tests/.tmp-digest/card.js');
const html = renderToStaticMarkup(React.createElement(DigestCard, {
  kicker: '这篇我带走的',
  doc: {
    body: '## 我想搞清的问题\n\n稀疏注意力仍然成立【H12】。',
    updated_at: '2026-11-04 01:00',
    cites: [{ token: '【H12】', paperId: 4, pid: 9 }],
  },
  busy: false,
  emptyHint: '还没有',
  onGenerate() {},
  onOpen() {},
}));
assert(html.includes('这篇我带走的') && html.includes('重新生成'), '精炼笔记卡片有标题和重做按钮');
assert(html.includes('我想搞清的问题') && html.includes('划线'), '正文标题和划线标记被渲染成可点的标记');
assert(!html.includes('【H12】'), '标记不再以原始记号显示');
const emptyHtml = renderToStaticMarkup(React.createElement(DigestCard, {
  kicker: '这个主题我带走的', doc: null, busy: false, emptyHint: '先留下记录', onGenerate() {}, onOpen() {},
}));
assert(emptyHtml.includes('生成') && emptyHtml.includes('先留下记录') && !emptyHtml.includes('重新生成'), '还没有笔记时只显示生成');

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
