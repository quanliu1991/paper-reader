// l2r-debug-entry.ts — L2R 长跳跟随调试：量化 IO 回调时序（best 页选择、滞回判断、跟随执行）
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import * as db from '../electron/db';
import * as arxiv from '../electron/arxiv';

const LOG = process.env.PR_E2E_LOG!;
const DONE = process.env.PR_E2E_DONE!;
const log = (s: string) => { fs.appendFileSync(LOG, s + '\n'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    await sleep(1500);
    const parsed = arxiv.parseArxivHtml(fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8'), '2609.34683');
    const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
    db.insertBlocks(paperId, parsed.blocks);
    const pdfDir = path.join(app.getPath('userData'), 'pdfs');
    fs.mkdirSync(pdfDir, { recursive: true });
    const seedPdf = path.resolve('build/test-paper.pdf');
    if (fs.existsSync(seedPdf)) fs.copyFileSync(seedPdf, path.join(pdfDir, `${paperId}.pdf`));
    const realBlocks = (db.getBlocks(paperId) as any[]).filter(b => b.type !== 'fig');
    realBlocks.forEach((b, i) => {
      db.saveTranslation(paperId, b.pid, `第${i + 1}段测试译文内容，包含足够长度的文本用于排版测试 ${i}。`, 'test', 'test');
    });
    await sleep(1000);
    await win.webContents.executeJavaScript(`
      (async () => {
        const st = window.__store.getState();
        await st.openPaper(${paperId});
        st.setLayout('pdf-layout');
      })()
    `);
    let clusterInfo: any = null;
    for (let i = 0; i < 40; i++) {
      clusterInfo = await win.webContents.executeJavaScript('window.__dpvClusterDone ?? null');
      if (clusterInfo) break;
      await sleep(500);
    }
    log('cluster: ' + JSON.stringify(clusterInfo));

    // 预热：左栏全页渲染
    await win.webContents.executeJavaScript(`
      (async () => {
        const L = document.querySelector('.dpv-left');
        for (let round = 0; round < 4; round++) {
          const h0 = L.scrollHeight;
          for (let y = 0; y < L.scrollHeight; y += 700) { L.scrollTop = y; await new Promise(r => setTimeout(r, 120)); }
          L.scrollTop = 0;
          await new Promise(r => setTimeout(r, 400));
          if (Math.abs(L.scrollHeight - h0) <= 2) return round;
        }
      })()
    `);
    log('warm done');

    const diag: any = await win.webContents.executeJavaScript(`
      (async () => {
        const L = document.querySelector('.dpv-left'), R = document.querySelector('.dpv-right');
        // 注入探针：包一层 setVisiblePage 不可行，改监听 R 的 scrollTo 行为
        const events = [];
        const origScrollTo = Element.prototype.scrollTo;
        Element.prototype.scrollTo = function(...args) {
          if (this === R) events.push({ at: performance.now(), top: args[0]?.top ?? args[0] });
          return origScrollTo.apply(this, args);
        };
        const out = { events, samples: [] };
        const domPage = n => L.querySelector('.pdf-page[data-page="' + n + '"]');
        const domPara = n => R.querySelector('.dpv-zhpara[data-page="' + n + '"]');
        const settle = async (pane, ms = 4000) => {
          let last = pane.scrollTop, same = 0;
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            await new Promise(r => setTimeout(r, 250));
            const cur = pane.scrollTop;
            if (Math.abs(cur - last) <= 1) { same++; if (same >= 2) return true; } else same = 0;
            last = cur;
          }
          return false;
        };
        for (const pg of [3, 6, 8, 9, 11]) {
          const pageEl = domPage(pg);
          if (!pageEl) continue;
          const evBefore = out.events.length;
          L.scrollTop = pageEl.getBoundingClientRect().top - L.getBoundingClientRect().top + L.scrollTop - 10;
          L.dispatchEvent(new Event('scroll'));
          await settle(L); await settle(R);
          // 等跟随：pg 首段接近 R 顶（最多 3s）
          for (let w = 0; w < 12; w++) {
            const pe = domPara(pg), rr0 = R.getBoundingClientRect();
            if (!pe || Math.abs(pe.getBoundingClientRect().top - (rr0.top + 12)) <= 50) break;
            await new Promise(r => setTimeout(r, 250));
          }
          await new Promise(r => setTimeout(r, 200));
          const paraEl = domPara(pg);
          const err = paraEl ? Math.round(paraEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top) : null;
          const rr = R.getBoundingClientRect();
          const rTop = [...R.querySelectorAll('.dpv-zhpara[data-page]')].find(p => p.getBoundingClientRect().bottom > rr.top + 4);
          out.samples.push({ pg, err, rTopPg: rTop?.dataset.page, scrollTos: out.events.slice(evBefore).length, rST: Math.round(R.scrollTop) });
        }
        Element.prototype.scrollTo = origScrollTo;
        return out;
      })()
    `);
    log('samples: ' + JSON.stringify(diag.samples, null, 1));
    log('scrollTo events: ' + JSON.stringify(diag.events.slice(0, 12)));
    fs.writeFileSync(DONE, '1');
  } catch (e: any) {
    log('FATAL: ' + (e?.stack ?? e));
    fs.writeFileSync(DONE, '0');
  } finally {
    setTimeout(() => app.quit(), 300);
  }
});
