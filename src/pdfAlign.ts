// PDF 对照的几何：页首对齐（验收：页顶与该页首段误差 ≤50px）与页内段落对齐共用同一套纯函数。
// 页内对齐把左栏阅读线上的文本框，和右栏同一段的对应比例点，拉到各自栏的同一条阅读线。

export const READ_LINE = 48;
export const PAGE_TOP_PAD = 12;
export const PAGE_TOP_PAD_L = 8;
export const PAGE_BAND_LO = -16;
export const PAGE_BAND_HI = 56;
export const PARA_DEAD = 36;
export const PAGE_DEAD = 50;
/** 阅读线离最近文本框超过这个距离（多半在图/表上）时不对齐，避免跳到远处段落。 */
export const MAX_ANCHOR_DIST = 140;

export interface AlignBox {
  pid: number;
  page: number;
  x: number;
  y: number;
  h: number;
  pageH: number;
}

export function inPageTopBand(pageTop: number, paneTop: number): boolean {
  const off = pageTop - paneTop;
  return off >= PAGE_BAND_LO && off <= PAGE_BAND_HI;
}

export function boxScreenTop(box: AlignBox, hostTop: number, hostH: number): number {
  return hostTop + (box.y / box.pageH) * hostH;
}

export function boxScreenHeight(box: AlignBox, hostH: number): number {
  return Math.max(8, (box.h / box.pageH) * hostH);
}

/**
 * 阅读线上的原文（已归一化）对应哪一段。
 * 优先「整行出现在段首」的块；行比块更长时，取被整行包含的最长块（标题）。
 */
export function pickBlockPid(lineNorm: string, blocks: { pid: number; norm: string }[]): number {
  const key = lineNorm.slice(0, 32);
  if (key.length < 10) return 0;
  const hits = blocks.filter(b => {
    if (b.pid <= 0 || b.norm.length < 8) return false;
    if (b.norm.includes(key)) return true;
    return b.norm.length <= key.length && key.includes(b.norm);
  });
  if (!hits.length) return 0;
  const containsKey = hits.filter(b => b.norm.includes(key));
  const pool = containsKey.length ? containsKey : hits;
  pool.sort((a, b) => {
    if (!containsKey.length) return b.norm.length - a.norm.length;
    const d = a.norm.indexOf(key) - b.norm.indexOf(key);
    if (d) return d;
    return a.norm.length - b.norm.length;
  });
  return pool[0].pid;
}

export function fractionIn(top: number, height: number, anchorY: number): number {
  if (height <= 0) return 0;
  return Math.min(1, Math.max(0, (anchorY - top) / height));
}

export function nextScrollTop(scrollTop: number, point: number, anchor: number): number {
  return Math.max(0, scrollTop + (point - anchor));
}

/** 阅读线所在的文本框。双栏同时穿过阅读线时，取垂直中心更近的；中心相同取左栏（x 更小）。 */
export function pickBoxAtAnchor<T extends AlignBox>(
  boxes: T[],
  page: number,
  hostTop: number,
  hostH: number,
  anchorY: number,
): T | null {
  if (hostH <= 0) return null;
  let best: T | null = null;
  let bestScore = Infinity;
  let bestDist = Infinity;
  for (const b of boxes) {
    if (b.page !== page || b.pid <= 0 || b.pageH <= 0 || b.h <= 0) continue;
    const top = boxScreenTop(b, hostTop, hostH);
    const bot = top + boxScreenHeight(b, hostH);
    const contains = anchorY >= top - 4 && anchorY <= bot + 4;
    const dist = contains ? 0 : anchorY < top ? top - anchorY : anchorY - bot;
    const score = dist * 1e6 + Math.abs((top + bot) / 2 - anchorY) + b.x * 0.01;
    if (score < bestScore) {
      bestScore = score;
      bestDist = dist;
      best = b;
    }
  }
  if (!best || bestDist > MAX_ANCHOR_DIST) return null;
  return best;
}

/** 同一页、同一段的全部文本框的外接纵向范围（多簇合成一段）。 */
export function pidSpan(
  boxes: AlignBox[],
  pid: number,
  page: number,
  hostTop: number,
  hostH: number,
): { top: number; height: number } | null {
  if (!pid || hostH <= 0) return null;
  let top = Infinity;
  let bot = -Infinity;
  for (const b of boxes) {
    if (b.pid !== pid || b.page !== page || b.pageH <= 0) continue;
    const t = boxScreenTop(b, hostTop, hostH);
    const bb = t + boxScreenHeight(b, hostH);
    if (t < top) top = t;
    if (bb > bot) bot = bb;
  }
  if (!Number.isFinite(top)) return null;
  return { top, height: Math.max(8, bot - top) };
}
