// 全篇真翻译验收（隔离副本，不碰真实库）：copy 真库 → translateAll 全部段 → 统计成功率/QC
// 由 scripts/verify-translation.mjs 驱动
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import * as db from '../electron/db';

const LOG = process.env.PR_E2E_LOG!;
const DONE = process.env.PR_E2E_DONE!;
const log = (s: string) => { fs.appendFileSync(LOG, s + '\n'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run() {
  try {
    const win = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    await sleep(1200);
    const papers = db.listPapers() as any[];
    const target = papers[0];
    if (!target) { log('FATAL: no paper in copied lib'); fs.writeFileSync(DONE, '0'); return; }
    await win.webContents.executeJavaScript(`(async () => { const st = window.__store.getState(); await st.openPaper(${target.id}); st.setLayout('translate'); })()`);
    await sleep(2000);

    // 全篇翻译（真实 provider 已随副本带过来 + .mk 已复制）
    const allBlocks: any[] = await win.webContents.executeJavaScript(`
      window.__store.getState().blocks.filter(b => b.type !== 'fig').map(b => ({ pid: b.pid, en: b.en }))
    `);
    log(`target paper=${target.id} blocks=${allBlocks.length}`);
    await win.webContents.executeJavaScript(`
      window.api.translateAll({ paperId: ${target.id}, blocks: ${JSON.stringify(allBlocks)}, scope: 'all' })
    `);

    // 进度轮询（最长 15 分钟）
    const t0 = Date.now();
    let lastDone = -1;
    while (Date.now() - t0 < 15 * 60 * 1000) {
      await sleep(10000);
      const st: any = await win.webContents.executeJavaScript(`
        (() => { const s = window.__store.getState(); return { translated: s.blocks.filter(b => b.zh).length, total: ${allBlocks.length} }; })()
      `);
      if (st.translated !== lastDone) { log(`progress: ${st.translated}/${st.total}`); lastDone = st.translated; }
      if (st.translated >= st.total) break;
    }

    // 结果统计
    const result: any = await win.webContents.executeJavaScript(`
      (() => {
        const s = window.__store.getState();
        const zh = s.blocks.filter(b => b.zh);
        const pend = s.blocks.filter(b => !b.zh && b.type !== 'fig');
        const dirty = zh.filter(b => /这是.{0,4}测试|预填译文|确定性测试/.test(b.zh));
        const samples = zh.slice(0, 5).map(b => ({ pid: b.pid, en: b.en.slice(0, 40), zh: b.zh.slice(0, 60) }));
        return { translated: zh.length, pending: pend.length, dirty: dirty.length, samples };
      })()
    `);
    log('RESULT: ' + JSON.stringify(result, null, 1));
    const ok = result.translated >= Math.floor(allBlocks.length * 0.9) && result.dirty === 0;
    log(ok ? 'TRANSLATION VERIFY PASS' : 'TRANSLATION VERIFY FAIL');
    fs.writeFileSync(DONE, ok ? '1' : '0');
  } catch (e: any) {
    log('FATAL: ' + (e?.stack ?? e));
    fs.writeFileSync(DONE, '0');
  } finally {
    setTimeout(() => app.quit(), 300);
  }
}
