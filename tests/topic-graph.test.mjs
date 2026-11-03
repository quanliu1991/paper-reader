// 主题依赖库：分层 + 阅读顺序 离线单元测试
// .tmp-tg 是 gitignore 的编译产物——先自编译再动态 import（保证 fresh clone 可跑）
import { build } from 'esbuild';
await build({
  entryPoints: ['electron/topic-graph.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-tg/topic-graph.js', logLevel: 'silent',
});
const { stratifyAndOrder, mergeSeedIds } = await import('../tests/.tmp-tg/topic-graph.js');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

// 构造一个典型引用图：地基（老+被引多）→ 核心 → 桥梁 → 前沿
const N = (id, year, cc) => ({ arxivId: id, title: `Paper ${id}`, year, citationCount: cc, layer: 'seed', inDeg: 0, outDeg: 0, readOrder: null });
const nodes = [
  N('found1', 2017, 50000), N('found2', 2018, 8000),        // 地基：老
  N('key1', 2023, 900), N('key2', 2023, 700),               // 核心：图内被引高（近作）
  N('bridge1', 2022, 150), N('bridge2', 2022, 90),          // 桥梁
  N('front1', 2026, 12), N('front2', 2026, 5),              // 前沿：新
  N('misc1', 2023, 40),
];
const edges = [
  // found1 被 key1,key2,bridge1,front1 引 → in=4
  { src: 'key1', dst: 'found1' }, { src: 'key2', dst: 'found1' },
  { src: 'bridge1', dst: 'found1' }, { src: 'front1', dst: 'found1' },
  // found2 被 key1,bridge1,bridge2 引 → in=3
  { src: 'key1', dst: 'found2' }, { src: 'bridge1', dst: 'found2' }, { src: 'bridge2', dst: 'found2' },
  // key1 被 bridge1,bridge2,front1,front2 引 → in=4
  { src: 'bridge1', dst: 'key1' }, { src: 'bridge2', dst: 'key1' },
  { src: 'front1', dst: 'key1' }, { src: 'front2', dst: 'key1' },
  // key2 被 bridge2,front1 引 → in=2
  { src: 'bridge2', dst: 'key2' }, { src: 'front1', dst: 'key2' },
  // bridge1 被 front1 引 → in=1；bridge1 引 found1,found2,key1 → out=3
  { src: 'front1', dst: 'bridge1' },
  // bridge2 被 front2 引；bridge2 引 found2,key1,key2 → out=3
  { src: 'front2', dst: 'bridge2' },
  // front1 引 found1,key1,key2,bridge1 → out=4
  // front2 引 key1,bridge2 → out=2
  // misc1 引 key1,key2 → out=2，无人引 → in=0
  { src: 'misc1', dst: 'key1' }, { src: 'misc1', dst: 'key2' },
];

const { nodes: layered, edges: les } = stratifyAndOrder(nodes, edges, nodes.map(n => n.arxivId));

const layerOf = id => layered.find(n => n.arxivId === id)?.layer;
const orderOf = id => layered.find(n => n.arxivId === id)?.readOrder;

console.log('\n[1] 分层正确性');
assert(layerOf('found1') === 'foundation', 'found1（2017, in=4/5+）→ foundation');
assert(layerOf('key1') === 'key', `key1（in=4 ≥ max(4, 9*0.08)）→ key（实际 ${layerOf('key1')}）`);
assert(layerOf('bridge1') === 'bridge', `bridge1（in=1?, out=3）→ bridge（实际 ${layerOf('bridge1')}）`);
assert(layerOf('front1') === 'frontier', `front1（2026, in=0, out=4）→ frontier（实际 ${layerOf('front1')}）`);

console.log('\n[2] 度数计算');
assert(layered.find(n => n.arxivId === 'found1').inDeg === 4, `found1 inDeg=4（实际 ${layered.find(n => n.arxivId === 'found1').inDeg}）`);
assert(layered.find(n => n.arxivId === 'front1').outDeg === 4, `front1 outDeg=4（实际 ${layered.find(n => n.arxivId === 'front1').outDeg}）`);

console.log('\n[3] 阅读顺序');
const orders = layered.map(n => n.readOrder);
assert(new Set(orders).size === layered.length, 'readOrder 无重复');
assert(orders.every(o => o >= 1 && o <= layered.length), 'readOrder 连续 1..N');
const fO = orderOf('found1'), kO = orderOf('key1'), bO = orderOf('bridge1'), frO = orderOf('front1');
assert(fO < kO, `foundation 先于 key（${fO} < ${kO}）`);
assert(kO < bO, `key 先于 bridge（${kO} < ${bO}）`);
assert(bO < frO, `bridge 先于 frontier（${bO} < ${frO}）`);
// 地基内部：老在前
assert(orderOf('found1') < orderOf('found2'), 'foundation 内按年代升序（2017 < 2018）');

console.log('\n[4] 边保持');
assert(les.length === edges.length, `边数不变（${les.length}/${edges.length}）`);

console.log('\n[5] 边去重防御');
const dup = stratifyAndOrder(nodes, [...edges, ...edges], ['x']);
assert(dup.edges.length === edges.length, `重复边被去重（${dup.edges.length}/${edges.length}）`);

console.log('\n[6] 空图 / 单节点');
const single = stratifyAndOrder([N('only', 2024, 3)], [], ['only']);
assert(single.nodes[0].readOrder === 1, '单节点 readOrder=1');

console.log('\n[7] 种子合并：相关性榜之外的新论文保留');
const merged = mergeSeedIds(
  ['2505.02390', '2403.05525'],
  ['2610.35671', '2609.19969', '2505.02390'],
);
assert(merged.includes('2609.19969'), 'DeepSeek-V4.1 技术报告进入种子');
assert(merged.includes('2610.35671'), '更新的 V4.1 论文进入种子');
assert(merged.filter(id => id === '2505.02390').length === 1, '已在相关性列表中的不重复');
assert(merged[0] === '2505.02390', '相关性顺序仍在前面');

console.log('\n[8] 没有引用边的最新论文归前沿');
const year = new Date().getFullYear();
const fresh = stratifyAndOrder([N('v41', year, 0)], [], ['v41']);
assert(fresh.nodes[0].layer === 'frontier', `孤立新论文 → frontier（实际 ${fresh.nodes[0].layer}）`);

console.log('\n[9] 系列查询：正文按 arXiv 时间，评测和外部论文靠后');
const { isSeriesQuery, isCommentaryTitle, isSeriesTitle, decodeXmlEntities, namesakeIds } = await import('../tests/.tmp-tg/topic-graph.js');
assert(isSeriesQuery('deepseek') === true, 'deepseek 是系列查询');
assert(isSeriesQuery('speculative decoding') === false, '多词方法主题不是系列');
assert(isCommentaryTitle('o3-mini vs DeepSeek-R1: Which One is Safer?') === true, '对比文算评测');
assert(isCommentaryTitle('DeepSeek-V3 Technical Report') === false, '技术报告不是评测');
assert(isCommentaryTitle('DeepSeek on a Trip: Inducing Targeted Visual Hallucinations via Representation Vulnerabilities') === true, '攻击文不是系列正文');
assert(isCommentaryTitle('DeepSeek: Paradigm Shifts and Technical Evolution in Large AI Models') === true, '综述不是系列正文');
assert(isCommentaryTitle('DeepSeek-V4-Flash on AMD gfx90a: Correctness Recovery and Inference Performance') === true, '第三方移植不是系列正文');
assert(isCommentaryTitle('DeepSeekMath Meets Order Book: Group-Aware Policy Optimization') === true, '应用文不是系列正文');
assert(isSeriesTitle('DeepSeek-Coder: When the Large Language Model Meets Programming') === true, 'Coder 技术报告是正文');
assert(isSeriesTitle('DeepSeek-V3 Technical Report') === true, 'V3 Technical Report 是正文');
assert(isSeriesTitle('DeepSeekMath-V2: Towards Self-Verifiable Mathematical Reasoning') === true, 'Math-V2 是正文');
assert(isSeriesTitle('DeepSeek-OCR 2: Visual Causal Flow') === true, 'OCR 2 是正文');
assert(isSeriesTitle('DeepSeek-V3, GPT-4, Phi-4, and LLaMA-3.3 generate correct code') === false, '把多个模型放在一起比较的不是正文');
assert(isSeriesTitle('DeepSeek-R1 Outperforms Gemini 2.0 Pro, OpenAI o1, and o3-mini') === false, 'Outperforms 评测不是正文');
assert(isSeriesTitle('DeepSeek reshaping healthcare in China') === false, '领域应用短文不是正文');
assert(decodeXmlEntities('LLM &amp; HPC') === 'LLM & HPC', '标题里的 XML 实体要还原');

const seriesNodes = [
  { ...N('1801.03406', 2018, 12), title: 'DeepSeek: Content Based Image Search & Retrieval' },
  { ...N('2401.02954', 2024, 900), title: 'DeepSeek LLM: Scaling Open-Source Language Models with Longtermism' },
  { ...N('2401.14196', 2024, 2021), title: 'DeepSeek-Coder: When the Large Language Model Meets Programming' },
  { ...N('2405.04434', 2024, 4000), title: 'DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model' },
  { ...N('2412.19437', 2024, 5000), title: 'DeepSeek-V3 Technical Report' },
  { ...N('2501.12948', 2025, 5977), title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning' },
  { ...N('2501.18438', 2025, 35), title: 'o3-mini vs DeepSeek-R1: Which One is Safer?' },
  { ...N('2404.06654', 2024, 1580), title: "RULER: What's the Real Context Size of Your Long-Context Language Models?" },
  { ...N('2610.05238', 2026, 3), title: 'The Law of DeepSeek' },
];
const series = stratifyAndOrder(seriesNodes, [], seriesNodes.map(n => n.arxivId), 'deepseek');
const sLayer = id => series.nodes.find(n => n.arxivId === id)?.layer;
const sOrder = id => series.nodes.find(n => n.arxivId === id)?.readOrder;
assert(sLayer('2401.02954') === 'series', 'DeepSeek LLM 是系列正文');
assert(sLayer('2501.12948') === 'series', 'DeepSeek-R1 是系列正文，不是地基');
assert(sLayer('2501.18438') === 'discussion', 'vs 评测归入讨论');
assert(sLayer('2610.05238') === 'discussion', 'The Law of DeepSeek 归入讨论');
assert(sLayer('2404.06654') === 'context', '标题不含查询词的高引论文是外部参照');
assert(sLayer('1801.03406') === 'context', '隔了多年的同名旧文不当成系列开头');
assert(sOrder('2401.02954') < sOrder('2401.14196'), '同年按 arXiv id：LLM 早于 Coder');
assert(sOrder('2401.14196') < sOrder('2405.04434'), 'Coder 早于 V2');
assert(sOrder('2405.04434') < sOrder('2412.19437'), 'V2 早于 V3');
assert(sOrder('2412.19437') < sOrder('2501.12948'), 'V3 早于 R1');
assert(sOrder('2501.12948') < sOrder('2501.18438'), '系列正文早于评测');
assert(sOrder('2501.18438') < sOrder('2404.06654'), '评测早于外部参照');
assert(namesakeIds(seriesNodes.filter(n => n.title.startsWith('DeepSeek'))).has('1801.03406'), '同名旧文被识别');

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
