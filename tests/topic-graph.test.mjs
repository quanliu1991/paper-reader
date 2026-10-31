// 主题依赖库：分层 + 阅读顺序 离线单元测试
// .tmp-tg 是 gitignore 的编译产物——先自编译再动态 import（保证 fresh clone 可跑）
import { build } from 'esbuild';
await build({
  entryPoints: ['electron/topic-graph.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-tg/topic-graph.js', logLevel: 'silent',
});
const { stratifyAndOrder } = await import('../tests/.tmp-tg/topic-graph.js');

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

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
