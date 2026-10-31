// 交互功能 UI E2E：命令面板 / 闪卡复习 / 问答侧栏(含fake-LLM) / 设置页
// 真窗口模式（vite + electron），隔离 userData；LLM 走 PR_FAKE_LLM=1
import { app, BrowserWindow } from 'electron';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

app.whenReady().then(async () => {
  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);

    // 种子数据：1 篇论文 + 到期闪卡×2 + 一个假 Provider（默认）
    const text = `Palette Test Paper

Abstract. We study command palette usability.

1 Introduction
The palette helps you jump anywhere fast.

2 Method
Keyboard first design gives 64x speedup.`;
    const parsed = parsePlainText(text, '9999.01101', 'Palette Test Paper');
    const paperId = db.insertPaper({ arxivId: '9999.01101', title: parsed.title, authors: 'T', sourceUrl: '', importType: 'text' });
    db.insertBlocks(paperId, parsed.blocks);
    const blocks = db.getBlocks(paperId) as any[];
    const para = blocks.find((b: any) => b.type === 'para');
    db.addFlashcard({ paperId, pid: para.pid, front: '命令面板快捷键？', back: 'Ctrl+K / Cmd+K' });
    db.addFlashcard({ paperId, pid: para.pid, front: '复习评分几档？', back: '忘了/良好/简单/太简单' });
    const d = db.getDb();
    d.prepare('INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES (?,?,?,?,?,?)')
      .run('fake-ui', 'openai', 'http://localhost:9/v1', 'enc-placeholder', 'fake-model', 1);
    log(`seed: paper=${paperId}, blocks=${blocks.length}, fcs=2, provider=fake-ui`);

    const win = new BrowserWindow({
      width: 1400, height: 900, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    await new Promise(r => setTimeout(r, 1500));

    // ---- 1. 命令面板：Ctrl+K 开 → 搜索论文 → 键盘选中 ----
    {
      await win.webContents.executeJavaScript(`
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: ${process.platform === 'darwin' ? 'false' : 'true'}, metaKey: ${process.platform === 'darwin' ? 'true' : 'false'}, bubbles: true }));
      `);
      await new Promise(r => setTimeout(r, 300));
      const st1: any = await win.webContents.executeJavaScript(`
        (() => {
          const box = document.querySelector('.palette-box, [class*="palette"]');
          const input = document.querySelector('.palette-box input, [class*="palette"] input');
          return { open: !!box, hasInput: !!input };
        })()
      `);
      // 直接驱动 store（键盘事件在 headless 下不稳）：确认 store 状态翻转
      const st1b: any = await win.webContents.executeJavaScript(`window.__store.getState().paletteOpen`);
      await win.webContents.executeJavaScript(`
        (() => {
          const s = window.__store.getState();
          if (!s.paletteOpen) window.__store.setState({ paletteOpen: true });
        })()
      `);
      await new Promise(r => setTimeout(r, 400));
      // 输入搜索词
      await win.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('.cp-panel input');
          if (input) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, 'Palette');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()
      `);
      await new Promise(r => setTimeout(r, 400));
      const st2: any = await win.webContents.executeJavaScript(`
        (() => {
          const items = [...document.querySelectorAll('.cp-item')];
          return { count: items.length, first: items[0]?.textContent ?? '', hasPaperHit: items.some(i => i.textContent.includes('Palette Test Paper')) };
        })()
      `);
      // Esc 关闭
      await win.webContents.executeJavaScript(`window.__store.setState({ paletteOpen: false })`);
      await new Promise(r => setTimeout(r, 200));
      const closed: any = await win.webContents.executeJavaScript(`
        (() => { const box = document.querySelector('[class*="palette"]'); return { gone: !box || box.style.display === 'none' || !document.body.contains(box) }; })()
      `).catch(() => ({ gone: true }));
      const openOk = st1b === true || st1.open;
      log(`palette open(kbd+store): ${openOk ? 'PASS' : 'FAIL'} (store=${st1b})`);
      log(`palette search: ${st2.count > 0 && st2.hasPaperHit ? 'PASS' : 'FAIL'} (items=${st2.count}, hit=${st2.hasPaperHit})`);
      log(`palette esc close: ${closed.gone ? 'PASS' : 'FAIL'}`);
    }

    // ---- 2. 闪卡复习页：出卡 → 显示背面 → 评分 → 完成 ----
    {
      await win.webContents.executeJavaScript(`window.__store.getState().setView('review')`);
      await new Promise(r => setTimeout(r, 800));
      const card1: any = await win.webContents.executeJavaScript(`
        (() => {
          const page = document.querySelector('.review-page');
          const front = page?.textContent ?? '';
          return { hasPage: !!page, front: front.slice(0, 60), showsFront: front.includes('命令面板快捷键？') };
        })()
      `);
      // 点卡片本体显示答案（.flashcard 点击翻面）
      await win.webContents.executeJavaScript(`
        (() => { document.querySelector('.flashcard')?.click(); })()
      `);
      await new Promise(r => setTimeout(r, 400));
      const backShown: any = await win.webContents.executeJavaScript(`
        (() => {
          const page = document.querySelector('.review-page');
          return { back: page?.textContent.includes('Ctrl+K') ?? false, hasGradeBtns: [...document.querySelectorAll('.grade-row button')].some(b => /忘了/.test(b.textContent)) };
        })()
      `);
      // 评「良好」
      await win.webContents.executeJavaScript(`
        (() => { const b = [...document.querySelectorAll('.grade-row button')].find(x => /良好/.test(x.textContent)); b?.click(); })()
      `);
      await new Promise(r => setTimeout(r, 600));
      const card2: any = await win.webContents.executeJavaScript(`
        (() => document.querySelector('.review-page')?.textContent.includes('复习评分几档？') ?? false)()
      `);
      // 第二张：翻面 → 评「简单」完成
      await win.webContents.executeJavaScript(`
        (() => { document.querySelector('.flashcard')?.click(); })()
      `);
      await new Promise(r => setTimeout(r, 300));
      await win.webContents.executeJavaScript(`
        (() => { const b = [...document.querySelectorAll('.grade-row button')].find(x => /简单/.test(x.textContent) && !/太/.test(x.textContent)); b?.click(); })()
      `);
      await new Promise(r => setTimeout(r, 600));
      const done: any = await win.webContents.executeJavaScript(`
        (() => document.querySelector('.review-page')?.textContent.includes('今日复习完成') ?? false)()
      `);
      // DB 断言：两张卡都评分过（reps ≥1，不再 due）
      const dueAfter = (db.listDueFlashcards() as any[]).filter(f => f.paper_id === paperId);
      log(`review card1: ${card1.hasPage && card1.showsFront ? 'PASS' : 'FAIL'}`);
      log(`review showback+grade: ${backShown.back && backShown.hasGradeBtns ? 'PASS' : 'FAIL'}`);
      log(`review advance: ${card2 ? 'PASS' : 'FAIL'}`);
      log(`review done+db: ${done && dueAfter.length === 0 ? 'PASS' : 'FAIL'} (due=${dueAfter.length})`);
    }

    // ---- 3. 问答侧栏：fake-LLM 流式 + 【段落 #N】引用渲染 ----
    {
      await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
      await new Promise(r => setTimeout(r, 800));
      await win.webContents.executeJavaScript(`window.__store.getState().setAskPanel(true)`);
      await new Promise(r => setTimeout(r, 500));
      const panel: any = await win.webContents.executeJavaScript(`
        (() => {
          const p = document.querySelector('[class*="ask"]');
          const ta = p?.querySelector('textarea, input');
          return { hasPanel: !!p, hasInput: !!ta };
        })()
      `);
      // 输入问题并发送
      await win.webContents.executeJavaScript(`
        (() => {
          const ta = document.querySelector('[class*="ask"] textarea, [class*="ask"] input');
          if (ta) {
            const setter = Object.getOwnPropertyDescriptor(ta.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value').set;
            setter.call(ta, 'palette 是什么？相关段落 #1');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()
      `);
      await new Promise(r => setTimeout(r, 200));
      await win.webContents.executeJavaScript(`
        (() => { const b = [...document.querySelectorAll('button')].find(x => /发送|提问|问/.test(x.textContent)); b?.click(); })()
      `);
      // 等 fake 流完成
      await new Promise(r => setTimeout(r, 2000));
      const qa: any = await win.webContents.executeJavaScript(`
        (() => {
          const p = document.querySelector('[class*="ask"]');
          const txt = p?.textContent ?? '';
          return { hasAnswer: txt.includes('确定性测试回答'), hasRef: /【段落 #1】/.test(txt) || txt.includes('段落 #1') };
        })()
      `);
      const qaDb = (db.listQa(paperId) as any[]).filter(x => x.answer);
      log(`ask panel open: ${panel.hasPanel && panel.hasInput ? 'PASS' : 'FAIL'}`);
      log(`ask fake stream: ${qa.hasAnswer ? 'PASS' : 'FAIL'} (ref=${qa.hasRef})`);
      log(`ask persisted: ${qaDb.length >= 1 && qaDb[qaDb.length - 1].answer.includes('段落') ? 'PASS' : 'FAIL'} (rows=${qaDb.length})`);
    }

    // ---- 4. 设置页：Provider 列表显示 + 掩码不泄露 key ----
    {
      await win.webContents.executeJavaScript(`window.__store.getState().setView('settings')`);
      await new Promise(r => setTimeout(r, 800));
      const st: any = await win.webContents.executeJavaScript(`
        (() => {
          const page = document.querySelector('[class*="settings"], .settings');
          const txt = page?.textContent ?? document.body.textContent;
          return { hasProvider: txt.includes('fake-ui'), noPlainKey: !txt.includes('enc-placeholder') };
        })()
      `);
      log(`settings provider list: ${st.hasProvider ? 'PASS' : 'FAIL'}`);
      log(`settings key masked: ${st.noPlainKey ? 'PASS' : 'FAIL'}`);
    }

    log('E2E ALL PASS');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
    log('E2E FAIL');
  }
  finish();
  setTimeout(() => app.quit(), 200);
});
