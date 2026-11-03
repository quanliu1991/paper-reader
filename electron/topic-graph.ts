// 主题依赖库构建引擎：
// 1) arXiv 搜索主题 → 种子论文（相关性 top，并并入标题命中的最新论文）
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

interface ArxivHit { arxivId: string; title: string; year: number | null }

// 相关性榜在前，标题时间序里多出来的新论文接在后面（同 id 只留一次）
export function mergeSeedIds(primary: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...primary, ...extra]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// 一个词、又不是通用方法名：按系列读（DeepSeek / LLaMA），而不是按领域地基读。
const GENERIC_TOPIC_WORDS = new Set([
  'attention', 'transformer', 'transformers', 'diffusion', 'learning', 'reasoning', 'alignment',
  'language', 'model', 'models', 'network', 'networks', 'optimization', 'quantization',
  'inference', 'training', 'decoding', 'speculative', 'retrieval', 'generation', 'vision',
  'multimodal', 'reinforcement', 'policy', 'reward', 'agent', 'agents', 'memory', 'context',
  'efficient', 'efficiency', 'scaling', 'mixture', 'experts', 'expert',
]);

export function isSeriesQuery(query: string): boolean {
  const parts = query.toLowerCase().trim().split(/\s+/).filter(w => w.length > 1);
  if (parts.length !== 1) return false;
  const w = parts[0];
  if (w.length < 4) return false;
  if (GENERIC_TOPIC_WORDS.has(w)) return false;
  return true;
}

const COMMENTARY_TITLE = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\bcompar/i,
  /\bevaluat/i,
  /\bbenchmark/i,
  /\bsurvey\b/i,
  /\banalysis of\b/i,
  /\bsafety\b/i,
  /\bshortcoming/i,
  /\bhow effective\b/i,
  /\bthe law of\b/i,
  /\bhallucin/i,
  /\bvulnerab/i,
  /\bparadigm shifts?\b/i,
  /\btechnical evolution\b/i,
  /\bon amd\b/i,
  /^deepseek\S*\s+meets\b/i,
];

export function isCommentaryTitle(title: string): boolean {
  return COMMENTARY_TITLE.some(re => re.test(title));
}

// 官方技术报告是 “DeepSeek-V3: …” / “DeepSeek LLM: …” / “DeepSeek-V3 Technical Report”。
// “DeepSeek-R1 Outperforms …” “DeepSeek reshaping healthcare” 这种不是系列正文。
export function isSeriesTitle(title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t || isCommentaryTitle(t)) return false;
  if (/^DeepSeek-V\d[\d.]* Technical Report$/i.test(t)) return true;
  if (/^DeepSeek(?:\s+LLM|\s*MoE|\s*Math|\s*OCR)(?:\s*-\s*[A-Za-z0-9.]+)*\s*:/i.test(t)) return true;
  if (/^DeepSeek-[A-Za-z0-9.]+(?:-[A-Za-z0-9.]+)*(?:\s+\d+)?\s*:/i.test(t)) return true;
  if (/^DeepSeek\s+Elastic\b/i.test(t)) return true;
  return false;
}

// arXiv id 的 YYMM 前缀就是投稿顺序，同一年里比引用数更接近真实发表顺序。
export function arxivSeq(id: string): number {
  const m = id.match(/^(\d{4})\.(\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 100000 + Number(m[2]);
}

// 系列名撞车：2018 年那篇图像检索 DeepSeek 和 2024 起的模型系列之间空了好几年。
export function namesakeIds(papers: Array<{ arxivId: string; year: number | null }>): Set<string> {
  const dated = papers.filter(p => p.year != null).sort((a, b) => a.year! - b.year!);
  if (dated.length < 5) return new Set();
  let cut = -1;
  for (let i = 0; i < dated.length - 1; i++) {
    const gap = dated[i + 1].year! - dated[i].year!;
    const after = dated.length - (i + 1);
    if (gap >= 3 && after >= 4) { cut = dated[i].year!; break; }
  }
  if (cut < 0) return new Set();
  return new Set(dated.filter(p => p.year! <= cut).map(p => p.arxivId));
}

function parseArxivAtom(xml: string): ArxivHit[] {
  const hits: ArxivHit[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const idMatch = e.match(/<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
    const tMatch = e.match(/<title>([\s\S]*?)<\/title>/);
    const dMatch = e.match(/<published>(\d{4})/);
    if (!idMatch || !tMatch) continue;
    hits.push({
      arxivId: idMatch[1].replace(/v\d+$/, ''),
      title: decodeXmlEntities(tMatch[1].replace(/\s+/g, ' ').trim()),
      year: dMatch ? Number(dMatch[1]) : null,
    });
  }
  return hits;
}

async function queryArxiv(
  searchQuery: string, limit: number,
  sortBy: 'relevance' | 'submittedDate',
  sortOrder: 'ascending' | 'descending' = 'descending',
  start = 0,
): Promise<ArxivHit[]> {
  const order = sortBy === 'submittedDate' ? `&sortOrder=${sortOrder}` : '';
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}&start=${start}&max_results=${limit}&sortBy=${sortBy}${order}`;
  const xml = await (await fetch(url, { signal: AbortSignal.timeout(30000) })).text();
  return parseArxivAtom(xml);
}

// 系列论文会夹在上百篇评测中间。只取最新/最旧各 20 篇时，中间的技术报告（如 V4）会丢。
async function queryArxivPaged(
  searchQuery: string, cap: number,
  sortBy: 'relevance' | 'submittedDate',
  sortOrder: 'ascending' | 'descending',
): Promise<ArxivHit[]> {
  const all: ArxivHit[] = [];
  const page = 50;
  for (let start = 0; all.length < cap; start += page) {
    const n = Math.min(page, cap - all.length);
    const batch = await queryArxiv(searchQuery, n, sortBy, sortOrder, start);
    all.push(...batch);
    if (batch.length < n) break;
  }
  return all;
}

// ---------- 1. 种子搜索 ----------
// 相关性 top 会被第三方评测占满（搜 deepseek 时官方 V4.1 在 2899 篇里排不进前 20）。
// 再按标题 + 提交时间取最新一批，保证型号技术报告进种子。arXiv 无引用数，用 S2 批量补。
export async function searchSeeds(query: string, limit = 20): Promise<GraphNode[]> {
  const q = query.trim().replace(/"/g, '');
  if (!q) return [];
  const byRelevance = await queryArxiv(`all:${q}`, limit, 'relevance');
  // 系列名常黏在型号上（DeepSeekMoE / DeepSeekMath），带引号的短语搜不到，改用前缀。
  const series = isSeriesQuery(q);
  const titleQ = series ? `ti:${q}*` : `ti:"${q}"`;
  let byTitleNew: ArxivHit[] = [];
  let byTitleOld: ArxivHit[] = [];
  try {
    if (series) {
      byTitleOld = await queryArxivPaged(titleQ, 160, 'submittedDate', 'ascending');
    } else {
      byTitleNew = await queryArxiv(titleQ, limit, 'submittedDate', 'descending');
      byTitleOld = await queryArxiv(titleQ, limit, 'submittedDate', 'ascending');
    }
  } catch { /* 标题检索失败时仍用相关性种子 */ }
  const byId = new Map<string, ArxivHit>();
  for (const hit of [...byRelevance, ...byTitleOld, ...byTitleNew]) {
    if (!byId.has(hit.arxivId)) byId.set(hit.arxivId, hit);
  }
  // 标题命中（从旧到新、从新到旧）优先保留，避免相关性榜把最新技术报告挤出上限。
  const titled = mergeSeedIds(byTitleOld.map(h => h.arxivId), byTitleNew.map(h => h.arxivId));
  const ids = mergeSeedIds(titled, byRelevance.map(h => h.arxivId)).slice(0, series ? 180 : 48);
  if (!ids.length) return [];
  const titles = new Map(ids.map(id => [id, byId.get(id)!.title]));
  const years = new Map(ids.map(id => [id, byId.get(id)!.year]));
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
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function batchDetails(arxivIds: string[]): Promise<Map<string, { title: string; year: number | null; citationCount: number }>> {
  const out = new Map<string, { title: string; year: number | null; citationCount: number }>();
  for (let i = 0; i < arxivIds.length; i += 25) {
    const chunk = arxivIds.slice(i, i + 25);
    try {
      let arr: any[] | null = null;
      for (let attempt = 0; attempt < 4 && !arr; attempt++) {
        const r = await fetch(`${S2}/batch?fields=title,year,citationCount,externalIds`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: chunk.map(id => `ARXIV:${id}`) }),
          signal: AbortSignal.timeout(30000),
        });
        if (r.status === 429) {
          const retryAfter = Number(r.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
          await sleep(Math.min(wait, 20000));
          continue;
        }
        if (!r.ok) break;
        arr = await r.json() as any[];
      }
      if (!arr) continue;
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
function orderSeries(nodes: GraphNode[], edges: GraphEdge[], query: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const q = query.trim().toLowerCase();
  const leads = (title: string) => title.toLowerCase().replace(/^[^a-z0-9]+/, '').startsWith(q);
  const collisions = namesakeIds(nodes.filter(n => leads(n.title)));
  const reranked = nodes.map(n => {
    const hit = n.title.toLowerCase().includes(q);
    let layer = 'context';
    if (collisions.has(n.arxivId)) layer = 'context';
    else if (isSeriesTitle(n.title)) layer = 'series';
    else if (hit) layer = 'discussion';
    return { ...n, layer };
  });
  const rank: Record<string, number> = { series: 0, discussion: 1, context: 2 };
  reranked.sort((a, b) => {
    const ra = rank[a.layer] ?? 9;
    const rb = rank[b.layer] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.layer === 'series') return arxivSeq(a.arxivId) - arxivSeq(b.arxivId);
    if (a.layer === 'discussion') return b.citationCount - a.citationCount;
    return b.citationCount - a.citationCount;
  });
  const capped = reranked.filter(n => {
    if (n.layer === 'series') return true;
    const same = reranked.filter(x => x.layer === n.layer);
    const idx = same.findIndex(x => x.arxivId === n.arxivId);
    const limit = n.layer === 'discussion' ? 12 : 8;
    return idx < limit;
  });
  capped.forEach((n, i) => { n.readOrder = i + 1; });
  const keep = new Set(capped.map(n => n.arxivId));
  return { nodes: capped, edges: edges.filter(e => keep.has(e.src) && keep.has(e.dst)) };
}

export function stratifyAndOrder(
  nodes: GraphNode[], edges: GraphEdge[], seeds: string[], query = '',
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  nodes = nodes.map(n => ({ ...n, title: decodeXmlEntities(n.title) }));
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
    // frontier：新（近 2 年）且图内被引少。没有引用边的最新种子也算前沿
    // （官方技术报告刚发出来时引用图还是空的，否则会掉进「节点」）
    else if (yearOf(n) >= thisYear - 1 && ind <= 1) layer = 'frontier';
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
  if (isSeriesQuery(query)) return orderSeries(layered, edges, query);
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
  const { nodes: layered, edges: les } = stratifyAndOrder(nodes, edges, seeds.map(s => s.arxivId), query);
  onProgress?.(`构建完成：${layered.length} 篇论文入库`);
  return { nodes: layered, edges: les, seeds: seeds.map(s => s.arxivId) };
}
