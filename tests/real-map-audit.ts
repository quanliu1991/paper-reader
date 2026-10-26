// 真实论文页序审计：build/real-blocks.json + 真实 PDF（userData/pdfs/1.pdf）
// 输出：右栏每页组的前 3 段 EN 文本 vs 左栏该页 PDF 物理簇文本 —— 用户要求的「一一对应」证明
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as fs from 'fs';
import * as path from 'path';

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
  outer: for (let i = 0; i + n <= hay.length; i++) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
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
      sim[ci * B + bi] = simScore(cn, bn);
    }
  }
  const NEG = -1e9;
  const dp = new Float64Array((C + 1) * W).fill(NEG);
  const move = new Int8Array((C + 1) * W);
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

  const blocks = JSON.parse(fs.readFileSync(path.resolve('build/real-blocks.json'), 'utf8'));
  const blockNorms = blocks.filter((b: any) => b.type !== 'fig')
    .map((b: any) => ({ pid: b.pid, norm: normText(b.en) })).filter((x: any) => x.norm.length >= 6);
  const pidBySeq = new Map(blocks.map((b: any) => [b.seq, b.pid]));

  const pdfPath = path.join(process.env.APPDATA!, 'Paper Reader', 'pdfs', '1.pdf');
  const doc = await (pdfjsLib as any).getDocument({ url: pdfPath, useSystemFonts: true }).promise;

  // 聚类（与组件同款）
  const clustersAll: any[] = [];
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
      const sorted = l.items.slice().sort((a, b) => a.transform[4] - b.transform[4]);
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

  const pids = matchPidsMonotonic(clustersAll, blockNorms);
  clustersAll.forEach((c, i) => { c.pid = pids[i]; });

  // === 右栏页组构建（与组件 pidsByPage 同款：首次出现页 + 邻近归页 + seq 顺序） ===
  const pidFirstPage = new Map<number, number>();
  for (const c of clustersAll) {
    if (!c.pid || pidFirstPage.has(c.pid)) continue;
    pidFirstPage.set(c.pid, c.page);
  }
  const pageOfPid = new Map<number, number>();
  let lastPage = 1;
  for (const b of blocks) {
    if (b.type === 'fig') continue;
    const mapped = pidFirstPage.get(b.pid);
    if (mapped !== undefined) { pageOfPid.set(b.pid, mapped); lastPage = mapped; }
    else pageOfPid.set(b.pid, lastPage);
  }
  const byPage = new Map<number, any[]>();
  for (const b of blocks) {
    if (b.type === 'fig') continue;
    const pg = pageOfPid.get(b.pid);
    const a = byPage.get(pg) ?? []; a.push(b); byPage.set(pg, a);
  }

  // === 用户要求的审计：右栏每页组前 3 段 vs 左栏该页 PDF 物理文本 ===
  console.log('=== 右栏页组前 3 段（EN） vs 左栏 PDF 对应页物理文本 ===\n');
  let allOk = true;
  for (let pg = 1; pg <= doc.numPages; pg++) {
    const items = byPage.get(pg) ?? [];
    if (!items.length) continue;
    const pdfClusters = clustersAll.filter(c => c.page === pg);
    const pdfNorm = pdfClusters.map(c => c.norm).join('');
    console.log(`— 第 ${pg} 页组（${items.length} 段） —`);
    for (const b of items.slice(0, 3)) {
      const bn = normText(b.en);
      // 验证：该段头部 30 字符是否出现在本页 PDF 文本里（首段可能起始上一页——标注）
      const head = bn.slice(0, 30);
      const inPage = head.length >= 12 && pdfNorm.includes(head);
      const mark = inPage ? '✓' : (pidFirstPage.has(b.pid) ? '✗' : '~'); // ~ = 邻近归页
      if (inPage || !pidFirstPage.has(b.pid)) { /* ok or fallback */ } else allOk = false;
      console.log(`  ${mark} pid=${b.pid} ${b.type === 'heading' ? '#' : ''}${(b.en ?? '').replace(/\s+/g, ' ').slice(0, 58)}`);
    }
  }
  const mapped = [...pidFirstPage.keys()].length;
  console.log(`\n精确映射 ${mapped}/${blockNorms.length} 段（其余邻近归页），单调性由 DP 保证`);
  console.log(allOk ? '[real-map-audit] ALL PASS' : '[real-map-audit] CHECK MARKS');
  process.exit(0);
})();
