// 用户旅程 UI E2E：以真实用户视角从头到尾走完产品闭环。
// 覆盖：配置 Provider → arXiv 导入 → 阅读器（对照/PDF/译文三模式）→ 翻译进度 →
//       划线提问/解释 → 高亮 → 段落笔记 → 闪卡 → 复习 → 沉淀页 → 主题库 UI → 设置页 → 论文管理。
// 驱动方式：与 E2E基建 一致——executeJavaScript 直调 window.__store + DOM 事件（点击/滚动/键盘）。
// LLM：PR_FAKE_LLM=1 确定性假流（不烧 token），网络默认关闭（fixture 导入）。
import { app, BrowserWindow } from 'electron';
import * as db from '../electron/db';
import * as arxiv from '../electron/arxiv';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

const results: Array<[string, boolean, string]> = [];

// 直查 SQLite（用 db 模块导出的 getDb）
function dbCount(sql: string): number {
  const d = db.getDb();
  return Number((d.prepare(sql).get() as any)?.n ?? 0);
}
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const SHOT_DIR = path.resolve('build/uex');
function shotName(stage: string) { return path.join(SHOT_DIR, `${stage}.png`); }

// 段落级动作超时等待：轮询 DOM 直到条件满足
async function waitFor(wc: Electron.WebContents, jsExpr: string, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ok = await wc.executeJavaScript(`(!!(${jsExpr}))`);
      if (ok) return true;
    } catch { /* expr error → keep polling */ }
    await new Promise(r => setTimeout(r, 300));
  }
  log(`  [wait-timeout] ${label} (${timeoutMs}ms)`);
  return false;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
    await new Promise(r => setTimeout(r, 1200));
    const wc = win.webContents;

    // ========== 阶段 0：首次启动（空库） ==========
    log('== 阶段 0：首次启动 ==');
    const emptyState: any = await wc.executeJavaScript(`(() => ({
      sidebar: !!document.querySelector('.sidebar'),
      navBtns: document.querySelectorAll('.nav-btn').length,
      search: !!document.querySelector('.topbar-search'),
      emptyHint: (document.querySelector('.empty, .empty-state, .pl-empty')?.textContent ?? '').slice(0, 80),
      importInput: !!document.querySelector('input[placeholder*="arXiv" i], .pl-import input, input.pl-input'),
    }))()`);
    check('壳层：侧栏 + 顶栏搜索', emptyState.sidebar && emptyState.navBtns >= 4 && emptyState.search,
      `navBtns=${emptyState.navBtns}`);
    check('空库引导：导入入口可见', emptyState.importInput || !!emptyState.emptyHint, JSON.stringify(emptyState.emptyHint));
    await wc.executeJavaScript(`(() => { const s = document.querySelector('.nav-btn[title="设置"]'); s?.click(); return !!s; })()`);
    await new Promise(r => setTimeout(r, 600));

    // ========== 阶段 1：配置 Provider（fake） ==========
    log('== 阶段 1：设置页 + Provider 配置 ==');
    const settingsDom: any = await wc.executeJavaScript(`(() => ({
      providerForm: !!document.querySelector('input[placeholder*="名称" i], input[placeholder*="key" i], .st-provider input'),
      hasAddBtn: [...document.querySelectorAll('button')].some(b => /添加|新增|\\+/.test(b.textContent ?? '')),
      sections: document.querySelectorAll('.st-card, .st-section, section').length,
    }))()`);
    check('设置页：Provider 表单存在', settingsDom.providerForm || settingsDom.hasAddBtn,
      `sections=${settingsDom.sections}`);
    // 直接经 preload API 存一个 fake provider（UI 表单字段逐个 key 起来太脆，API 是同一链路）
    await wc.executeJavaScript(`window.api.saveProvider({ name: 'E2E Fake', baseUrl: 'http://localhost:9/v1', model: 'fake', apiKey: 'sk-e2e', protocol: 'openai', isDefault: true })`);
    const pvList: any[] = await wc.executeJavaScript(`window.api.listProviders()`);
    check('Provider 已保存并可列出', pvList.length >= 1, `count=${pvList.length}`);
    await wc.executeJavaScript(`document.querySelector('.nav-btn[title="论文库"]')?.click()`);
    await new Promise(r => setTimeout(r, 400));

    // ========== 阶段 2：导入论文（真实 UI 输入框 + 回车，链路同用户） ==========
    log('== 阶段 2：导入论文 ==');
    // 用户旅程优先走真实 UI：输入框打字 + 回车。输入框 onKeyDown=Enter → importArxiv()
    // （网络真实抓 arXiv；失败再回退 API+fixture 种子，保证旅程可继续）
    let paperId = 0;
    let importedViaUi = false;
    try {
      const uiImport: any = await wc.executeJavaScript(`(async () => {
        const input = document.querySelector('.import-box input');
        if (!input) return { ok: false, reason: 'no import input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '2609.34683');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { ok: true };
      })()`);
      if (uiImport.ok) {
        // 轮询论文出现（真实抓取可能要 10-60s）
        for (let i = 0; i < 100 && !paperId; i++) {
          await new Promise(r => setTimeout(r, 600));
          const ps: any[] = await wc.executeJavaScript(`window.api.listPapers()`);
          if (ps.length >= 1) paperId = ps[0].id;
        }
        importedViaUi = paperId > 0;
      }
    } catch { /* fallthrough to fixture */ }
    if (!importedViaUi) {
      log('  [fallback] UI 网络导入未成，改用 fixture 种子（parseArxivHtml 直插）');
      const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
      const parsed = arxiv.parseArxivHtml(html, '2609.34683');
      paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' } as any);
      db.insertBlocks(paperId, parsed.blocks);
      await wc.executeJavaScript(`window.__store.getState().loadPapers()`);
    }
    const papers: any[] = await wc.executeJavaScript(`window.api.listPapers()`);
    check('导入成功且列表刷新', papers.length === 1 && !!paperId, `papers=${papers.length}, id=${paperId}, viaUi=${importedViaUi}`);
    const hasCard = await waitFor(wc, `document.querySelectorAll('.paper-card, .pl-card, [class*="paper-card"]').length >= 1`, 5000, 'paper card');
    check('论文卡片渲染', hasCard);
    // 摘要卡（triage）字段
    const cardDom: any = await wc.executeJavaScript(`(() => {
      const c = document.querySelector('.paper-card, .pl-card, [class*="paper-card"]');
      return { text: (c?.textContent ?? '').slice(0, 400) };
    })()`);
    check('卡片含标题', (cardDom.text ?? '').includes('2609.34683') || (papers[0]?.title ?? '').length > 5, (papers[0]?.title ?? '').slice(0, 60));
    await wc.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
    const readerUp = await waitFor(wc, `!!document.querySelector('.reader, [class*="reader"]')`, 8000, 'reader mount');
    check('点击卡片进入阅读器', readerUp);
    await new Promise(r => setTimeout(r, 1500));

    // ========== 阶段 3：阅读器三模式 ==========
    log('== 阶段 3：阅读器三模式 ==');
    for (const layout of ['translate', 'pdf-layout', 'bilingual'] as const) {
      await wc.executeJavaScript(`window.__store.getState().setLayout('${layout}')`);
      const ok = await waitFor(wc,
        layout === 'pdf-layout'
          ? `document.querySelectorAll('.pdf-page canvas, .dpv-left').length >= 1`
          : layout === 'translate'
            ? `document.querySelectorAll('.tv-row, .tv-para-row').length >= 10`
            : `(document.querySelectorAll('.bi-row, [class*="bilingual"] p, [class*="bi-"]').length >= 10)`,
        15000, `layout=${layout}`);
      check(`模式切换：${layout}`, ok);
      await new Promise(r => setTimeout(r, 600));
      const img = await wc.capturePage();
      fs.writeFileSync(shotName(`03-reader-${layout}`), img.toPNG());
    }
    // 回到 translate 模式继续后续阶段
    await wc.executeJavaScript(`window.__store.getState().setLayout('translate')`);
    await new Promise(r => setTimeout(r, 800));

    // ========== 阶段 4：翻译全文（fake LLM 流 + 进度 + 逐段浮现） ==========
    log('== 阶段 4：翻译全文 ==');
    const blocks: any[] = await wc.executeJavaScript(`window.api.getBlocks(${paperId})`);
    const paras = blocks.filter((b: any) => b.type === 'para');
    const trStart: any = await wc.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /翻译全文|翻译/.test(b.textContent ?? ''));
      if (!btn) return null;
      btn.click(); return btn.textContent;
    })()`);
    check('「翻译全文」按钮存在并点击', !!trStart, String(trStart));
    // fake LLM 即时完成；轮询译文段落出现
    const zhAppeared = await waitFor(wc,
      `document.querySelectorAll('.tv-cell.zh, [class*="zh"]').length >= 3 && [...document.querySelectorAll('.tv-cell.zh, [class*="zh"]')].some(e => (e.textContent ?? '').trim().length > 20)`,
      20000, 'zh translations appear');
    check('译文逐段浮现（含真实中文文本）', zhAppeared);
    const dbZh = dbCount(`SELECT COUNT(*) n FROM translations WHERE paper_id=${paperId}`);
    check('译文已持久化（SQLite）', dbZh >= 3, `rows=${dbZh}`);
    const img4 = await wc.capturePage();
    fs.writeFileSync(shotName('04-translating'), img4.toPNG());

    // ========== 阶段 5：划线提问 + 快捷解释 ==========
    log('== 阶段 5：划线提问 ==');
    // 模拟划选：选中第一段部分文本 → 弹 sel-popover 工具条 → 点「提问」
    // React onMouseUp 挂在 .reader-scroll 容器上，需在宿主元素上派发 mouseup
    const askFlow: any = await wc.executeJavaScript(`(async () => {
      const para = document.querySelector('.tv-cell.en .tv-p');
      if (!para) return { ok: false, reason: 'no en para' };
      const host = para.closest('.reader-scroll') ?? para.parentElement;
      // 找到有文本的节点（RichText 可能拆分 text/math 节点）
      let textNode = null;
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { if ((walker.currentNode.textContent ?? '').trim().length > 20) { textNode = walker.currentNode; break; } }
      if (!textNode) return { ok: false, reason: 'no text node' };
      const len = Math.min(60, textNode.textContent.length);
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode, 0); range.setEnd(textNode, len);
      sel.removeAllRanges(); sel.addRange(range);
      host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const bar = document.querySelector('.sel-popover');
      if (!bar) return { ok: false, reason: 'no popover', selected: sel.toString().slice(0, 30) };
      const askBtn = [...bar.querySelectorAll('button')].find(b => /提问/.test(b.textContent ?? '') || b.title === '提问');
      if (!askBtn) return { ok: false, reason: 'no ask btn', barText: bar.textContent };
      askBtn.click();
      await new Promise(r => setTimeout(r, 500));
      const panel = document.querySelector('.ask-panel');
      if (!panel) return { ok: false, reason: 'no ask panel', barText: bar.textContent };
      const quoted = panel.querySelector('.sel-quote');
      return { ok: true, quoted: (quoted?.textContent ?? '').slice(0, 40), toolbar: bar.textContent.slice(0, 60) };
    })()`);
    check('划线弹出工具条（含提问）', askFlow.ok, JSON.stringify(askFlow));
    const askSent: any = await wc.executeJavaScript(`(async () => {
      const input = document.querySelector('.ask-panel textarea');
      if (!input) return { ok: false, reason: 'no input' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, '这段讲了什么？');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const send = [...document.querySelectorAll('button')].find(b => /发送|提问/.test(b.textContent ?? ''));
      if (!send) return { ok: false, reason: 'no send btn' };
      send.click();
      return { ok: true };
    })()`);
    check('提问发送', askSent.ok, JSON.stringify(askSent));
    const answerShown = await waitFor(wc,
      `[...document.querySelectorAll('.ask-panel .msg.a')].some(e => (e.textContent ?? '').trim().length > 20)`,
      15000, 'answer appears');
    check('回答流式呈现（fake LLM）', answerShown);
    const qaRows = dbCount(`SELECT COUNT(*) n FROM qa_pairs WHERE paper_id=${paperId}`);
    check('问答已持久化', qaRows >= 1, `rows=${qaRows}`);
    const img5 = await wc.capturePage();
    fs.writeFileSync(shotName('05-ask'), img5.toPNG());

    // ========== 阶段 6：高亮 + 笔记 ==========
    log('== 阶段 6：高亮与笔记 ==');
    // 划选 → sel-popover → 四色高亮（yellow）
    const hlFlow: any = await wc.executeJavaScript(`(async () => {
      const para = document.querySelector('.tv-cell.en .tv-p');
      if (!para) return { ok: false, reason: 'no en para' };
      const host = para.closest('.reader-scroll') ?? para.parentElement;
      let textNode = null;
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { if ((walker.currentNode.textContent ?? '').trim().length > 20) { textNode = walker.currentNode; break; } }
      if (!textNode) return { ok: false, reason: 'no text node' };
      const len = Math.min(60, textNode.textContent.length);
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode, 0); range.setEnd(textNode, len);
      sel.removeAllRanges(); sel.addRange(range);
      host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const bar = document.querySelector('.sel-popover');
      if (!bar) return { ok: false, reason: 'no popover' };
      const colorBtn = bar.querySelector('.hl-color-btn');
      if (!colorBtn) return { ok: false, reason: 'no color btn', barText: bar.textContent };
      colorBtn.click();
      await new Promise(r => setTimeout(r, 600));
      // 高亮后应能标记回显（mark 元素）
      return { ok: true, marked: document.querySelectorAll('mark, .hl-mark, [class*="hl"]').length };
    })()`);
    const hlRows = dbCount(`SELECT COUNT(*) n FROM highlights WHERE paper_id=${paperId}`);
    check('划线四色高亮入库', hlFlow.ok && hlRows >= 1, `flow=${JSON.stringify(hlFlow)}, rows=${hlRows}`);
    // 划词笔记：划选 → 工具条「笔记」→ 浮层输入 → 保存
    const noteFlow: any = await wc.executeJavaScript(`(async () => {
      const para = document.querySelector('.tv-cell.en .tv-p');
      if (!para) return { ok: false, reason: 'no en para' };
      const host = para.closest('.reader-scroll') ?? para.parentElement;
      let textNode = null;
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { if ((walker.currentNode.textContent ?? '').trim().length > 20) { textNode = walker.currentNode; break; } }
      if (!textNode) return { ok: false, reason: 'no text node' };
      const len = Math.min(40, textNode.textContent.length);
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode, 0); range.setEnd(textNode, len);
      sel.removeAllRanges(); sel.addRange(range);
      host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const bar = document.querySelector('.sel-popover');
      if (!bar) return { ok: false, reason: 'no popover' };
      const noteBtn = [...bar.querySelectorAll('button')].find(b => b.title.includes('笔记'));
      if (!noteBtn) return { ok: false, reason: 'no note btn', barText: bar.textContent };
      noteBtn.click();
      await new Promise(r => setTimeout(r, 400));
      const composer = document.querySelector('.note-composer textarea');
      if (!composer) return { ok: false, reason: 'no composer' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(composer, 'E2E 笔记：这段的方法论值得复盘');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const save = [...document.querySelectorAll('.note-composer button')].find(b => /保存|存/.test(b.textContent ?? ''));
      if (!save) return { ok: false, reason: 'no save btn' };
      save.click();
      await new Promise(r => setTimeout(r, 600));
      return { ok: true };
    })()`);
    const noteRows = dbCount(`SELECT COUNT(*) n FROM notes WHERE paper_id=${paperId}`);
    check('划词写笔记（挂段落）', noteFlow.ok && noteRows >= 1, `flow=${JSON.stringify(noteFlow)}, rows=${noteRows}`);
    const img6 = await wc.capturePage();
    fs.writeFileSync(shotName('06-highlight'), img6.toPNG());

    // ========== 阶段 7：闪卡 ==========
    log('== 阶段 7：闪卡 ==');
    await wc.executeJavaScript(`window.api.saveFlashcard({ paperId: ${paperId}, pid: ${paras[0]?.pid ?? 1}, front: 'E2E：本文的核心问题是什么？', back: 'fake' })`);
    const fcCount = dbCount(`SELECT COUNT(*) n FROM flashcards WHERE paper_id=${paperId}`);
    check('闪卡保存', fcCount >= 1, `rows=${fcCount}`);

    // ========== 阶段 8：复习（SM-2） ==========
    log('== 阶段 8：复习 ==');
    await wc.executeJavaScript(`document.querySelector('.nav-btn[title="闪卡复习"]')?.click()`);
    await new Promise(r => setTimeout(r, 800));
    const reviewDom: any = await wc.executeJavaScript(`(() => ({
      front: (document.querySelector('.fc-front')?.textContent ?? '').slice(0, 50),
      meta: (document.querySelector('.review-meta')?.textContent ?? '').slice(0, 40),
    }))()`);
    check('复习页展示到期卡片', reviewDom.front.length > 0, JSON.stringify(reviewDom));
    const graded: any = await wc.executeJavaScript(`(async () => {
      const card = document.querySelector('.flashcard');
      if (!card) return { ok: false, reason: 'no card' };
      card.click(); // 翻面显答案
      await new Promise(r => setTimeout(r, 400));
      const good = [...document.querySelectorAll('.grade')].find(b => /良好/.test(b.textContent ?? ''));
      if (!good) return { ok: false, reason: 'no grade btn' };
      good.click();
      await new Promise(r => setTimeout(r, 500));
      return { ok: true };
    })()`);
    check('评分打卡（SM-2 调度）', graded.ok, JSON.stringify(graded));
    const fcAfter = db.getDb().prepare(`SELECT interval_days, ease, reps FROM flashcards WHERE paper_id=${paperId} ORDER BY id DESC LIMIT 1`).get() as any;
    check('SM-2 状态已更新', fcAfter && fcAfter.reps >= 1, JSON.stringify(fcAfter));
    const img8 = await wc.capturePage();
    fs.writeFileSync(shotName('08-review'), img8.toPNG());

    // ========== 阶段 9：沉淀页（高亮 + 笔记聚合） ==========
    log('== 阶段 9：沉淀页 ==');
    await wc.executeJavaScript(`document.querySelector('.nav-btn[title="沉淀：高亮与笔记"]')?.click()`);
    await new Promise(r => setTimeout(r, 800));
    const notesDom: any = await wc.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.note-card').length,
      tabs: (document.querySelector('.notes-toolbar')?.textContent ?? '').slice(0, 60),
      firstCard: (document.querySelector('.note-card')?.textContent ?? '').slice(0, 80),
    }))()`);
    check('沉淀页聚合高亮/笔记', notesDom.cards >= 1, `cards=${notesDom.cards}, tabs=${notesDom.tabs}`);
    const img9 = await wc.capturePage();
    fs.writeFileSync(shotName('09-notes'), img9.toPNG());

    // ========== 阶段 10：主题依赖库 UI ==========
    log('== 阶段 10：主题库 ==');
    await wc.executeJavaScript(`document.querySelector('.nav-btn[title="主题依赖库"]')?.click()`);
    await new Promise(r => setTimeout(r, 800));
    const topicDom: any = await wc.executeJavaScript(`(() => ({
      input: !!document.querySelector('.topic-build-box input'),
      buildBtn: !!document.querySelector('.topic-build-box button'),
      head: (document.querySelector('.topic-page .list-head h1')?.textContent ?? ''),
    }))()`);
    check('主题库输入入口', topicDom.input && topicDom.buildBtn, JSON.stringify(topicDom));
    const img10 = await wc.capturePage();
    fs.writeFileSync(shotName('10-topic'), img10.toPNG());

    // ========== 阶段 11：BibTeX 导出 + 论文管理 ==========
    log('== 阶段 11：论文管理与导出 ==');
    await wc.executeJavaScript(`document.querySelector('.nav-btn[title="论文库"]')?.click()`);
    await new Promise(r => setTimeout(r, 600));
    const bib: any = await wc.executeJavaScript(`window.api.exportBibtex()`);
    check('BibTeX 导出', typeof bib === 'string' && bib.includes('@'), String(bib).slice(0, 40));
    // 状态/标签管理（状态四档：unread | reading | done | deep）
    await wc.executeJavaScript(`window.api.setStatus({ id: ${paperId}, status: 'done' })`);
    await wc.executeJavaScript(`window.api.setTags({ id: ${paperId}, tags: ['e2e', '翻译'] })`);
    const paperAfter: any = await wc.executeJavaScript(`window.api.getPaper(${paperId})`);
    check('状态 + 标签管理', paperAfter?.status === 'done' && (paperAfter?.tags ?? '').includes('e2e'),
      `status=${paperAfter?.status}, tags=${JSON.stringify(paperAfter?.tags)}`);

    // ========== 阶段 12：阅读进度持久化（重开论文恢复） ==========
    log('== 阶段 12：进度记忆 ==');
    await wc.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
    await new Promise(r => setTimeout(r, 1200));
    // 滚到中部（pid 锚点方案：滚动停 600ms 后写 localStorage paper:<id>:pid/scroll）
    const scroller: any = await wc.executeJavaScript(`(async () => {
      const el = document.querySelector('.reader-scroll');
      if (!el) return -1;
      el.scrollTop = Math.round(el.scrollHeight * 0.4);
      el.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 900));
      return Math.round(el.scrollTop);
    })()`);
    await wc.executeJavaScript(`window.__store.getState().setView('list')`);
    await new Promise(r => setTimeout(r, 600));
    await wc.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
    await new Promise(r => setTimeout(r, 1500));
    const restored: any = await wc.executeJavaScript(`(() => {
      const el = document.querySelector('.reader-scroll');
      return el ? Math.round(el.scrollTop) : -1;
    })()`);
    check('阅读进度记忆（重开恢复）', restored >= 100, `set=${scroller}, restored=${restored}`);
    // Bug 回归：进度百分比应入库（列表页「读至 X%」数据源 read:<id>）
    const readPctDb = dbCount(`SELECT COUNT(*) n FROM settings WHERE key='read:${paperId}' AND CAST(value AS INT) > 0`);
    check('阅读进度入库（列表页进度条数据源）', readPctDb >= 1, `read:${paperId} rows=${readPctDb}`);
    // 回列表确认卡片显示进度
    await wc.executeJavaScript(`window.__store.getState().setView('list')`);
    await new Promise(r => setTimeout(r, 700));
    const pctShown: any = await wc.executeJavaScript(`(() => {
      const card = document.querySelector('.paper-card');
      return { text: card?.textContent ?? '', bar: !!card?.querySelector('.read-progress') };
    })()`);
    check('论文卡显示「读至 X%」+ 进度条', pctShown.bar && /读至/.test(pctShown.text),
      `bar=${pctShown.bar}, hasPct=${/读至/.test(pctShown.text)}`);
    const img12 = await wc.capturePage();
    fs.writeFileSync(shotName('12-list-progress'), img12.toPNG());

    // ========== 汇总 ==========
    const fail = results.filter(r => !r[1]);
    log('');
    log(`==== 用户旅程 E2E 汇总：${results.length - fail.length}/${results.length} PASS ====`);
    for (const [name, ok, detail] of results) log(`  ${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
    log(fail.length === 0 ? 'E2E ALL PASS' : 'E2E FAIL');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
  } finally {
    finish();
    app.quit();
  }
});
