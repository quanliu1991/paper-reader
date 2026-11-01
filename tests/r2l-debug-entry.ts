// r2l-debug-entry.ts — R2L 联动执行链路探针：R 程序滚动（scrollTop 赋值）后 L 是否跟随
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import * as db from '../electron/db';
import * as arxiv from '../electron/arxiv';

const LOG = process.env.PR_E2E_LOG!;
const DONE = process.env.PR_E2E_DONE!;
const log = (s: string) => { fs.appendFileSync(LOG, s + '\n'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run() {
  try {
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

    const win = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    await sleep(1000);
    await win.webContents.executeJavaScript(`
      (async () => {
        const st = window.__store.getState();
        await st.openPaper(${paperId});
        st.setLayout('pdf-layout');
      })()
    `);
    for (let i = 0; i < 40; i++) {
      const done = await win.webContents.executeJavaScript('window.__dpvClusterDone ?? null');
      if (done) break;
      await sleep(500);
    }
    // 预热
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

    // 场景：先 L2R 到 pg11（复现 B1 尾状态），再 R 程序滚回 pg3（复现 B2:3）
    const out: any = await win.webContents.executeJavaScript(`
      (async () => {
        const L = document.querySelector('.dpv-left'), R = document.querySelector('.dpv-right');
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
        // 第一步：L 到 pg11（模拟 B1 尾页）
        const p11 = domPage(11);
        L.scrollTop = p11.getBoundingClientRect().top - L.getBoundingClientRect().top + L.scrollTop - 10;
        L.dispatchEvent(new Event('scroll'));
        await settle(L); await settle(R);
        await new Promise(r => setTimeout(r, 2000)); // 额外等 2s（模拟 B1→B2 间隔）
        const state1 = { lST: Math.round(L.scrollTop), rST: Math.round(R.scrollTop) };
        // 第二步：R 程序滚回 pg3 首段（模拟 B2:3）
        const para3 = domPara(3);
        R.scrollTop = para3.getBoundingClientRect().top - R.getBoundingClientRect().top + R.scrollTop - 10;
        R.dispatchEvent(new Event('scroll'));
        await settle(R); await settle(L);
        // 等 L 跟随（最多 3s）
        for (let w = 0; w < 12; w++) {
          const lTopPg = [...L.querySelectorAll('.pdf-page')].find(p => p.getBoundingClientRect().bottom > L.getBoundingClientRect().top + 4)?.dataset.page;
          if (lTopPg === '3') break;
          await new Promise(r => setTimeout(r, 250));
        }
        const lr = L.getBoundingClientRect();
        const lTopPg = [...L.querySelectorAll('.pdf-page')].find(p => p.getBoundingClientRect().bottom > lr.top + 4)?.dataset.page;
        const p3 = domPage(3);
        const err = para3 && p3 ? Math.round(para3.getBoundingClientRect().top - p3.getBoundingClientRect().top) : null;
        return { state1, state2: { lST: Math.round(L.scrollTop), rST: Math.round(R.scrollTop), lTopPg, err } };
      })()
    `);
    log('R2L probe: ' + JSON.stringify(out));
    fs.writeFileSync(DONE, '1');
  } catch (e: any) {
    log('FATAL: ' + (e?.stack ?? e));
    fs.writeFileSync(DONE, '0');
  } finally {
    setTimeout(() => app.quit(), 300);
  }
}
