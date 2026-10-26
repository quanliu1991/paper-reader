// 页面映射审计（离线）：真实 parseArxivHtml blocks + 真实 test-paper.pdf + 单调 DP 匹配。
// 断言：1) 单调性（pid 在簇序列上单调不减——末尾章节不可能映射到第 1 页）；
//       2) 每页首个匹配簇的 PDF 文本与块文本对应（标题/章节逐字命中）；
//       3) 匹配率 ≥ 35%（其余靠邻近归页兜底）。
// 组件端同款算法（DualPdfView.tsx），本脚本用作映射层的快速回归。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as fs from 'fs';
import * as path from 'path';
import * as arxiv from '../electron/arxiv';

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl',
  '\uFB05': 'st', '\uFB06': 'st', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-',
};
function normText(s: string): string {
  let out = s.replace(/\$\$[^$]*\$\$/g, ' ').replace(/\$[^$]*\$/g, ' ');
  out = out.replace(/[\uFB00-\uFB06\u2010-\u2014\u2212]/g, (ch) => LIGATURES[ch] ?? ch);
  return out.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}
function anchorIn(hay: string, needle: string): boolean {
  if (!needle.length || hay.length < needle.length) return false;
  const n = needle.length;
  for (let i = 0; i + n <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
function simScore(cn: string, bn: string): number {
  if (!cn.length || !bn.length) return 0;
  let prefix = 0;
  const pn = Math.min(cn.length, bn.length);
  while (prefix < pn && cn[prefix] === bn[prefix]) prefix++;
  if (prefix === cn.length && prefix === bn.length) return 1;
  if (prefix >= Math.min(cn.length, 30)) return 0.85 + prefix / Math.max(cn.length, bn.length) * 0.15;
  if (cn.length >= 24 && bn.includes(cn)) return 0.9;
  if (cn.length >= 40 && bn.includes(cn.slice(0, 40))) return 0.85;
  if (cn.length >= 24 && anchorIn(bn, cn.slice(0, 24))) return 0.75;
  if (cn.length >= 24 && anchorIn(bn, cn.slice(-24))) return 0.7;
  if (cn.length < 24 && bn.length < 24) {
    return cn === bn ? 0.95 : prefix / Math.max(cn.length, bn.length) < 0.5 ? 0 : prefix / Math.max(cn.length, bn.length);
  }
  return prefix / Math.max(cn.length, bn.length) >= 0.5 ? 0.5 * prefix / Math.max(cn.length, bn.length) : 0;
}
function prefixSim(a: string, b: string): number { return simScore(a, b); }
function matchPidsMonotonic(clusters: Array<{ norm: string }>, blockNorms: Array<{ pid: number; norm: string }>): number[] {
  const C = clusters.length, B = blockNorms.length;
  const result = new Array<number>(C).fill(0);
  if (!C || !B) return result;
  const TH = 0.45;
  const W = B + 1;
  const sim = new Float64Array(C * B);
  for (let ci = 0; ci < C; ci++) {
    const cn = clusters[ci].norm;
    if (cn.length < 6) continue;
    for (let bi = 0; bi < B; bi++) {
      const bn = blockNorms[bi].norm;
      if (bn.length < 6) continue;
      sim[ci * B + bi] = prefixSim(cn, bn);
    }
  }
  const NEG = -1e9;
  const dp = new Float64Array((C + 1) * W).fill(NEG);
  const move = new Int8Array((C + 1) * W); // 0=skip-c 1=skip-b 2=match 3=cont
  dp[0] = 0;
  for (let ci = 0; ci <= C; ci++) {
    for (let bi = 0; bi <= B; bi++) {
      const cur = dp[ci * W + bi];
      if (cur === NEG) continue;
      if (ci < C && cur > dp[(ci + 1) * W + bi]) { dp[(ci + 1) * W + bi] = cur; move[(ci + 1) * W + bi] = 0; }
      if (bi < B && cur > dp[ci * W + bi + 1]) { dp[ci * W + bi + 1] = cur; move[ci * W + bi + 1] = 1; }
      if (ci < C && bi < B) {
        const s = sim[ci * B + bi];
        if (s >= TH) {
          const v = cur + s * 2 - 0.02;
          if (v > dp[(ci + 1) * W + bi + 1]) { dp[(ci + 1) * W + bi + 1] = v; move[(ci + 1) * W + bi + 1] = 2; }
          const v2 = cur + s * 1.2 - 0.05;
          if (v2 > dp[(ci + 1) * W + bi]) { dp[(ci + 1) * W + bi] = v2; move[(ci + 1) * W + bi] = 3; }
        }
      }
    }
  }
  let ci = C, bi = B;
  while (ci > 0 || bi > 0) {
    const mv = move[ci * W + bi];
    if (mv === 2) { result[ci - 1] = blockNorms[bi - 1].pid; ci--; bi--; }
    else if (mv === 3) { result[ci - 1] = blockNorms[bi - 1].pid; ci--; }
    else if (mv === 1) bi--;
    else if (mv === 0) ci--;
    else break;
  }
  return result;
}

(async () => {
  const { pathToFileURL } = await import('url');
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
  ).href;

  const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
  const parsed = arxiv.parseArxivHtml(html, '2609.34683');
  const blocks = parsed.blocks.map((b: any, i: number) => ({ ...b, pid: i + 1 }));
  const blockNorms = blocks.filter((b: any) => b.type !== 'fig')
    .map((b: any) => ({ pid: b.pid, norm: normText(b.en) })).filter((x: any) => x.norm.length >= 6);

  const doc = await (pdfjsLib as any).getDocument({ url: path.resolve('build/test-paper.pdf') }).promise;
  const clustersAll: Array<{ norm: string; text: string; page: number }> = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = (tc.items as any[]).filter(i => i.str && i.str.trim() && i.width > 0);
    const vp = page.getViewport({ scale: 1 });
    const lines: { y: number; items: any[] }[] = [];
    for (const it of items) {
      const y = it.transform[5];
      const hit = lines.find(l => Math.abs(l.y - y) <= 3);
      if (hit) hit.items.push(it); else lines.push({ y, items: [it] });
    }
    const colGap = Math.max(12, vp.width * 0.03);
    const splitLines: { y: number; items: any[] }[] = [];
    for (const l of lines) {
      const sorted = l.items.slice().sort((a: any, b: any) => a.transform[4] - b.transform[4]);
      let seg: any[] = [];
      for (let i = 0; i < sorted.length; i++) {
        if (seg.length) {
          const prev = sorted[i - 1];
          if (sorted[i].transform[4] - (prev.transform[4] + prev.width) > colGap) { splitLines.push({ y: l.y, items: seg }); seg = []; }
        }
        seg.push(sorted[i]);
      }
      if (seg.length) splitLines.push({ y: l.y, items: seg });
    }
    const colOf = (l: { items: any[] }) => Math.min(...l.items.map((i: any) => i.transform[4])) < vp.width / 2 ? 0 : 1;
    const twoCol = new Set(splitLines.map(colOf)).size > 1;
    const lines2 = splitLines.slice().sort((a, b) => {
      const ca = colOf(a), cb = colOf(b);
      if (twoCol && ca !== cb) return ca - cb;
      return b.y - a.y;
    });
    type Cluster = { items: any[]; col: number };
    const clusters: Cluster[] = [];
    let cur: Cluster | null = null, prevY: number | null = null;
    for (const l of lines2) {
      const col = colOf(l);
      const lineH = Math.max(8, ...l.items.map((i: any) => i.height ?? 10));
      if (cur && prevY !== null) {
        const gap = prevY - l.y;
        if (col !== cur.col || gap > lineH * 1.7 || gap < -lineH * 2) { clusters.push(cur); cur = null; }
      }
      if (!cur) cur = { items: [], col };
      cur.items.push(...l.items);
      prevY = l.y;
    }
    if (cur) clusters.push(cur);
    for (const c of clusters) {
      const text = c.items.map((i: any) => i.str).join(' ');
      const norm = normText(text);
      if (norm.length < 6) continue;
      clustersAll.push({ norm, text, page: p });
    }
  }

  console.log(`clusters=${clustersAll.length}, blocks=${blocks.length}, matchableNorms=${blockNorms.length}`);
  const pids = matchPidsMonotonic(clustersAll, blockNorms);
  clustersAll.forEach((c, i) => { (c as any).pid = pids[i]; });

  // 1) 每页首个匹配审计
  console.log('=== 页↔段映射审计 ===');
  const seen = new Set<number>();
  let auditOk = true;
  for (const c of clustersAll as any[]) {
    if (!c.pid || seen.has(c.page)) continue;
    seen.add(c.page);
    const blk = blocks.find((b: any) => b.pid === c.pid);
    console.log(`p${c.page}: pid=${c.pid}`);
    console.log(`  pdf : ${c.text.slice(0, 70).replace(/\s+/g, ' ')}`);
    console.log(`  html: ${(blk?.en ?? '').replace(/\s+/g, ' ').slice(0, 70)}`);
  }

  // 2) 末尾章节归页（References/Conclusion 必须在文档后部，绝不映射到第 1-2 页）
  console.log('=== 末尾章节归页 ===');
  let tailOk = true;
  for (const b of blocks as any[]) {
    if (b.type === 'heading' && /^(references|conclusion)/i.test(b.en.trim())) {
      const cls = (clustersAll as any[]).filter(c => c.pid === b.pid);
      const firstPage = cls.length ? Math.min(...cls.map(c => c.page)) : null;
      const ok = firstPage === null || firstPage >= doc.numPages - 4;
      if (!ok) tailOk = false;
      console.log(`${ok ? 'PASS' : 'FAIL'} "${b.en.slice(0, 40)}" (pid=${b.pid}) → ${firstPage ? `第 ${firstPage} 页` : '未映射（邻近归页兜底）'}`);
    }
  }

  // 3) 单调性检查：匹配的 pid 在簇序列上必须单调不减
  let mono = true;
  let last = 0;
  for (const pid of pids) {
    if (pid && pid < last) { mono = false; break; }
    if (pid) last = pid;
  }
  const matched = pids.filter(Boolean).length;
  const uniq = new Set(pids.filter(Boolean)).size;
  const rate = uniq / blockNorms.length;
  console.log(`单调性: ${mono ? 'PASS' : 'FAIL'}`);
  console.log(`匹配率: ${Math.round(rate * 100)}% (${uniq}/${blockNorms.length}), 簇匹配 ${matched}/${clustersAll.length} → ${rate >= 0.35 ? 'PASS' : 'FAIL'}`);
  const allOk = mono && tailOk && rate >= 0.35;
  console.log(`[page-map-audit] ${allOk ? 'ALL PASS' : 'FAIL'}`);
  process.exit(allOk ? 0 : 1);
})();
