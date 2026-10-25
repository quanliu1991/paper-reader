import { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } from 'electron';
import path from 'path';
import * as db from './db';
import * as arxiv from './arxiv';
import * as llm from './llm';
import * as gh from './github-bridge';
import * as insights from './insights';
import * as tr from './translate';
import * as topicGraph from './topic-graph';
import fs from 'fs';

let win: BrowserWindow | null = null;

// 在途任务注册表（取消 + 退出清理）
const activeAbort = new Set<AbortController>();

// 自定义协议必须在 app ready 之前注册 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-figure', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'local-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Paper Reader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  protocol.handle('local-figure', (request) => {
    const url = request.url.replace(/^local-figure:\/\//, '');
    // url 形如 <paperId>/fig-N.ext；规范化 + 防目录穿越
    const safe = path.normalize(decodeURIComponent(url)).replace(/^([.]{2}[\/\\])+/, '');
    const filePath = path.join(app.getPath('userData'), 'figures', safe);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // PDF：local-pdf://p/<paperId> → userData/pdfs/<paperId>.pdf
  // 注意：纯数字 host 会被 URL 解析成 IPv4（local-pdf://2 → 0.0.0.2），故用 path 段承载 id
  protocol.handle('local-pdf', (request) => {
    const u = new URL(request.url);
    const id = u.pathname.replace(/\/+/g, '').split('/')[0] || u.hostname;
    const safe = path.basename(decodeURIComponent(id)); // 只留文件名防穿越
    const filePath = path.join(app.getPath('userData'), 'pdfs', `${safe}.pdf`);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // E2E 模式：加载测试脚本不创建窗口。
  // 防护：用户 shell 可能残留 PR_E2E/PR_PDF_E2E 变量（实测案例），
  // 入口文件不存在（打包版 asar 里没有）时直接落到正常启动，不再静默挂死。
  if (process.env.PR_E2E) {
    const entry = path.join(__dirname, 'e2e-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (process.env.PR_TR_QUALITY_E2E) {
    const entry = path.join(__dirname, 'translate-quality-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (process.env.PR_PDF_E2E) {
    // 完整链路（dev 有 dist-electron/pdf-e2e-entry.js）；打包版走内联冒烟
    const entry = path.join(__dirname, 'pdf-e2e-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
    // 打包版内联冒烟：asar 内 pdfjs 可导入 + 能解析真实 PDF（测试脚本预放）
    const logFile = process.env.PR_E2E_LOG!;
    const doneFile = process.env.PR_E2E_DONE!;
    const log = (s: string) => fs.appendFileSync(logFile, s + '\n');
    try {
      if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
      await app.whenReady();
      log('== packaged pdf check ==');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      log('import pdf.mjs: PASS');
      const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      (globalThis as any).pdfjsWorker = workerMod;
      log('import pdf.worker.mjs: PASS');
      const pdfPath = path.join(app.getPath('userData'), 'pdfs', '1.pdf');
      if (!fs.existsSync(pdfPath)) { log(`FATAL: pdf not found at ${pdfPath}`); }
      else {
        const data = new Uint8Array(fs.readFileSync(pdfPath));
        const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
        log(`getDocument: PASS (${doc.numPages} pages)`);
        const tc = await doc.getPage(1).then(pg => pg.getTextContent());
        const text = tc.items.map((it: any) => it.str).join(' ').slice(0, 60);
        log(`getTextContent: PASS (${text.replace(/\n/g, ' ')})`);
        log('E2E ALL PASS');
      }
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
    } finally {
      fs.writeFileSync(doneFile, '1');
      app.quit();
    }
    return;
  }
  if (process.env.PR_UI_INSPECT) {
    // 用户库检查：打开真实库中最近论文，检查渲染状态并截图
    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    registerIpc();
    const logFile = process.env.PR_E2E_LOG!;
    const doneFile = process.env.PR_E2E_DONE!;
    const log = (s: string) => fs.appendFileSync(logFile, s + '\n');
    try {
      await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
      await new Promise(r => setTimeout(r, 1500));
      const papers = db.listPapers() as any[];
      const target = papers.find(p => p.last_opened_at) ?? papers[0];
      if (!target) { log('no papers in library'); fs.writeFileSync(doneFile, '1'); app.quit(); return; }
      log(`opening paper ${target.id}: ${target.title.slice(0, 50)} (import=${target.import_type})`);
      await win.webContents.executeJavaScript(`
        window.__store.getState().openPaper(${target.id}).then(() => {
          window.__store.getState().setLayout('pdf-layout');
        })
      `);
      await new Promise(r => setTimeout(r, 6000));
      // 匹配调试：从 DOM 文本层取簇文本对比 blocks
      const dbg: any = await win.webContents.executeJavaScript(`
        (() => {
          const spans = [...document.querySelectorAll('.plv-textlayer span')].slice(0, 40);
          const lines = [];
          let cur = null;
          for (const sp of spans) {
            const y = Math.round(parseFloat(sp.style.top));
            if (cur && Math.abs(cur.y - y) <= 4) cur.t += sp.textContent + ' ';
            else { cur = { y, t: sp.textContent + ' ' }; lines.push(cur); }
          }
          const st = window.__store.getState();
          return {
            line0: lines[0]?.t.slice(0, 120),
            line1: lines[1]?.t.slice(0, 120),
            line2: lines[2]?.t.slice(0, 120),
            nLines: lines.length,
            block0en: st.blocks[0]?.en?.slice(0, 120),
            block1en: st.blocks[1]?.en?.slice(0, 120),
            block2en: st.blocks[2]?.en?.slice(0, 120),
            nZh: st.blocks.filter(b => b.zh).length,
            zh2: st.blocks[2]?.zh?.slice(0, 60) ?? null,
          };
        })()
      `);
      log('dbg: ' + JSON.stringify(dbg, null, 1));
      // 双页联动验证：点击第一个「真实译文」胶囊（跳过骨架）→ 左侧出现高亮框；左滚 → 右同步
      const link: any = await win.webContents.executeJavaScript(`
        (async () => {
          const caps = [...document.querySelectorAll('.dpv-zhcap')].filter(c => c.dataset.pid);
          if (!caps.length) return { linked: false, reason: 'no real caps' };
          caps[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise(r => setTimeout(r, 500));
          const hl = document.querySelectorAll('.dpv-hlbox');
          // 滚动同步
          const panes = document.querySelectorAll('.dpv-pane');
          if (panes.length === 2) {
            panes[0].scrollTop = Math.round(panes[0].scrollHeight * 0.4);
            panes[0].dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 400));
          }
          const lRatio = panes[0] ? panes[0].scrollTop / Math.max(1, panes[0].scrollHeight - panes[0].clientHeight) : 0;
          const rRatio = panes[1] ? panes[1].scrollTop / Math.max(1, panes[1].scrollHeight - panes[1].clientHeight) : 0;
          // 闪烁检测 + 骨架统计
          const c1 = document.querySelectorAll('.dpv-page canvas').length;
          await new Promise(r => setTimeout(r, 1200));
          const c2 = document.querySelectorAll('.dpv-page canvas').length;
          const capsNow = document.querySelectorAll('.dpv-zhcap');
          return {
            linked: hl.length > 0, hlCount: hl.length,
            scrollSynced: Math.abs(lRatio - rRatio) < 0.05,
            lRatio: Math.round(lRatio * 100) / 100, rRatio: Math.round(rRatio * 100) / 100,
            flicker: c1 !== c2, canvases1: c1, canvases2: c2,
            capTotal: capsNow.length,
            skeleton: [...capsNow].filter(c => c.classList.contains('skeleton')).length,
          };
        })()
      `);
      log('link: ' + JSON.stringify(link, null, 1));
      // 触发前 3 个 para block 翻译（主进程直接构造参数），验证胶囊链路
      const firstParas: any[] = await win.webContents.executeJavaScript(`
        window.__store.getState().blocks.filter(b => b.type === 'para').slice(0, 3).map(b => ({ pid: b.pid, en: b.en }))
      `);
      if (firstParas.length) {
        await win.webContents.executeJavaScript(`
          window.api.translateAll({
            paperId: ${target.id},
            blocks: ${JSON.stringify(firstParas)},
            scope: 'all',
          })
        `);
        await new Promise(r => setTimeout(r, 25000));
      }
      const diag: any = await win.webContents.executeJavaScript(`
        (() => {
          const st = window.__store.getState();
          const pages = document.querySelectorAll('.plv-page, .dpv-page');
          const textSpans = document.querySelectorAll('.dpv-textlayer span');
          const caps = document.querySelectorAll('.dpv-zhcap');
          const canvases = document.querySelectorAll('.dpv-page canvas');
          const firstCap = caps[0];
          const capInfo = firstCap ? {
            left: Math.round(firstCap.getBoundingClientRect().left),
            top: Math.round(firstCap.getBoundingClientRect().top),
            w: Math.round(firstCap.getBoundingClientRect().width),
            textLen: (firstCap.textContent ?? '').length,
          } : null;
          return {
            layout: st.layout, blocks: st.blocks.length,
            pages: pages.length, canvases: canvases.length,
            textSpans: textSpans.length,
            capsules: caps.length, capInfo,
          };
        })()
      `);
      log('diag: ' + JSON.stringify(diag, null, 1));
      const img = await win.webContents.capturePage();
      fs.mkdirSync(path.resolve('build'), { recursive: true });
      fs.writeFileSync(path.resolve('build/inspect-user.png'), img.toPNG());
      log('screenshot saved');
      log('INSPECT DONE');
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
    } finally {
      fs.writeFileSync(doneFile, '1');
      setTimeout(() => app.quit(), 300);
    }
    return;
  }
  if (process.env.PR_TOPIC_UI_E2E) {
    // 主题依赖库 UI E2E：真实网络构建 → 断言分层列表 + 阅读顺序
    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    registerIpc();
    const logFile = process.env.PR_E2E_LOG!;
    const doneFile = process.env.PR_E2E_DONE!;
    const log = (s: string) => fs.appendFileSync(logFile, s + '\n');
    try {
      await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
      await new Promise(r => setTimeout(r, 1200));

      // 阶段 0：侧栏导航存在主题入口
      const shell: any = await win.webContents.executeJavaScript(`
        (() => ({
          hasSidebar: !!document.querySelector('.sidebar'),
          navBtnTitles: [...document.querySelectorAll('.nav-btn')].map(b => b.title),
        }))()
      `);
      log(`shell: navBtns=${JSON.stringify(shell.navBtnTitles)}`);
      log(`sidebar topic entry: ${shell.navBtnTitles.includes('主题依赖库') ? 'PASS' : 'FAIL'}`);

      // 阶段 1：切到主题页，看到构建表单
      await win.webContents.executeJavaScript(`window.__store.getState().setView('topics')`);
      await new Promise(r => setTimeout(r, 600));
      const form: any = await win.webContents.executeJavaScript(`
        (() => ({
          hasBuildBox: !!document.querySelector('.topic-build-box'),
          inputs: document.querySelectorAll('.topic-build-box input').length,
          emptyHint: !!document.querySelector('.empty-hint'),
        }))()
      `);
      log(`topic form: buildBox=${form.hasBuildBox}, inputs=${form.inputs}, emptyHint=${form.emptyHint}`);

      // 阶段 2：真实构建主题（网络：arXiv + Semantic Scholar）
      await win.webContents.executeJavaScript(`
        (async () => {
          const inputs = document.querySelectorAll('.topic-build-box input');
          const setVal = (el, v) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          setVal(inputs[0], '投机解码');
          setVal(inputs[1], 'speculative decoding');
          document.querySelector('.topic-build-box button.primary').click();
        })()
      `);
      let detail: any = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        detail = await win.webContents.executeJavaScript(`
          (() => {
            const sections = document.querySelectorAll('.topic-section');
            const papers = document.querySelectorAll('.topic-paper');
            const badges = [...document.querySelectorAll('.layer-badge')].map(b => b.textContent);
            const orders = [...document.querySelectorAll('.read-order')].map(o => o.textContent);
            const progress = document.querySelector('.topic-progress')?.textContent ?? '';
            const buildBtn = document.querySelector('.topic-build-box button.primary')?.textContent ?? '';
            return { sections: sections.length, papers: papers.length, badges, firstOrders: orders.slice(0, 5), progress };
          })()
        `);
        if (detail.papers > 0) break;
      }
      log(`topic detail: sections=${detail?.sections}, papers=${detail?.papers}, layers=${JSON.stringify(detail?.badges)}, firstOrders=${JSON.stringify(detail?.firstOrders)}`);
      log(`topic built: ${detail && detail.papers >= 20 && detail.sections >= 2 ? 'PASS' : 'FAIL'}`);

      // 阶段 3：返回列表页回看主题卡片
      await win.webContents.executeJavaScript(`document.querySelector('.icon-btn[title="返回主题列表"]')?.click()`);
      await new Promise(r => setTimeout(r, 500));
      const list: any = await win.webContents.executeJavaScript(`
        (() => ({
          cards: document.querySelectorAll('.topic-card').length,
          firstCard: document.querySelector('.tc-name')?.textContent ?? null,
        }))()
      `);
      log(`topic list: cards=${list.cards}, first=${list.firstCard}`);
      log(`topic card: ${list.cards >= 1 && list.firstCard === '投机解码' ? 'PASS' : 'FAIL'}`);

      fs.writeFileSync(doneFile, 'done');
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
      fs.writeFileSync(doneFile, 'error');
    } finally {
      app.quit();
    }
    return;
  }
  if (process.env.PR_PDF_UI_E2E) {
    // UI E2E：注册完整 IPC 后走测试窗口流程（复用 registerIpc + local-pdf 协议）
    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    registerIpc();
    const logFile = process.env.PR_E2E_LOG!;
    const doneFile = process.env.PR_E2E_DONE!;
    const log = (s: string) => fs.appendFileSync(logFile, s + '\n');
    try {
      win.webContents.on('did-finish-load', async () => {
        await new Promise(r => setTimeout(r, 1200));
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

        // 阶段 0：应用壳层（侧栏导航 + 顶栏搜索）
        const shell: any = await win.webContents.executeJavaScript(`
          (() => ({
            sidebar: !!document.querySelector('.sidebar'),
            navBtns: document.querySelectorAll('.nav-btn').length,
            topSearch: !!document.querySelector('.topbar-search'),
            inReaderHidden: !!document.querySelector('.app.in-reader'),
          }))()
        `);
        log(`shell: sidebar=${shell.sidebar}, navBtns=${shell.navBtns}, topSearch=${shell.topSearch}`);

        await win.webContents.executeJavaScript(`
          window.__store.getState().openPaper(${paperId}).then(() => {
            window.__store.getState().setLayout('translate');
          })
        `);
        await new Promise(r => setTimeout(r, 2000));

        // 阶段 1：豆包式翻译全文视图（默认视图）
        const tvStats: any = await win.webContents.executeJavaScript(`
          (() => {
            const rows = document.querySelectorAll('.tv-row');
            const paraRows = document.querySelectorAll('.tv-para-row');
            const pending = document.querySelectorAll('.tv-pending-bar');
            const collapsed = document.querySelectorAll('.tv-collapsed');
            const expandHints = document.querySelectorAll('.tv-expand-hint');
            return { rows: rows.length, paraRows: paraRows.length, pending: pending.length,
                     collapsed: collapsed.length, expandHints: expandHints.length,
                     firstParaPid: paraRows[0]?.dataset.pid ?? null };
          })()
        `);
        log(`translate view: rows=${tvStats.rows}, paraRows=${tvStats.paraRows}, pending=${tvStats.pending}, collapsed=${tvStats.collapsed}`);
        // 联动高亮：点击第一个段落行，等 React 状态更新后断言同行双语同亮
        const linked: any = await win.webContents.executeJavaScript(`
          (async () => {
            const paraRows = document.querySelectorAll('.tv-para-row');
            if (!paraRows.length) return { linked: false, reason: 'no paraRows' };
            paraRows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const activeRow = document.querySelector('.tv-row.active');
            const enCell = activeRow?.querySelector('.tv-cell.en');
            const zhCell = activeRow?.querySelector('.tv-cell.zh');
            return { linked: !!(activeRow && enCell && zhCell), pid: activeRow?.dataset.pid ?? null };
          })()
        `);
        log(`row-linked-highlight: ${linked.linked ? 'PASS' : 'FAIL'}（pid=${linked.pid}, 同行双语同亮）`);
        log(`translate view render: ${tvStats.rows >= 50 ? 'PASS' : 'FAIL'}`);

        // 阶段 2：PDF 阅读模式（单栏，译文原位覆盖）——轮询等 canvas（异步渲染，固定等待会抖）
        await win.webContents.executeJavaScript(`window.__store.getState().setLayout('pdf-layout')`);
        let stats: any = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          stats = await win.webContents.executeJavaScript(`
          (() => {
            const canvases = document.querySelectorAll('.pdf-page canvas');
            const pages = document.querySelectorAll('.pdf-page');
            const zhCaps = document.querySelectorAll('.dpv-zhcap');
            const badge = document.querySelector('.pdf-page-indicator');
            const err = document.querySelector('.pdf-error');
            const scroll = document.querySelector('.dpv-scroll');
            const loadings = document.querySelectorAll('.pdf-loading');
            return { canvases: canvases.length, pages: pages.length, zhCaps: zhCaps.length, badge: badge?.textContent ?? null,
                     firstCanvasW: canvases[0]?.width ?? 0,
                     errText: err?.textContent?.slice(0, 160) ?? null,
                     hasScroll: !!scroll,
                     scrollH: scroll?.offsetHeight ?? -1, scrollSH: scroll?.scrollHeight ?? -1,
                     loadings: loadings.length, firstPageH: pages[0]?.offsetHeight ?? -1 };
          })()
        `);
          if (stats.errText || (stats.canvases >= 1 && stats.firstCanvasW > 300)) break;
        }
        log(`pdf view: canvases=${stats.canvases}/${stats.pages} pages, zhCaps=${stats.zhCaps}, badge=${JSON.stringify(stats.badge)}, scroll=${stats.hasScroll} h=${stats.scrollH}/sh=${stats.scrollSH}, loading=${stats.loadings}, pageH=${stats.firstPageH}`);
        if (stats.errText) log(`pdf error text: ${stats.errText}`);
        log(`canvas rendered: ${stats.canvases >= 1 && stats.firstCanvasW > 300 ? 'PASS' : 'FAIL'}`);
        log(`zh layer mounted: ${stats.zhCaps >= 1 ? 'PASS' : (stats.canvases >= 1 ? 'PASS (no zh yet, canvas ok)' : 'FAIL')}`);

        // 字体一致性：打包 Noto Serif SC/Sans SC 必须实际加载；有译文胶囊时 computed family 必须唯一
        const fontStats: any = await win.webContents.executeJavaScript(`
          (async () => {
            await document.fonts.ready;
            const loaded400 = document.fonts.check('400 14px "Noto Serif SC"', '译文测试一致性');
            const loaded700 = document.fonts.check('700 14px "Noto Serif SC"', '译');
            const loadedSans = document.fonts.check('600 14px "Noto Sans SC"', '标题');
            const caps = [...document.querySelectorAll('.dpv-zhcap')];
            const fams = new Set();
            for (const c of caps) fams.add(getComputedStyle(c).fontFamily.split(',')[0].replace(/"/g, ''));
            return { loaded400, loaded700, loadedSans, n: caps.length, fams: [...fams] };
          })()
        `);
        log(`fonts: serif400=${fontStats.loaded400}, serif700=${fontStats.loaded700}, sans600=${fontStats.loadedSans}, zhCaps=${fontStats.n}, families=${JSON.stringify(fontStats.fams)}`);
        const fontOk = fontStats.loaded400 && fontStats.loaded700 && fontStats.loadedSans
          && (fontStats.n === 0 || (fontStats.fams.length === 1 && fontStats.fams[0] === 'Noto Serif SC'));
        log(`font consistency: ${fontOk ? 'PASS' : 'FAIL'}`);

        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.resolve('build'), { recursive: true });
        fs.writeFileSync(path.resolve('build/pdf-ui-e2e.png'), img.toPNG());
        // translate 视图单独截图（切回去再截）
        await win.webContents.executeJavaScript(`window.__store.getState().setLayout('translate')`);
        await new Promise(r => setTimeout(r, 800));
        const tvImg = await win.webContents.capturePage();
        fs.writeFileSync(path.resolve('build/translate-ui-e2e.png'), tvImg.toPNG());
        log('screenshots saved');
        const allPass = stats.canvases >= 1 && stats.firstCanvasW > 300
          && tvStats.rows >= 50 && linked.linked && shell.sidebar && shell.navBtns >= 2 && shell.topSearch
          && fontOk;
        if (allPass) log('E2E ALL PASS');
        else log('E2E FAIL (see above)');
        fs.writeFileSync(doneFile, '1');
        app.quit();
      });
      const url = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199';
      await win.loadURL(url);
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
      fs.writeFileSync(doneFile, '1');
      app.quit();
    }
    return;
  }
  if (process.env.PR_SOAK) {
    require(path.join(__dirname, 'soak-entry.js'));
    return;
  }
  createWindow();
  registerIpc();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前取消所有在途请求
app.on('before-quit', () => {
  for (const ctl of activeAbort) { try { ctl.abort(); } catch {} }
});

// ==================== IPC 基础设施 ====================
// 统一错误结构：{ok, error, hint}
type Handler = (e: Electron.IpcMainInvokeEvent, ...args: any[]) => any;

function wrap(name: string, fn: Handler) {
  ipcMain.handle(name, async (e, ...args) => {
    try {
      return { ok: true, data: await fn(e, ...args) };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err).replace(/^Error:\s*/, ''), hint: err?.hint ?? '' };
    }
  });
}

function send(channel: string, payload: any) {
  win?.webContents.send(channel, payload);
}

// ==================== IPC ====================
function registerIpc() {
  // ---------- papers ----------
  wrap('papers:list', () => db.listPapers());
  wrap('papers:get', (_e, id: number) => { db.touchPaper(id); return db.getPaper(id); });
  wrap('papers:delete', (_e, id: number) => { db.deletePaper(id); return true; });
  wrap('papers:getBlocks', (_e, id: number) => db.getBlocks(id));

  // ---------- 主题依赖库 ----------
  const topicJobs = new Set<number>(); // 构建中防重
  wrap('topic:build', async (_e, arg: { name: string; query: string }) => {
    if (!arg.query?.trim()) throw new Error('查询词不能为空');
    const topicId = db.createTopic(arg.name.trim() || arg.query.trim(), arg.query.trim());
    if (topicJobs.has(topicId)) throw new Error('该主题正在构建中');
    topicJobs.add(topicId);
    try {
      const result = await topicGraph.buildTopicGraph(arg.query.trim(), msg => {
        send('topic:progress', { topicId, msg });
      });
      db.saveTopicGraph(topicId,
        result.nodes.map(n => ({
          topic_id: topicId, arxiv_id: n.arxivId, title: n.title, year: n.year,
          citation_count: n.citationCount, layer: n.layer, in_degree: n.inDeg,
          out_degree: n.outDeg, read_order: n.readOrder, imported: 0,
        })),
        result.edges,
      );
      return { topicId, nodeCount: result.nodes.length, edgeCount: result.edges.length };
    } catch (e: any) {
      db.setTopicError(topicId, e?.message ?? String(e));
      throw e;
    } finally {
      topicJobs.delete(topicId);
    }
  });
  wrap('topic:list', () => db.listTopics());
  wrap('topic:get', (_e, topicId: number) => ({
    topic: db.getTopic(topicId),
    papers: db.listTopicPapers(topicId),
    edges: db.listTopicEdges(topicId),
  }));
  wrap('topic:delete', (_e, topicId: number) => { db.deleteTopic(topicId); return true; });
  wrap('topic:importPaper', async (_e, arg: { topicId: number; arxivId: string }) => {
    const id = arxiv.normalizeArxivId(arg.arxivId);
    if (!id) throw new Error('无法识别 arXiv ID');
    const paperId = await importPaperCore(id, 'html');
    db.markTopicPaperImported(arg.topicId, arg.arxivId);
    return { paperId };
  });

  wrap('papers:importArxiv', async (_e, input: string) => {
    const id = arxiv.normalizeArxivId(input);
    if (!id) throw new Error('无法识别 arXiv ID（形如 2609.34683 或完整 URL）');
    const paperId = await importPaperCore(id, 'html');
    return { paperId, count: (db.getBlocks(paperId) as any[]).length };
  });

  wrap('papers:importText', (_e, arg: { arxivId: string; title: string; text: string }) => {
    const parsed = arxiv.parsePlainText(arg.text, arg.arxivId, arg.title);
    const paperId = db.insertPaper({
      arxivId: arg.arxivId, title: arg.title || arg.arxivId, authors: '',
      sourceUrl: `https://arxiv.org/abs/${arg.arxivId}`, importType: 'text',
    });
    db.insertBlocks(paperId, parsed.blocks);
    return { paperId, count: parsed.blocks.length };
  });

  // 导入串行队列（防 SQLite 写锁）
  let importChain: Promise<any> = Promise.resolve();
  function importPaperCore(arxivId: string, _mode: string): Promise<number> {
    const task = importChain.then(async () => {
      const parsed = await arxiv.fetchAndParse(arxivId);
      const paperId = db.insertPaper({
        arxivId, title: parsed.title, authors: parsed.authors,
        sourceUrl: `https://arxiv.org/abs/${arxivId}`, importType: parsed.importType,
      });
      db.insertBlocks(paperId, parsed.blocks);

      // 图表下载（不阻塞导入返回——后台跑）
      downloadFiguresFor(paperId, arxivId).catch(() => {});
      // Triage 摘要后台生成
      generateTriageInBackground(paperId).catch(() => {});
      // PDF 后台下载（原版视图用）
      downloadPdfFor(paperId, arxivId).catch(() => {});
      return paperId;
    });
    importChain = task.catch(() => {});
    return task;
  }

  // ---------- PDF 支撑 ----------
  const pdfJobs = new Set<number>();
  async function downloadPdfFor(paperId: number, arxivId: string): Promise<boolean> {
    if (pdfJobs.has(paperId)) return false;
    pdfJobs.add(paperId);
    try {
      const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
      fs.mkdirSync(pdfsDir, { recursive: true });
      const dest = path.join(pdfsDir, `${paperId}.pdf`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) return true;
      const resp = await fetch(`https://arxiv.org/pdf/${arxivId}`, { signal: AbortSignal.timeout(90000) });
      if (!resp.ok) return false;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 10000 || buf.slice(0, 4).toString() !== '%PDF') return false;
      fs.writeFileSync(dest, buf);
      send('pdf:ready', { paperId });
      return true;
    } catch { return false; } finally { pdfJobs.delete(paperId); }
  }

  // 确保论文 PDF 存在（返回是否存在）
  wrap('pdf:ensure', async (_e, paperId: number) => {
    const paper = db.getPaper(paperId) as any;
    if (!paper?.arxiv_id) return { exists: false };
    const dest = path.join(app.getPath('userData'), 'pdfs', `${paperId}.pdf`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) return { exists: true };
    // 后台下载不等待（首次导入已在 importPaperCore 里触发）
    const exists = await downloadPdfFor(paperId, paper.arxiv_id);
    return { exists };
  });

  wrap('pdf:onReady', (_e, cb: any) => cb); // 占位（渲染层用事件订阅，见 preload）

  // 页面对齐：解析 PDF 文本层，为每个 block 定位页码
  wrap('pdf:pageMap', async (_e, paperId: number) => {
    const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
    const pdfPath = path.join(pdfsDir, `${paperId}.pdf`);
    if (!fs.existsSync(pdfPath)) return { exists: false, map: {} };
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      (globalThis as any).pdfjsWorker = workerMod;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true }).promise;
      const pageTexts: string[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const tc = await doc.getPage(p).then(pg => pg.getTextContent());
        pageTexts.push(tc.items.map((it: any) => it.str).join(' ').replace(/\s+/g, ' '));
      }
      const blocks = db.getBlocks(paperId) as any[];
      const map: Record<number, number> = {};
      let pageCursor = 0;
      for (const b of blocks) {
        if (b.type === 'fig') { map[b.pid] = pageCursor + 1; continue; }
        const needle = b.en.replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!needle) { map[b.pid] = pageCursor + 1; continue; }
        // 从当前页向后找（文档顺序假设）
        let found = -1;
        for (let p = pageCursor; p < pageTexts.length; p++) {
          if (pageTexts[p].includes(needle)) { found = p; break; }
        }
        if (found === -1) {
          // 全文兜底
          for (let p = 0; p < pageTexts.length; p++) {
            if (pageTexts[p].includes(needle)) { found = p; break; }
          }
        }
        if (found >= 0) { pageCursor = found; map[b.pid] = found + 1; }
        else map[b.pid] = pageCursor + 1;
      }
      return { exists: true, numPages: doc.numPages, map };
    } catch (e) {
      return { exists: true, map: {}, error: String(e) };
    }
  });

  // text 降级论文自动升级入口（注册后异步执行）
  function scheduleUpgradeTextImports() {
    setTimeout(() => { upgradeTextImports().catch(() => {}); }, 3000);
  }
  scheduleUpgradeTextImports();

  // text 降级论文自动升级：重抓 HTML 结构化导入（含图表）+ PDF
  async function upgradeTextImports() {
    const rows = db.getDb().prepare("SELECT id, arxiv_id FROM papers WHERE import_type='text'").all() as any[];
    console.log(`[upgrade] text papers: ${rows.length}`);
    if (!rows.length) return;
    for (const row of rows) {
      try {
        const parsed = await arxiv.fetchAndParse(row.arxiv_id);
        console.log(`[upgrade] ${row.arxiv_id}: importType=${parsed.importType}, blocks=${parsed.blocks.length}`);
        if (parsed.importType !== 'html') continue; // 仍无 HTML，保持现状
        // 删旧 blocks 重插（旧 translations 的 pid 引用失效，一并清掉）
        db.getDb().prepare('DELETE FROM blocks WHERE paper_id=?').run(row.id);
        db.getDb().prepare('DELETE FROM translations WHERE paper_id=?').run(row.id);
        db.getDb().prepare('UPDATE papers SET title=?, authors=?, import_type=? WHERE id=?')
          .run(parsed.title, parsed.authors, 'html', row.id);
        db.insertBlocks(row.id, parsed.blocks);
        downloadFiguresFor(row.id, row.arxiv_id).catch(() => {});
        downloadPdfFor(row.id, row.arxiv_id).catch(() => {});
        send('paper:upgraded', { paperId: row.id, title: parsed.title });
      } catch (e) { console.log(`[upgrade] ${row.arxiv_id} FAILED: ${e}`); }
    }
  }

  async function downloadFiguresFor(paperId: number, arxivId: string) {
    // 重新拉 HTML 找图（fetchAndParse 没保留原始 html——用 blocks 里 figPath 的远端 URL 直接下）
    const blocks = db.getBlocks(paperId) as any[];
    const fsMod = await import('fs');
    const figuresDir = path.join(app.getPath('userData'), 'figures', String(paperId));
    fsMod.mkdirSync(figuresDir, { recursive: true });
    let i = 0;
    const stmt = db.getDb().prepare('UPDATE blocks SET fig_path=? WHERE pid=?');
    for (const b of blocks) {
      if (b.type !== 'fig' || !b.fig_path) continue;
      i++;
      const url = b.fig_path;
      const ext = (url.match(/\.(svg|png|jpg|jpeg|gif)$/i) || [, 'png'])[1];
      const fname = `fig-${i}.${ext}`;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        fsMod.writeFileSync(path.join(figuresDir, fname), buf);
        stmt.run(`${paperId}/${fname}`, b.pid);
        send('fig:updated', { pid: b.pid, figPath: `${paperId}/${fname}` });
      } catch { /* 单图失败跳过 */ }
    }
  }

  function generateTriageInBackground(paperId: number) {
    const provider = getDefaultProvider();
    if (!provider) return Promise.resolve(); // 未配置 provider 则跳过
    const blocks = db.getBlocks(paperId) as any[];
    const paper = db.getPaper(paperId) as any;
    const abstract = blocks.find(b => /abstract/i.test(b.en) && b.type === 'heading')
      ? (blocks[blocks.findIndex(b => /abstract/i.test(b.en))]?.en ?? '')
      : blocks.slice(0, 3).map(b => b.en).join(' ');
    const bodySample = blocks.filter(b => b.type === 'para').slice(0, 10).map(b => b.en).join('\n').slice(0, 4000);
    const knownTitles = (db.listPapers() as any[]).filter(p => p.id !== paperId).map(p => p.title).slice(0, 20);
    return insights.genTriageSummary(provider, paper.title, paper.authors ?? '', abstract, bodySample, knownTitles)
      .then(s => {
        db.saveSummary(paperId, JSON.stringify(s), '', provider.name, provider.model);
        send('summary:ready', { paperId, summary: s });
      })
      .catch(() => { /* 摘要失败不打扰 */ });
  }

  // ---------- summaries ----------
  wrap('summary:get', (_e, paperId: number) => db.getSummary(paperId));
  wrap('summary:regen', async (_e, paperId: number) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider');
    await generateTriageInBackground(paperId);
    return db.getSummary(paperId);
  });

  // 分节通读摘要
  wrap('summary:sections', async (_e, paperId: number) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider');
    const existing = db.getSummary(paperId) as any;
    if (existing?.section_summaries) return JSON.parse(existing.section_summaries);
    const blocks = db.getBlocks(paperId) as any[];
    // 按 heading 分组
    const sections: Array<{ heading: string; text: string }> = [];
    let cur: { heading: string; text: string } | null = null;
    for (const b of blocks) {
      if (b.type === 'heading') {
        if (cur) sections.push(cur);
        cur = { heading: b.en, text: '' };
      } else if (cur && b.type === 'para') {
        cur.text += b.en + '\n';
      }
    }
    if (cur) sections.push(cur);
    const result = await insights.genSectionSummaries(provider, sections);
    const packed = JSON.stringify(result);
    const old = db.getSummary(paperId) as any;
    db.saveSummary(paperId, old?.summary ?? '', packed, provider.name, provider.model);
    return result;
  });

  // ---------- translations ----------
  wrap('tr:save', (_e, a: { paperId: number; pid: number; zh: string; provider: string; model: string }) => {
    db.saveTranslation(a.paperId, a.pid, a.zh, a.provider, a.model);
    return true;
  });

  // 批量翻译（带取消）——上下文感知 + QC 守卫 + 自动重译
  const trAbort = new Map<number, AbortController>(); // paperId → ctl
  wrap('tr:translateAll', async (e, arg: {
    paperId: number; blocks: Array<{ pid: number; en: string }>; scope: 'untranslated' | 'all';
  }) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider，请先到设置页添加');
    const ctl = new AbortController();
    trAbort.set(arg.paperId, ctl);
    activeAbort.add(ctl);
    const repoGlossary = loadGlossaryForTranslation();
    const concurrency = 3;
    let done = 0;
    let cancelled = false;
    const queue = [...arg.blocks];
    const providerCfg = provider;
    // 上下文快照：本批开始时的全篇状态（含已译段落，供术语一致性）
    const allBlocks = (db.getBlocks(arg.paperId) as any[]).map((b: any) => ({
      pid: b.pid, seq: b.seq, type: b.type, level: b.level, en: b.en, zh: b.zh,
    }));
    const paper = db.getPaper(arg.paperId) as any;
    const paperMeta: tr.PaperMeta = {
      title: paper?.title ?? '', authors: paper?.authors ?? '', arxivId: paper?.arxiv_id ?? '',
    };

    async function worker() {
      for (;;) {
        if (cancelled || ctl.signal.aborted) return;
        const item = queue.shift();
        if (!item) return;
        // 拿最新全篇状态（含本批刚译完的段落 → 术语承接）
        const blocksNow = (db.getBlocks(arg.paperId) as any[]).map((b: any) => ({
          pid: b.pid, seq: b.seq, type: b.type, level: b.level, en: b.en, zh: b.zh,
        }));
        const settled = tr.extractSettledTerms(blocksNow);
        const glossaryLines = [...(repoGlossary ? repoGlossary.trim().split('\n') : []), ...settled];
        let zh = await translateBlockCtx(providerCfg, item.en, paperMeta, blocksNow, item.pid, glossaryLines, ctl.signal);
        // QC 守卫：不达标 → 修正提示重译一次；仍不达标 → 用分数高的
        if (zh.ok && zh.text) {
          const qc1 = tr.qcTranslation(item.en, zh.text);
          if (!qc1.ok) {
            const zh2 = await translateBlockCtx(providerCfg, item.en, paperMeta, blocksNow, item.pid, glossaryLines, ctl.signal, qc1.issues);
            if (zh2.ok && zh2.text) {
              const qc2 = tr.qcTranslation(item.en, zh2.text);
              zh = qc2.score >= qc1.score ? zh2 : zh;
            }
          }
        }
        done++;
        if (zh.ok) {
          db.saveTranslation(arg.paperId, item.pid, zh.text!, providerCfg.name, providerCfg.model);
          e.sender.send('tr:progress', { pid: item.pid, zh: zh.text, done, total: arg.blocks.length });
        } else {
          e.sender.send('tr:progress', { pid: item.pid, err: zh.err, done, total: arg.blocks.length });
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
      trAbort.delete(arg.paperId);
      activeAbort.delete(ctl);
    }
    return { cancelled, done };
  });

  wrap('tr:cancel', (_e, paperId: number) => {
    trAbort.get(paperId)?.abort();
    return true;
  });

  // 上下文感知翻译：论文元信息 + 章节链 + 摘要 + 前文译文 + 后文原文 + 术语表
  function translateBlockCtx(
    provider: llm.ProviderConfig, en: string, paperMeta: tr.PaperMeta,
    blocks: tr.BlockLite[], pid: number, glossaryLines: string[],
    signal?: AbortSignal, qcIssues?: string[],
  ): Promise<{ ok: boolean; text?: string; err?: string }> {
    const sys = tr.buildSystemPrompt(glossaryLines);
    let ctx = tr.extractContext(blocks, pid) ?? { paperLine: '', sectionLine: '', abstractHint: '', prevZh: '', nextEn: '' };
    ctx = { ...ctx, paperLine: `${paperMeta.title}${paperMeta.authors ? ` · ${paperMeta.authors.split(/[;,]/).slice(0, 3).join(', ')}` : ''}${paperMeta.arxivId ? ` (arXiv:${paperMeta.arxivId})` : ''}` };
    let userContent = tr.buildContextBlock(ctx) + en;
    if (qcIssues?.length) {
      userContent += `\n\n【上一版译文的质检问题（必须全部修正后重新输出完整译文）】\n${qcIssues.map(s => '- ' + s).join('\n')}`;
    }
    return new Promise((resolve) => {
      let acc = '';
      llm.chatStream(provider, [
        { role: 'system', content: sys },
        { role: 'user', content: userContent },
      ], {
        onDelta: (d) => { acc += d; },
        onDone: (full) => resolve({ ok: true, text: cleanZh((full || acc).trim()) }),
        onError: (err) => resolve({ ok: false, err }),
      }, { temperature: 0.15, maxTokens: 4096, signal });
    });
  }

  // 输出清洗：去掉 LLM 偶发的包裹标记
  function cleanZh(s: string): string {
    return s
      .replace(/^```(?: chinese|zh|markdown)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .replace(/^(?:译文|翻译)\s*[：:]\s*\n?/i, '')
      .trim();
  }

  function loadGlossaryForTranslation(): string {
    const root = gh.getRepoRoot();
    if (!root) return '';
    const terms = gh.loadGlossary(root).filter(t => t.level === 'learning' || t.level === 'unknown');
    if (!terms.length) return '';
    const lines = terms.slice(0, 120).map(t => `- ${t.term}: ${t.explain}`);
    return `\n术语表（这些术语已有既定解释，翻译时保持一致）：\n${lines.join('\n')}`;
  }

  // 术语一致性校验
  wrap('tr:checkTerms', async (_e, paperId: number) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider');
    const root = gh.getRepoRoot();
    const glossary = root ? gh.loadGlossary(root) : [];
    const blocks = db.getBlocks(paperId) as any[];
    const translated = blocks.filter((b: any) => b.zh && b.type === 'para').map((b: any) => ({ pid: b.pid, en: b.en, zh: b.zh }));
    return insights.checkTermConsistency(provider, translated, glossary);
  });

  // ---------- highlights & QA ----------
  wrap('hl:add', (_e, h: { paperId: number; pid: number; textEn: string; note?: string; color?: string }) => db.addHighlight(h));
  wrap('hl:list', (_e, paperId: number) => db.listHighlights(paperId));
  wrap('hl:remove', (_e, id: number) => { db.removeHighlight(id); return true; });

  // 豆包式划词三键：解释 / 搜索 / 翻译（一次性返回，不落库）
  wrap('quick:action', async (_e, arg: { kind: 'explain' | 'search' | 'translate'; text: string; context?: string }) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider，请先到设置页添加');
    const sys: Record<string, string> = {
      explain: `你是 AI/ML 领域的资深研究者。用户在阅读论文时选中了一段文字，请解释其中的关键概念。要求：
1. 先一句话点明它是什么，再展开 2-4 句细节
2. 术语保留英文，配日常类比帮助理解
3. 如有相关公式，用 $...$ 写出并解释符号含义
4. 控制在 200 字以内，直接输出解释，不要前缀`,
      search: `用户在阅读论文《${arg.context ?? ''}》时选中了一段文字，想了解相关背景。请基于你的知识给出：
1. 这个概念/工作的背景与来源（谁提出、解决什么问题）
2. 相关的重要工作或替代方案（2-3 个）
3. 在这篇论文语境下的作用
控制在 200 字以内，术语保留英文。`,
      translate: `你是专业的 AI/ML 论文翻译。把选中的英文翻译成流畅中文：术语保留英文（如 KV cache、prefill），数学公式 $...$ 原样保留。只输出译文。`,
    };
    const acc: string[] = [];
    let quickErr: string | null = null;
    await llm.chatStream(provider, [
      { role: 'system', content: sys[arg.kind] },
      { role: 'user', content: arg.text },
    ], {
      onDelta: d => { acc.push(d); },
      onDone: () => {},
      onError: err => { quickErr = err; },
    });
    if (quickErr) throw new Error(quickErr);
    return acc.join('');
  });


  wrap('qa:ask', async (e, arg: {
    paperId: number; pid: number; question: string; context: string; highlightId?: number;
  }) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider，请先到设置页添加');
    const qaId = db.addQa({ paperId: arg.paperId, highlightId: arg.highlightId, pid: arg.pid, question: arg.question, answer: '', provider: provider.name, model: provider.model });
    const ch = `qa:stream:${qaId}`;
    const ctl = new AbortController();
    activeAbort.add(ctl);
    let acc = '';
    await llm.chatStream(provider, [
      { role: 'system', content: `你是论文阅读助手。用中文回答。
规则：
1. 先直接回答问题，再补充细节
2. 回答依据论文上下文，不编造论文没有的内容
3. 引用依据时标注段落位置，格式【段落 #N】（N 是上下文中标注的段号）
4. 术语保留英文` },
      { role: 'user', content: arg.context },
      { role: 'user', content: `我的问题：${arg.question}` },
    ], {
      onDelta: (d) => { acc += d; e.sender.send(ch, { delta: d }); },
      onDone: (full) => {
        const answer = (full || acc).trim();
        db.getDb().prepare('UPDATE qa_pairs SET answer=? WHERE id=?').run(answer, qaId);
        e.sender.send(ch, { done: true });
      },
      onError: (err) => e.sender.send(ch, { error: err }),
    }, { temperature: 0.4, maxTokens: 4096, signal: ctl.signal }).finally(() => activeAbort.delete(ctl));
    return qaId;
  });

  wrap('qa:list', (_e, paperId: number) => db.listQa(paperId));

  // ---------- flashcards ----------
  wrap('fc:save', (_e, f: { paperId: number; pid: number; front: string; back: string }) => db.addFlashcard(f));
  wrap('fc:updateBack', (_e, id: number, back: string) => { db.updateFlashcardBack(id, back); return true; });
  wrap('fc:listDue', () => db.listDueFlashcards());
  wrap('fc:grade', (_e, id: number, q: number) => { db.gradeFlashcard(id, q); return true; });
  // AI 补闪卡答案
  wrap('fc:genBack', async (_e, f: { paperId: number; pid: number; front: string; id: number }) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider');
    const blocks = db.getBlocks(f.paperId) as any[];
    const idx = blocks.findIndex(b => b.pid === f.pid);
    const ctx = blocks.slice(Math.max(0, idx - 1), idx + 2).map(b => b.en).join('\n').slice(0, 3000);
    const back = await insights.chatOnce(provider, [
      { role: 'system', content: '为这张论文闪卡生成简短答案（中文 2-4 句，术语保留英文）。只输出答案。' },
      { role: 'user', content: `卡片正面（问题/术语）：${f.front}\n\n论文上下文：\n${ctx}` },
    ], 512);
    db.updateFlashcardBack(f.id, back);
    return back;
  });

  // ---------- providers ----------
  wrap('pv:list', () => {
    const rows = db.getDb().prepare('SELECT * FROM providers ORDER BY id').all() as any[];
    return rows.map(r => ({ ...r, api_key: maskKey(llm.decryptSecret(r.api_key)) }));
  });
  wrap('pv:save', (_e, p: { id?: number; name: string; protocol: 'openai' | 'anthropic'; baseUrl: string; apiKey: string; model: string; isDefault: boolean; existingEncrypted?: string }) => {
    const d = db.getDb();
    const keyEnc = p.apiKey ? llm.encryptSecret(p.apiKey) : (p.existingEncrypted ?? '');
    if (!keyEnc) throw new Error('API Key 不能为空');
    if (p.id) {
      d.prepare('UPDATE providers SET name=?, protocol=?, base_url=?, api_key=?, model=?, is_default=? WHERE id=?')
        .run(p.name, p.protocol, p.baseUrl, keyEnc, p.model, p.isDefault ? 1 : 0, p.id);
      if (p.isDefault) d.prepare('UPDATE providers SET is_default=0 WHERE id<>?').run(p.id);
    } else {
      const info = d.prepare('INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES (?,?,?,?,?,?)')
        .run(p.name, p.protocol, p.baseUrl, keyEnc, p.model, p.isDefault ? 1 : 0);
      if (p.isDefault) d.prepare('UPDATE providers SET is_default=0 WHERE id<>?').run(info.lastInsertRowid);
    }
    return true;
  });
  wrap('pv:delete', (_e, id: number) => { db.getDb().prepare('DELETE FROM providers WHERE id=?').run(id); return true; });
  wrap('pv:test', async (_e, p: { protocol: string; baseUrl: string; apiKey: string; model: string }) => {
    return await new Promise<{ ok: boolean; msg: string }>((resolve) => {
      let acc = '';
      llm.chatStream(
        { name: 'test', protocol: p.protocol as any, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model },
        [{ role: 'user', content: '回复「OK」两个字即可' }],
        {
          onDelta: (d) => { acc += d; },
          onDone: () => resolve({ ok: true, msg: `连通成功：${acc.trim().slice(0, 20)}` }),
          onError: (err) => resolve({ ok: false, msg: err }),
        },
        { maxTokens: 16, temperature: 0 }
      );
    });
  });

  function getDefaultProvider(): llm.ProviderConfig | null {
    const d = db.getDb();
    let row = d.prepare('SELECT * FROM providers WHERE is_default=1').get() as any;
    if (!row) row = d.prepare('SELECT * FROM providers ORDER BY id LIMIT 1').get() as any;
    if (!row) return null;
    return {
      id: row.id, name: row.name, protocol: row.protocol,
      baseUrl: row.base_url, apiKey: llm.decryptSecret(row.api_key), model: row.model,
    };
  }

  // ---------- bibtex ----------
  wrap('bibtex:export', async () => {
    const papers = db.listPapers() as any[];
    const entries: string[] = [];
    for (const p of papers) {
      const key = (p.arxiv_id || `paper${p.id}`).replace(/\./g, '_');
      const year = (p.created_at ?? '').slice(0, 4) || new Date().getFullYear().toString();
      entries.push(`@misc{${key},
  title = {${p.title}},
  author = {${p.authors || 'Unknown'}},
  year = {${year}},
  eprint = {${p.arxiv_id}},
  archivePrefix = {arXiv},
  url = {${p.source_url || `https://arxiv.org/abs/${p.arxiv_id}`}}
}`);
    }
    return entries.join('\n\n');
  });

  // 翻译版 PDF 导出：渲染层把译文 HTML 发来，主进程窗口化打印为 PDF（豆包式一键下载）
  wrap('pdf:exportTranslated', async (_e, arg: { paperId: number; html: string; title: string }) => {
    const paper = db.getPaper(arg.paperId) as any;
    const title = arg.title || paper?.title || 'translation';
    // local-figure:// 引用转 base64 内联（离线打印窗口没有自定义协议）
    const figDir = path.join(app.getPath('userData'), 'figures');
    let html = arg.html.replace(/local-figure:\/\/([^"'\s)]+)/g, (_m, rel: string) => {
      try {
        const name = rel.split('/').pop() ?? '';
        const p = path.join(figDir, path.basename(decodeURIComponent(name)));
        const buf = fs.readFileSync(p);
        const ext = (p.match(/\.(png|jpg|jpeg|gif)$/i) || [, 'png'])[1] as string;
        return `data:image/${ext};base64,${buf.toString('base64')}`;
      } catch { return ''; }
    });
    const exportWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    try {
      const fullHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: "Georgia", "Times New Roman", "Noto Serif SC", "SimSun", serif; margin: 0; color: #1a1a1a; }
  .doc { max-width: 760px; margin: 0 auto; padding: 48px 40px; }
  h1.doc-title { font-size: 22px; text-align: center; margin: 0 0 6px; }
  .doc-meta { text-align: center; color: #666; font-size: 12px; margin-bottom: 28px; }
  h2 { font-size: 17px; margin: 24px 0 10px; }
  h3 { font-size: 15px; margin: 18px 0 8px; }
  p { text-indent: 2em; margin: 0 0 10px; line-height: 1.85; text-align: justify; font-size: 14px; }
  figure { margin: 16px auto; text-align: center; page-break-inside: avoid; }
  figure img { max-width: 88%; }
  figcaption { font-size: 12px; color: #555; margin-top: 6px; }
  .page-header { text-align: center; color: #999; font-size: 11px; margin: 20px 0 10px; letter-spacing: 2px; font-family: "Segoe UI", sans-serif; }
  @page { margin: 18mm 16mm; }
  @media print { .doc { padding: 0; } }
</style></head><body><div class="doc">${html}</div></body></html>`;
      await exportWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));
      await new Promise(r => setTimeout(r, 600)); // 等图片加载
      const pdf = await exportWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.6, bottom: 0.6, left: 0.55, right: 0.55 },
      });
      const fileName = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}_中文版.pdf`;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        defaultPath: fileName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { saved: false };
      fs.writeFileSync(filePath, pdf);
      return { saved: true, filePath };
    } finally {
      exportWin.destroy();
    }
  });

  // ---------- github bridge ----------
  wrap('gh:setRepo', (_e, p: string) => {
    const r = gh.setRepoRoot(p);
    if (r.ok) db.setSetting('repo_path', p);
    return r;
  });
  wrap('gh:getRepo', () => {
    const p = gh.getRepoRoot();
    return { path: p, connected: !!p };
  });
  wrap('gh:listFulltext', () => {
    const root = gh.getRepoRoot();
    if (!root) return [];
    return gh.listFulltextFiles(root);
  });
  wrap('gh:importFulltext', (_e, arxivId: string) => {
    const root = gh.getRepoRoot();
    if (!root) throw new Error('未连接仓库');
    const text = gh.readFulltext(root, arxivId);
    if (!text) throw new Error(`.fulltext/${arxivId}.txt 不存在`);
    const parsed = arxiv.parsePlainText(text, arxivId, arxivId);
    const paperId = db.insertPaper({
      arxivId, title: arxivId, authors: '', sourceUrl: `https://arxiv.org/abs/${arxivId}`, importType: 'text',
    });
    db.insertBlocks(paperId, parsed.blocks);
    generateTriageInBackground(paperId).catch(() => {});
    return { paperId, count: parsed.blocks.length };
  });
  wrap('gh:listNotes', () => {
    const root = gh.getRepoRoot();
    return root ? gh.listNotes(root) : [];
  });
  wrap('gh:readNote', (_e, name: string) => {
    const root = gh.getRepoRoot();
    if (!root) return null;
    return gh.readNote(root, name);
  });
  wrap('gh:writeQa', (_e, arg: { arxivId: string; question: string; answer: string }) => {
    const root = gh.getRepoRoot();
    if (!root) throw new Error('未连接仓库');
    const date = new Date().toISOString().slice(0, 10);
    return gh.appendQaToNote(root, arg.arxivId, { question: arg.question, answer: arg.answer, date });
  });
  // 导出阅读摘要到知识库
  wrap('gh:exportSummary', (_e, paperId: number) => {
    const root = gh.getRepoRoot();
    if (!root) throw new Error('未连接仓库');
    const paper = db.getPaper(paperId) as any;
    const sum = db.getSummary(paperId) as any;
    const qa = db.listQa(paperId) as any[];
    const hls = db.listHighlights(paperId) as any[];
    const blocks = db.getBlocks(paperId) as any[];
    const date = new Date().toISOString().slice(0, 10);
    let triage: insights.TriageSummary | null = null;
    try { triage = sum?.summary ? JSON.parse(sum.summary) : null; } catch { triage = null; }
    const md = `---
论文: ${paper.title}
arxiv: ${paper.arxiv_id}
日期: ${date}
状态: Paper Reader 阅读摘要
---

# ${paper.title}

> Paper Reader 自动导出 · ${date}

## 快速评估
${triage ? `- **一句话**：${triage.oneLiner}
- **核心问题**：${triage.problem}
- **方法**：${triage.method}
- **结果**：${triage.results}
- **关联**：${triage.related}` : '（未生成 AI 摘要）'}

## 高亮摘录（${hls.length} 条）
${hls.map(h => `- ${h.text_en}`).join('\n') || '（无）'}

## 问答记录（${qa.length} 条）
${qa.filter(q => q.answer).map(q => `> ❓ **Q:** ${q.question}\n>\n> **A:** ${q.answer.slice(0, 500)}`).join('\n\n') || '（无）'}
`;
    const fname = `paper-reader-${paper.arxiv_id.replace(/\./g, '-')}.md`;
    fs.writeFileSync(path.join(root, 'notes', 'papers', fname), md, 'utf8');
    return { ok: true, note: fname };
  });
}

function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}
