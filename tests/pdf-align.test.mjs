import { build } from 'esbuild';

await build({
  entryPoints: ['src/pdfAlign.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-align/pdfAlign.js', logLevel: 'silent',
});
const {
  READ_LINE, inPageTopBand, pickBoxAtAnchor, pickBlockPid, pidSpan, fractionIn, nextScrollTop,
} = await import('../tests/.tmp-align/pdfAlign.js');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

const pane = 100;
assert(inPageTopBand(pane + 10, pane), '页顶在视口顶 +10px 时仍按页对齐');
assert(!inPageTopBand(pane - 200, pane), '页顶滚出上沿后改为段落对齐');
assert(inPageTopBand(pane + READ_LINE, pane), '阅读线以内的页首仍算页首带');

const pageH = 1000;
const hostTop = 0;
const hostH = 1000;
const boxes = [
  { pid: 1, page: 2, x: 40, y: 80, h: 40, pageH },
  { pid: 2, page: 2, x: 40, y: 200, h: 120, pageH },
  { pid: 3, page: 2, x: 520, y: 200, h: 120, pageH },
  { pid: 4, page: 2, x: 40, y: 800, h: 40, pageH },
];

assert(pickBoxAtAnchor(boxes, 2, hostTop, hostH, 250)?.pid === 2, '阅读线落在左栏段落上，不取同高的右栏');
assert(pickBoxAtAnchor(boxes, 2, hostTop, hostH, 260)?.pid === 2, '更靠近左栏中心时仍取左栏');
const rightOnly = [
  { pid: 2, page: 2, x: 40, y: 40, h: 30, pageH },
  { pid: 3, page: 2, x: 520, y: 200, h: 80, pageH },
];
assert(pickBoxAtAnchor(rightOnly, 2, hostTop, hostH, 230)?.pid === 3, '左栏已经结束时改跟右栏');
assert(pickBoxAtAnchor(boxes, 2, hostTop, hostH, 500) === null, '阅读线落在大块空白（图/表）时不跳到远处段落');

const span = pidSpan(boxes, 2, 2, hostTop, hostH);
assert(span && span.top === 200 && span.height === 120, '同一段的文本框合成一个纵向范围');
assert(fractionIn(200, 120, 260) === 0.5, '阅读线在文本框中点时比例是 0.5');

// 左→右把译文上的对应比例点拉到阅读线；右→左用同一比例回到原文，误差应回到 0。
const elTop = 500;
const elH = 400;
const anchor = 260;
const frac = fractionIn(span.top, span.height, anchor);
const point = elTop + frac * elH;
const scrolledElTop = elTop - (point - (pane + READ_LINE));
const backFrac = fractionIn(scrolledElTop, elH, pane + READ_LINE);
const backPoint = span.top + backFrac * span.height;
assert(Math.abs(backPoint - anchor) < 0.01, '左右两次对齐互为逆操作，不会来回拉');
assert(nextScrollTop(1000, point, pane + READ_LINE) === 1000 + (point - (pane + READ_LINE)), '滚动增量等于点到阅读线的距离');

const lineBlocks = [
  { pid: 10, norm: 'deepseekv4towardshighlyefficient' },
  { pid: 20, norm: 'generalinfrastructures' },
  { pid: 21, norm: 'generalinfrastructuresarebuiltfromshared' },
];
assert(pickBlockPid('generalinfrastructures', lineBlocks) === 20, '标题行对齐到标题段，而不是更长的复述');
assert(pickBlockPid('short', lineBlocks) === 0, '太短的一行不对齐，避免误跳');
assert(pickBlockPid('arebuiltfromsharedservicesonly', [{ pid: 3, norm: 'wearebuiltfromsharedservicesonlyhere' }]) === 3, '正文中段也能对上所在段落');

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
