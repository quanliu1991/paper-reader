// 端到端：真实网络构建「speculative decoding」主题依赖库
import { buildTopicGraph } from './.tmp-tg/topic-graph.js';

const t0 = Date.now();
try {
  const r = await buildTopicGraph('speculative decoding', msg => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`));
  console.log(`\n=== 结果：${r.nodes.length} 节点 / ${r.edges.length} 边 / ${r.seeds.length} 种子 ===`);
  const byLayer = {};
  for (const n of r.nodes) byLayer[n.layer] = (byLayer[n.layer] ?? 0) + 1;
  console.log('分层统计:', byLayer);
  console.log('\n前 10 推荐阅读顺序:');
  r.nodes.slice(0, 10).forEach(n => {
    console.log(`  #${n.readOrder} [${n.layer}] (${n.year}) 被引${n.citationCount} ${n.title.slice(0, 70)}`);
  });
  // 抽查关键论文是否命中
  const ids = new Set(r.nodes.map(n => n.arxivId));
  const titles = r.nodes.map(n => n.title.toLowerCase()).join(' ');
  console.log('\n抽查:');
  console.log('  含 LeViT/深轴论文（投机解码经典）:', titles.includes('speculative') ? 'yes' : 'no');
  console.log('  节点有 arXiv id:', r.nodes.every(n => /^\d{4}\.\d{4,5}$/.test(n.arxivId) || n.arxivId.includes('/')) ? 'sample ok' : 'check');
  if (r.nodes.length < 10) { console.error('节点过少，疑似失败'); process.exit(1); }
  if (r.edges.length < 5) { console.error('边过少，疑似失败'); process.exit(1); }
  console.log('\nE2E PASS');
} catch (e) {
  console.error('E2E FAIL:', e?.message ?? e);
  process.exit(1);
}
