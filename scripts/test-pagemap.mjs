// 验证 pdfjs 在 Node（Electron 外）可用 + pageMap 算法
import { execSync } from 'child_process';
import fs from 'fs';

// pdfjs legacy build 是 ESM——Node 直接动态 import
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const data = new Uint8Array(fs.readFileSync('build/test-paper.pdf'));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
console.log('pages:', doc.numPages);

const pageTexts = [];
for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
  const tc = await doc.getPage(p).then(pg => pg.getTextContent());
  pageTexts.push(tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' '));
}
console.log('page1 head:', pageTexts[0].slice(0, 120));

// 用解析器的 blocks 验证定位率
import { build } from 'esbuild';
await build({
  entryPoints: ['electron/arxiv.ts'],
  bundle: true, platform: 'node', format: 'esm',
  outfile: 'tests/.arxiv-bundle.mjs', external: ['electron'], logLevel: 'silent',
});
const { parseArxivHtml } = await import('../tests/.arxiv-bundle.mjs');
const html = fs.readFileSync('tests/fixtures/2609.34683.html', 'utf8');
const parsed = parseArxivHtml(html, '2609.34683');

let located = 0, fallback = 0;
let pageCursor = 0;
for (const b of parsed.blocks) {
  if (b.type === 'fig') continue;
  const needle = b.en.replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!needle) continue;
  let found = -1;
  for (let p = pageCursor; p < pageTexts.length; p++) {
    if (pageTexts[p].includes(needle)) { found = p; break; }
  }
  if (found === -1) {
    for (let p = 0; p < pageTexts.length; p++) {
      if (pageTexts[p].includes(needle)) { found = p; break; }
    }
  }
  if (found >= 0) { pageCursor = found; located++; }
  else fallback++;
}
console.log(`located: ${located}, fallback: ${fallback}, rate: ${(located / (located + fallback) * 100).toFixed(1)}%`);
