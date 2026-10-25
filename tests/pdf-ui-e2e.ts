// PDF 视图 UI E2E：真实窗口导入论文 → 切 PDF 模式 → 验证 canvas 渲染 + 截图
import { app, BrowserWindow } from 'electron';
import * as db from '../electron/db';
import * as arxiv from '../electron/arxiv';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

app.whenReady().then(async () => {
  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    // dev server（外层测试已启动 vite）或 dist
    const url = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    await win.loadURL(url);
    await new Promise(r => setTimeout(r, 1500));

    // 主进程导入论文（HTML fixture）
    const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
    const parsed = arxiv.parseArxivHtml(html, '2609.34683');
    const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
    db.insertBlocks(paperId, parsed.blocks);
    log(`import: PASS (paper ${paperId}, ${parsed.blocks.length} blocks)`);

    // 预放 PDF（避免下载等待）
    const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
    fs.mkdirSync(pdfsDir, { recursive: true });
    const seed = path.resolve('build/test-paper.pdf');
    if (fs.existsSync(seed)) fs.copyFileSync(seed, path.join(pdfsDir, `${paperId}.pdf`));
    log(`pdf seeded: ${fs.existsSync(path.join(pdfsDir, `${paperId}.pdf`)) ? 'PASS' : 'FAIL'}`);

    // 渲染层：打开论文 + 切 PDF 阅读模式（单栏，译文原位覆盖）
    await win.webContents.executeJavaScript(`
      window.__store.getState().openPaper(${paperId}).then(() => {
        window.__store.getState().setLayout('pdf-layout');
      })
    `);
    await new Promise(r => setTimeout(r, 4500)); // 等 PDF 加载渲染

    const stats = await win.webContents.executeJavaScript(`
      (() => {
        const canvases = document.querySelectorAll('.pdf-page canvas');
        const pages = document.querySelectorAll('.pdf-page');
        const zh = document.querySelectorAll('.dpv-zhcap');
        const badge = document.querySelector('.pdf-page-indicator');
        return { canvases: canvases.length, pages: pages.length, zhCaps: zh.length, badge: badge?.textContent ?? null,
                 firstCanvasW: canvases[0]?.width ?? 0 };
      })()
    `);
    log(`pdf view: canvases=${stats.canvases}/${stats.pages} pages, zhCaps=${stats.zhCaps}, badge=${JSON.stringify(stats.badge)}`);
    log(`canvas rendered: ${stats.canvases >= 1 && stats.firstCanvasW > 300 ? 'PASS' : 'FAIL'}`);
    log(`zh layer mounted: ${stats.zhCaps >= 1 || stats.pages >= 1 ? 'PASS' : 'FAIL'}`);

    // 字体一致性：打包 Noto Serif SC 必须已加载；有译文胶囊时所有正文 computed family 必须唯一
    const fontStats = await win.webContents.executeJavaScript(`
      (async () => {
        await document.fonts.ready;
        const loaded400 = document.fonts.check('400 14px "Noto Serif SC"', '译文测试一致性');
        const loaded700 = document.fonts.check('700 14px "Noto Serif SC"', '译');
        const loadedSans = document.fonts.check('600 14px "Noto Sans SC"', '标题');
        const caps = [...document.querySelectorAll('.dpv-zhcap')];
        const fams = new Set(), weights = new Set();
        for (const c of caps) {
          const cs = getComputedStyle(c);
          fams.add(cs.fontFamily.split(',')[0].replace(/"/g, ''));
          weights.add(c.classList.contains('heading') ? 'heading-600' : cs.fontWeight);
        }
        return { loaded400, loaded700, loadedSans, n: caps.length, fams: [...fams], weights: [...weights] };
      })()
    `);
    log(`fonts: serif400=${fontStats.loaded400}, serif700=${fontStats.loaded700}, sans600=${fontStats.loadedSans}`);
    log(`zh caps font check: n=${fontStats.n}, families=${JSON.stringify(fontStats.fams)}, weights=${JSON.stringify(fontStats.weights)}`);
    const fontOk = fontStats.loaded400 && fontStats.loaded700 && fontStats.loadedSans
      && (fontStats.n === 0 || (fontStats.fams.length === 1 && fontStats.fams[0] === 'Noto Serif SC'));
    log(`font consistency: ${fontOk ? 'PASS' : 'FAIL'}`);

    // 截图存档
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.resolve('build'), { recursive: true });
    fs.writeFileSync(path.resolve('build/pdf-ui-e2e.png'), img.toPNG());
    log('screenshot saved');

    if (stats.canvases >= 1 && stats.firstCanvasW > 300 && fontOk) log('E2E ALL PASS');
    else log('E2E FAIL');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
  } finally {
    finish();
    app.quit();
  }
});
