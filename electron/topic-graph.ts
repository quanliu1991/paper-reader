// 主题依赖库构建引擎：
// 1) arXiv 搜索主题 → 种子论文（按相关性 + 引用量取 top）
// 2) Semantic Scholar 图 API 双向扩展（被引 = 谁依赖它；引用 = 它依赖谁）
// 3) 子图内连通度（in/out degree）分层：foundation / key / bridge / frontier
// 4) 拓扑排序 + 层级 → 推荐阅读顺序（地基先读，最新综述殿后）

export interface GraphNode {
  arxivId: string; title: string; year: number | null;
  citationCount: number; layer: string; inDeg: number; outDeg: number; readOrder: number | null;
}

export interface GraphEdge { src: string; dst: string }

const S2 = 'https://api.semanticscholar.org/graph/v1/paper';

async function fetchJson(url: string, timeoutMs = 30000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- 1. 种子搜索 ----------
// arXiv API 按相关性搜，同时拿引用量排序信号（arXiv 无引用数，用 S2 批量补）
export async function searchSeeds(query: string, limit = 20): Promise<GraphNode[]> {
  // arXiv atom 搜索（相关性排序）
  const q = encodeURIComponent(query);
  const xml = await (await fetch(`http://export.arxiv.org/api/query?search_query=all:${q}&start=0&max_results=${limit}&sortBy=relevance`, { signal: AbortSignal.timeout(30000) })).text();
  const ids: string[] = [];
  const titles = new Map<string, string>();
  const years = new Map<string, number | null>();
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const idMatch = e.match(/<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
    const tMatch = e.match(/<title>([\s\S]*?)<\/title>/);
    const dMatch = e.match(/<published>(\d{4})/);
    if (idMatch && tMatch) {
      const id = idMatch[1].replace(/v\d+$/, '');
      ids.push(id);
      titles.set(id, tMatch[1].replace(/\s+/g, ' ').trim());
      years.set(id, dMatch ? Number(dMatch[1]) : null);
    }
  }
  if (!ids.length) return [];
  // S2 批量补引用数（POST batch 接口，一次最多 500）
  const details = await batchDetails(ids);
  return ids.map(id => ({
    arxivId: id,
    title: details.get(id)?.title ?? titles.get(id) ?? id,
    year: details.get(id)?.year ?? years.get(id) ?? null,
    citationCount: details.get(id)?.citationCount ?? 0,
    layer: 'seed', inDeg: 0, outDeg: 0, readOrder: null,
  }));
}

// S2 batch POST：arxiv id → {title, year, citationCount}
async function batchDetails(arxivIds: string[]): Promise<Map<string, { title: string; year: number | null; citationCount: number }>> {
  const out = new Map<string, { title: string; year: number | null; citationCount: number }>();
  for (let i = 0; i < arxivIds.length; i += 100) {
    const chunk = arxivIds.slice(i, i + 100);
    try {
      const r = await fetch(`${S2}/batch?fields=title,year,citationCount,externalIds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk.map(id => `ARXIV:${id}`) }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) continue;
      const arr = await r.json() as any[];
      arr.forEach((p, idx) => {
        if (!p) return;
        out.set(chunk[idx], { title: p.title ?? chunk[idx], year: p.year ?? null, citationCount: p.citationCount ?? 0 });
      });
    } catch { /* 网络失败降级：无引用数 */ }
  }
  return out;
}

// ---------- 2. 图扩展 ----------
// 对种子集取高引种子（top-K）拉「被引」与「引用」，过滤回 arXiv 论文 + 标题相关性过滤
export async function expandGraph(
  seeds: GraphNode[], query: string,
  opts: { topK?: number; perSeedRefs?: number; perSeedCites?: number } = {},
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const topK = opts.topK ?? 10;
  const perRefs = opts.perSeedRefs ?? 20;
  const perCites = opts.perSeedCites ?? 8;
  const qterms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const nodeMap = new Map<string, GraphNode>();
  for (const s of seeds) nodeMap.set(s.arxivId, s);
  const edges = new Set<string>();
  const addEdge = (src: string, dst: string) => {
    if (src !== dst && nodeMap.has(src) && nodeMap.has(dst)) edges.add(`${src}|${dst}`);
  };

  // 按（引用数 + 是否近年）挑扩展核心种子
  const coreSeeds = [...seeds].sort((a, b) => b.citationCount - a.citationCount).slice(0, topK);

  for (const s of coreSeeds) {
    // 被引（谁依赖它 → 它是地基/关键）
    try {
      const r = await fetchJson(
        `${S2}/ARXIV:${s.arxivId}/citations?fields=title,year,citationCount,externalIds&limit=${perRefs}`,
        30000,
      );
      for (const c of (r?.data ?? []) as any[]) {
        const p = c.citingPaper;
        const aid = p?.externalIds?.ArXiv;
        if (!aid) continue;
        if (!nodeMap.has(aid)) {
          nodeMap.set(aid, {
            arxivId: aid, title: p.title ?? aid, year: p.year ?? null,
            citationCount: p.citationCount ?? 0, layer: 'node', inDeg: 0, outDeg: 0, readOrder: null,
          });
        }
        addEdge(aid, s.arxivId);
      }
    } catch { /* 单种子失败继续 */ }
    // 引用（它依赖谁 → 追溯地基）
    try {
      const r = await fetchJson(
        `${S2}/ARXIV:${s.arxivId}/references?fields=title,year,citationCount,externalIds&limit=${perCites}`,
        30000,
      );
      for (const c of (r?.data ?? []) as any[]) {
        const p = c.citedPaper;
        const aid = p?.externalIds?.ArXiv;
        if (!aid) continue;
        if (!nodeMap.has(aid)) {
          nodeMap.set(aid, {
            arxivId: aid, title: p.title ?? aid, year: p.year ?? null,
            citationCount: p.citationCount ?? 0, layer: 'node', inDeg: 0, outDeg: 0, readOrder: null,
          });
        }
        addEdge(s.arxivId, aid);
      }
    } catch { /* 单种子失败继续 */ }
  }

  // 相关性过滤：非种子节点需命中查询词（标题/或高引地基豁免）
  const keep = new Set(seeds.map(s => s.arxivId));
  const filtered = new Map<string, GraphNode>();
  for (const [id, n] of nodeMap) {
    if (keep.has(id)) { filtered.set(id, n); continue; }
    const hay = n.title.toLowerCase();
    const hit = qterms.some(w => hay.includes(w)) || n.citationCount >= 1500; // 地基论文豁免（attention is all you need 等）
    if (hit) filtered.set(id, n);
  }
  // 边过滤到存活节点
  const edgeList: GraphEdge[] = [];
  for (const key of edges) {
    const [src, dst] = key.split('|');
    if (filtered.has(src) && filtered.has(dst)) edgeList.push({ src, dst });
  }
  return { nodes: [...filtered.values()], edges: edgeList };
}

// ---------- 3. 分层 + 阅读顺序 ----------
export function stratifyAndOrder(
  nodes: GraphNode[], edges: GraphEdge[], seeds: string[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // 边去重（真实数据可能含重复引用对）
  const edgeSet = new Set(edges.map(e => `${e.src}|${e.dst}`));
  edges = [...edgeSet].map(k => { const [src, dst] = k.split('|'); return { src, dst }; });
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    inDeg.set(e.dst, (inDeg.get(e.dst) ?? 0) + 1);   // 被引用 → 影响力
    outDeg.set(e.src, (outDeg.get(e.src) ?? 0) + 1); // 引用别人 → 依赖
  }
  const yearOf = (n: GraphNode) => n.year ?? 9999;
  const thisYear = new Date().getFullYear();

  // 阈值随图密度自适应：稀疏图（边少）按最大入度的比例分层，稠密图同时用节点数兜底
  const maxInd = Math.max(0, ...edges.map(e => (inDeg.get(e.dst) ?? 0)));
  const keyTh = Math.max(3, Math.ceil(maxInd * 0.45));
  const foundTh = Math.max(2, Math.ceil(maxInd * 0.2));

  // 领域演进速度不同（投机解码 2022 开创 vs 传统领域几十年）：
  // 「老」的界线用图内年份分布 P25 与固定 6 年窗口的较晚者
  const years = nodes.map(yearOf).filter(y => y < 9000).sort((a, b) => a - b);
  const p25 = years.length ? years[Math.floor(years.length * 0.25)] : thisYear - 6;
  const oldCut = Math.max(p25, thisYear - 6);

  const layered = nodes.map(n => {
    const ind = inDeg.get(n.arxivId) ?? 0;
    const out = outDeg.get(n.arxivId) ?? 0;
    let layer = 'node';
    // foundation：老 + （图内被引较高或全局高引）→ 领域地基
    if (yearOf(n) <= oldCut && (ind >= foundTh || n.citationCount >= 1000)) layer = 'foundation';
    // key：图内被引最高的核心，或全局高引（不管年代）
    else if (ind >= keyTh || n.citationCount >= 1500) layer = 'key';
    // frontier：新（近 2 年）且图内被引少（站在前沿）
    else if (yearOf(n) >= thisYear - 1 && ind <= 1 && out >= 1) layer = 'frontier';
    // bridge：引用多方（综合地基）且至少被引一次（连接地基与前沿）
    else if (out >= 2 && ind >= 1) layer = 'bridge';
    return { ...n, layer, inDeg: ind, outDeg: out };
  });

  // 阅读顺序：foundation 年代升序 → key 引用数降序 → bridge → frontier（新综述最后）
  const rank = { foundation: 0, key: 1, bridge: 2, node: 3, frontier: 4 } as Record<string, number>;
  layered.sort((a, b) => {
    const ra = rank[a.layer] ?? 3;
    const rb = rank[b.layer] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.layer === 'foundation') return (a.year ?? 0) - (b.year ?? 0);
    if (a.layer === 'frontier') return (b.year ?? 0) - (a.year ?? 0);
    return b.citationCount - a.citationCount;
  });
  layered.forEach((n, i) => { n.readOrder = i + 1; });
  // 种子不在排序里也不丢（已含在 nodes 中）
  return { nodes: layered, edges };
}

// ---------- 一键构建 ----------
export async function buildTopicGraph(
  query: string,
  onProgress?: (msg: string) => void,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; seeds: string[] }> {
  onProgress?.(`搜索「${query}」种子论文…`);
  const seeds = await searchSeeds(query, 20);
  if (!seeds.length) throw new Error('arXiv 搜索无结果，换个关键词试试');
  onProgress?.(`得到 ${seeds.length} 篇种子，扩展引用图…`);
  const { nodes, edges } = await expandGraph(seeds, query);
  onProgress?.(`图扩展完成：${nodes.length} 节点 / ${edges.length} 边，分层排序…`);
  const { nodes: layered, edges: les } = stratifyAndOrder(nodes, edges, seeds.map(s => s.arxivId));
  onProgress?.(`构建完成：${layered.length} 篇论文入库`);
  return { nodes: layered, edges: les, seeds: seeds.map(s => s.arxivId) };
}
