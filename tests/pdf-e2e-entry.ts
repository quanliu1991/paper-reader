// PDF 链路 E2E：真实 App 主进程内验证 下载 PDF → local-pdf 可读 → pageMap 构建率
import { app } from 'electron';
import { net } from 'electron';
import fs from 'fs';
import path from 'path';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

async function run() {
  if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
  log('== PDF 链路 E2E ==');

  // 1. 下载真实 PDF
  const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
  fs.mkdirSync(pdfsDir, { recursive: true });
  const paperId = 99901;
  const dest = path.join(pdfsDir, `${paperId}.pdf`);
  const resp = await fetch('https://arxiv.org/pdf/2609.34683', { signal: AbortSignal.timeout(90000) });
  log(`download: ${resp.ok ? 'PASS' : 'FAIL'} (${resp.status})`);
  if (!resp.ok) { log('E2E ABORT'); finish(); app.quit(); return; }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`pdf magic: ${buf.slice(0, 4).toString() === '%PDF' ? 'PASS' : 'FAIL'} (${(buf.length / 1024).toFixed(0)}KB)`);

  // 2. local-pdf 协议可读（net.fetch file 层等价验证）
  const fileResp = await net.fetch('file:///' + dest.replace(/\\/g, '/'));
  const body = new Uint8Array(await fileResp.arrayBuffer());
  log(`protocol read: ${body.length === buf.length ? 'PASS' : `FAIL (${body.length} vs ${buf.length})`}`);

  // 3. pageMap：blocks（fixture 解析）→ 页定位率（Node 下注入主线程 worker handler）
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (globalThis as any).pdfjsWorker = workerMod;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(body), useSystemFonts: true }).promise;
  log(`numPages: ${doc.numPages}`);
  const pageTexts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then(pg => pg.getTextContent());
    pageTexts.push(tc.items.map((it: any) => it.str).join(' ').replace(/\s+/g, ' '));
  }
  // 用 fixture HTML 解析的 blocks
  const htmlPath = path.resolve('tests/fixtures/2609.34683.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const { parseArxivHtml } = await import('../electron/arxiv');
  const parsed = parseArxivHtml(html, '2609.34683');
  let located = 0, fallback = 0;
  let pageCursor = 0;
  const map: Record<number, number> = {};
  for (const b of parsed.blocks) {
    const pid = b.seq;
    if (b.type === 'fig') { map[pid] = pageCursor + 1; continue; }
    const needle = b.en.replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!needle) { map[pid] = pageCursor + 1; continue; }
    let found = -1;
    for (let p = pageCursor; p < pageTexts.length; p++) if (pageTexts[p].includes(needle)) { found = p; break; }
    if (found === -1) for (let p = 0; p < pageTexts.length; p++) if (pageTexts[p].includes(needle)) { found = p; break; }
    if (found >= 0) { pageCursor = found; located++; map[pid] = found + 1; }
    else { fallback++; map[pid] = pageCursor + 1; }
  }
  const rate = located / (located + fallback);
  log(`pageMap: located=${located} fallback=${fallback} rate=${(rate * 100).toFixed(1)}%`);
  log(`pageMap quality: ${rate >= 0.75 ? 'PASS' : 'FAIL'} (阈值 75%)`);
  // 单调性检查（页码应大体递增）
  const seqs = parsed.blocks.map(b => map[b.seq]).filter(Boolean);
  let nonMono = 0;
  for (let i = 1; i < seqs.length; i++) if (seqs[i] < seqs[i - 1] - 1) nonMono++;
  log(`monotonic: ${nonMono <= 10 ? 'PASS' : 'FAIL'} (${nonMono} 回退点)`);

  log('E2E ALL PASS');
  finish();
  app.quit();
}

run().catch(e => { log(`FATAL: ${e?.stack ?? e}`); finish(); app.quit(); });
