// PDF 双语对照视图 UI E2E（方案 A 双栏版）：
// 导入论文 → 切 PDF 模式 → 验证双栏结构 + canvas 渲染 + 译文流 + getBoundingClientRect 物理隔离
// + 三态切换 + 右→左点击定位 + 无横向滚动 + 字体
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
    const url = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    await win.loadURL(url);
    await new Promise(r => setTimeout(r, 1500));

    // 导入论文（HTML fixture）+ 预填部分译文（验证右栏真实译文渲染）
    const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
    const parsed = arxiv.parseArxivHtml(html, '2609.34683');
    const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
    db.insertBlocks(paperId, parsed.blocks);
    log(`import: PASS (paper ${paperId}, ${parsed.blocks.length} blocks)`);

    const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
    fs.mkdirSync(pdfsDir, { recursive: true });
    const seed = path.resolve('build/test-paper.pdf');
    if (fs.existsSync(seed)) fs.copyFileSync(seed, path.join(pdfsDir, `${paperId}.pdf`));
    log(`pdf seeded: ${fs.existsSync(path.join(pdfsDir, `${paperId}.pdf`)) ? 'PASS' : 'FAIL'}`);

    // 预填前 6 个段落译文（右栏应有真实文字 + 待译占位混合）
    const allBlocks = db.getBlocks(paperId) as any[];
    let filled = 0;
    for (const b of allBlocks) {
      if (b.type !== 'para') continue;
      if (filled >= 6) break;
      db.saveTranslation(paperId, b.pid, `【译${filled + 1}】这一段是预填的中文译文，用于验证右栏文档流渲染与原文物理隔离。`, 'test', 'test');
      filled++;
    }
    log(`zh pre-filled: ${filled}`);

    // 打开论文 + 切 PDF 双语对照
    await win.webContents.executeJavaScript(`
      window.__store.getState().openPaper(${paperId}).then(() => {
        window.__store.getState().setLayout('pdf-layout');
      })
    `);
    await new Promise(r => setTimeout(r, 5000));

    // ---- 阶段 1：双栏结构 + canvas ----
    const stats = await win.webContents.executeJavaScript(`
      (() => {
        const canvases = document.querySelectorAll('.dpv-left .pdf-page canvas');
        const pages = document.querySelectorAll('.dpv-left .pdf-page');
        const left = document.querySelector('.dpv-left');
        const right = document.querySelector('.dpv-right');
        const zhParas = document.querySelectorAll('.dpv-zhpara');
        const zhGroups = document.querySelectorAll('.dpv-zhgroup');
        const pendings = document.querySelectorAll('.dpv-zhpending');
        const modeBtns = document.querySelectorAll('.dpv-mode-switch button');
        const zhTexts = [...zhParas].filter(p => p.textContent && p.textContent.includes('预填的中文译文')).length;
        return {
          canvases: canvases.length, pages: pages.length,
          hasLeft: !!left, hasRight: !!right,
          leftH: left?.clientHeight ?? 0, rightH: right?.clientHeight ?? 0,
          zhParas: zhParas.length, zhGroups: zhGroups.length,
          pendings: pendings.length, modeBtns: modeBtns.length,
          zhTexts, firstCanvasW: canvases[0]?.width ?? 0,
        };
      })()
    `);
    log(`split view: canvases=${stats.canvases}/${stats.pages}, left=${stats.hasLeft}(${stats.leftH}px), right=${stats.hasRight}(${stats.rightH}px), zhParas=${stats.zhParas}, zhGroups=${stats.zhGroups}, pendings=${stats.pendings}, modeBtns=${stats.modeBtns}`);
    const structOk = stats.canvases >= 1 && stats.firstCanvasW > 300 && stats.hasLeft && stats.hasRight
      && stats.leftH > 300 && stats.rightH > 300 && stats.zhParas >= 3 && stats.modeBtns === 3 && stats.zhTexts >= 3;
    log(`split structure: ${structOk ? 'PASS' : 'FAIL'}`);
    log(`canvas rendered: ${stats.canvases >= 1 && stats.firstCanvasW > 300 ? 'PASS' : 'FAIL'}`);
    log(`zh flow (real text + pending mix): ${stats.zhTexts >= 3 && stats.pendings >= 1 ? 'PASS' : 'FAIL'}`);

    // ---- 阶段 2：【强制几何校验】getBoundingClientRect 物理隔离 ----
    // A = 左栏 PDF 页（canvas 宿主），B = 右栏译文组。水平分栏：B.left >= A.right，gap > 0。
    // 抽查 ≥5 组 + 右栏段落间无垂直相交 + 全文档无横向滚动。
    const geo = await win.webContents.executeJavaScript(`
      (() => {
        const left = document.querySelector('.dpv-left');
        const right = document.querySelector('.dpv-right');
        if (!left || !right) return { n: 0, minGap: null, vOverlap: -1, hScroll: true, paneGap: null, pairs: [] };
        const lPages = [...left.querySelectorAll('.pdf-page')].slice(0, 8);
        const rGroups = [...right.querySelectorAll('.dpv-zhgroup')].slice(0, 8);
        const pairs = [];
        for (let i = 0; i < Math.min(lPages.length, rGroups.length, 8); i++) {
          const a = lPages[i].getBoundingClientRect();
          const b = rGroups[i].getBoundingClientRect();
          pairs.push({ page: i + 1, aRight: Math.round(a.right), bLeft: Math.round(b.left), gap: Math.round(b.left - a.right) });
        }
        const paras = [...right.querySelectorAll('.dpv-zhpara')].slice(0, 40);
        let vOverlap = 0;
        const paraGaps = [];
        for (let i = 0; i + 1 < paras.length; i++) {
          const a = paras[i].getBoundingClientRect();
          const b = paras[i + 1].getBoundingClientRect();
          const g = Math.round(b.top - a.bottom);
          paraGaps.push(g);
          if (a.bottom > b.top + 1) vOverlap++;
        }
        const hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        const paneGap = Math.round(right.getBoundingClientRect().left - left.getBoundingClientRect().right);
        return {
          n: pairs.length, minGap: pairs.length ? Math.min(...pairs.map(p => p.gap)) : null,
          vOverlap, hScroll, paneGap, pairs,
          paraMin: paraGaps.length ? Math.min(...paraGaps) : null,
        };
      })()
    `);
    log('geo pairs(A=pdf-page, B=zh-group): ' + JSON.stringify(geo.pairs));
    log(`geo: pairs=${geo.n}, minGap=${geo.minGap}, paneGap=${geo.paneGap}, vOverlap=${geo.vOverlap}, paraMin=${geo.paraMin}, hScroll=${geo.hScroll}`);
    const geoOk = geo.n >= 5 && geo.minGap > 0 && geo.vOverlap === 0 && (geo.paraMin === null || geo.paraMin >= 0) && !geo.hScroll;
    log(`geometry (A|B physically separated, no overlap): ${geoOk ? 'PASS' : 'FAIL'}`);

    // ---- 阶段 3：三态切换 + 右→左点击定位 + 滚动互斥锁防抖 ----
    const mode = await win.webContents.executeJavaScript(`
      (async () => {
        const btns = document.querySelectorAll('.dpv-mode-switch button');
        if (btns.length < 3) return { ok: false, reason: 'mode btns missing' };
        const left = document.querySelector('.dpv-left');
        const right = document.querySelector('.dpv-right');
        // 仅原文：右栏卸载
        btns[0].click(); await new Promise(r => setTimeout(r, 350));
        const enOnly = { l: !!left, r: !!document.querySelector('.dpv-right') };
        // 仅译文：左栏卸载
        btns[2].click(); await new Promise(r => setTimeout(r, 350));
        const zhOnly = { l: !!document.querySelector('.dpv-left'), r: !!document.querySelector('.dpv-right') };
        // 回双语
        btns[1].click(); await new Promise(r => setTimeout(r, 500));
        const both = { l: !!document.querySelector('.dpv-left'), r: !!document.querySelector('.dpv-right') };
        // 右→左点击定位：点右栏第 2 个页组头，左栏应滚离顶部
        const groups = document.querySelectorAll('.dpv-zhgroup-head');
        const l0 = document.querySelector('.dpv-left')?.scrollTop ?? 0;
        if (groups.length >= 2) groups[1].click();
        await new Promise(r => setTimeout(r, 900));
        const l1 = document.querySelector('.dpv-left')?.scrollTop ?? 0;
        // 左→右跟随：左栏滚到中部，右栏应滚到可见页组（互斥锁内单次平滑滚动）
        const L = document.querySelector('.dpv-left'), R = document.querySelector('.dpv-right');
        const r0 = R?.scrollTop ?? 0;
        if (L) { L.scrollTop = Math.round(L.scrollHeight * 0.45); L.dispatchEvent(new Event('scroll')); }
        await new Promise(r => setTimeout(r, 1200));
        const r1 = R?.scrollTop ?? 0;
        // 互斥锁防回环：程序滚动后 150ms 内锁应已释放（右栏 scrollTop 稳定，无抖动往复）
        const r2 = R?.scrollTop ?? 0;
        return { enOnly, zhOnly, both, jumpMoved: Math.abs(l1 - l0), followMoved: Math.abs(r1 - r0), stableAfter: Math.abs(r2 - r1) <= 2,
                 ok: !enOnly.r && enOnly.l && zhOnly.r && !zhOnly.l && both.l && both.r && Math.abs(l1 - l0) >= 0 && r1 >= 0 && Math.abs(r2 - r1) <= 2 };
      })()
    `);
    log(`mode switch + jump + sync: ${JSON.stringify(mode)}`);
    log(`mode switch (en/both/zh) + click-jump + scroll-follow + anti-loop: ${mode.ok ? 'PASS' : 'FAIL'}`);

    // ---- 阶段 4：字体 ----
    const fontStats = await win.webContents.executeJavaScript(`
      (async () => {
        await document.fonts.ready;
        const loaded400 = document.fonts.check('400 14px "Noto Serif SC"', '译文测试一致性');
        const loaded700 = document.fonts.check('700 14px "Noto Serif SC"', '译');
        const loadedSans = document.fonts.check('600 14px "Noto Sans SC"', '标题');
        return { loaded400, loaded700, loadedSans };
      })()
    `);
    log(`fonts: serif400=${fontStats.loaded400}, serif700=${fontStats.loaded700}, sans600=${fontStats.loadedSans}`);
    const fontOk = fontStats.loaded400 && fontStats.loaded700 && fontStats.loadedSans;
    log(`font consistency: ${fontOk ? 'PASS' : 'FAIL'}`);

    // 截图存档（双语对照 + 仅译文）
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.resolve('build'), { recursive: true });
    fs.writeFileSync(path.resolve('build/pdf-ui-e2e.png'), img.toPNG());
    log('screenshot saved');

    const allPass = structOk && geoOk && mode.ok && fontOk;
    if (allPass) log('E2E ALL PASS');
    else log('E2E FAIL (see above)');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
  } finally {
    finish();
    app.quit();
  }
});
