// fig-verify-entry.ts — 图表修复验证：把真实库（已含 4 张本地图）拷到隔离 userData，
// 打开论文 → 逐布局截图 → 断言 <img> 真图加载（naturalWidth>0）且无「图片下载中」占位残留（表格占位除外）
// 由 main.ts 在 PR_FIG_VERIFY=1 时 require（IPC 已注册，同 ux-audit-entry 模式）
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';

const LOG = process.env.PR_E2E_LOG!;
const DONE = process.env.PR_E2E_DONE!;
const log = (s: string) => fs.appendFileSync(LOG, s + '\n');

const REAL = path.join(app.getPath('home'), 'Library/Application Support/Paper Reader');

async function run() {
  const ud = process.env.PR_E2E_USER_DATA!;
  // 拷真实库（只读副本；userData 已由 main.ts setPath）
  fs.mkdirSync(ud, { recursive: true });
  fs.copyFileSync(path.join(REAL, 'paper-reader.db'), path.join(ud, 'paper-reader.db'));
  for (const sub of ['figures', 'pdfs']) {
    const src = path.join(REAL, sub);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(ud, sub), { recursive: true });
  }
  const figFiles = fs.existsSync(path.join(ud, 'figures/1')) ? fs.readdirSync(path.join(ud, 'figures/1')) : [];
  log(`seeded: figs on disk = ${figFiles.length} (${figFiles.join(',')})`);

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  await new Promise(r => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`window.__store.getState().openPaper(1)`);
  await new Promise(r => setTimeout(r, 2000));

  const layouts = ['pdf-layout', 'translate', 'bilingual', 'zh'] as const;
  let allOk = true;
  for (const lay of layouts) {
    await win.webContents.executeJavaScript(`window.__store.getState().setLayout(${JSON.stringify(lay)})`);
    await new Promise(r => setTimeout(r, 2500));
    const stat: any = await win.webContents.executeJavaScript(`
      (async () => {
        // 逐个滚动到每个 lazy img 的 figure（双栏 grid 里一张可见不代表全部加载）
        const figs = [...document.querySelectorAll('figure.dpv-zhfig, .tv-fig, .bi-fig, .paper-fig')];
        for (const f of figs) {
          const im = f.querySelector('img');
          if (im && !(im.complete && im.naturalWidth > 0)) {
            (f.scrollIntoViewIfNeeded ? f.scrollIntoViewIfNeeded(true) : f.scrollIntoView({ block: 'center' }));
            await new Promise(r => setTimeout(r, 400));
          }
        }
        await new Promise(r => setTimeout(r, 800));
        const imgs = [...document.querySelectorAll('img')].filter(im => im.src.startsWith('local-figure://'));
        const loaded = imgs.filter(im => im.complete && im.naturalWidth > 0);
        const phs = [...document.querySelectorAll('.dpv-zhfigph, .tv-fig-placeholder, .bi-fig-ph, .fig-placeholder')];
        const pendingPh = phs.filter(el => /下载中/.test(el.textContent ?? '')).length;
        const tablePh = phs.filter(el => /表格/.test(el.textContent ?? '')).length;
        return { figImgs: imgs.length, figLoaded: loaded.length, pendingPh, tablePh };
      })()
    `);
    const ok = stat.figImgs === 4 && stat.figLoaded === 4 && stat.pendingPh === 0;
    allOk = allOk && ok;
    log(`[${lay}] imgs=${stat.figImgs} loaded=${stat.figLoaded} pendingPh=${stat.pendingPh} tablePh=${stat.tablePh} → ${ok ? 'PASS' : 'FAIL'}`);
    const shot = await win.webContents.capturePage();
    fs.mkdirSync(path.resolve('build'), { recursive: true });
    fs.writeFileSync(path.resolve(`build/fig-verify-${lay}.png`), shot.toPNG());
  }
  log(allOk ? 'FIG VERIFY ALL PASS' : 'FIG VERIFY HAS FAILURES');
  fs.writeFileSync(DONE, allOk ? '1' : '0');
}

run().catch(e => {
  log(`FATAL: ${e?.stack ?? e}`);
  fs.writeFileSync(DONE, '0');
}).finally(() => { setTimeout(() => app.quit(), 300); });
