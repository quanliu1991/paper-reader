// 首页摘要显示验收：打开首页（不进论文）→ 断言 paper-card 有 triage oneLiner → 截图
// 由 scripts/verify-home.mjs 驱动（隔离副本）
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';

const LOG = process.env.PR_E2E_LOG!;
const DONE = process.env.PR_E2E_DONE!;
const log = (s: string) => { fs.appendFileSync(LOG, s + '\n'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run() {
  try {
    const win = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    await sleep(2500); // 首页 loadPapers + 渲染
    const r: any = await win.webContents.executeJavaScript(`
      (() => {
        const cards = [...document.querySelectorAll('.paper-card')];
        const lines = [...document.querySelectorAll('.triage-line')];
        const pendings = lines.filter(l => l.textContent?.includes('待生成'));
        return {
          cards: cards.length,
          triageLines: lines.length,
          withSummary: lines.filter(l => l.textContent && l.textContent.trim().length > 5 && !l.textContent.includes('待生成')).length,
          pendingCount: pendings.length,
          samples: lines.slice(0, 3).map(l => (l.textContent ?? '').trim().slice(0, 70)),
        };
      })()
    `);
    log('home: ' + JSON.stringify(r, null, 1));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.resolve('build/home-summary.png'), img.toPNG());
    log('screenshot saved: build/home-summary.png');
    const ok = r.cards > 0 && r.withSummary >= 1 && r.pendingCount === 0;
    log(ok ? 'HOME SUMMARY PASS' : 'HOME SUMMARY FAIL');
    fs.writeFileSync(DONE, ok ? '1' : '0');
  } catch (e: any) {
    log('FATAL: ' + (e?.stack ?? e));
    fs.writeFileSync(DONE, '0');
  } finally {
    setTimeout(() => app.quit(), 300);
  }
}
