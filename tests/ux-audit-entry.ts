// UX 审计 E2E：黄金旅程全流程走查 + 运行时探针（错误/慢操作）+ 确定性 UX 规则 + 每视图截图
// 产出：build/ux/screenshots/*.png + 结构化 findings（stdout JSON 行 UX-FINDING: {...}）
import { app, BrowserWindow } from 'electron';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finding = (f: { id: string; severity: 'high' | 'medium' | 'low'; view: string; title: string; evidence: string; screenshot?: string }) => {
  log('UX-FINDING: ' + JSON.stringify(f));
};
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

const shotDir = path.resolve('build/ux/screenshots');

async function shot(win: BrowserWindow, name: string): Promise<string> {
  const img = await win.webContents.capturePage();
  const p = path.join(shotDir, `${name}.png`);
  fs.writeFileSync(p, img.toPNG());
  return p;
}

app.whenReady().then(async () => {
  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
    fs.mkdirSync(shotDir, { recursive: true });
    log('== UX 审计黄金旅程 ==');

    // 种子：论文 + 译文 + 闪卡 + 假 Provider（fake-LLM）
    const text = `Vision-Language Models Survey

Abstract. We survey vision-language models and their applications in 2026.

1 Introduction
Multimodal understanding has grown rapidly. Benchmarks now cover 64x more tasks than 2023.

2 Architecture
The typical stack joins a vision encoder with an LLM decoder. Figure 1 shows the pipeline.

3 Results
Unified models reach state of the art on most benchmarks while remaining cheaper to train.`;
    const parsed = parsePlainText(text, '9999.02101', 'Vision-Language Models Survey');
    const paperId = db.insertPaper({ arxivId: '9999.02101', title: parsed.title, authors: 'A; B', sourceUrl: '', importType: 'text' });
    db.insertBlocks(paperId, parsed.blocks);
    const blocks = db.getBlocks(paperId) as any[];
    let n = 0;
    for (const b of blocks) {
      if (b.type === 'para' && n < 5) { db.saveTranslation(paperId, b.pid, `【译${n + 1}】这是预填的中文译文，用于 UX 审计走查，长度与原文相当以保证排版稳定。`, 'ux', 'ux'); n++; }
    }
    db.addFlashcard({ paperId, pid: blocks.find((b: any) => b.type === 'para').pid, front: 'VLM 是什么？', back: '视觉-语言模型' });
    db.getDb().prepare('INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES (?,?,?,?,?,?)')
      .run('ux-audit', 'openai', 'http://localhost:9/v1', 'enc-x', 'fake', 1);
    db.saveSummary(paperId, JSON.stringify({ oneLiner: 'VLM 综述', problem: '多模态', method: '编码器+解码器', results: 'SOTA', related: '' }), '[]', 'ux', 'ux');
    log(`seed: paper=${paperId}, zh=${n}`);

    const win = new BrowserWindow({
      width: 1440, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });

    // ---- 探针注入：console.error / 未捕获异常 / 慢操作 ----
    const probeErrors: any[] = [];
    win.webContents.on('console-message', (_e, _lvl, msg, line, src) => {
      if (/error|uncaught|failed/i.test(msg)) probeErrors.push({ msg: msg.slice(0, 300), src: String(src).slice(0, 120), line });
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      finding({ id: 'ux-render-crash', severity: 'high', view: 'any', title: '渲染进程崩溃', evidence: JSON.stringify(details) });
    });

    await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    await new Promise(r => setTimeout(r, 1500));

    // 注入渲染层探针（window.onerror / unhandledrejection）
    await win.webContents.executeJavaScript(`
      window.__uxProbeErrors = [];
      window.addEventListener('error', e => window.__uxProbeErrors.push({ kind: 'error', msg: String(e.message).slice(0, 300) }));
      window.addEventListener('unhandledrejection', e => window.__uxProbeErrors.push({ kind: 'rejection', msg: String(e.reason).slice(0, 300) }));
      'probe-ready'
    `);

    // ---- 视图 1：论文库列表 ----
    await shot(win, '01-paper-list');
    {
      const st: any = await win.webContents.executeJavaScript(`
        (() => {
          const cards = document.querySelectorAll('[class*="paper-card"], [class*="card"]');
          const importInput = document.querySelector('.import-row input, input[placeholder*="arXiv"], input[placeholder*="导入"]');
          const sidebar = document.querySelector('.sidebar');
          // 溢出裁剪检测：主容器横向溢出
          const doc = document.documentElement;
          const hOverflow = doc.scrollWidth > doc.clientWidth + 4;
          return { cards: cards.length, hasImport: !!importInput, hasSidebar: !!sidebar, hOverflow };
        })()
      `);
      log(`view list: cards=${st.cards}, import=${st.hasImport}, sidebar=${st.hasSidebar}, hOverflow=${st.hOverflow}`);
      if (st.hOverflow) finding({ id: 'ux-list-hoverflow', severity: 'medium', view: 'list', title: '论文库横向溢出', evidence: `scrollWidth>${st.clientWidth ?? 'client'}`, screenshot: '01-paper-list.png' });
      if (!st.hasImport) finding({ id: 'ux-list-noimport', severity: 'high', view: 'list', title: '导入入口不可见', evidence: 'no import input found' });
    }

    // ---- 视图 2-4：阅读器三模式 ----
    await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
    await new Promise(r => setTimeout(r, 900));
    for (const layout of ['dual', 'bilingual', 'zh']) {
      await win.webContents.executeJavaScript(`window.__store.getState().setLayout('${layout}')`);
      await new Promise(r => setTimeout(r, 700));
      await shot(win, `02-reader-${layout}`);
      const st: any = await win.webContents.executeJavaScript(`
        (() => {
          const main = document.querySelector('.reader-main, main, [class*="reader"]');
          const doc = document.documentElement;
          const hOverflow = doc.scrollWidth > doc.clientWidth + 4;
          const textLen = (main?.textContent ?? '').length;
          return { hOverflow, textLen, hasZh: (main?.textContent ?? '').includes('预填的中文译文') };
        })()
      `);
      log(`view reader-${layout}: text=${st.textLen}, zh=${st.hasZh}, hOverflow=${st.hOverflow}`);
      if (st.textLen < 100) finding({ id: `ux-reader-${layout}-empty`, severity: 'high', view: `reader-${layout}`, title: `${layout} 模式内容过少`, evidence: `textLen=${st.textLen}`, screenshot: `02-reader-${layout}.png` });
      if (st.hOverflow) finding({ id: `ux-reader-${layout}-hoverflow`, severity: 'medium', view: `reader-${layout}`, title: `${layout} 模式横向溢出`, evidence: 'scrollWidth > clientWidth', screenshot: `02-reader-${layout}.png` });
    }

    // ---- 视图 5：问答侧栏（fake-LLM）----
    await win.webContents.executeJavaScript(`window.__store.getState().setAskPanel(true)`);
    await new Promise(r => setTimeout(r, 500));
    await shot(win, '03-ask-panel');
    {
      const ta = await win.webContents.executeJavaScript(`!!document.querySelector('[class*="ask"] textarea, [class*="ask"] input')`);
      if (!ta) finding({ id: 'ux-ask-noinput', severity: 'high', view: 'ask', title: '问答输入框缺失', evidence: 'no textarea/input', screenshot: '03-ask-panel.png' });
      log(`view ask: input=${ta}`);
    }

    // ---- 视图 6：复习页 ----
    await win.webContents.executeJavaScript(`window.__store.getState().setView('review')`);
    await new Promise(r => setTimeout(r, 700));
    await shot(win, '04-review');
    {
      const st: any = await win.webContents.executeJavaScript(`
        (() => ({ hasCard: !!document.querySelector('.flashcard'), text: document.querySelector('.review-page')?.textContent.slice(0, 50) ?? '' }))()
      `);
      if (!st.hasCard) finding({ id: 'ux-review-empty', severity: 'high', view: 'review', title: '到期闪卡未显示', evidence: `text=${st.text}`, screenshot: '04-review.png' });
      log(`view review: card=${st.hasCard}`);
    }

    // ---- 视图 7：命令面板 ----
    await win.webContents.executeJavaScript(`window.__store.getState().setState ? null : window.__store.setState({ paletteOpen: true })`);
    await new Promise(r => setTimeout(r, 400));
    await shot(win, '05-palette');
    {
      const st: any = await win.webContents.executeJavaScript(`
        (() => {
          const items = document.querySelectorAll('.cp-item');
          const mask = document.querySelector('.cp-mask');
          return { items: items.length, hasMask: !!mask };
        })()
      `);
      if (st.items === 0) finding({ id: 'ux-palette-empty', severity: 'medium', view: 'palette', title: '命令面板无候选项', evidence: 'items=0', screenshot: '05-palette.png' });
      // Esc 关闭规则
      await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await new Promise(r => setTimeout(r, 300));
      const closed = await win.webContents.executeJavaScript(`!document.querySelector('.cp-mask')`);
      if (!closed) finding({ id: 'ux-palette-noesc', severity: 'medium', view: 'palette', title: '命令面板 Esc 不关闭', evidence: 'mask still present', screenshot: '05-palette.png' });
      log(`view palette: items=${st.items}, escClose=${closed}`);
    }

    // ---- 视图 8：设置页 ----
    await win.webContents.executeJavaScript(`window.__store.getState().setView('settings')`);
    await new Promise(r => setTimeout(r, 700));
    await shot(win, '06-settings');
    {
      const st: any = await win.webContents.executeJavaScript(`
        (() => {
          const txt = document.body.textContent;
          return { hasProvider: txt.includes('ux-audit'), noKeyLeak: !txt.includes('enc-x'), hasForm: !!document.querySelector('input, select') };
        })()
      `);
      if (!st.hasProvider) finding({ id: 'ux-settings-noprovider', severity: 'high', view: 'settings', title: 'Provider 未列出', evidence: 'ux-audit provider missing' });
      if (!st.noKeyLeak) finding({ id: 'ux-settings-keyleak', severity: 'high', view: 'settings', title: 'API key 明文泄露', evidence: 'raw key visible' });
      log(`view settings: provider=${st.hasProvider}, keySafe=${st.noKeyLeak}`);
    }

    // ---- 探针汇总 ----
    const renderErrors: any[] = await win.webContents.executeJavaScript(`window.__uxProbeErrors ?? []`);
    const allErrors = [...renderErrors, ...probeErrors.filter(e => !/favicon|net::ERR|ECONNREFUSED|localhost:9/i.test(e.msg))];
    if (allErrors.length > 0) {
      finding({ id: 'ux-runtime-errors', severity: 'high', view: 'golden-journey', title: `运行时错误 ${allErrors.length} 个`, evidence: JSON.stringify(allErrors.slice(0, 5)) });
    }
    log(`probe errors: render=${renderErrors.length}, console=${probeErrors.length} (filtered ${allErrors.length})`);

    log('UX AUDIT DONE');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
    log('UX AUDIT FAIL');
  }
  finish();
  setTimeout(() => app.quit(), 200);
});
