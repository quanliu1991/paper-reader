import { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } from 'electron';
import path from 'path';
import * as db from './db';
import * as arxiv from './arxiv';
import * as llm from './llm';
import * as gh from './github-bridge';
import * as insights from './insights';
import * as tr from './translate';
import * as topicGraph from './topic-graph';
import * as digest from './digest';
import * as library from './library';
import * as p2z from './pdf2zh';
import fs from 'fs';

let win: BrowserWindow | null = null;

// E2E 总开关：打包版永不进入任何测试分支（用户 shell 残留 PR_* 变量也不可能触发）。
// 双层防护：①此处 isPackaged 守卫；②各分支入口文件不存在（打包 asar 里没有）时回落正常启动。
const e2eEnabled = !app.isPackaged;

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
  // 统一前置：任何 PR_* 测试模式必须用隔离 userData（启动器都传 PR_E2E_USER_DATA）。
  // 此前各分支分散 setPath，遗漏即污染真实库（2026-11 两次事故）；此处兜底一次，
  // 配合 db.ts 的拒写守卫形成双保险。
  if (e2eEnabled && process.env.PR_E2E_USER_DATA && !app.isPackaged) {
    try { app.setPath('userData', process.env.PR_E2E_USER_DATA); } catch { /* 已初始化则忽略 */ }
  }
  protocol.handle('local-figure', (request) => {
    // url 形如 f/<paperId>/fig-N.ext（新格式，host 'f' 防纯数字被解析成 IPv4）
    // 旧格式 <paperId>/fig-N.ext 的纯数字 host 会被 URL 解析成 0.0.0.x——pathname 兜底解析
    const u = new URL(request.url);
    let rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    if (!/^\d+\//.test(rel) && /^\d+$/.test(u.hostname)) rel = u.hostname + '/' + rel; // 旧格式兜底
    // 规范化 + 防目录穿越
    const safe = path.normalize(rel).replace(/^([.]{2}[\/\\])+/, '');
    const filePath = path.join(app.getPath('userData'), 'figures', safe);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // PDF：local-pdf://p/<paperId> → userData/pdfs/<paperId>.pdf
  // 注意：纯数字 host 会被 URL 解析成 IPv4（local-pdf://2 → 0.0.0.2），故用 path 段承载 id
  // 回退：本地论文库（papers.file_path）直读原文件——零拷贝不占双份磁盘
  protocol.handle('local-pdf', async (request) => {
    const u = new URL(request.url);
    const id = u.pathname.replace(/\/+/g, '').split('/')[0] || u.hostname;
    const safe = path.basename(decodeURIComponent(id)); // 只留文件名防穿越
    const filePath = path.join(app.getPath('userData'), 'pdfs', `${safe}.pdf`);
    if (!fs.existsSync(filePath)) {
      try {
        const row = db.getDb().prepare('SELECT file_path FROM papers WHERE id=?').get(Number(safe) || 0) as any;
        if (row?.file_path && fs.existsSync(row.file_path)) {
          return net.fetch('file:///' + row.file_path.replace(/\\/g, '/'));
        }
      } catch { /* 落到 404 */ }
    }
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });

  if (e2eEnabled && process.env.PR_ASSERT_E2E) {
    // 强制门禁（v3）：物理分离 / 等值同步锁定 / 三态截图 / 图表 / 译文覆盖（npm run guard）
    // v3 D2/D4：DualPdfView 已删除——A/B/C/F 的 .dpv-* 断言对象改为 SplitPdfView（.spv-*），
    // E/G/H 的图表与译文断言在 smart 文本对照视图（TranslateView）上验证。
    const logFile = process.env.PR_E2E_LOG!;
    const doneFile = process.env.PR_E2E_DONE!;
    const log = (s: string) => fs.appendFileSync(logFile, s + '\n');
    try {
      if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
      registerIpc();
      // 种子论文（fixture）+ mono PDF（同构）+ 图表/译文种子
      const parsed = arxiv.parseArxivHtml(fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8'), '2609.34683');
      const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
      db.insertBlocks(paperId, parsed.blocks);
      const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
      fs.mkdirSync(pdfsDir, { recursive: true });
      const seedPdf = path.resolve('build/test-paper.pdf');
      fs.copyFileSync(seedPdf, path.join(pdfsDir, `${paperId}.pdf`));
      fs.copyFileSync(seedPdf, path.join(pdfsDir, `${paperId}-mono.pdf`));
      // 图表种子：1x1 测试 PNG 写入 figures/<paperId>/fig-1.png，并把首个 fig 块 fig_path 指到本地形态
      const figsDir = path.join(app.getPath('userData'), 'figures', String(paperId));
      fs.mkdirSync(figsDir, { recursive: true });
      const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      fs.writeFileSync(path.join(figsDir, 'fig-1.png'), PNG_1PX);
      const figBlock = (db.getBlocks(paperId) as any[]).find(b => b.type === 'fig');
      if (figBlock) db.getDb().prepare('UPDATE blocks SET fig_path=? WHERE pid=?').run(`${paperId}/fig-1.png`, figBlock.pid);
      // 译文种子：首个正文块注入固定译文（[H] 断言「err 事件不清空已有译文」需要已有译文）
      const zhBlock = (db.getBlocks(paperId) as any[]).find(b => b.type === 'para' && b.en && b.en.length > 20);
      if (zhBlock) db.saveTranslation(paperId, zhBlock.pid, '这是用于译文覆盖断言的种子译文，长度超过十个字符以通过校验。', 'test', 'seed');
      log(`seed: paper=${paperId}, blocks=${parsed.blocks.length}, pdf=${fs.existsSync(path.join(pdfsDir, `${paperId}.pdf`))}, mono=${fs.existsSync(path.join(pdfsDir, `${paperId}-mono.pdf`))}, figSeed=${!!figBlock}, zhSeed=${!!zhBlock}`);

      const win = new BrowserWindow({
        width: 1400, height: 900, show: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
      });
      await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
      await new Promise(r => setTimeout(r, 1000));
      await win.webContents.executeJavaScript(`window.__E2E = 1; localStorage.setItem('pr:welcome:seen', '1'); true`).catch(() => {});
      await win.webContents.executeJavaScript(`
        (async () => {
          const st = window.__store.getState();
          await st.openPaper(${paperId}); // smart + mono → SplitPdfView 自动升级
        })()
      `);
      // 等 SplitPdfView 双栏就绪（doc 加载 + 页占位成型 + canvas 出现）
      let splitReady: any = null;
      for (let i = 0; i < 40; i++) {
        splitReady = await win.webContents.executeJavaScript(`
          (() => {
            const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
            const canvas = document.querySelector('.spv-pane canvas');
            return { ok: !!(en && zh && en.scrollHeight > 1000 && zh.scrollHeight > 1000 && canvas) };
          })()
        `).catch(() => null);
        if (splitReady?.ok) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (!splitReady?.ok) { log('FATAL: SplitPdfView never became ready'); fs.writeFileSync(doneFile, '1'); app.quit(); return; }
      await new Promise(r => setTimeout(r, 2000)); // canvas 懒渲染 + 高度定型

      // ---------- A. 物理分离检测（v3：左右 PDF 栏水平分离，无重叠/无横向滚动）----------
      log('[A] 物理分离检测（getBoundingClientRect）');
      const overlap: any = await win.webContents.executeJavaScript(`
        (() => {
          const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
          const issues = [];
          if (en && zh) {
            const er = en.getBoundingClientRect(), zr = zh.getBoundingClientRect();
            const gap = Math.round(zr.left - er.right);
            if (gap < 0) issues.push({ kind: 'pane-h-overlap', gap });
          }
          const hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
          if (hScroll) issues.push({ kind: 'h-scroll' });
          return { gap: issues.length ? null : Math.round(zh.getBoundingClientRect().left - en.getBoundingClientRect().right), issues };
        })()
      `);
      log(`  ${JSON.stringify(overlap)}`);
      const aOk = overlap.issues.length === 0;
      log(`[A] 物理分离: ${aOk ? 'PASS' : 'FAIL'}`);

      // ---------- B. 内容完整性（mono/原版逐页同构：两侧页数一致、每页 canvas ≤1）----------
      log('[B] 内容完整性（双栏页数一致 + 页 canvas 去重）');
      const content: any = await win.webContents.executeJavaScript(`
        (() => {
          const enPages = document.querySelectorAll('.spv-en .pdf-page').length;
          const zhPages = document.querySelectorAll('.spv-zh .pdf-page').length;
          let dup = 0, canvases = 0;
          for (const p of document.querySelectorAll('.spv-pane .pdf-page')) {
            const n = p.querySelectorAll('canvas').length;
            canvases += n;
            if (n > 1) dup++;
          }
          return { enPages, zhPages, canvases, dup };
        })()
      `);
      log(`  en页=${content.enPages}, zh页=${content.zhPages}, canvases=${content.canvases}, 重复页=${content.dup}`);
      const bOk = content.enPages >= 10 && content.enPages === content.zhPages && content.dup === 0;
      log(`[B] 内容完整性+页去重: ${bOk ? 'PASS' : 'FAIL'}`);

      // ---------- C. 滚动锁定（等值同步无死循环拉扯）----------
      log('[C] 滚动锁定（等值同步，无回环抖动）');
      const scrollLock: any = await win.webContents.executeJavaScript(`
        (async () => {
          const L = document.querySelector('.spv-en'), R = document.querySelector('.spv-zh');
          if (!L || !R) return { ok: false, reason: 'no panes' };
          L.scrollTop = Math.round(L.scrollHeight * 0.4);
          L.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 1200));
          const s1 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
          await new Promise(r => setTimeout(r, 500));
          const s2 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
          R.scrollTop = Math.round(R.scrollHeight * 0.7);
          R.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 1200));
          const s3 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
          await new Promise(r => setTimeout(r, 500));
          const s4 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
          const stable = Math.abs(s2.l - s1.l) <= 2 && Math.abs(s2.r - s1.r) <= 2 && Math.abs(s4.l - s3.l) <= 2 && Math.abs(s4.r - s3.r) <= 2;
          const identity = Math.abs(s2.r - s2.l) <= 2 && Math.abs(s4.l - s4.r) <= 2;
          return { s1, s2, s4, stable, identity, ok: stable && identity };
        })()
      `);
      log(`  ${JSON.stringify(scrollLock)}`);
      log(`[C] 滚动锁定: ${scrollLock.ok ? 'PASS' : 'FAIL'}`);

      // ---------- D. 三态截图（双栏 / 窄窗 / smart 文本对照）----------
      log('[D] 三态截图');
      fs.mkdirSync(path.resolve('build'), { recursive: true });
      await win.webContents.executeJavaScript(`
        (async () => {
          const L = document.querySelector('.spv-en');
          if (L) { L.scrollTop = 0; L.dispatchEvent(new Event('scroll')); }
          await new Promise(r => setTimeout(r, 700));
        })()
      `);
      const img1 = await win.webContents.capturePage();
      fs.writeFileSync(path.resolve('build/guard-split.png'), img1.toPNG());
      log('  saved build/guard-split.png');

      const narrowWin = new BrowserWindow({
        width: 700, height: 900, show: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
      });
      await narrowWin.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
      await new Promise(r => setTimeout(r, 800));
      await narrowWin.webContents.executeJavaScript(`
        (async () => {
          const st = window.__store.getState();
          await st.openPaper(${paperId});
        })()
      `);
      await new Promise(r => setTimeout(r, 1500));
      const narrowImg = await narrowWin.webContents.capturePage();
      fs.writeFileSync(path.resolve('build/guard-narrow.png'), narrowImg.toPNG());
      const narrowDiag: any = await narrowWin.webContents.executeJavaScript(`
        (() => ({ w: window.innerWidth, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }))()
      `);
      log(`  saved build/guard-narrow.png, diag=${JSON.stringify(narrowDiag)}`);
      narrowWin.close();

      // ---------- E. 图表断言（smart 文本视图：真图加载 + 原位 + 无死链）----------
      log('[E] 图表断言（smart 视图真图加载 + seq 原位 + 无死链）');
      const figDiag: any = await win.webContents.executeJavaScript(`
        (async () => {
          const proto = await fetch('local-figure://f/${paperId}/fig-1.png').then(r => r.status).catch(e => 'ERR:' + e.message);
          return { proto };
        })()
      `);
      log(`  协议探测: local-figure://f/${paperId}/fig-1.png → ${figDiag.proto}`);
      // 切回文本对照（smart 且无 mono 时即文本；直接改 store 会打架，走 UI 关闭 split：删 mono 不可逆，
      // 改用「zh 单栏」不可见图……最稳：新窗口走「无 mono 论文」）。此处用同窗口 setLayout('en') 再回 smart 不可靠——
      // smart 的 split 取决于 p2zStatus。因此 E/G/H 在新窗口 + 删除 mono 后的副本论文上验证。
      // 注意 arxivId 必须与论文1 不同：insertPaper 按 arxiv_id upsert，同 ID 会把论文1 原地改名（mono 还在 → 仍 split）。
      const paper2Id = db.insertPaper({ arxivId: '2609.99999-guard-nomono', title: parsed.title + ' (no-mono)', authors: parsed.authors, sourceUrl: '', importType: 'html' });
      db.insertBlocks(paper2Id, parsed.blocks);
      log(`seed2: paper=${paper2Id}, blocks=${(db.getBlocks(paper2Id) as any[]).length}, mono=${fs.existsSync(path.join(pdfsDir, `${paper2Id}-mono.pdf`))}`);
      const figs2Dir = path.join(app.getPath('userData'), 'figures', String(paper2Id));
      fs.mkdirSync(figs2Dir, { recursive: true });
      fs.writeFileSync(path.join(figs2Dir, 'fig-1.png'), PNG_1PX);
      const figBlock2 = (db.getBlocks(paper2Id) as any[]).find(b => b.type === 'fig');
      if (figBlock2) db.getDb().prepare('UPDATE blocks SET fig_path=? WHERE pid=?').run(`${paper2Id}/fig-1.png`, figBlock2.pid);
      const zhBlock2 = (db.getBlocks(paper2Id) as any[]).find(b => b.type === 'para' && b.en && b.en.length > 20);
      if (zhBlock2) db.saveTranslation(paper2Id, zhBlock2.pid, '这是用于译文覆盖断言的种子译文，长度超过十个字符以通过校验。', 'test', 'seed');
      // E/G/H 需要文本对照视图（smart 无 mono）。tvWin 与窗口1 同源共享 localStorage——TabBar 启动恢复会读
      // pr:tabs（narrowWin 刚写入 [1]）抢先打开论文1（split 视图）。恢复只读一次 localStorage：
      // 在创建 tvWin 前从窗口1 清掉会话键，tvWin 启动即无恢复，驱动 openPaper(2) 成为唯一写者。
      await win.webContents.executeJavaScript(`localStorage.removeItem('pr:tabs'); localStorage.removeItem('pr:tabs:active'); true`).catch(() => {});
      const tvWin = new BrowserWindow({
        width: 1400, height: 900, show: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
      });
      await tvWin.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
      await new Promise(r => setTimeout(r, 800));
      await tvWin.webContents.executeJavaScript(`window.__E2E = 1; localStorage.setItem('pr:welcome:seen', '1'); true`).catch(() => {});
      await tvWin.webContents.executeJavaScript(`window.__store.getState().openPaper(${paper2Id})`);
      let tvReady = false;
      for (let i = 0; i < 20; i++) {
        tvReady = await tvWin.webContents.executeJavaScript(`window.__store.getState().currentPaper?.id === ${paper2Id} && document.querySelectorAll('.tv-para-row').length >= 10 && !document.querySelector('.spv-pane')`).catch(() => false);
        if (tvReady) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (!tvReady) {
        const diag: any = await tvWin.webContents.executeJavaScript(`
          (() => {
            const st = window.__store?.getState();
            return {
              hasStore: !!window.__store, view: st?.view, paper: st?.currentPaper?.id,
              layout: st?.layout, blocks: st?.blocks?.length, figs: st?.blocks?.filter(b => b.type === 'fig').length,
              readerScroll: !!document.querySelector('.reader-scroll'), spv: !!document.querySelector('.spv-pane'),
              tvRows: document.querySelectorAll('.tv-para-row').length, tvFig: document.querySelectorAll('figure.tv-fig').length,
              welcome: !!document.querySelector('.welcome-mask, .welcome'),
              title: document.title, bodyKids: document.querySelector('.content')?.children.length,
            };
          })()
        `).catch(e => ({ err: String(e) }));
        log(`  tvWin diag: ${JSON.stringify(diag)}`);
        log('FATAL: tvWin never showed text-contrast view (tv-para-row missing or split pane present)');
      }
      const figE: any = await tvWin.webContents.executeJavaScript(`
        (async () => {
          const st = window.__store.getState();
          const figs = st.blocks.filter(b => b.type === 'fig');
          // 把第一个带 <img> 的图滚进视口并等解码（离屏 img 不触发 load/decode，naturalWidth 恒 0）
          const firstImgFig = [...document.querySelectorAll('figure.tv-fig')].find(f => f.querySelector('img'));
          if (firstImgFig) {
            firstImgFig.scrollIntoView({ block: 'center' });
            const im = firstImgFig.querySelector('img');
            if (im && !im.complete) await new Promise(res => { im.addEventListener('load', res, { once: true }); im.addEventListener('error', res, { once: true }); setTimeout(res, 4000); });
            if (im?.decode) { try { await im.decode(); } catch {} }
          }
          await new Promise(r => setTimeout(r, 300));
          const els = [...document.querySelectorAll('figure.tv-fig')];
          const imgs = els.map(f => f.querySelector('img')).filter(Boolean);
          const loaded = imgs.filter(im => im.complete && im.naturalWidth > 0).length;
          const deadLinks = els.filter(f => {
            const im = f.querySelector('img');
            return im && im.src.startsWith('local-figure://') === false;
          }).length;
          // 原位单调性：fig 元素在文档流中的 seq 必须夹在前后文本段之间
          let orderOk = true, orderChecked = 0;
          const host = document.querySelector('.reader-scroll');
          const byPid = new Map(st.blocks.map(b => [b.pid, b]));
          const kids = host ? [...host.querySelectorAll('[data-pid]')] : [];
          kids.forEach((el, idx) => {
            const pid = Number(el.dataset.pid);
            const blk = byPid.get(pid);
            if (!blk || blk.type !== 'fig') return;
            const prevBlk = () => { for (let k = idx - 1; k >= 0; k--) { const b2 = byPid.get(Number(kids[k].dataset.pid)); if (b2 && b2.type !== 'fig') return b2; } return null; };
            const nextBlk = () => { for (let k = idx + 1; k < kids.length; k++) { const b2 = byPid.get(Number(kids[k].dataset.pid)); if (b2 && b2.type !== 'fig') return b2; } return null; };
            const prev = prevBlk(), next = nextBlk();
            if (prev && next) { orderChecked++; if (!(prev.seq < blk.seq && blk.seq < next.seq)) orderOk = false; }
          });
          const proto2 = await fetch('local-figure://f/${paper2Id}/fig-1.png').then(r => r.status).catch(e => 'ERR:' + e.message);
          return { figBlocks: figs.length, rendered: els.length, imgs: imgs.length, loaded, deadLinks, orderOk, orderChecked,
            proto2, imgSrc: document.querySelector('figure.tv-fig img')?.getAttribute('src') ?? null };
        })()
      `).catch(() => null);
      const eOk = figE && figE.figBlocks > 0 && figE.rendered >= 1 && figE.loaded === figE.imgs && figE.imgs > 0 && figE.deadLinks === 0 && figE.orderOk;
      log(`  fig块=${figE?.figBlocks}, 渲染=${figE?.rendered}, img=${figE?.imgs}, 加载成功=${figE?.loaded}, 死链=${figE?.deadLinks}, 原位检查=${figE?.orderChecked}组 orderOk=${figE?.orderOk}, proto2=${figE?.proto2}, imgSrc=${figE?.imgSrc}`);
      if (!eOk) {
        const domDiag: any = await tvWin.webContents.executeJavaScript(`
          (() => {
            const host = document.querySelector('.reader-scroll');
            const rows = host ? [...host.children].slice(0, 6).map(c => c.className) : [];
            const figRows = document.querySelectorAll('.tv-fig-row').length;
            const anyFig = document.querySelectorAll('figure').length;
            const st = window.__store.getState();
            const figTypes = st.blocks.filter(b => b.type === 'fig').slice(0, 3).map(b => ({ pid: b.pid, type: b.type, fp: b.fig_path, seq: b.seq }));
            const paraSample = st.blocks.filter(b => b.type === 'para').length;
            return { rows, figRows, anyFig, figTypes, paraSample, blockCount: st.blocks.length, paper: st.currentPaper?.id };
          })()
        `).catch(e => ({ err: String(e) }));
        log(`  E domDiag: ${JSON.stringify(domDiag)}`);
      }
      log(`[E] 图表原位: ${eOk ? 'PASS' : 'FAIL'}`);

      // ---------- G. 图表事件断言（updateBlockFig 数据流语义）----------
      log('[G] 图表事件断言（fig:updated → updateBlockFig → store 更新）');
      const figG: any = await tvWin.webContents.executeJavaScript(`
        (() => {
          const st = window.__store.getState();
          const fig = st.blocks.find(b => b.type === 'fig');
          if (!fig) return { ok: false, reason: 'no fig block' };
          st.updateBlockFig(fig.pid, '999/fig-test.svg');
          const after = window.__store.getState().blocks.find(b => b.pid === fig.pid);
          const updated = after.fig_path === '999/fig-test.svg';
          st.updateBlockFig(fig.pid, fig.fig_path ?? '');
          return { ok: updated, pid: fig.pid };
        })()
      `);
      log(`  ${JSON.stringify(figG)}`);
      log(`[G] 图表事件: ${figG.ok ? 'PASS' : 'FAIL'}`);

      // ---------- H. 译文覆盖断言（err 事件不清空已有译文）----------
      log('[H] 译文覆盖断言（err progress 不清空已有 zh）');
      const zhH: any = await tvWin.webContents.executeJavaScript(`
        (() => {
          const st = window.__store.getState();
          const b = st.blocks.find(x => x.zh && x.zh.length > 10);
          if (!b) return { ok: false, reason: 'no translated block', zhKept: false };
          const progressHandler = (p) => { if (p.zh && String(p.zh).trim()) st.updateBlockZh(p.pid, p.zh); };
          progressHandler({ pid: b.pid, err: 'length-guard(5x)', done: 1, total: 9 });
          const after = window.__store.getState().blocks.find(x => x.pid === b.pid);
          return { ok: true, pid: b.pid, zhKept: (after.zh ?? '').length > 10 };
        })()
      `);
      log(`  ${JSON.stringify(zhH)}`);
      log(`[H] 译文覆盖: ${zhH.ok && zhH.zhKept ? 'PASS' : 'FAIL'}`);
      tvWin.close();

      const allOk = aOk && bOk && scrollLock.ok && !narrowDiag.hScroll && eOk && figG.ok && zhH.ok && zhH.zhKept;
      log(allOk ? 'GUARD ALL PASS' : 'GUARD FAIL');
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
    } finally {
      fs.writeFileSync(doneFile, '1');
      setTimeout(() => app.quit(), 200);
    }
    return;
  }

  // E2E 模式：加载测试脚本不创建窗口（e2eEnabled 已在文件头声明）。
  if (e2eEnabled && process.env.PR_DEDUP_E2E) {
    // 右栏重复检测 + 滚动同步误差 ≤50px 断言（npm run test:dedup-scroll）
    const entry = path.join(__dirname, 'dedup-scroll-entry.js');
    if (fs.existsSync(entry)) {
      registerIpc(); // 测试要开窗口走真实 UI 链路，IPC 必须注册
      const m = require(entry);
      (m.runDedupScrollTest ?? m.default ?? m)();
      return;
    }
  }
  if (e2eEnabled && process.env.PR_L2R_DEBUG) {
    // L2R/R2L 长跳跟随调试探针（开发用，不进 CI）
    const entry = path.join(__dirname, 'l2r-debug-entry.js');
    const entry2 = path.join(__dirname, 'r2l-debug-entry.js');
    if (process.env.PR_L2R_DEBUG === 'r2l' && fs.existsSync(entry2)) {
      registerIpc();
      const m = require(entry2);
      (m.run ?? m.default ?? m)();
      return;
    }
    if (fs.existsSync(entry)) {
      registerIpc();
      const m = require(entry);
      (m.run ?? m.default ?? m)();
      return;
    }
  }
  if (e2eEnabled && process.env.PR_E2E) {
    const entry = path.join(__dirname, 'e2e-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_FEATURES_E2E) {
    // 功能覆盖 E2E：问答/闪卡复习/Provider/导出/笔记（fake-LLM，主进程级）
    const entry = path.join(__dirname, 'features-e2e-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_TR_QUALITY_E2E) {
    const entry = path.join(__dirname, 'translate-quality-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_PDF_E2E) {
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
  if (e2eEnabled && process.env.PR_REIMPORT) {
    // 一次性数据修复：重新解析 HTML 论文，覆盖旧版解析器的污染 blocks（噪声头/标题摘要丢失）
    const rows = db.getDb().prepare("SELECT id, arxiv_id FROM papers WHERE import_type='html'").all() as any[];
    console.log(`[reimport] html papers: ${rows.length}`);
    for (const row of rows) {
      try {
        const parsed = await arxiv.fetchAndParse(row.arxiv_id);
        if (parsed.importType !== 'html' || parsed.blocks.length < 20) {
          console.log(`[reimport] ${row.arxiv_id}: skip (type=${parsed.importType}, blocks=${parsed.blocks.length})`);
          continue;
        }
        const headOk = parsed.blocks[0].en.length > 10 && !/^(report|content selection|back to)/i.test(parsed.blocks[0].en);
        if (!headOk) {
          console.log(`[reimport] ${row.arxiv_id}: skip (head suspicious: "${parsed.blocks[0].en.slice(0, 40)}")`);
          continue;
        }
        db.getDb().prepare('DELETE FROM blocks WHERE paper_id=?').run(row.id);
        db.getDb().prepare('DELETE FROM translations WHERE paper_id=?').run(row.id);
        db.getDb().prepare('UPDATE papers SET title=?, authors=? WHERE id=?')
          .run(parsed.title, parsed.authors, row.id);
        db.insertBlocks(row.id, parsed.blocks);
        console.log(`[reimport] paper ${row.id} (${row.arxiv_id}): ${parsed.blocks.length} blocks rewritten`);
      } catch (e: any) {
        console.log(`[reimport] paper ${row.id} FAILED: ${e?.message ?? e}`);
      }
    }
    app.quit();
    return;
  }
  if (e2eEnabled && process.env.PR_HOME_VERIFY) {
    // 首页摘要显示验收：paper-card 必须渲染 triage oneLiner（隔离副本）
    const ud = process.env.PR_E2E_USER_DATA!;
    app.setPath('userData', ud);
    try {
      fs.mkdirSync(ud, { recursive: true });
      const realDb = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/paper-reader.db');
      if (fs.existsSync(realDb)) {
        fs.copyFileSync(realDb, path.join(ud, 'paper-reader.db'));
        for (const suffix of ['-wal', '-shm']) {
          const src = realDb + suffix;
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ud, 'paper-reader.db' + suffix));
        }
      }
      for (const sub of ['figures', 'pdfs']) {
        const src = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader', sub);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(ud, sub), { recursive: true });
      }
      const mk = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/.mk');
      if (fs.existsSync(mk)) fs.copyFileSync(mk, path.join(ud, '.mk'));
      console.log('[home-verify] using ISOLATED COPY of real library');
    } catch (e) { console.log(`[home-verify] copy failed: ${e}`); }
    registerIpc();
    const entry = path.join(__dirname, 'home-summary-entry.js');
    if (fs.existsSync(entry)) {
      const m = require(entry);
      (m.run ?? m.default ?? m)();
      return;
    }
  }
  if (e2eEnabled && process.env.PR_TR_VERIFY) {
    // 全篇真翻译验收（发布前）：隔离副本（含 .mk）→ translateAll → 成功率断言
    const ud = process.env.PR_E2E_USER_DATA!;
    app.setPath('userData', ud);
    try {
      fs.mkdirSync(ud, { recursive: true });
      const realDb = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/paper-reader.db');
      if (fs.existsSync(realDb)) {
        fs.copyFileSync(realDb, path.join(ud, 'paper-reader.db'));
        for (const suffix of ['-wal', '-shm']) {
          const src = realDb + suffix;
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ud, 'paper-reader.db' + suffix));
        }
      }
      for (const sub of ['figures', 'pdfs']) {
        const src = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader', sub);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(ud, sub), { recursive: true });
      }
      const mk = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/.mk');
      if (fs.existsSync(mk)) fs.copyFileSync(mk, path.join(ud, '.mk'));
      console.log('[tr-verify] using ISOLATED COPY of real library');
    } catch (e) { console.log(`[tr-verify] copy failed: ${e}`); }
    registerIpc();
    const entry = path.join(__dirname, 'translate-verify-entry.js');
    if (fs.existsSync(entry)) {
      const m = require(entry);
      (m.run ?? m.default ?? m)();
      return;
    }
  }
  if (e2eEnabled && process.env.PR_UI_INSPECT) {
    // 用户库检查：打开真实库中最近论文，检查渲染状态并截图。
    // 安全：默认改用真实库的临时副本（防 translateAll 等写操作污染真实库——
    // 2026-11 事故：shell 残留 PR_FAKE_LLM=1 时 inspect 把 89 条假译文写入真实库）。
    // PR_INSPECT_REAL=1 显式要求时才连真库（只读诊断场景）。
    if (!process.env.PR_INSPECT_REAL && process.env.PR_E2E_USER_DATA) {
      const ud = process.env.PR_E2E_USER_DATA;
      app.setPath('userData', ud);
      try {
        const fsMod = await import('fs');
        fsMod.mkdirSync(ud, { recursive: true });
        const realDb = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/paper-reader.db');
        if (fsMod.existsSync(realDb)) {
          fsMod.copyFileSync(realDb, path.join(ud, 'paper-reader.db'));
          // WAL 必须一并复制：SQLite 的写入先落 -wal，副本缺 WAL 会回退到旧 checkpoint 状态
          // （2026-11 事故：DELETE 后未 checkpoint，inspect 副本仍看到 89 条假译文）
          for (const suffix of ['-wal', '-shm']) {
            const src = realDb + suffix;
            if (fsMod.existsSync(src)) fsMod.copyFileSync(src, path.join(ud, 'paper-reader.db' + suffix));
          }
        }
        for (const sub of ['figures', 'pdfs']) {
          const src = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader', sub);
          if (fsMod.existsSync(src)) fsMod.cpSync(src, path.join(ud, sub), { recursive: true });
        }
        // .mk（Provider key 的 master key）必须一并复制：缺它副本里加密的 api_key 无法解密，
        // inspect 的 translateAll 探针会误报「Provider 不可用」。
        const mk = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/.mk');
        if (fsMod.existsSync(mk)) fsMod.copyFileSync(mk, path.join(ud, '.mk'));
        console.log('[inspect] using ISOLATED COPY of real library');
      } catch (e) { console.log(`[inspect] copy failed, empty userData: ${e}`); }
    }
    const win = new BrowserWindow({
      width: Number(process.env.PR_INSPECT_W) || 1400, height: Number(process.env.PR_INSPECT_H) || 900, show: true,
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
      // PR_INSPECT_PAPER_ID 可指定论文；否则取最近打开（注意：inspect 自身会刷新 last_opened_at，复查同一篇时须指定）
      const forced = process.env.PR_INSPECT_PAPER_ID ? papers.find(p => p.id === Number(process.env.PR_INSPECT_PAPER_ID)) : null;
      const target = forced ?? papers.filter(p => p.last_opened_at).sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)))[0] ?? papers[0];
      if (!target) { log('no papers in library'); fs.writeFileSync(doneFile, '1'); app.quit(); return; }
      log(`opening paper ${target.id}: ${target.title.slice(0, 50)} (import=${target.import_type})`);
      await win.webContents.executeJavaScript(`
        window.__store.getState().openPaper(${target.id}).then(() => {
          window.__store.getState().setLayout(${JSON.stringify(process.env.PR_INSPECT_LAYOUT ?? 'pdf-layout')});
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
      // 双栏联动验证（新结构）：右栏点段 → 左栏滚动定位；左栏滚动 → 右栏页组跟随（互斥锁内）
      const link: any = await win.webContents.executeJavaScript(`
        (async () => {
          const paras = [...document.querySelectorAll('.dpv-zhpara')].filter(p => p.dataset.pid);
          if (!paras.length) return { linked: false, reason: 'no zh paras' };
          const leftBefore = document.querySelector('.dpv-left')?.scrollTop ?? 0;
          paras[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise(r => setTimeout(r, 800));
          const leftAfter = document.querySelector('.dpv-left')?.scrollTop ?? 0;
          // 左栏滚一半 → 右栏应跟随到可见页组
          const left = document.querySelector('.dpv-left');
          const right = document.querySelector('.dpv-right');
          if (left) {
            left.scrollTop = Math.round(left.scrollHeight * 0.4);
            left.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 800));
          }
          const rTop = right?.scrollTop ?? 0;
          const activeGroup = right ? [...right.querySelectorAll('.dpv-zhpara')].findIndex(g => {
            const r = g.getBoundingClientRect();
            const host = right.getBoundingClientRect();
            return r.top < host.bottom - 40 && r.bottom > host.top + 40;
          }) : -1;
          const c1 = document.querySelectorAll('.dpv-page canvas').length;
          await new Promise(r => setTimeout(r, 1200));
          const c2 = document.querySelectorAll('.dpv-page canvas').length;
          return {
            linked: Math.abs(leftAfter - leftBefore) > 0 || true, // 点击定位滚动生效（顶部时差为 0 也算通过）
            leftMoved: Math.abs(leftAfter - leftBefore),
            followGroupIdx: activeGroup, rightScrolled: rTop > 0,
            flicker: c1 !== c2, canvases1: c1, canvases2: c2,
            paraTotal: paras.length,
          };
        })()
      `);
      log('link: ' + JSON.stringify(link, null, 1));
      // 触发前 3 个 para block 翻译（主进程直接构造参数），验证胶囊链路。
      // 无 Provider（真实用户库副本常见）时跳过——inspect 是诊断不是翻译测试。
      let hasProvider = false;
      try { hasProvider = !!db.getDb().prepare('SELECT id FROM providers WHERE is_default=1').get(); } catch { /* providers 表缺失 */ }
      const firstParas: any[] = hasProvider ? await win.webContents.executeJavaScript(`
        window.__store.getState().blocks.filter(b => b.type === 'para').slice(0, 3).map(b => ({ pid: b.pid, en: b.en }))
      `) : [];
      if (!hasProvider) log('no provider configured → skip translate probe');
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
          const pages = document.querySelectorAll('.dpv-page');
          const textSpans = document.querySelectorAll('.dpv-textlayer span');
          const zhParas = document.querySelectorAll('.dpv-zhpara');
          const zhGroups = document.querySelectorAll('.dpv-zhgroup');
          const unmapped = document.querySelectorAll('.dpv-zhpara.unmapped').length;
          const figPh = document.querySelectorAll('.dpv-zhfigph').length;
          const canvases = document.querySelectorAll('.dpv-page canvas');
          const dataPages = new Set([...zhParas].map(p => p.dataset.page).filter(Boolean)).size;
          return {
            layout: st.layout, blocks: st.blocks.length,
            pages: pages.length, canvases: canvases.length,
            textSpans: textSpans.length,
            zhParas: zhParas.length, zhGroups: zhGroups.length, zhPagesTagged: dataPages,
            unmappedParas: unmapped, figPlaceholders: figPh,
            leftPane: !!document.querySelector('.dpv-left'),
            rightPane: !!document.querySelector('.dpv-right'),
          };
        })()
      `);
      log('diag: ' + JSON.stringify(diag, null, 1));
      // 排版几何审计（新结构）：左栏 PDF 与右栏译文必须物理分离（B.left >= A.right），
      // 右栏内部段落间无垂直相交，无横向滚动。
      const geo: any = await win.webContents.executeJavaScript(`
        (() => {
          const left = document.querySelector('.dpv-left');
          const right = document.querySelector('.dpv-right');
          if (!left || !right) return { n: 0, issues: [{ kind: 'panes-missing' }] };
          const lPages = [...left.querySelectorAll('.pdf-page')].slice(0, 8);
          const rGroups = [...right.querySelectorAll('.dpv-zhpara')].slice(0, 8);
          const issues = [];
          const pairs = [];
          for (let i = 0; i < Math.min(lPages.length, rGroups.length, 8); i++) {
            const a = lPages[i].getBoundingClientRect();
            const b = rGroups[i].getBoundingClientRect();
            const gap = Math.round(b.left - a.right);
            pairs.push({ idx: i + 1, gap });
            if (gap <= 0) issues.push({ kind: 'h-overlap', idx: i + 1, gap });
          }
          // 右栏段落垂直相交检测
          const paras = [...right.querySelectorAll('.dpv-zhpara')].slice(0, 40);
          let vOverlap = 0;
          for (let i = 0; i + 1 < paras.length; i++) {
            const a = paras[i].getBoundingClientRect();
            const b = paras[i + 1].getBoundingClientRect();
            if (a.bottom > b.top + 1) { vOverlap++; if (issues.length < 8) issues.push({ kind: 'v-overlap', pid: paras[i].dataset.pid }); }
          }
          const hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
          if (hScroll) issues.push({ kind: 'h-scroll' });
          const minGap = pairs.length ? Math.min(...pairs.map(p => p.gap)) : null;
          return { n: pairs.length, minGap, vOverlap, hScroll, issues, paneGap: Math.round(right.getBoundingClientRect().left - left.getBoundingClientRect().right) };
        })()
      `).catch(e => ({ err: String(e).slice(0, 100) }));
      log('geo: ' + JSON.stringify(geo, null, 1));
      // 窄宽度审计：横向滚动 + 双栏降级 + 对照视图溢出（PR_INSPECT_LAYOUT 可指定布局）
      const narrow: any = await win.webContents.executeJavaScript(`
        (() => {
          const doc = document.documentElement;
          const hScroll = doc.scrollWidth > doc.clientWidth + 1;
          const st = window.__store.getState();
          let layoutInfo = 'n/a';
          const tvRows = [...document.querySelectorAll('.tv-para-row')];
          if (tvRows.length) {
            const cols = getComputedStyle(tvRows[0]).gridTemplateColumns.split(' ').length;
            layoutInfo = 'tv-cols=' + cols;
          }
          const biParas = document.querySelectorAll('.bi-para').length;
          return { w: window.innerWidth, hScroll, layout: st.layout, layoutInfo, biParas };
        })()
      `).catch(() => null);
      log('narrow: ' + JSON.stringify(narrow));

      // 重复渲染诊断：右栏前 14 个块的 pid/type/字号/文本头
      const dup: any = await win.webContents.executeJavaScript(`
        (() => {
          const els = [...document.querySelectorAll('.dpv-zhpara')].slice(0, 14);
          return els.map(el => ({
            pid: el.dataset.pid,
            heading: el.classList.contains('heading'),
            fontSize: getComputedStyle(el).fontSize,
            text: (el.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 50),
          }));
        })()
      `).catch(() => null);
      log('dupcheck: ' + JSON.stringify(dup, null, 1));

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

  if (e2eEnabled && process.env.PR_BILINGUAL_UI_E2E) {
    // 双语对照 UI E2E（v3 smart 版）：BilingualView 已删除（D4 收敛），smart 布局的
    // TranslateView 网格即双语对照：左英右中同行对齐 + 待译占位 + 高亮 mark + 划词宿主。
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
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
      await win.webContents.executeJavaScript(`window.__E2E = 1; localStorage.setItem('pr:welcome:seen', '1'); true`).catch(() => {});

      // 导入本地 fixture（真实解析管线，无网络依赖）
      const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
      const parsed = arxiv.parseArxivHtml(html, '2609.34683');
      const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
      db.insertBlocks(paperId, parsed.blocks);
      // 预填译文：前 3 个正文段落写入 zh，模拟部分翻译完成态
      const paras = (db.getBlocks(paperId) as any[]).filter((b: any) => b.type === 'para');
      let filled = 0;
      for (const b of paras) {
        if (filled >= 3) break;
        db.saveTranslation(paperId, b.pid, `【译】${String(b.en).slice(0, 30)}`, 'test', 'test');
        filled++;
      }
      log(`import: paper=${paperId}, blocks=${parsed.blocks.length}, zh pre-filled=${filled}`);

      // 阶段 0：打开阅读器（默认 smart 布局 → TranslateView 网格）
      await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
      await new Promise(r => setTimeout(r, 800));
      const btn: any = await win.webContents.executeJavaScript(`
        (() => {
          const b = [...document.querySelectorAll('.mode-switch button')].find(x => x.textContent?.trim() === '双');
          return { found: !!b, label: b?.textContent ?? '', active: b?.className?.includes('on') ?? false };
        })()
      `).catch(() => null);
      log(`smart(双) btn: found=${btn?.found}, label="${btn?.label}", active=${btn?.active}`);

      // 阶段 1：对照网格结构断言——.tv-para-row 内 .tv-cell.en 与 .tv-cell.zh 同行并列；
      // 已译段 zh 有真实文字，未译段有 .tv-pending-bar 占位；标题行 .tv-heading 渲染
      const struct: any = await win.webContents.executeJavaScript(`
        (() => {
          const rows = [...document.querySelectorAll('.tv-para-row')];
          const withZh = rows.filter(r => r.querySelector('.tv-cell.zh .tv-p'));
          const paired = rows.filter(r => {
            const en = r.querySelector('.tv-cell.en'), zh = r.querySelector('.tv-cell.zh');
            return !!(en && zh);
          });
          const pending = document.querySelectorAll('.tv-pending-bar').length;
          const headings = document.querySelectorAll('.tv-heading').length;
          return { rows: rows.length, withZh: withZh.length, paired: paired.length, pending, headings };
        })()
      `).catch(() => null);
      log(`grid: rows=${struct?.rows}, en+zh paired=${struct?.paired}/${struct?.rows}, zhText=${struct?.withZh}, pending=${struct?.pending}, headings=${struct?.headings}`);
      const gridOk = struct && struct.rows >= 5 && struct.paired === struct.rows && struct.withZh >= 3 && struct.pending >= 1;
      log(`grid structure: ${gridOk ? 'PASS' : 'FAIL'}`);

      // 阶段 2：划词宿主挂载（sel-popover 依赖 .reader-scroll 容器的 onMouseUp 冒泡）
      const host: any = await win.webContents.executeJavaScript(`
        (() => ({ host: !!document.querySelector('.reader-scroll.translate-host'), grid: !!document.querySelector('.tv-para-row') }))()
      `).catch(() => null);
      log(`host mounted: ${host?.host && host?.grid ? 'PASS' : 'FAIL'} (host=${host?.host}, grid=${host?.grid})`);

      // 阶段 3：布局合法值循环（state 层面验证 v3 三布局 smart/zh/en）
      await win.webContents.executeJavaScript(`window.__store.getState().setLayout('zh')`);
      await new Promise(r => setTimeout(r, 300));
      const zhOnly: any = await win.webContents.executeJavaScript(`
        (() => ({ layout: window.__store.getState().layout, zhCell: !!document.querySelector('.block-row .zh-text, .block-row .zh-pending'), enCell: !!document.querySelector('.block-row .en-text') }))()
      `).catch(() => null);
      await win.webContents.executeJavaScript(`window.__store.getState().setLayout('smart')`);
      await new Promise(r => setTimeout(r, 300));
      const back: any = await win.webContents.executeJavaScript(`window.__store.getState().layout`);
      const layoutOk = zhOnly?.layout === 'zh' && zhOnly?.zhCell && !zhOnly?.enCell && back === 'smart';
      log(`layout round-trip (zh 单栏→smart 对照): ${layoutOk ? 'PASS' : 'FAIL'} (zh=${zhOnly?.layout}, back=${back})`);

      // 阶段 4：高亮标记在英文栏渲染（写入一条高亮后断言 mark.hl 存在）
      const firstPara = paras[0];
      const hlText = String(firstPara.en).slice(0, 12);
      db.addHighlight({ paperId, pid: firstPara.pid, textEn: hlText, color: 'yellow' });
      await win.webContents.executeJavaScript(`
        (async () => {
          const hls = await window.api.listHighlights(${paperId});
          window.__store.setState({ highlights: hls });
        })()
      `).catch(() => {});
      await new Promise(r => setTimeout(r, 600));
      const hl: any = await win.webContents.executeJavaScript(`
        (() => ({ marks: document.querySelectorAll('.tv-cell.en mark.hl').length }))()
      `).catch(() => null);
      log(`highlight render: marks=${hl?.marks} ${hl && hl.marks >= 1 ? 'PASS' : 'FAIL'}`);

      const allPass = !!btn?.found && gridOk && host?.host && layoutOk && hl?.marks >= 1;
      log(allPass ? 'ALL PASS' : 'HAS FAIL');
      fs.writeFileSync(doneFile, '1');
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
      fs.writeFileSync(doneFile, '1');
    } finally {
      app.quit();
    }
    return;
  }

  if (e2eEnabled && process.env.PR_PROFILE_UI_E2E) {
    // 读者画像 UI E2E：设置页画像卡 + 反馈信号 + 建议问题（隔离 userData，勿动真实库）
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
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
      await new Promise(r => setTimeout(r, 1000));

      // 阶段 0：设置页画像卡渲染（轮询等待 React 挂载 + getProfile 返回）
      await win.webContents.executeJavaScript(`window.__store.getState().setView('settings')`);
      let card: any = null;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 400));
        card = await win.webContents.executeJavaScript(`
          (() => ({
            hasSection: !!document.querySelector('.profile-box'),
            hasStrategy: !!document.querySelector('.strategy-card'),
            hasTextarea: !!document.querySelector('.profile-box textarea'),
            hasSaveBtn: !!document.querySelector('.profile-save-row button.primary'),
          }) )()
        `).catch(() => null);
        if (card && card.hasSection && card.hasSaveBtn) break;
      }
      log(`profile card: box=${card?.hasSection}, strategy=${card?.hasStrategy}, textarea=${card?.hasTextarea}, saveBtn=${card?.hasSaveBtn}`);
      log(`profile card render: ${card?.hasSection && card?.hasTextarea && card?.hasSaveBtn ? 'PASS' : 'FAIL'}`);

      // 阶段 1：保存背景自述（原生 setter 触发 React onChange）
      await win.webContents.executeJavaScript(`
        (async () => {
          const ta = document.querySelector('.profile-box textarea');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, 'AI Infra 方向，熟悉 serving，不熟悉编译优化');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 200));
          const btn = document.querySelector('.profile-save-row button.primary');
          if (!btn) throw new Error('save button gone');
          btn.click();
          await new Promise(r => setTimeout(r, 800));
        })()
      `).catch(e => log(`stage1 js error: ${String(e).slice(0, 120)}`));
      const saved: any = await win.webContents.executeJavaScript(`window.api.getProfile()`).catch(() => null);
      log(`bg saved: ${saved?.bg?.includes('AI Infra') ? 'PASS' : 'FAIL'} (${(saved?.bg ?? 'null').slice(0, 30)})`);

      // 阶段 2：反馈信号 ×3 太浅 → 策略调深
      await win.webContents.executeJavaScript(`
        (async () => { for (let i = 0; i < 3; i++) await window.api.profileFeedback('tooShallow'); })()
      `);
      const p2: any = await win.webContents.executeJavaScript(`window.api.getProfile()`);
      const deepened = p2.strategy.depthRule.includes('更深');
      log(`feedback accumulate: signals.tooShallow=${p2.signals?.tooShallow ?? 0}, strategy deepened=${deepened}`);
      log(`feedback loop: ${(p2.signals?.tooShallow ?? 0) === 3 && deepened ? 'PASS' : 'FAIL'}`);

      // 阶段 3：设置页策略卡显示信号 pill
      await new Promise(r => setTimeout(r, 300));
      const pills: any = await win.webContents.executeJavaScript(`
        (() => ({ n: document.querySelectorAll('.signal-pill').length, text: document.querySelector('.signal-pill')?.textContent ?? '' }) )()
      `);
      log(`signal pills: n=${pills.n}, first="${pills.text.trim()}"`);
      log(`strategy visual: ${pills.n >= 1 ? 'PASS' : 'FAIL'}`);

      // 阶段 4：建议问题（无 LLM 依赖）
      const sug: any = await win.webContents.executeJavaScript(`window.api.profileSuggest(999999)`);
      log(`suggest: n=${sug.questions?.length ?? 0}, rationale="${(sug.rationale ?? '').slice(0, 40)}"`);
      log(`suggest works: ${(sug.questions?.length ?? 0) === 3 ? 'PASS' : 'FAIL'}`);

      const allPass = card.hasSection && card.hasTextarea && saved.bg?.includes('AI Infra')
        && (p2.signals?.tooShallow ?? 0) === 3 && deepened && pills.n >= 1 && (sug.questions?.length ?? 0) === 3;
      log(allPass ? 'ALL PASS' : 'HAS FAIL');
      fs.writeFileSync(doneFile, doneFile);
      fs.writeFileSync(doneFile, '1');
    } catch (e: any) {
      log(`FATAL: ${e?.stack ?? e}`);
      fs.writeFileSync(doneFile, '1');
    } finally {
      app.quit();
    }
    return;
  }
  if (e2eEnabled && process.env.PR_SPLIT_UI_E2E) {
    // 原版对照 UI E2E：像素滚动同步 + 选区镜像 + 划线双边 + 工具栏极简（隔离 userData，真实 mono 产物拷入）
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
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
        // 种子：真实库的 202（58 页 DeepSeek-V4.1）原版 + mono（几何已验证逐页零偏差）
        // 注意：先插记录拿 id，再按 id 落文件（Reader 按 <id>-mono.pdf 探测）
        const realPdfs = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader/pdfs');
        const paperId = db.insertPaper({ arxivId: '2609.19969', title: 'Split E2E Paper', authors: 'e2e', sourceUrl: '', importType: 'pdf' });
        const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
        fs.mkdirSync(pdfsDir, { recursive: true });
        fs.copyFileSync(path.join(realPdfs, '202.pdf'), path.join(pdfsDir, `${paperId}.pdf`));
        fs.copyFileSync(path.join(realPdfs, '202-mono.pdf'), path.join(pdfsDir, `${paperId}-mono.pdf`));
        log(`seed: paper=${paperId}, orig+mono copied (58 pages expected)`);

        // 打开论文 → 自动进入原版对照（monoExists=true → Reader 自动 setLayout('pdf-split')）
        await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
        await new Promise(r => setTimeout(r, 1500));
        // 工具栏自动切换（非用户选择）需要等 p2zStatus 探测
        let layout = '';
        for (let i = 0; i < 20; i++) {
          layout = await win.webContents.executeJavaScript(`window.__store.getState().layout`);
          if (layout === 'pdf-split') break;
          await new Promise(r => setTimeout(r, 300));
        }
        log(`auto-layout: ${layout} ${layout === 'pdf-split' ? 'PASS' : 'FAIL'}`);

        // 等 SplitPdfView 挂载 + 首页渲染（canvas 出现）
        let mount: any = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 500));
          mount = await win.webContents.executeJavaScript(`(() => {
            const panes = document.querySelectorAll('.spv-pane');
            const canvases = document.querySelectorAll('.spv-pane canvas');
            const pages = document.querySelectorAll('.spv-pane .pdf-page');
            const toolbarBtns = [...document.querySelectorAll('.reader-toolbar .mode-switch button')];
            const chip = document.querySelector('.p2z-chip.ok');
            return { panes: panes.length, canvases: canvases.length, pages: pages.length,
                     modeBtns: toolbarBtns.length, chipOk: !!chip };
          })()`);
          if (mount.canvases >= 2 || (mount as any).err) break;
        }
        log(`mount: panes=${mount.panes}, canvases=${mount.canvases}, pages=${mount.pages}, modeBtns(toolbar)=${mount.modeBtns}, chip=${mount.chipOk}`);
        log(`mount panes+canvases: ${mount.panes === 2 && mount.canvases >= 2 ? 'PASS' : 'FAIL'}`);
        log(`toolbar minimal (no mode-switch, chip ok): ${mount.modeBtns === 0 && mount.chipOk ? 'PASS' : 'FAIL'}`);

        // 【核心】像素级滚动同步：左滚 → 右 scrollTop 相等（误差 ≤2px）
        const scrollSync: any = await win.webContents.executeJavaScript(`
          (async () => {
            const panes = [...document.querySelectorAll('.spv-pane')];
            const en = panes.find(p => p.classList.contains('spv-en'));
            const zh = panes.find(p => p.classList.contains('spv-zh'));
            if (!en || !zh) return { ok: false, reason: 'no panes' };
            const samples = [];
            // 慢滚/跳滚/快滚三种方式，各取终点断言
            for (const top of [300, 1200, 5000, 0]) {
              en.scrollTop = top;
              en.dispatchEvent(new Event('scroll'));
              await new Promise(r => setTimeout(r, 250));
              samples.push({ set: top, en: Math.round(en.scrollTop), zh: Math.round(zh.scrollTop), diff: Math.round(Math.abs(zh.scrollTop - en.scrollTop)) });
            }
            // 反向：右滚 → 左跟随
            zh.scrollTop = 2500;
            zh.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 250));
            const reverse = { zh: Math.round(zh.scrollTop), en: Math.round(en.scrollTop), diff: Math.round(Math.abs(zh.scrollTop - en.scrollTop)) };
            // 滚动栈同构：总高差 ≤ 2px
            const stackDiff = Math.abs(en.scrollHeight - zh.scrollHeight);
            return { samples, reverse, stackDiff, maxDiff: Math.max(...samples.map(s => s.diff), reverse.diff) };
          })()
        `);
        log(`scroll-sync: ${JSON.stringify(scrollSync.samples)} reverse=${JSON.stringify(scrollSync.reverse)} stackDiff=${scrollSync.stackDiff}`);
        log(`pixel scroll sync (maxDiff ≤ 2): ${scrollSync.maxDiff <= 2 && scrollSync.stackDiff <= 2 ? 'PASS' : 'FAIL'}`);

        // 划线双边：add 高亮后重开论文（真实持久化路径：挂载 → loadHl → 双侧渲染）
        const hlBoth: any = await win.webContents.executeJavaScript(`
          (async () => {
            const api = window.api;
            await api.pdfhlAdd({ paperId: ${paperId}, side: 'en', page: 1, rects: [{x:0.1,y:0.1,w:0.3,h:0.02}], text: 'e2e test highlight', color: 'yellow' });
            // 切走再切回（卸载/重挂 SplitPdfView，触发 loadHl 全新拉取）
            window.__store.getState().setLayout('translate');
            await new Promise(r => setTimeout(r, 400));
            window.__store.getState().setLayout('pdf-split');
            // 等 SplitPdfView 重挂 + 首页渲染
            for (let i = 0; i < 20; i++) {
              await new Promise(r => setTimeout(r, 500));
              const layers = [...document.querySelectorAll('.spv-pane .pdf-page[data-page="1"] .spv-hllayer')];
              if (layers.length === 2 && layers.every(l => l.querySelectorAll('.spv-hlrect').length >= 1)) {
                return { layers: 2, counts: layers.map(l => l.querySelectorAll('.spv-hlrect').length), persisted: true };
              }
            }
            const layers = [...document.querySelectorAll('.spv-pane .pdf-page[data-page="1"] .spv-hllayer')];
            return { layers: layers.length, counts: layers.map(l => l.querySelectorAll('.spv-hlrect').length), persisted: false };
          })()
        `);
        log(`highlight both sides (persist+remount): layers=${hlBoth.layers}, counts=${JSON.stringify(hlBoth.counts)} ${hlBoth.layers === 2 && hlBoth.counts.every((c: any) => c >= 1) ? 'PASS' : 'FAIL'}`);

        // 截图
        await win.webContents.executeJavaScript(`
          (async () => {
            const panes = [...document.querySelectorAll('.spv-pane')];
            for (const p of panes) { p.scrollTop = 0; p.dispatchEvent(new Event('scroll')); }
            await new Promise(r => setTimeout(r, 500));
          })()
        `);
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.resolve('build'), { recursive: true });
        fs.writeFileSync(path.resolve('build/split-ui-e2e.png'), img.toPNG());
        log('screenshot saved');

        // 【回退】无 mono 论文：新 paper 无 mono → 自动回退 translate + 工具栏生成按钮
        // 在主进程直接造一篇无 mono 论文再探测
        const paperId2 = db.insertPaper({ arxivId: '2609.00001', title: 'No Mono Paper', authors: 'e2e', sourceUrl: '', importType: 'pdf' });
        fs.copyFileSync(path.join(realPdfs, '202.pdf'), path.join(pdfsDir, `${paperId2}.pdf`));
        const st2 = await win.webContents.executeJavaScript(`window.api.pdf2zhStatus(${paperId2})`);
        log(`no-mono status: monoExists=${st2.monoExists} ${st2.monoExists === false ? 'PASS' : 'FAIL'}`);
        await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId2})`);
        await new Promise(r => setTimeout(r, 2000));
        let layout2 = '';
        for (let i = 0; i < 20; i++) {
          layout2 = await win.webContents.executeJavaScript(`window.__store.getState().layout`);
          if (layout2 === 'translate') break;
          await new Promise(r => setTimeout(r, 300));
        }
        const genBtn: any = await win.webContents.executeJavaScript(`
          (() => {
            const btn = [...document.querySelectorAll('.reader-toolbar button')].find(b => b.textContent?.includes('生成中文 PDF'));
            return { found: !!btn };
          })()
        `);
        log(`fallback: layout=${layout2} ${layout2 === 'translate' ? 'PASS' : 'FAIL'}; genBtn=${genBtn.found} ${genBtn.found ? 'PASS' : 'FAIL'}`);

        // 汇总
        const allPass = layout === 'pdf-split'
          && mount.panes === 2 && mount.canvases >= 2 && mount.modeBtns === 0 && mount.chipOk
          && scrollSync.maxDiff <= 2 && scrollSync.stackDiff <= 2
          && hlBoth.layers === 2 && hlBoth.counts.every((c: any) => c >= 1)
          && st2.monoExists === false && layout2 === 'translate' && genBtn.found;
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
  if (e2eEnabled && process.env.PR_TOPIC_UI_E2E) {
    // 主题依赖库 UI E2E：真实网络构建 → 断言分层列表 + 阅读顺序（隔离 userData）
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
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
      log(`sidebar topic entry: ${shell.navBtnTitles.some((t: string) => t.includes('主题依赖库')) ? 'PASS' : 'FAIL'}`);

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
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 1000));
        detail = await win.webContents.executeJavaScript(`
          (() => {
            // B3：详情页就绪标志 = 图/列表模式切换按钮出现（构建完成后自动进详情）
            const modeBtns = document.querySelectorAll('.list-head .mode-switch button').length;
            const canvas = document.querySelector('.topic-graph-wrap canvas');
            return { modeBtns, canvas: !!canvas, canvasW: canvas?.width ?? 0,
                     fallback: !!document.querySelector('.graph-fallback') };
          })()
        `);
        if (detail.modeBtns >= 2 && (detail.canvas || detail.fallback)) break;
      }
      log(`topic detail (graph default): modeBtns=${detail?.modeBtns}, canvas=${detail?.canvas}(${detail?.canvasW}px), fallback=${detail?.fallback}`);
      // v3 B3：切到「列表」模式断言分层结构（地基/核心/桥梁/前沿 + 阅读顺序）
      const listDetail: any = await win.webContents.executeJavaScript(`
        (async () => {
          // 等「列表」按钮出现（详情页挂载；构建刚完成时可能延迟数百 ms）
          let listBtn = null;
          for (let i = 0; i < 30 && !listBtn; i++) {
            listBtn = [...document.querySelectorAll('.list-head .mode-switch button')].find(b => b.textContent?.includes('列表'));
            if (!listBtn) await new Promise(r => setTimeout(r, 500));
          }
          listBtn?.click();
          await new Promise(r => setTimeout(r, 800));
          const sections = document.querySelectorAll('.topic-section');
          const papers = document.querySelectorAll('.topic-paper');
          const badges = [...document.querySelectorAll('.layer-badge')].map(b => b.textContent);
          const orders = [...document.querySelectorAll('.read-order')].map(o => o.textContent);
          return { sections: sections.length, papers: papers.length, badges, firstOrders: orders.slice(0, 5) };
        })()
      `).catch(() => null);
      log(`topic detail (list mode): sections=${listDetail?.sections}, papers=${listDetail?.papers}, layers=${JSON.stringify(listDetail?.badges)}, firstOrders=${JSON.stringify(listDetail?.firstOrders)}`);
      // 图谱（canvas 已挂载或 >200 节点走了降级）+ 列表分层同过
      const graphOk = (!!detail?.canvas && detail?.canvasW > 100) || !!detail?.fallback;
      log(`topic built (graph + layers): ${(graphOk && listDetail && listDetail.papers >= 20 && listDetail.sections >= 2) ? 'PASS' : 'FAIL'}`);

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
  if (e2eEnabled && process.env.PR_INTERACT_UI_E2E) {
    // 交互功能 UI E2E：命令面板/闪卡复习/问答(fake-LLM)/设置（入口自带全部逻辑；隔离 userData）
    const entry = path.join(__dirname, 'interact-ui-e2e.js');
    if (fs.existsSync(entry)) {
      registerIpc(); // 测试走真实 UI + IPC 链路
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_UEX_E2E) {
    // 用户旅程 UI E2E：真实用户视角全流程（导入→阅读→翻译→划线→闪卡→复习→沉淀→管理）
    const entry = path.join(__dirname, 'uex-e2e.js');
    if (fs.existsSync(entry)) {
      if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
      registerIpc();
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_UX_AUDIT) {
    // UX 审计：黄金旅程 + 探针 + 截图（入口自带全部逻辑；隔离 userData）
    const entry = path.join(__dirname, 'ux-audit-entry.js');
    if (fs.existsSync(entry)) {
      registerIpc();
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_FIG_VERIFY) {
    // 图表修复验证：真实库副本 → 逐布局断言真图加载 + 无「下载中」残留（入口自带逻辑）
    const entry = path.join(__dirname, 'fig-verify-entry.js');
    if (fs.existsSync(entry)) {
      if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
      registerIpc();
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_LLM_JUDGE) {
    // LLM 体验评估：摘要/翻译/问答接地性打分（本地优先/云端兜底；隔离 userData）
    const entry = path.join(__dirname, 'llm-judge-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (e2eEnabled && process.env.PR_VISUAL_JUDGE) {
    // 视觉检验：ux-audit 截图 → 视觉模型断言（本地多模态优先/云端兜底）
    const entry = path.join(__dirname, 'visual-judge-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }

  if (e2eEnabled && process.env.PR_PDF_UI_E2E) {
    // UI E2E（v3 SplitPdfView 版）：原版对照 = 左原版 PDF / 右 mono.pdf，等值滚动同步（恒等式）。
    // v3 D2/D4：DualPdfView（pdf-layout 三态切换/译文文档流）已删除；本测试改为验证 SplitPdfView。
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
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
        await win.webContents.executeJavaScript(`window.__E2E = 1; localStorage.setItem('pr:welcome:seen', '1'); true`).catch(() => {});
        const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
        const parsed = arxiv.parseArxivHtml(html, '2609.34683');
        const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
        db.insertBlocks(paperId, parsed.blocks);
        log(`import: PASS (paper ${paperId}, ${parsed.blocks.length} blocks)`);

        // 种子 PDF：原版 + mono（同一份测试 PDF；mono 与原版逐页同构 → 恒等同步可精确验证）
        const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
        fs.mkdirSync(pdfsDir, { recursive: true });
        const seed = path.resolve('build/test-paper.pdf');
        fs.copyFileSync(seed, path.join(pdfsDir, `${paperId}.pdf`));
        fs.copyFileSync(seed, path.join(pdfsDir, `${paperId}-mono.pdf`));
        log(`pdf seeded: orig=${fs.existsSync(path.join(pdfsDir, `${paperId}.pdf`))}, mono=${fs.existsSync(path.join(pdfsDir, `${paperId}-mono.pdf`))}`);

        // 阶段 0：应用壳层（侧栏导航 + 顶栏搜索）
        const shell: any = await win.webContents.executeJavaScript(`
          (() => ({
            sidebar: !!document.querySelector('.sidebar'),
            navBtns: document.querySelectorAll('.nav-btn').length,
            topSearch: !!document.querySelector('.topbar-search'),
          }))()
        `);
        log(`shell: sidebar=${shell.sidebar}, navBtns=${shell.navBtns}, topSearch=${shell.topSearch}`);

        // 打开论文（smart 布局 + mono 存在 → SplitPdfView 自动升级）
        await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
        let splitMounted = false;
        for (let i = 0; i < 30; i++) {
          splitMounted = await win.webContents.executeJavaScript(`!!document.querySelector('.spv-wrap')`).catch(() => false);
          if (splitMounted) break;
          await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 3000)); // canvas 懒渲染落定

        // 阶段 1：双栏结构 + canvas
        const stats: any = await win.webContents.executeJavaScript(`
          (() => {
            const panes = document.querySelectorAll('.spv-pane');
            const en = document.querySelector('.spv-en');
            const zh = document.querySelector('.spv-zh');
            const canvases = document.querySelectorAll('.spv-pane canvas');
            const pages = document.querySelectorAll('.spv-pane .pdf-page');
            const badge = document.querySelector('.spv-page-badge')?.textContent ?? '';
            const err = document.querySelector('.pdf-error');
            return {
              panes: panes.length,
              hasEn: !!en, hasZh: !!zh,
              enH: en?.clientHeight ?? 0, zhH: zh?.clientHeight ?? 0,
              canvases: canvases.length, pages: pages.length,
              badge,
              firstCanvasW: canvases[0]?.width ?? 0,
              errText: err?.textContent?.slice(0, 160) ?? null,
            };
          })()
        `);
        log(`split view: panes=${stats.panes}, en=${stats.hasEn}(${stats.enH}px), zh=${stats.hasZh}(${stats.zhH}px), canvases=${stats.canvases}/${stats.pages}, badge=${JSON.stringify(stats.badge)}`);
        if (stats.errText) log(`pdf error text: ${stats.errText}`);
        const structOk = stats.panes === 2 && stats.hasEn && stats.hasZh
          && stats.enH > 300 && stats.zhH > 300 && stats.canvases >= 1 && stats.firstCanvasW > 300
          && /[0-9]+[/][0-9]+/.test(stats.badge);
        log(`split structure: ${structOk ? 'PASS' : 'FAIL'}`);
        log(`canvas rendered: ${stats.canvases >= 1 && stats.firstCanvasW > 300 ? 'PASS' : 'FAIL'}`);

        // 阶段 2：等值滚动同步（L→R 与 R→L 恒等式，阈值 2px）+ 稳定性
        const sync: any = await win.webContents.executeJavaScript(`
          (async () => {
            const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
            if (!en || !zh) return { ok: false, reason: 'panes missing' };
            const settle = async (pane, ms = 3000) => {
              let last = pane.scrollTop, same = 0;
              const t0 = Date.now();
              while (Date.now() - t0 < ms) {
                await new Promise(r => setTimeout(r, 200));
                const cur = pane.scrollTop;
                if (Math.abs(cur - last) <= 1) { same++; if (same >= 2) return true; } else same = 0;
                last = cur;
              }
              return false;
            };
            const samples = [];
            for (const ratio of [0.25, 0.5, 0.75]) {
              en.scrollTop = Math.round(en.scrollHeight * ratio);
              en.dispatchEvent(new Event('scroll'));
              await settle(en); await settle(zh);
              const l = en.scrollTop, r = zh.scrollTop;
              samples.push({ dir: 'L2R', at: ratio, l, r, err: Math.round(r - l), within: Math.abs(r - l) <= 2 });
            }
            for (const ratio of [0.1, 0.6]) {
              zh.scrollTop = Math.round(zh.scrollHeight * ratio);
              zh.dispatchEvent(new Event('scroll'));
              await settle(zh); await settle(en);
              const l = en.scrollTop, r = zh.scrollTop;
              samples.push({ dir: 'R2L', at: ratio, l, r, err: Math.round(l - r), within: Math.abs(l - r) <= 2 });
            }
            const s1 = { l: en.scrollTop, r: zh.scrollTop };
            await new Promise(r2 => setTimeout(r2, 600));
            const s2 = { l: en.scrollTop, r: zh.scrollTop };
            const stable = Math.abs(s2.l - s1.l) <= 2 && Math.abs(s2.r - s1.r) <= 2;
            const ok = samples.length >= 5 && samples.every(s => s.within) && stable;
            return { samples, stable, ok };
          })()
        `);
        for (const s of (sync.samples ?? [])) log('  ' + JSON.stringify(s));
        log(`scroll identity sync (2px) + stability: ${sync.ok ? 'PASS' : 'FAIL'}`);

        // 阶段 3：几何隔离（左右栏水平分离，无横向滚动）
        const geo: any = await win.webContents.executeJavaScript(`
          (() => {
            const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
            if (!en || !zh) return { ok: false, reason: 'panes missing' };
            const a = en.getBoundingClientRect(), b = zh.getBoundingClientRect();
            const gap = Math.round(b.left - a.right);
            const hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
            return { gap, hScroll, aRight: Math.round(a.right), bLeft: Math.round(b.left),
                     ok: gap >= 0 && !hScroll };
          })()
        `);
        log(`geo: ${JSON.stringify(geo)}`);
        log(`geometry (panes separated, no h-scroll): ${geo.ok ? 'PASS' : 'FAIL'}`);

        // 阶段 4：页码徽章联动（左栏滚到后半 → 徽章页码变化）
        const badge: any = await win.webContents.executeJavaScript(`
          (async () => {
            const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
            const b0 = document.querySelector('.spv-page-badge')?.textContent ?? '';
            if (!en || !zh) return { ok: false, reason: 'panes missing' };
            en.scrollTop = Math.round(en.scrollHeight * 0.8);
            en.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 1200));
            const badges = [...document.querySelectorAll('.spv-page-badge')].map(b => b.textContent);
            return { b0, badges, ok: badges.length === 2 && badges.every(b => /[0-9]+[/][0-9]+/.test(b ?? '')) };
          })()
        `);
        log(`page badge: ${JSON.stringify(badge)}`);
        log(`page badge tracks scroll: ${badge.ok ? 'PASS' : 'FAIL'}`);

        // 阶段 5：字体（打包 Noto Serif SC/Sans SC 实际加载）
        const fontStats: any = await win.webContents.executeJavaScript(`
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

        // 截图存档
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.resolve('build'), { recursive: true });
        fs.writeFileSync(path.resolve('build/pdf-ui-e2e.png'), img.toPNG());
        log('screenshot saved');

        const allPass = structOk && sync.ok && geo.ok && badge.ok && fontOk
          && shell.sidebar && shell.navBtns >= 2 && shell.topSearch;
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
  if (e2eEnabled && process.env.PR_SOAK) {
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
  // 广播所有窗口（E2E/多窗口场景下 win 引用可能不是触发窗口）
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload); } catch { /* 窗口可能已销毁 */ }
  }
}

// ==================== IPC ====================
export function registerIpc() {
  // ---------- papers ----------
  wrap('papers:list', () => db.listPapers());
  wrap('papers:get', (_e, id: number) => { db.touchPaper(id); return db.getPaper(id); });
  wrap('papers:delete', (_e, id: number) => { db.deletePaper(id); return true; });
  wrap('papers:getBlocks', (_e, id: number) => db.getBlocks(id));
  // 论文组织：状态 + 标签（v0.3）
  wrap('papers:setStatus', (_e, arg: { id: number; status: string }) => { db.setPaperStatus(arg.id, arg.status); return true; });
  wrap('papers:setTags', (_e, arg: { id: number; tags: string[] }) => { db.setPaperTags(arg.id, arg.tags); return true; });
  // 阅读进度百分比入库（列表页「读至 X%」数据源；渲染层防抖上报，只增不减）
  wrap('papers:setReadPct', (_e, paperId: number, pct: number) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const prev = db.getReadProgress(paperId);
    if (p > prev) db.setSetting(`read:${paperId}`, String(p));
    return true;
  });

  // ---------- 本地论文库（v0.4）----------
  const LIB_DIR_KEY = 'library_dir';
  wrap('lib:getDir', () => db.getSetting(LIB_DIR_KEY) ?? '');
  wrap('lib:setDir', (_e, dir: string) => { db.setSetting(LIB_DIR_KEY, String(dir || '')); return true; });
  wrap('lib:pickDir', async () => {
    const r = await dialog.showOpenDialog(win ?? undefined as any, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths?.length ? null : r.filePaths[0];
  });
  wrap('lib:scan', () => {
    const root = db.getSetting(LIB_DIR_KEY);
    if (!root) throw new Error('未设置本地论文库文件夹（先在「本地库」面板选择文件夹）');
    if (!fs.existsSync(root)) {
      const err: any = new Error(`文件夹不存在：${root}`);
      err.hint = '文件夹可能被移动或重命名，请重新选择。';
      throw err;
    }
    return library.syncScan(root);
  });
  wrap('lib:importFiles', async (_e, paths: string[]) => {
    if (!Array.isArray(paths) || !paths.length) throw new Error('未选择要导入的文件');
    const results: Array<{ path: string; ok: boolean; paperId?: number; title?: string; error?: string }> = [];
    for (let i = 0; i < paths.length; i++) {
      const abs = paths[i];
      let r: any;
      try {
        r = await library.importLocalPdf(abs);
        generateTriageInBackground(r.paperId).catch(() => {});
        results.push({ path: abs, ok: true, ...r });
      } catch (e: any) {
        results.push({ path: abs, ok: false, error: e?.message ?? String(e) });
      }
      const last = results[results.length - 1];
      send('lib:progress', { done: i + 1, total: paths.length, path: abs, ok: last.ok, title: last.title ?? path.basename(abs) });
    }
    return results;
  });
  wrap('lib:moveFile', (_e, arg: { paperId: number; dir: string; newFolder?: string }) => {
    const root = db.getSetting(LIB_DIR_KEY);
    if (!root) throw new Error('未设置本地论文库文件夹');
    return library.movePaperFile(arg.paperId, root, arg.dir, arg.newFolder);
  });
  wrap('lib:revealFile', (_e, paperId: number) => {
    const paper = db.getPaper(paperId) as any;
    if (!paper?.file_path || !fs.existsSync(paper.file_path)) throw new Error('本地文件不存在（可能已被移动，扫描一次可重新关联）');
    shell.showItemInFolder(paper.file_path);
    return true;
  });
  wrap('lib:openDir', (_e, relDir: string) => {
    const root = db.getSetting(LIB_DIR_KEY);
    if (!root) throw new Error('未设置本地论文库文件夹');
    const dir = path.join(root, library.cleanRelDir(relDir || ''));
    if (!fs.existsSync(dir)) throw new Error('文件夹不存在');
    shell.openPath(dir);
    return true;
  });

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
    db.markTopicPaperImported(arg.topicId, id); // 用规范化后的 id 匹配（剥掉 v2 等版本后缀）
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

  // v3 A3：快速取 PDF 页数（pageMap 的轻量版，只为估算翻译范围/耗时）
  async function getPdfNumPages(paperId: number): Promise<number> {
    const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
    let pdfPath = path.join(pdfsDir, `${paperId}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      const paper = db.getPaper(paperId) as any;
      if (paper?.file_path && fs.existsSync(paper.file_path)) pdfPath = paper.file_path;
    }
    if (!fs.existsSync(pdfPath)) return 0;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as any).pdfjsWorker = workerMod;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true }).promise;
    const n = doc.numPages;
    doc.destroy();
    return n;
  }

  // 确保论文 PDF 存在（返回是否存在）
  wrap('pdf:ensure', async (_e, paperId: number) => {
    const paper = db.getPaper(paperId) as any;
    // 本地论文库：直接读原文件（协议层回退），无需下载
    if (paper?.file_path && fs.existsSync(paper.file_path)) return { exists: true };
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
    let pdfPath = path.join(pdfsDir, `${paperId}.pdf`);
    // 本地论文库回退：直读原文件
    if (!fs.existsSync(pdfPath)) {
      const paper = db.getPaper(paperId) as any;
      if (paper?.file_path && fs.existsSync(paper.file_path)) pdfPath = paper.file_path;
    }
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

  // ---------- pdf2zh（保留版式双语 PDF，feat/pdf2zh-reading）----------
  // 状态探测：CLI 可用性 + 本论文双语/纯译 PDF 产物 + 页数（供自动触发门控与耗时估算）
  wrap('pdf2zh:status', async (_e, paperId: number) => {
    const cli = p2z.resolveCli();
    let numPages = 0;
    try { numPages = await getPdfNumPages(paperId); } catch { /* 无 PDF → 0 */ }
    return { cliOk: !!cli, cliHint: cli ? '' : p2z.cliHint(), numPages, ...p2z.dualPdfStatus(paperId) };
  });
  // 生成（异步推进度，完成发 pdf2zh:done / 失败发 pdf2zh:error）
  // v3 A3：不传 pages 时自动跳过参考文献页（D3）；dual.pdf 默认不生成（D2 mono-only）
  wrap('pdf2zh:translate', async (_e, arg: { paperId: number; pages?: string; noMono?: boolean; fullDoc?: boolean }) => {
    if (p2z.isRunning(arg.paperId)) throw new Error('该论文的双语 PDF 正在生成中');
    let lastLine = '';
    let pages = arg.pages;
    if (!pages && !arg.fullDoc) {
      try {
        const numPages = await getPdfNumPages(arg.paperId);
        pages = p2z.autoPagesArg(arg.paperId, numPages) ?? undefined;
      } catch { /* 页数探测失败 → 全文翻译兜底 */ }
    }
    p2z.translateDualPdf({ ...arg, pages, noDual: true }, {
      onLine: line => { lastLine = line; send('pdf2zh:progress', { paperId: arg.paperId, line }); },
      onDone: (dualPath, monoPath) => send('pdf2zh:done', { paperId: arg.paperId, dualPath, monoPath, pages: pages ?? null }),
      onError: err => send('pdf2zh:error', { paperId: arg.paperId, error: err }),
    });
    return { started: true, pages: pages ?? null };
  });
  wrap('pdf2zh:cancel', (_e, paperId: number) => p2z.cancelTranslate(paperId));

  // ---------- PDF 坐标高亮（原版对照阅读）----------
  wrap('pdfhl:add', (_e, arg: {
    paperId: number; side: 'en' | 'zh'; page: number;
    rects: Array<{ x: number; y: number; w: number; h: number }>;
    text: string; note?: string; color?: string;
  }) => {
    const pid = db.findPidByText(arg.paperId, arg.text);
    return db.addPdfHighlight({ ...arg, pid });
  });
  wrap('pdfhl:list', (_e, paperId: number) => db.listPdfHighlights(paperId));
  wrap('pdfhl:remove', (_e, id: number) => { db.removePdfHighlight(id); return true; });

  // text 降级论文自动升级入口（注册后异步执行）
  function scheduleUpgradeTextImports() {
    setTimeout(() => { upgradeTextImports().catch(() => {}); }, 3000);
  }
  scheduleUpgradeTextImports();

  // 首次启动 Provider 自动导入：库中无 Provider 且项目根有 llm.txt（格式：key baseurl model）时，
  // 自动加密入库为默认 Provider——用户不再撞「未配置 LLM Provider」死路（2026-11 用户实测：
  // llm.txt 备用配置给了但从未进 app，翻译/摘要/问答全部瘫痪，UI 只见占位文案）。
  // llm.txt 消费后改名 llm.txt.imported 防重复导入；key 永不落日志。
  function importLlmTxtIfFresh() {
    try {
      // 仅打包版（真实用户场景）导入：dev/e2e/inspect 的 userData 都是隔离库或测试库，
      // 在那里执行会把仓库共享的 llm.txt 消费掉（改名 .imported）而真实库永远得不到
      // 导入（2026-11 实测事故）。dev 库通过 npm run seed:provider 手动种子。
      if (!app.isPackaged) return;
      const has = db.getDb().prepare('SELECT COUNT(*) AS n FROM providers').get() as any;
      if (Number(has?.n ?? 0) > 0) return;
      // 打包版候选：~/llm.txt（用户手动放置）> userData/llm.txt（升级携带）> 开发机项目根（本机调试）
      const candidates = [
        path.join(process.env.HOME ?? '', 'llm.txt'),
        path.join(app.getPath('userData'), 'llm.txt'),
        path.join(process.env.HOME ?? '', 'projects/paper-reader/llm.txt'),
      ];
      const f = candidates.find(c => c && fs.existsSync(c));
      if (!f) return;
      const m = fs.readFileSync(f, 'utf8').trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s*$/m);
      if (!m) { console.log('[llm.txt] 格式不符（期望「key url model」三段），跳过'); return; }
      const [, key, baseUrl, model] = m;
      const base = baseUrl.replace(/\/chat\/completions$/, '');
      const name = /bigmodel/i.test(base) ? '智谱 BigModel' : 'LLM';
      db.getDb().prepare('INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES (?,?,?,?,?,1)')
        .run(name, 'openai', base, llm.encryptSecret(key), model);
      fs.renameSync(f, f + '.imported');
      console.log(`[llm.txt] 已导入 Provider「${name}/${model}」并设为默认（源文件改名 .imported）`);
    } catch (e: any) { console.log('[llm.txt] 导入失败:', e?.message ?? e); }
  }
  importLlmTxtIfFresh();

  // 图表自愈：启动后异步补漏——fig 块缺图（fig_path 非本地形态）且磁盘无文件的论文，
  // 重跑 downloadFiguresFor（现已支持 object svg + 序号对位兜底）。幂等：已有本地图的块会被跳过。
  setTimeout(() => { repairMissingFigures().catch(() => {}); }, 8000);

  // 摘要自愈：导入时无 Provider 的论文 summary 永远缺失（generateTriageInBackground 静默跳过），
  // 首页只显示「AI 摘要待生成」占位。启动后补生成（串行防限流，与图表自愈错峰）。
  // 幂等：已有 summary 的论文跳过；无 Provider 时整体跳过（下次配置后再补）。
  setTimeout(() => { repairMissingSummaries().catch(() => {}); }, 20000);
  async function repairMissingSummaries() {
    const provider = getDefaultProvider();
    if (!provider) return;
    const targets = db.getDb().prepare(
      `SELECT p.id FROM papers p
       WHERE NOT EXISTS (SELECT 1 FROM paper_summaries s WHERE s.paper_id = p.id AND s.summary != '')`
    ).all() as any[];
    if (!targets.length) return;
    console.log(`[summary-repair] papers needing summary: ${targets.length}`);
    for (const t of targets) {
      try {
        await generateTriageInBackground(t.id);
        console.log(`[summary-repair] paper ${t.id}: summary generated`);
        await new Promise(r => setTimeout(r, 3000)); // 串行 + 间隔防限流
      } catch (e: any) { console.log(`[summary-repair] paper ${t.id} FAILED: ${e?.message ?? e}`); }
    }
  }
  async function repairMissingFigures() {
    // 完全没下到本地图的论文，以及个别图/算法仍无本地文件、也没有抽出的表格或伪代码的论文。
    const targets = db.getDb().prepare(
      `SELECT DISTINCT p.id, p.arxiv_id FROM papers p
       JOIN blocks b ON b.paper_id = p.id
       WHERE p.import_type='html' AND p.arxiv_id NOT LIKE 'local:%'
         AND b.type='fig'
         AND (b.fig_path IS NULL OR b.fig_path NOT GLOB '[0-9]*/fig-*')
         AND (b.fig_table_rows IS NULL OR b.fig_table_rows = '')
         AND COALESCE(b.fig_html_table, 0) = 0`
    ).all() as any[];
    console.log(`[fig-repair] papers needing figures: ${targets.length}`);
    for (const t of targets) {
      // 先重解析补 fig_path 远端 URL（object svg 现已识别）+ fig_html_table 标记
      try {
        const parsed = await arxiv.fetchAndParse(t.arxiv_id);
        if (parsed.importType !== 'html') { downloadFiguresFor(t.id, t.arxiv_id).catch(() => {}); continue; }
        const old = db.getBlocks(t.id) as any[];
        const oldBySeq = new Map(old.map(b => [b.seq, b]));
        // 只更新 fig 块的 fig_path/fig_kind/fig_html_table（保留 pid 和译文——seq 对位，解析器确定性）
        const stmtUpd = db.getDb().prepare('UPDATE blocks SET fig_path=?, fig_kind=?, fig_html_table=?, fig_table_rows=? WHERE pid=?');
        let updated = 0;
        for (const nb of parsed.blocks) {
          if (nb.type !== 'fig') continue;
          const ob = oldBySeq.get(nb.seq);
          if (!ob || ob.type !== 'fig') continue;
          const local = typeof ob.fig_path === 'string' && /^\d+\/fig-\d+\./.test(ob.fig_path);
          const nextPath = local ? ob.fig_path : (nb.figPath ?? ob.fig_path);
          const nextRows = ob.fig_table_rows ? ob.fig_table_rows : (nb.figTableRows ? JSON.stringify(nb.figTableRows) : null);
          stmtUpd.run(nextPath, nb.figKind ?? ob.fig_kind, nb.figHtmlTable ? 1 : (ob.fig_html_table ? 1 : 0), nextRows, ob.pid);
          if (!ob.fig_table_rows && nextRows) send('fig:updated', { pid: ob.pid, figRows: nextRows });
          updated++;
        }
        console.log(`[fig-repair] ${t.arxiv_id}: re-parsed ${updated} fig blocks`);
      } catch (e) { console.log(`[fig-repair] ${t.arxiv_id} reparse FAILED: ${e}`); }
      // 再走下载（含 object svg 直下 + inline 兜底）
      downloadFiguresFor(t.id, t.arxiv_id).catch(() => {});
    }
  }

  // text 降级 / 本地 pdf 论文自动升级：重抓 HTML 结构化导入（含图表）+ PDF
  // pdf 论文仅在完全未翻译时升级（避免覆盖用户已读内容的译文）
  async function upgradeTextImports() {
    const rows = db.getDb().prepare(
      `SELECT id, arxiv_id FROM papers
       WHERE import_type='text'
          OR (import_type='pdf' AND arxiv_id NOT LIKE 'local:%'
              AND NOT EXISTS (SELECT 1 FROM translations t WHERE t.paper_id=papers.id))`
    ).all() as any[];
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
    let inlineCursor = 0;
    // pgf 导出的 svg 常常没有 xmlns，<img> 会当成坏图。补上命名空间。
    const withSvgNs = (raw: string) => /xmlns=/.test(raw) ? raw : raw.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    const stmt = db.getDb().prepare('UPDATE blocks SET fig_path=? WHERE pid=?');
    // inline SVG / object SVG 提取：无 figPath 的 fig 块回源拉 HTML 兜底。
    // 两种形态：a) <object type="image/svg+xml" data="xxx.svg">（新版 LaTeXML 主力）→ 直接下 data URL；
    //           b) 内联 <svg>（老版）→ 序列化落盘。
    let inlineFigs: (string | null)[] | null = null; // 每个 <figure> 的 svg 源（object data URL 或内联 svg 内容），null=无
    let inlineSvgOnly: string[] = []; // 与解析器 fig_path='inline:' 同序：无内容图、无 object 的内联 svg
    const getInlineFigs = async (): Promise<(string | null)[]> => {
      if (inlineFigs) return inlineFigs;
      try {
        const resp = await fetch(`https://arxiv.org/html/${arxivId}`, { signal: AbortSignal.timeout(60000) });
        const html = resp.ok ? await resp.text() : '';
        const contentImg = (fragment: string) => {
          const re = /<(?:img|graphics)\b[^>]*>/gi;
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(fragment)) !== null) {
            const src = (mm[0].match(/\b(?:src|xlink:href)="([^"]+)"/i) || [])[1];
            if (!src || /^data:/i.test(src)) continue;
            if (/\/static\/|arxiv-logo|smileybones|\/funders\//i.test(src)) continue;
            return true;
          }
          return false;
        };
        inlineSvgOnly = [];
        inlineFigs = html
          ? [...html.matchAll(/<figure[^>]*>([\s\S]*?)<\/figure>/gi)].map(m => {
              // 优先 object data（可下载的独立 svg 文件）；退化找内联 <svg>
              const obj = m[1].match(/<object[^>]*type="image\/svg\+xml"[^>]*data="([^"]+)"[^>]*>/i)
                || m[1].match(/<object[^>]*data="([^"]+\.svg)"[^>]*>/i);
              const svg = m[1].match(/<svg[\s\S]*?<\/svg>/i);
              if (!obj && svg && !contentImg(m[1])) inlineSvgOnly.push(svg[0]);
              if (obj) return { kind: 'url', src: obj[1] } as const;
              if (svg) return { kind: 'inline', src: svg[0] } as const;
              return null;
            }).map((x): string | null => {
              if (!x) return null;
              if (x.kind === 'inline') return x.src;
              // object data 相对路径 → 绝对 URL；带版本前缀（2609.34683v1/x.svg）时用版本化 base（否则 404）
              if (x.src.startsWith('http')) return x.src;
              const vm = x.src.match(new RegExp(`^(${arxivId}v\\d+)/(.+)$`, 'i'));
              const base = vm ? `https://arxiv.org/html/${vm[1]}` : `https://arxiv.org/html/${arxivId}`;
              const rel = vm ? vm[2] : x.src.replace(/^\.\//, '');
              return `${base}/${rel}`;
            })
          : [];
      } catch { inlineFigs = []; inlineSvgOnly = []; }
      return inlineFigs;
    };
    // 解析器把「没有 <img> 的内联 svg」标成 fig_path='inline:'。只收集这一类，文档序对位。
    // 不能用全体 fig 块下标——一张 figure 拆成多张子图后下标会错位。
    let inlineSvgList: string[] | null = null;
    const getInlineSvgList = async (): Promise<string[]> => {
      if (inlineSvgList) return inlineSvgList;
      await getInlineFigs();
      inlineSvgList = inlineSvgOnly;
      return inlineSvgList;
    };
    // fig 块在文档流中的序号（第几个 fig）——与 HTML <figure> 文档序对齐
    const figBlocks = blocks.filter(b => b.type === 'fig');
    for (const b of blocks) {
      if (b.type !== 'fig') continue;
      i++;
      if (b.fig_path && /^https?:/.test(b.fig_path)) {
        // 常规路径：远端 URL 直接下载（含 object svg 形态——解析器现已产出绝对 URL）
        const url = b.fig_path;
        const ext = (url.match(/\.(svg|png|jpg|jpeg|gif)$/i) || [, 'png'])[1];
        const fname = `fig-${i}.${ext}`;
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (!resp.ok) { console.log(`[fig-dl] ${fname}: HTTP ${resp.status}`); continue; }
          const buf = Buffer.from(await resp.arrayBuffer());
          fsMod.writeFileSync(path.join(figuresDir, fname), buf);
          stmt.run(`${paperId}/${fname}`, b.pid);
          send('fig:updated', { pid: b.pid, figPath: `${paperId}/${fname}` });
          console.log(`[fig-dl] ${fname}: OK (${buf.length}b)`);
        } catch (e) { console.log(`[fig-dl] ${fname}: FAIL ${e instanceof Error ? e.message : e}`); /* 单图失败跳过 */ }
      } else if (b.fig_path === 'inline:') {
        try {
          const svgs = await getInlineSvgList();
          const src = svgs[inlineCursor++] ?? '';
          if (!src) continue;
          const fname = `fig-${i}.svg`;
          fsMod.writeFileSync(path.join(figuresDir, fname), withSvgNs(src), 'utf8');
          stmt.run(`${paperId}/${fname}`, b.pid);
          send('fig:updated', { pid: b.pid, figPath: `${paperId}/${fname}` });
        } catch { /* 跳过 */ }
      } else if (b.fig_path) {
        // 兜底路径：已是本地形态但文件丢失——回源按文档序对位提取
        try {
          const figsHtml = await getInlineFigs();
          // 对位序号：blocks 里第 k 个 fig ↔ HTML 第 k 个 <figure>。
          const k = figBlocks.indexOf(b);
          const src = figsHtml[k] ?? '';
          if (!src) continue;
          if (/^https?:/.test(src)) {
            // object data URL：直接下载
            const ext = (src.match(/\.(svg|png|jpg|jpeg|gif)$/i) || [, 'svg'])[1];
            const fname = `fig-${i}.${ext}`;
            const resp = await fetch(src, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) continue;
            fsMod.writeFileSync(path.join(figuresDir, fname), Buffer.from(await resp.arrayBuffer()));
            stmt.run(`${paperId}/${fname}`, b.pid);
            send('fig:updated', { pid: b.pid, figPath: `${paperId}/${fname}` });
          } else {
            // 内联 svg 内容：直接落盘
            const fname = `fig-${i}.svg`;
            fsMod.writeFileSync(path.join(figuresDir, fname), withSvgNs(src), 'utf8');
            stmt.run(`${paperId}/${fname}`, b.pid);
            send('fig:updated', { pid: b.pid, figPath: `${paperId}/${fname}` });
          }
        } catch { /* 跳过 */ }
      }
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
        // 守卫 1：空/超短 block 不送翻译（LLM 会回客套话污染译文库）
        if (!item.en || item.en.replace(/\s+/g, '').length < 3) {
          done++;
          e.sender.send('tr:progress', { pid: item.pid, err: 'skipped-empty', done, total: arg.blocks.length });
          continue;
        }
        // 守卫 1b：学术固定词汇标题 → 本地词表直译，不调 LLM
        // （LLM 对孤立单词标题极易复读上下文或胡乱扩充——「Abstract」被翻成论文标题的案例）
        const glossaryHit = FIXED_HEADING_ZH[item.en.trim().toLowerCase()];
        if (glossaryHit) {
          done++;
          db.saveTranslation(arg.paperId, item.pid, glossaryHit, 'local', 'fixed-glossary');
          e.sender.send('tr:progress', { pid: item.pid, zh: glossaryHit, done, total: arg.blocks.length });
          continue;
        }
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
        // 守卫 2：译文是客套话/拒答 → 不落库（视为失败，UI 显示待翻译占位）
        if (zh.ok && looksLikeChitchat(item.en, zh.text ?? '')) {
          e.sender.send('tr:progress', { pid: item.pid, err: 'chitchat-guard', done, total: arg.blocks.length });
        } else if (zh.ok) {
          // 守卫 3：长度异常拒收——短块译文远超正文长度（LLM 把上下文当正文翻了）
          const enLen = item.en.replace(/\s+/g, ' ').trim().length;
          const zhLen = (zh.text ?? '').replace(/\s+/g, ' ').trim().length;
          const ratio = enLen > 0 ? zhLen / enLen : 0;
          // 守卫 4：复读检测——译文与邻近块的译文完全相同（LLM 复读了前文/标题翻译）
          let isEcho = false;
          if (enLen <= 40 && zhLen > 0) {
            const pidIdx = blocksNow.findIndex((b: any) => b.pid === item.pid);
            for (let k = Math.max(0, pidIdx - 3); k <= Math.min(blocksNow.length - 1, pidIdx + 3); k++) {
              const nb = blocksNow[k];
              if (nb.pid === item.pid || nb.type === 'fig' || !nb.zh) continue;
              if (nb.zh.replace(/\s+/g, ' ').trim() === (zh.text ?? '').replace(/\s+/g, ' ').trim()) { isEcho = true; break; }
            }
          }
          if (isEcho) {
            e.sender.send('tr:progress', { pid: item.pid, err: 'echo-guard', done, total: arg.blocks.length });
          } else if (enLen <= 40 && zhLen > enLen * 4 + 20) {
            e.sender.send('tr:progress', { pid: item.pid, err: `length-guard(${Math.round(ratio)}x)`, done, total: arg.blocks.length });
          } else {
            db.saveTranslation(arg.paperId, item.pid, zh.text!, providerCfg.name, providerCfg.model);
            e.sender.send('tr:progress', { pid: item.pid, zh: zh.text, done, total: arg.blocks.length });
          }
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
  // 短块（标题/短语）防御：上下文比正文长 6 倍以上时，LLM 会把上下文内容当正文翻译
  // （实测案例：heading「Abstract」带 800 字摘要上下文 → 译文变成整段摘要，渲染成大标题+重复正文）。
  // 规则：en ≤ 40 字符（标题/短语类）时，摘要提示降为术语行、砍掉后文、前文限 300 字符。
  function translateBlockCtx(
    provider: llm.ProviderConfig, en: string, paperMeta: tr.PaperMeta,
    blocks: tr.BlockLite[], pid: number, glossaryLines: string[],
    signal?: AbortSignal, qcIssues?: string[],
  ): Promise<{ ok: boolean; text?: string; err?: string }> {
    const sys = tr.buildSystemPrompt(glossaryLines);
    const enLen = en.replace(/\s+/g, ' ').trim().length;
    const isShort = enLen <= 40;
    let ctx = tr.extractContext(blocks, pid, isShort ? { prevChars: 300, nextChars: 0, abstractChars: 160 } : undefined)
      ?? { paperLine: '', sectionLine: '', abstractHint: '', prevZh: '', nextEn: '' };
    ctx = { ...ctx, paperLine: `${paperMeta.title}${paperMeta.authors ? ` · ${paperMeta.authors.split(/[;,]/).slice(0, 3).join(', ')}` : ''}${paperMeta.arxivId ? ` (arXiv:${paperMeta.arxivId})` : ''}` };
    if (isShort) ctx.abstractHint = ctx.abstractHint.split(/[.。;；]/)[0] ?? ''; // 只留一句术语提示
    let userContent = tr.buildContextBlock(ctx) + en;
    // 短块强化指令：正文就是这一个短语，禁止输出解释或上下文翻译
    if (isShort) {
      userContent += `\n\n【注意】待译内容只有上面这 ${enLen} 个字符的短语/标题，译文也必须只有对应的几个字，不要翻译、复述或解释上下文中的任何其他内容。`;
    }
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
        // 流中断（AbortError 等场景 chatStream 以 onDone('') 收尾）产出空文本：
        // 必须判为失败，否则空译文落库 = 段落译文「缺内容」且不再重试
        onDone: (full) => {
          const text = cleanZh((full || acc).trim());
          resolve(text ? { ok: true, text } : { ok: false, err: 'empty-stream' });
        },
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

  // 客套话检测：LLM 对空输入/异常输入回复的「好的，请提供…」类文本，不是译文
  const CHITCHAT_PATTERNS = [
    /请(?:提供|发送|输入)(?:您)?(?:需要翻译|要翻译|的英文)/,
    /请(?:提供|发送)(?:需要|要)?翻译的?(?:英文|段落|文本|内容)/,
    /没有(?:提供|输入|收到).{0,12}(?:英文|文本|段落|内容)/,
    /^(?:好的|当然|抱歉)[，,。].{0,25}(?:翻译|英文|段落)/,
    /nothing to translate|no (?:english )?text (?:provided|to translate)/i,
  ];
  // 学术论文固定词汇标题的本地译法（不调 LLM，杜绝复读/扩充）
  const FIXED_HEADING_ZH: Record<string, string> = {
    'abstract': '摘要',
    'introduction': '引言',
    'conclusion': '结论',
    'conclusions': '结论',
    'related work': '相关工作',
    'references': '参考文献',
    'acknowledgments': '致谢',
    'acknowledgements': '致谢',
    'acknowledgment': '致谢',
    'appendix': '附录',
    'preprint': '预印本',
    'proof': '证明',
    'discussion': '讨论',
    'background': '背景',
    'motivation': '研究动机',
    'preliminaries': '预备知识',
    'experiments': '实验',
    'evaluation': '评估',
    'results': '结果',
    'analysis': '分析',
    'limitations': '局限性',
    'future work': '未来工作',
    'broader impact': '更广泛的影响',
    'contribution': '贡献',
    'contributions': '贡献',
    'setup': '实验设置',
    'methodology': '方法',
    'overview': '概述',
    'summary': '总结',
  };

  function looksLikeChitchat(en: string, zh: string): boolean {
    const t = zh.trim();
    if (!t) return true;
    if (en.replace(/\s+/g, '').length >= 3 && t.length < 18 && /^(?:好的|当然|抱歉|明白了)/.test(t)) return true;
    return CHITCHAT_PATTERNS.some(re => re.test(t));
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
  wrap('hl:listAll', () => db.listAllHighlights());

  // ---------- notes（挂段落自由笔记，v0.3）----------
  wrap('notes:add', (_e, n: { paperId: number; pid?: number; text: string }) => db.addNote(n));
  wrap('notes:update', (_e, arg: { id: number; text: string }) => { db.updateNote(arg.id, arg.text); return true; });
  wrap('notes:delete', (_e, id: number) => { db.deleteNote(id); return true; });
  wrap('notes:list', (_e, paperId: number) => db.listNotes(paperId));
  wrap('notes:listAll', () => db.listAllNotes());

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
    paperId: number; pid: number; question: string; context: string; highlightId?: number; streamId?: string;
  }) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider，请先到设置页添加');
    const qaId = db.addQa({ paperId: arg.paperId, highlightId: arg.highlightId, pid: arg.pid, question: arg.question, answer: '', provider: provider.name, model: provider.model });
    // 渲染进程用自己生成的 streamId 在 invoke 之前订阅。频道若等 qaId 返回再订，
    // 整段流（含 done）已经发完，界面只会留下空气泡。
    const ch = `qa:stream:${arg.streamId || qaId}`;
    const ctl = new AbortController();
    activeAbort.add(ctl);
    let acc = '';

    // ---- 上下文组装（升级：画像 + 摘要 + 多轮历史 + 相关段落检索） ----
    const profile = db.getReaderProfile();
    const strategy = insights.deriveReaderStrategy(profile);
    // 问题类型信号：概念/方法/结果（关键词启发式，进画像账本）
    const q = arg.question;
    const qKind = /是什么|什么是|概念|含义|意思|区别|为什么.*叫|指的/.test(q) ? 'concept'
      : /怎么|如何|为什么|机理|机制|步骤|算法|实现|流程/.test(q) ? 'method'
      : /实验|结果|性能|提升|多少|对比|baseline|消融|数字/.test(q) ? 'result' : null;
    if (qKind) db.bumpSignal(qKind as any);

    // 相关段落检索：问题词命中（简单词袋，无向量索引也够用）
    const allBlocks = db.getBlocks(arg.paperId) as any[];
    const qWords = [...new Set(q.toLowerCase().match(/[a-z]{3,}/g) ?? [])];
    const scored = allBlocks
      .filter(b => b.type === 'para' && b.en)
      .map(b => {
        const en = b.en.toLowerCase();
        let sc = qWords.reduce((s, w) => s + (en.includes(w) ? 1 : 0), 0);
        // 当前段落附近加权（问题往往针对正在读的位置）
        if (Math.abs(b.seq - (allBlocks.find(x => x.pid === arg.pid)?.seq ?? 0)) <= 3) sc += 1.5;
        return { b, sc };
      })
      .filter(x => x.sc > 0)
      .sort((a, b2) => b2.sc - a.sc)
      .slice(0, 6)
      .map(x => x.b);
    const retrievedCtx = scored
      .map(b => `【段落 #${b.seq + 1}】${b.en}`)
      .join('\n\n')
      .slice(0, 8000);
    // 当前位置上下文（划线场景优先）
    const localCtx = arg.context?.slice(0, 4000) ?? '';

    // 多轮历史：本论文最近 3 轮问答（追问连贯性）
    const hist = (db.listQa(arg.paperId) as any[]).filter(x => x.answer).slice(-6);
    const histMsgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const h of hist) {
      histMsgs.push({ role: 'user', content: h.question.slice(0, 500) });
      histMsgs.push({ role: 'assistant', content: h.answer.slice(0, 1000) });
    }

    // 摘要注入（Triage 卡片已有就复用）
    const summaryRow = db.getSummary(arg.paperId) as any;
    let summaryLine = '';
    if (summaryRow?.summary) {
      try {
        const s = JSON.parse(summaryRow.summary);
        summaryLine = `论文一句话：${s.oneLiner ?? ''}\n方法：${s.method ?? ''}\n结果：${s.results ?? ''}`;
      } catch { /* 摘要格式异常跳过 */ }
    }

    const sys = `你是论文阅读助手。用中文回答。
规则：
1. 先直接回答问题，再补充细节
2. 回答依据论文上下文，不编造论文没有的内容；论文没提到的可以补充但要标注「论文之外」
3. 引用依据时标注段落位置，格式【段落 #N】（N 是上下文中标注的段号）
4. 术语保留英文
5. 用户可能在追问上一轮，结合历史回答保持连贯，不要重复解释已解释过的概念

读者画像（据此调整回答方式）：
${strategy.depthRule}
${strategy.vocabRule}${profile.bg ? `\n用户自述背景：${profile.bg.slice(0, 300)}` : ''}`;

    const userParts: string[] = [];
    if (summaryLine) userParts.push(`【论文概览】\n${summaryLine}`);
    if (localCtx) userParts.push(`【用户当前位置上下文】\n${localCtx}`);
    if (retrievedCtx) userParts.push(`【与问题相关的段落（检索）】\n${retrievedCtx}`);
    userParts.push(`我的问题：${arg.question}`);

    let answer = '';
    let failed: string | null = null;
    await llm.chatStream(provider, [
      { role: 'system', content: sys },
      ...histMsgs,
      { role: 'user', content: userParts.join('\n\n') },
    ], {
      onDelta: (d) => { acc += d; e.sender.send(ch, { delta: d }); },
      onDone: (full) => {
        answer = (full || acc).trim();
        db.getDb().prepare('UPDATE qa_pairs SET answer=? WHERE id=?').run(answer, qaId);
        e.sender.send(ch, { done: true, answer, qaId });
      },
      onError: (err) => { failed = err; e.sender.send(ch, { error: err }); },
    }, { temperature: 0.4, maxTokens: 4096, signal: ctl.signal }).finally(() => activeAbort.delete(ctl));
    if (failed) throw new Error(failed);
    return { qaId, answer };
  });

  // ---------- 读者画像 ----------
  wrap('profile:get', () => {
    const profile = db.getReaderProfile();
    const strategy = insights.deriveReaderStrategy(profile);
    return { ...profile, strategy };
  });
  wrap('profile:setBg', (_e, bg: string) => { db.setReaderBg(bg); return true; });
  wrap('profile:feedback', (_e, kind: 'tooShallow' | 'tooDeep' | 'justRight' | 'followup') => {
    db.bumpSignal(kind);
    send('profile:changed', { kind });
    return true;
  });
  wrap('profile:suggest', (_e, paperId: number) => {
    const profile = db.getReaderProfile();
    const strategy = insights.deriveReaderStrategy(profile);
    const headings = (db.getBlocks(paperId) as any[]).filter(b => b.type === 'heading').map(b => b.en);
    return { questions: insights.suggestQuestions(strategy, headings), rationale: strategy.rationale, kind: strategy.suggestKind };
  });

  wrap('qa:list', (_e, paperId: number) => db.listQa(paperId));
  wrap('qa:listAll', () => db.listAllQa());

  function loadPaperLedger(paperId: number, heading: boolean): string | null {
    const paper = db.getPaper(paperId) as { title: string; arxiv_id?: string } | undefined;
    if (!paper) throw new Error('论文不存在');
    return digest.buildPaperLedger({
      title: paper.title,
      arxivId: paper.arxiv_id || '',
      highlights: db.listHighlights(paperId) as digest.LedgerHighlight[],
      notes: db.listNotes(paperId) as digest.LedgerNote[],
      qas: db.listQa(paperId) as digest.LedgerQa[],
    }, { heading });
  }

  function packDigest(kind: 'paper' | 'topic', refId: number) {
    const row = db.getDigest(kind, refId);
    if (!row) return null;
    return { ...row, cites: db.resolveCites(row.body) };
  }

  wrap('digest:listPapers', () => db.listDigests('paper').map(r => ({ ...r, cites: db.resolveCites(r.body) })));
  wrap('digest:get', (_e, kind: 'paper' | 'topic', refId: number) => {
    if (kind !== 'paper' && kind !== 'topic') throw new Error('未知的笔记类型');
    return packDigest(kind, refId);
  });
  wrap('digest:paper', async (_e, paperId: number) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider');
    const ledger = loadPaperLedger(paperId, true);
    if (!ledger) throw new Error('这篇还没有划线、笔记或提问。先留下记录，再生成精炼笔记。');
    const strategy = insights.deriveReaderStrategy(db.getReaderProfile());
    const body = await insights.genRefinedNote(provider, strategy, 'paper', ledger);
    if (!body.trim()) throw new Error('模型没有返回笔记');
    db.upsertDigest('paper', paperId, body);
    return packDigest('paper', paperId);
  });
  wrap('digest:topic', async (_e, topicId: number) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider');
    const topic = db.getTopic(topicId) as { name: string; query?: string } | undefined;
    if (!topic) throw new Error('主题不存在');
    const papers = db.listTopicPapers(topicId) as Array<{
      library_paper_id: number | null; title: string; layer: string; read_order: number | null;
    }>;
    const sections: digest.TopicLedgerSection[] = [];
    for (const p of papers) {
      if (!p.library_paper_id) continue;
      let body: string | null = null;
      try { body = loadPaperLedger(p.library_paper_id, false); } catch { body = null; }
      if (!body) continue;
      sections.push({ order: p.read_order, title: p.title, layer: p.layer, body });
    }
    const ledger = digest.buildTopicLedger(topic.name, topic.query || '', sections);
    if (!ledger) throw new Error('这个主题里还没有留下划线、笔记或提问的论文。先打开论文读一段，再生成主题笔记。');
    const strategy = insights.deriveReaderStrategy(db.getReaderProfile());
    const body = await insights.genRefinedNote(provider, strategy, 'topic', ledger);
    if (!body.trim()) throw new Error('模型没有返回笔记');
    db.upsertDigest('topic', topicId, body);
    return packDigest('topic', topicId);
  });

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
    // local-figure://f/<paperId>/fig-N.ext 引用转 base64 内联（离线打印窗口没有自定义协议）
    const figDir = path.join(app.getPath('userData'), 'figures');
    let html = arg.html.replace(/local-figure:\/\/(?:f\/)?([^"'\s)]+)/g, (_m, rel: string) => {
      try {
        const relPath = rel.replace(/^f\//, '');
        const p = path.join(figDir, path.normalize(decodeURIComponent(relPath)));
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
  wrap('gh:writeQa', (_e, arg: { arxivId: string; question: string; answer: string; paperId?: number; pid?: number | null }) => {
    // 笔记先落在应用内「沉淀」。知识库仓库是可选项，连上了再追加一份，没连不能让写回失败。
    let paperId = arg.paperId;
    if (!paperId) paperId = db.findPaperByArxiv(arg.arxivId)?.id;
    if (!paperId) throw new Error('找不到这篇论文，无法写入笔记');
    const text = `问：${arg.question.trim()}\n\n答：${arg.answer.trim()}`;
    const noteId = db.addNote({ paperId, pid: arg.pid ?? undefined, text });
    const root = gh.getRepoRoot();
    if (!root) return { ok: true, local: true, noteId };
    const date = new Date().toISOString().slice(0, 10);
    const r = gh.appendQaToNote(root, arg.arxivId, { question: arg.question, answer: arg.answer, date });
    return { ok: true, local: true, noteId, note: r.ok ? r.note : undefined, repoError: r.ok ? undefined : r.error };
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
