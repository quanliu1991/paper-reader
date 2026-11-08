// E2E：原版对照滚动回归（v3 SplitPdfView 版，PR_DEDUP_E2E 入口，由 main.ts require）
// v3 D2/D4：DualPdfView（右栏译文文档流 + 簇映射同步）已删除——重复检测失去对象；
// 滚动同步改为 SplitPdfView 恒等式（mono 与原版逐页同构 → scrollTop 等值映射）。
// 本回归覆盖：① 双栏等值同步（L→R / R→L ≤2px）② 稳定性（无回环抖动）
// ③ 关闭重开后滚动位置恢复（splitTop 持久化）④ 无横向滚动
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as db from '../electron/db';
import * as arxiv from '../electron/arxiv';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runDedupScrollTest() {
  const logFile = process.env.PR_E2E_LOG!;
  const doneFile = process.env.PR_E2E_DONE!;
  const log = (s: string) => { fs.appendFileSync(logFile, s + '\n'); console.log(s); };
  let pass = true;
  try {
    // ---- 种子：fixture 论文 + 原版/mono PDF（同构）----
    const parsed = arxiv.parseArxivHtml(fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8'), '2609.34683');
    const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
    db.insertBlocks(paperId, parsed.blocks);
    const pdfDir = path.join(require('electron').app.getPath('userData'), 'pdfs');
    fs.mkdirSync(pdfDir, { recursive: true });
    const seedPdf = path.resolve('build/test-paper.pdf');
    fs.copyFileSync(seedPdf, path.join(pdfDir, `${paperId}.pdf`));
    fs.copyFileSync(seedPdf, path.join(pdfDir, `${paperId}-mono.pdf`));
    log(`seed: paper=${paperId}, blocks=${parsed.blocks.length}, mono=${fs.existsSync(path.join(pdfDir, `${paperId}-mono.pdf`))}`);

    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    if (process.env.PR_E2E_LOAD === 'dist') {
      await win.loadFile(path.join(__dirname, '../dist/index.html'));
    } else {
      await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
    }
    await sleep(1000);
    await win.webContents.executeJavaScript(`window.__E2E = 1; localStorage.setItem('pr:welcome:seen', '1'); true`).catch(() => {});
    await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);

    // 等 SplitPdfView 挂载（smart + mono → 自动升级）+ canvas 尺寸就绪
    let mounted = false;
    for (let i = 0; i < 40; i++) {
      mounted = await win.webContents.executeJavaScript(`
        (() => {
          const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
          return !!(en && zh && en.scrollHeight > 1000 && zh.scrollHeight > 1000);
        })()
      `).catch(() => false);
      if (mounted) break;
      await sleep(500);
    }
    if (!mounted) { log('FATAL: SplitPdfView never mounted'); pass = false; }
    else {
      await sleep(1500); // canvas 懒渲染 + 布局定型

      // ---- A. 等值滚动同步（L→R 与 R→L，阈值 2px；两栏同构恒等式）----
      log('[A] 等值滚动同步（阈值 2px）');
      const a: any = await win.webContents.executeJavaScript(`
        (async () => {
          const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
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
          for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
            en.scrollTop = Math.round(en.scrollHeight * ratio);
            en.dispatchEvent(new Event('scroll'));
            await settle(en); await settle(zh);
            const l = en.scrollTop, r = zh.scrollTop;
            samples.push({ dir: 'L2R', at: ratio, err: Math.round(r - l), within: Math.abs(r - l) <= 2 });
          }
          for (const ratio of [0.3, 0.7]) {
            zh.scrollTop = Math.round(zh.scrollHeight * ratio);
            zh.dispatchEvent(new Event('scroll'));
            await settle(zh); await settle(en);
            const l = en.scrollTop, r = zh.scrollTop;
            samples.push({ dir: 'R2L', at: ratio, err: Math.round(l - r), within: Math.abs(l - r) <= 2 });
          }
          return { samples, ok: samples.length >= 6 && samples.every(s => s.within) };
        })()
      `);
      for (const s of (a.samples ?? [])) log('  ' + JSON.stringify(s));
      log('[A] 等值同步: ' + (a.ok ? 'PASS' : 'FAIL'));
      if (!a.ok) pass = false;

      // ---- B. 稳定性（落定后 800ms 漂移 ≤2px，无回环抖动）----
      const b: any = await win.webContents.executeJavaScript(`
        (async () => {
          const en = document.querySelector('.spv-en'), zh = document.querySelector('.spv-zh');
          const s1 = { l: Math.round(en.scrollTop), r: Math.round(zh.scrollTop) };
          await new Promise(r => setTimeout(r, 800));
          const s2 = { l: Math.round(en.scrollTop), r: Math.round(zh.scrollTop) };
          return { s1, s2, ok: Math.abs(s2.l - s1.l) <= 2 && Math.abs(s2.r - s1.r) <= 2 };
        })()
      `);
      log(`[B] 稳定性: ${b.ok ? 'PASS' : 'FAIL'} (${JSON.stringify(b.s1)} -> ${JSON.stringify(b.s2)})`);
      if (!b.ok) pass = false;

      // ---- C. 无横向滚动 ----
      const c: any = await win.webContents.executeJavaScript(`
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      `);
      log('[C] 无横向滚动: ' + (c ? 'PASS' : 'FAIL'));
      if (!c) pass = false;

      // ---- D. 重开恢复（回列表 → 重开论文 → 滚动位置恢复 ±4px）----
      const d: any = await win.webContents.executeJavaScript(`
        (async () => {
          const en = document.querySelector('.spv-en');
          en.scrollTop = Math.round(en.scrollHeight * 0.5);
          en.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 800));
          return Math.round(en.scrollTop);
        })()
      `);
      await win.webContents.executeJavaScript(`window.__store.getState().setView('list')`);
      await sleep(500);
      const savedTop = await win.webContents.executeJavaScript(`Number(localStorage.getItem('paper:${paperId}:splitTop') || 0)`).catch(() => -1);
      await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
      // 等 SplitPdfView 恢复完成：先等双栏就绪（高度成型），再等 scrollTop 稳定 1s
      // （SplitPdfView 的恢复是 500ms 轮询——挂载时 doc 未载完，就绪后才 scrollTo(splitTop)）
      let restored: number | null = null;
      for (let i = 0; i < 30; i++) {
        restored = await win.webContents.executeJavaScript(`
          (() => {
            const en = document.querySelector('.spv-en');
            return en && en.scrollHeight > 1000 ? Math.round(en.scrollTop) : null;
          })()
        `).catch(() => null);
        if (restored != null) break;
        await sleep(400);
      }
      if (restored != null) {
        // 就绪后等恢复动作落定（轮询周期 500ms + 滚动事件）
        let last = -1, same = 0;
        for (let i = 0; i < 30 && same < 3; i++) {
          await sleep(500);
          const cur = await win.webContents.executeJavaScript(`Math.round(document.querySelector('.spv-en')?.scrollTop ?? -1)`).catch(() => -1);
          if (cur === last) same++; else { same = 0; last = cur; }
        }
        restored = last;
      }
      const dOk = restored != null && Math.abs((restored ?? 0) - d) <= 4;
      log(`[D] 重开恢复: ${dOk ? 'PASS' : 'FAIL'} (set=${d}, saved=${savedTop}, restored=${restored})`);
      if (!dOk) pass = false;
    }
    log(pass ? 'DEDUP-SCROLL ALL PASS' : 'DEDUP-SCROLL FAIL');
  } catch (e: any) {
    log('FATAL: ' + (e?.stack ?? e));
    pass = false;
  } finally {
    fs.writeFileSync(doneFile, pass ? '1' : '0');
  }
}
