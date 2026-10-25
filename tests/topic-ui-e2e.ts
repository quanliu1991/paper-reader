// 主题依赖库 UI E2E：真实网络构建主题 → 断言分层列表 + 阅读顺序 UI
// 由 tests/topic-ui-e2e.test.mjs 调起（PR_TOPIC_UI_E2E=1）
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import * as db from './db';
import * as arxiv from './arxiv';
import { registerIpc, send } from './ipc-reg';

export async function run() {
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

    // 阶段 2：真实构建一个主题（网络：arXiv + Semantic Scholar）
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
    // 轮询等待构建完成（真实网络 10-40s）
    let detail: any = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      detail = await win.webContents.executeJavaScript(`
        (() => {
          const sections = document.querySelectorAll('.topic-section');
          const papers = document.querySelectorAll('.topic-paper');
          const badges = [...document.querySelectorAll('.layer-badge')].map(b => b.textContent);
          const orders = [...document.querySelectorAll('.read-order')].map(o => o.textContent);
          return { sections: sections.length, papers: papers.length, badges, firstOrders: orders.slice(0, 5), building: !!document.querySelector('.topic-progress') };
        })()
      `);
      if (detail.papers > 0 && !detail.building) break;
    }
    log(`topic detail: sections=${detail.sections}, papers=${detail.papers}, layers=${JSON.stringify(detail.badges)}, firstOrders=${JSON.stringify(detail.firstOrders)}`);
    log(`topic built: ${detail.papers >= 20 && detail.sections >= 2 ? 'PASS' : 'FAIL'}`);

    // 阶段 3：列表页回看主题卡片
    await win.webContents.executeJavaScript(`document.querySelector('.icon-btn[title="返回主题列表"]')?.click()`);
    await new Promise(r => setTimeout(r, 500));
    const list: any = await win.webContents.executeJavaScript(`
      (() => ({
        cards: document.querySelectorAll('.topic-card').length,
        firstCard: document.querySelector('.tc-name')?.textContent ?? null,
        firstMeta: document.querySelector('.tc-meta')?.textContent ?? '',
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
}
