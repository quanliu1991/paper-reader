// 视觉/内容/滚动 三大断言库（强制门禁 PR_ASSERT_E2E，npm run guard）：
//   A. 物理重叠检测：相邻译文段 getBoundingClientRect 垂直相交 = FAIL；左右栏水平相交 = FAIL；
//      正文流禁止 position:absolute/fixed（静态规约 1）
//   B. 内容完整性及去重：右栏连续 5 段无「完全重复字串」（≥20 字符重复窗口）；
//      渲染段落数 = blocks 数（防丢段）；页锚 ≥3（防映射崩坏）
//   C. 滚动锁定：双向 scroll 后 500ms 内两侧 scrollTop 收敛（无死循环拉扯）
//   D. 三态截图：双语对照 / 窄屏 / 点击定位 → build/guard-*.png（供视觉自校验）
// 任何断言失败 → exit 1，禁止交付。
import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as db from '../electron/db';
import * as arxiv from '../electron/arxiv';
import * as llm from '../electron/llm';
import * as tr from '../electron/translate';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function ok<T>(data: T) { return { ok: true, data }; }
function err(e: any) { return { ok: false, error: String(e?.message ?? e) }; }

function registerGuardIpc() {
  const wrap = (ch: string, fn: (e: any, ...a: any[]) => any) =>
    ipcMain.handle(ch, async (e, ...a) => { try { return ok(await fn(e, ...a)); } catch (ex) { return err(ex); } });
  wrap('papers:list', () => db.listPapers());
  wrap('papers:get', (_e, id: number) => { db.touchPaper(id); return db.getPaper(id); });
  wrap('papers:getBlocks', (_e, id: number) => db.getBlocks(id));
  wrap('papers:delete', (_e, id: number) => { db.deletePaper(id); return true; });
  wrap('pdf:ensure', (_e, paperId: number) => {
    const dest = path.join(app.getPath('userData'), 'pdfs', `${paperId}.pdf`);
    return { exists: fs.existsSync(dest) && fs.statSync(dest).size > 10000 };
  });
  wrap('pdf:pageMap', (_e, _paperId: number) => ({}));
  wrap('tr:translateAll', () => ({ cancelled: false, done: 0 })); // guard 内不触发真实翻译
  wrap('tr:cancel', () => true);
  wrap('summary:get', () => null);
  wrap('summary:sections', () => []);
  wrap('quick:action', () => ({ ok: true, text: '' }));
  // local-pdf / local-figure 协议（与主进程同款）
  const serveFile = async (url: string, dirName: string, mime: (p: string) => string) => {
    const rel = decodeURIComponent(url.replace(/^local-[a-z]+:\/\//, ''));
    const base = path.join(app.getPath('userData'), dirName);
    const p = path.normalize(path.join(base, rel));
    if (!p.startsWith(base)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(await net.fetch(`file:///${p.split(path.sep).join('/')}`), { headers: { 'Content-Type': mime(p) } });
  };
  protocol.handle('local-pdf', (req) => serveFile(req.url, 'pdfs', () => 'application/pdf'));
  protocol.handle('local-figure', (req) => serveFile(req.url, 'figures', (p) => /\.(png|jpe?g)$/i.test(p) ? 'image/png' : 'image/svg+xml'));
}

app.whenReady().then(async () => {
  const logFile = process.env.PR_E2E_LOG!;
  const doneFile = process.env.PR_E2E_DONE!;
  const log = (s: string) => fs.appendFileSync(logFile, s + '\n');

  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
    registerGuardIpc();

    // 种子论文（fixture，与其他 E2E 同源）
    const parsed = arxiv.parseArxivHtml(fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8'), '2609.34683');
    const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
    db.insertBlocks(paperId, parsed.blocks);
    const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
    fs.mkdirSync(pdfsDir, { recursive: true });
    const seedPdf = path.resolve('build/test-paper.pdf');
    if (fs.existsSync(seedPdf)) fs.copyFileSync(seedPdf, path.join(pdfsDir, `${paperId}.pdf`));
    log(`seed: paper=${paperId}, blocks=${parsed.blocks.length}, pdf=${fs.existsSync(path.join(pdfsDir, `${paperId}.pdf`))}`);

    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
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
      clusterInfo = await win.webContents.executeJavaScript(`window.__dpvClusterDone ?? null`);
      if (clusterInfo) break;
      await sleep(500);
    }
    if (!clusterInfo) { log('FATAL: cluster never finished'); fs.writeFileSync(doneFile, '1'); app.quit(); return; }
    log(`cluster: ${JSON.stringify(clusterInfo)}`);

    // ---------- A. 物理重叠检测 ----------
    log('[A] 物理重叠检测（getBoundingClientRect）');
    const overlap: any = await win.webContents.executeJavaScript(`
      (() => {
        const left = document.querySelector('.dpv-left');
        const right = document.querySelector('.dpv-right');
        const issues = [];
        if (left && right) {
          const lr = left.getBoundingClientRect(), rr = right.getBoundingClientRect();
          const hGap = Math.round(rr.left - lr.right);
          if (hGap < 0) issues.push({ kind: 'pane-h-overlap', gap: hGap });
        }
        const paras = [...document.querySelectorAll('.dpv-right .dpv-zhpara')];
        let vOverlap = 0;
        for (let i = 0; i + 1 < paras.length; i++) {
          const a = paras[i].getBoundingClientRect(), b = paras[i + 1].getBoundingClientRect();
          if (b.top < a.bottom - 1) { vOverlap++; if (issues.length < 5) issues.push({ kind: 'para-v-overlap', pid: paras[i].dataset.pid, overlapPx: Math.round(a.bottom - b.top) }); }
        }
        let absCount = 0;
        for (const p of paras) {
          const pos = getComputedStyle(p).position;
          if (pos === 'absolute' || pos === 'fixed') absCount++;
        }
        return { paras: paras.length, vOverlap, issues, absCount };
      })()
    `);
    log(`  paras=${overlap.paras}, vOverlap=${overlap.vOverlap}, absPositioned=${overlap.absCount}, issues=${JSON.stringify(overlap.issues)}`);
    const aOk = overlap.vOverlap === 0 && overlap.issues.length === 0 && overlap.absCount === 0;
    log(`[A] 物理重叠: ${aOk ? 'PASS' : 'FAIL'}`);

    // ---------- B. 内容完整性及去重 ----------
    log('[B] 内容完整性及去重');
    const content: any = await win.webContents.executeJavaScript(`
      (() => {
        const paras = [...document.querySelectorAll('.dpv-right .dpv-zhpara')];
        const texts = paras.map(p => (p.textContent ?? '').replace(/\\s+/g, ' ').trim());
        let dupPairs = [];
        for (let w = 0; w + 5 <= texts.length; w += 5) {
          const win5 = texts.slice(w, w + 5);
          for (let i = 0; i < win5.length; i++) {
            for (let j = i + 1; j < win5.length; j++) {
              const a = win5[i], b = win5[j];
              if (!a || !b || a.length < 20 || b.length < 20) continue;
              for (let k = 0; k + 20 <= a.length; k += 10) {
                if (b.includes(a.slice(k, k + 20))) { dupPairs.push({ i: w + i, j: w + j, frag: a.slice(k, k + 20) }); k = a.length; break; }
              }
            }
          }
        }
        const st = window.__store.getState();
        const expected = st.blocks.filter(b => b.type !== 'fig').length;
        const pagesTagged = new Set(paras.map(p => p.dataset.page).filter(Boolean)).size;
        return { dupCount: dupPairs.length, dupPairs: dupPairs.slice(0, 5), rendered: paras.length, expected, pagesTagged };
      })()
    `);
    log(`  渲染段=${content.rendered}/${content.expected}(期望), 页锚=${content.pagesTagged}, 重复对=${content.dupCount}`);
    if (content.dupCount > 0) log(`  重复样例: ${JSON.stringify(content.dupPairs)}`);
    const bOk = content.dupCount === 0 && content.rendered === content.expected && content.pagesTagged >= 3;
    log(`[B] 内容去重+完整性: ${bOk ? 'PASS' : 'FAIL'}`);

    // ---------- C. 滚动锁定 ----------
    log('[C] 滚动锁定（无死循环拉扯）');
    const scrollLock: any = await win.webContents.executeJavaScript(`
      (async () => {
        const L = document.querySelector('.dpv-left');
        const R = document.querySelector('.dpv-right');
        if (!L || !R) return { ok: false, reason: 'no panes' };
        L.scrollTop = Math.round(L.scrollHeight * 0.4);
        L.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 1500));
        const s1 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
        await new Promise(r => setTimeout(r, 500));
        const s2 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
        const t = R.querySelector('.dpv-zhpara[data-page="5"]') ?? R.querySelector('.dpv-zhpara[data-page="3"]');
        if (t) { R.scrollTop = t.offsetTop - 40; R.dispatchEvent(new Event('scroll')); }
        await new Promise(r => setTimeout(r, 1500));
        const s3 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
        await new Promise(r => setTimeout(r, 500));
        const s4 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
        const stable = Math.abs(s2.l - s1.l) <= 2 && Math.abs(s2.r - s1.r) <= 2 && Math.abs(s4.l - s3.l) <= 2 && Math.abs(s4.r - s3.r) <= 2;
        const followed = s4.l > 50;
        return { s1, s2, s3, s4, stable, followed, ok: stable && followed };
      })()
    `);
    log(`  ${JSON.stringify(scrollLock)}`);
    log(`[C] 滚动锁定: ${scrollLock.ok ? 'PASS' : 'FAIL'}`);

    // ---------- D. 三态截图 ----------
    log('[D] 三态截图');
    fs.mkdirSync(path.resolve('build'), { recursive: true });
    await win.webContents.executeJavaScript(`
      (async () => {
        const L = document.querySelector('.dpv-left'), R = document.querySelector('.dpv-right');
        if (L) { L.scrollTop = 0; L.dispatchEvent(new Event('scroll')); }
        if (R) R.scrollTop = 0;
        await new Promise(r => setTimeout(r, 700));
      })()
    `);
    const img1 = await win.webContents.capturePage();
    fs.writeFileSync(path.resolve('build/guard-both.png'), img1.toPNG());
    log(`  saved build/guard-both.png`);

    const narrowWin = new BrowserWindow({
      width: 700, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    await narrowWin.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
    await sleep(800);
    await narrowWin.webContents.executeJavaScript(`
      (async () => {
        const st = window.__store.getState();
        await st.openPaper(${paperId});
        st.setLayout('pdf-layout');
      })()
    `);
    await sleep(1500);
    const narrowImg = await narrowWin.webContents.capturePage();
    fs.writeFileSync(path.resolve('build/guard-narrow.png'), narrowImg.toPNG());
    const narrowDiag: any = await narrowWin.webContents.executeJavaScript(`
      (() => ({ w: window.innerWidth, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }))()
    `);
    log(`  saved build/guard-narrow.png, diag=${JSON.stringify(narrowDiag)}`);
    narrowWin.close();

    await win.webContents.executeJavaScript(`
      (async () => {
        const paras = [...document.querySelectorAll('.dpv-right .dpv-zhpara[data-pid]')];
        const p = paras[Math.min(20, paras.length - 1)];
        if (p) p.click();
        await new Promise(r => setTimeout(r, 700));
      })()
    `);
    const img3 = await win.webContents.capturePage();
    fs.writeFileSync(path.resolve('build/guard-click-jump.png'), img3.toPNG());
    log(`  saved build/guard-click-jump.png`);

    const allOk = aOk && bOk && scrollLock.ok && !narrowDiag.hScroll;
    log(allOk ? 'GUARD ALL PASS' : 'GUARD FAIL');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
  } finally {
    fs.writeFileSync(doneFile, '1');
    setTimeout(() => app.quit(), 200);
  }
});

