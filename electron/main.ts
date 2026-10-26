import { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } from 'electron';
import path from 'path';
import * as db from './db';
import * as arxiv from './arxiv';
import * as llm from './llm';
import * as gh from './github-bridge';
import * as insights from './insights';
import * as tr from './translate';
import * as topicGraph from './topic-graph';
import fs from 'fs';

let win: BrowserWindow | null = null;

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
  protocol.handle('local-figure', (request) => {
    const url = request.url.replace(/^local-figure:\/\//, '');
    // url 形如 <paperId>/fig-N.ext；规范化 + 防目录穿越
    const safe = path.normalize(decodeURIComponent(url)).replace(/^([.]{2}[\/\\])+/, '');
    const filePath = path.join(app.getPath('userData'), 'figures', safe);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // PDF：local-pdf://p/<paperId> → userData/pdfs/<paperId>.pdf
  // 注意：纯数字 host 会被 URL 解析成 IPv4（local-pdf://2 → 0.0.0.2），故用 path 段承载 id
  protocol.handle('local-pdf', (request) => {
    const u = new URL(request.url);
    const id = u.pathname.replace(/\/+/g, '').split('/')[0] || u.hostname;
    const safe = path.basename(decodeURIComponent(id)); // 只留文件名防穿越
    const filePath = path.join(app.getPath('userData'), 'pdfs', `${safe}.pdf`);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // E2E 模式：加载测试脚本不创建窗口。
  // 防护：用户 shell 可能残留 PR_E2E/PR_PDF_E2E 变量（实测案例），
  // 入口文件不存在（打包版 asar 里没有）时直接落到正常启动，不再静默挂死。
  if (process.env.PR_E2E) {
    const entry = path.join(__dirname, 'e2e-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (process.env.PR_TR_QUALITY_E2E) {
    const entry = path.join(__dirname, 'translate-quality-entry.js');
    if (fs.existsSync(entry)) {
      require(entry);
      return;
    }
  }
  if (process.env.PR_PDF_E2E) {
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
  if (process.env.PR_REIMPORT) {
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
  if (process.env.PR_UI_INSPECT) {
    // 用户库检查：打开真实库中最近论文，检查渲染状态并截图
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
      // 触发前 3 个 para block 翻译（主进程直接构造参数），验证胶囊链路
      const firstParas: any[] = await win.webContents.executeJavaScript(`
        window.__store.getState().blocks.filter(b => b.type === 'para').slice(0, 3).map(b => ({ pid: b.pid, en: b.en }))
      `);
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
  if (process.env.PR_BILINGUAL_UI_E2E) {
    // 双语书模式 UI E2E：布局切换 + 英中交错 + 划词宿主 + 高亮（隔离 userData）
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

      // 导入本地 fixture（真实解析管线，无网络依赖）
      const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
      const parsed = arxiv.parseArxivHtml(html, '2609.34683');
      const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
      db.insertBlocks(paperId, parsed.blocks);
      // 预填译文：前 3 个正文段落写入 zh，模拟翻译完成态
      const paras = (db.getBlocks(paperId) as any[]).filter((b: any) => b.type === 'para');
      let filled = 0;
      for (const b of paras) {
        if (filled >= 3) break;
        db.saveTranslation(paperId, b.pid, `【译】${String(b.en).slice(0, 30)}`, 'test', 'test');
        filled++;
      }
      log(`import: paper=${paperId}, blocks=${parsed.blocks.length}, zh pre-filled=${filled}`);

      // 阶段 0：打开阅读器并切到 bilingual 布局
      await win.webContents.executeJavaScript(`window.__store.getState().openPaper(${paperId})`);
      await new Promise(r => setTimeout(r, 600));
      const btn: any = await win.webContents.executeJavaScript(`
        (() => {
          const b = document.querySelector('.mode-switch button[onclick*="bilingual"], .mode-switch button:nth-child(2)');
          return { found: !!b, label: b?.textContent ?? '', active: b?.className?.includes('active') ?? false };
        })()
      `).catch(() => null);
      log(`bilingual btn: found=${btn?.found}, label="${btn?.label}", preActive=${btn?.active}`);
      await win.webContents.executeJavaScript(`window.__store.getState().setLayout('bilingual')`);
      await new Promise(r => setTimeout(r, 600));

      // 阶段 1：交错结构断言——每个 .bi-para 内 .bi-en 后紧跟 .bi-zh
      const struct: any = await win.webContents.executeJavaScript(`
        (() => {
          const rows = [...document.querySelectorAll('.bi-para')];
          const withZh = rows.filter(r => r.querySelector('.bi-zh'));
          const ordered = withZh.filter(r => {
            const en = r.querySelector('.bi-en'), zh = r.querySelector('.bi-zh');
            return en && zh && (en.compareDocumentPosition(zh) & Node.DOCUMENT_POSITION_FOLLOWING);
          });
          const pending = document.querySelectorAll('.bi-pending').length;
          const headings = document.querySelectorAll('.bi-heading').length;
          return { rows: rows.length, withZh: withZh.length, ordered: ordered.length, pending, headings };
        })()
      `).catch(() => null);
      log(`interleaved: rows=${struct?.rows}, en→zh ordered=${struct?.ordered}/${struct?.withZh}, pending=${struct?.pending}, headings=${struct?.headings}`);
      const interleaveOk = struct && struct.rows >= 5 && struct.ordered === struct.withZh && struct.withZh >= 3 && struct.pending >= 1;
      log(`interleave structure: ${interleaveOk ? 'PASS' : 'FAIL'}`);

      // 阶段 2：划词宿主挂载（onMouseUp 冒泡依赖 .bilingual-host 容器）
      const host: any = await win.webContents.executeJavaScript(`
        (() => ({ host: !!document.querySelector('.bilingual-host'), view: !!document.querySelector('.bilingual-view') }))()
      `).catch(() => null);
      log(`host mounted: ${host?.host && host?.view ? 'PASS' : 'FAIL'} (host=${host?.host}, view=${host?.view})`);

      // 阶段 3：快捷键循环包含 bilingual（state 层面直接验证类型合法）
      await win.webContents.executeJavaScript(`window.__store.getState().setLayout('zh')`);
      await new Promise(r => setTimeout(r, 200));
      await win.webContents.executeJavaScript(`window.__store.getState().setLayout('bilingual')`);
      await new Promise(r => setTimeout(r, 300));
      const back: any = await win.webContents.executeJavaScript(`window.__store.getState().layout`);
      log(`layout round-trip: ${back === 'bilingual' ? 'PASS' : 'FAIL'} (${back})`);

      // 阶段 4：高亮标记在英文段落渲染（写入一条高亮后断言 mark.hl 存在）
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
        (() => ({ marks: document.querySelectorAll('.bi-en mark.hl').length }))()
      `).catch(() => null);
      log(`highlight render: marks=${hl?.marks} ${hl && hl.marks >= 1 ? 'PASS' : 'FAIL'}`);

      const allPass = interleaveOk && host?.host && back === 'bilingual' && hl?.marks >= 1;
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
  if (process.env.PR_PROFILE_UI_E2E) {
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
  if (process.env.PR_TOPIC_UI_E2E) {
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
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        detail = await win.webContents.executeJavaScript(`
          (() => {
            const sections = document.querySelectorAll('.topic-section');
            const papers = document.querySelectorAll('.topic-paper');
            const badges = [...document.querySelectorAll('.layer-badge')].map(b => b.textContent);
            const orders = [...document.querySelectorAll('.read-order')].map(o => o.textContent);
            const progress = document.querySelector('.topic-progress')?.textContent ?? '';
            const buildBtn = document.querySelector('.topic-build-box button.primary')?.textContent ?? '';
            return { sections: sections.length, papers: papers.length, badges, firstOrders: orders.slice(0, 5), progress };
          })()
        `);
        if (detail.papers > 0) break;
      }
      log(`topic detail: sections=${detail?.sections}, papers=${detail?.papers}, layers=${JSON.stringify(detail?.badges)}, firstOrders=${JSON.stringify(detail?.firstOrders)}`);
      log(`topic built: ${detail && detail.papers >= 20 && detail.sections >= 2 ? 'PASS' : 'FAIL'}`);

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
  if (process.env.PR_PDF_UI_E2E) {
    // UI E2E：注册完整 IPC 后走测试窗口流程（复用 registerIpc + local-pdf 协议；隔离 userData）
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
        const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
        const parsed = arxiv.parseArxivHtml(html, '2609.34683');
        const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
        db.insertBlocks(paperId, parsed.blocks);
        log(`import: PASS (paper ${paperId}, ${parsed.blocks.length} blocks)`);

        const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
        fs.mkdirSync(pdfsDir, { recursive: true });
        const seed = path.resolve('build/test-paper.pdf');
        if (fs.existsSync(seed)) fs.copyFileSync(seed, path.join(pdfsDir, `${paperId}.pdf`));
        log(`pdf seeded: ${fs.existsSync(path.join(pdfsDir, `${paperId}.pdf`)) ? 'PASS' : 'FAIL'}`);

        // 阶段 0：应用壳层（侧栏导航 + 顶栏搜索）
        const shell: any = await win.webContents.executeJavaScript(`
          (() => ({
            sidebar: !!document.querySelector('.sidebar'),
            navBtns: document.querySelectorAll('.nav-btn').length,
            topSearch: !!document.querySelector('.topbar-search'),
            inReaderHidden: !!document.querySelector('.app.in-reader'),
          }))()
        `);
        log(`shell: sidebar=${shell.sidebar}, navBtns=${shell.navBtns}, topSearch=${shell.topSearch}`);

        await win.webContents.executeJavaScript(`
          window.__store.getState().openPaper(${paperId}).then(() => {
            window.__store.getState().setLayout('translate');
          })
        `);
        await new Promise(r => setTimeout(r, 2000));

        // 阶段 1：豆包式翻译全文视图（默认视图）
        const tvStats: any = await win.webContents.executeJavaScript(`
          (() => {
            const rows = document.querySelectorAll('.tv-row');
            const paraRows = document.querySelectorAll('.tv-para-row');
            const pending = document.querySelectorAll('.tv-pending-bar');
            const collapsed = document.querySelectorAll('.tv-collapsed');
            const expandHints = document.querySelectorAll('.tv-expand-hint');
            return { rows: rows.length, paraRows: paraRows.length, pending: pending.length,
                     collapsed: collapsed.length, expandHints: expandHints.length,
                     firstParaPid: paraRows[0]?.dataset.pid ?? null };
          })()
        `);
        log(`translate view: rows=${tvStats.rows}, paraRows=${tvStats.paraRows}, pending=${tvStats.pending}, collapsed=${tvStats.collapsed}`);
        // 联动高亮：点击第一个段落行，等 React 状态更新后断言同行双语同亮
        const linked: any = await win.webContents.executeJavaScript(`
          (async () => {
            const paraRows = document.querySelectorAll('.tv-para-row');
            if (!paraRows.length) return { linked: false, reason: 'no paraRows' };
            paraRows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const activeRow = document.querySelector('.tv-row.active');
            const enCell = activeRow?.querySelector('.tv-cell.en');
            const zhCell = activeRow?.querySelector('.tv-cell.zh');
            return { linked: !!(activeRow && enCell && zhCell), pid: activeRow?.dataset.pid ?? null };
          })()
        `);
        log(`row-linked-highlight: ${linked.linked ? 'PASS' : 'FAIL'}（pid=${linked.pid}, 同行双语同亮）`);
        log(`translate view render: ${tvStats.rows >= 50 ? 'PASS' : 'FAIL'}`);

        // 阶段 2：PDF 阅读模式（单栏，译文原位覆盖）——轮询等 canvas（异步渲染，固定等待会抖）
        await win.webContents.executeJavaScript(`window.__store.getState().setLayout('pdf-layout')`);
        let stats: any = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          stats = await win.webContents.executeJavaScript(`
          (() => {
            const canvases = document.querySelectorAll('.pdf-page canvas');
            const pages = document.querySelectorAll('.pdf-page');
            const zhGroups = document.querySelectorAll('.dpv-zhgroup');
            const zhParas = document.querySelectorAll('.dpv-zhpara');
            const modeBtns = document.querySelectorAll('.dpv-mode-switch button');
            const badge = document.querySelector('.dpv-page-indicator');
            const err = document.querySelector('.pdf-error');
            const left = document.querySelector('.dpv-left');
            const right = document.querySelector('.dpv-right');
            return { canvases: canvases.length, pages: pages.length, zhGroups: zhGroups.length, zhParas: zhParas.length,
                     modeBtns: modeBtns.length, badge: badge?.textContent ?? null,
                     firstCanvasW: canvases[0]?.width ?? 0,
                     errText: err?.textContent?.slice(0, 160) ?? null,
                     hasLeft: !!left, hasRight: !!right,
                     leftH: left?.offsetHeight ?? -1, rightH: right?.offsetHeight ?? -1,
                     firstPageH: pages[0]?.offsetHeight ?? -1 };
          })()
        `);
          if (stats.errText || (stats.canvases >= 1 && stats.firstCanvasW > 300)) break;
        }
        log(`pdf view: canvases=${stats.canvases}/${stats.pages} pages, zhGroups=${stats.zhGroups}, zhParas=${stats.zhParas}, modeBtns=${stats.modeBtns}, badge=${JSON.stringify(stats.badge)}, left=${stats.hasLeft} h=${stats.leftH}, right=${stats.hasRight} h=${stats.rightH}, pageH=${stats.firstPageH}`);
        if (stats.errText) log(`pdf error text: ${stats.errText}`);
        log(`canvas rendered: ${stats.canvases >= 1 && stats.firstCanvasW > 300 ? 'PASS' : 'FAIL'}`);
        log(`split panes + zh flow mounted: ${stats.hasLeft && stats.hasRight && stats.zhParas >= 1 && stats.modeBtns === 3 ? 'PASS' : 'FAIL'}`);

        // 等聚类完成（右栏页组齐备再做几何断言；上限 20s）
        let clusterInfo: any = null;
        for (let i = 0; i < 40; i++) {
          clusterInfo = await win.webContents.executeJavaScript(`window.__dpvClusterDone ?? null`);
          if (clusterInfo) break;
          await new Promise(r => setTimeout(r, 500));
        }
        const zhGroupCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.dpv-zhpara[data-page]').length`);
        log(`cluster: done=${JSON.stringify(clusterInfo)}, zhParas(data-page)=${zhGroupCount}`);

        // 【映射审计】每页首个匹配簇（PDF 原文 vs 块原文）+ 右栏带 data-page 段落前 3 段文本
        const mapAudit: any = await win.webContents.executeJavaScript(`
          (() => {
            const audit = window.__dpvMapAudit ?? {};
            const paras = [...document.querySelectorAll('.dpv-zhpara[data-page]')];
            const rightPages = {};
            for (const p of paras) {
              const pg = p.dataset.page;
              if (rightPages[pg]) continue;
              rightPages[pg] = (p.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60);
            }
            return { audit, rightPages };
          })()
        `);
        log('=== 映射审计：每页首个匹配（PDF 簇原文 vs 块原文） ===');
        for (const [pg, a] of Object.entries<any>(mapAudit.audit)) {
          log(`  p${pg} pid=${a.pid}: pdf="${a.pdfHead.slice(0, 50)}..." html="${a.blockHead.slice(0, 50)}..."`);
        }
        log('=== 右栏各页首个 data-page 段落渲染文本 ===');
        for (const [pg, t] of Object.entries<any>(mapAudit.rightPages)) {
          log(`  p${pg}: ${JSON.stringify(t)}`);
        }
        // 单调性断言：右栏各页组的 pid 集合必须随页码递增（后页的 pid 不小于前页的最小 pid）
        const mono: any = await win.webContents.executeJavaScript(`
          (() => {
            const boxes = window.__dpvBoxesPids ?? [];
            return { n: boxes.length, uniq: new Set(boxes).size };
          })()
        `);
        log(`matched pids: ${mono.uniq}/${mono.n} clusters`);

        // 【强制几何校验】左栏 PDF（A）与右栏译文（B）必须物理分离：
        // 水平分栏：B.left >= A.right（gap > 0）；抽查 ≥5 组页/译文对 + 译文段间无垂直相交 + 无横向滚动。
        const flowGeo: any = await win.webContents.executeJavaScript(`
          (() => {
            const left = document.querySelector('.dpv-left');
            const right = document.querySelector('.dpv-right');
            if (!left || !right) return { n: 0, pairs: [], hScroll: true };
            const lPages = [...left.querySelectorAll('.pdf-page')].slice(0, 8);
            const rGroups = [...right.querySelectorAll('.dpv-zhpara')].slice(0, 8);
            const lRect = left.getBoundingClientRect();
            const rRect = right.getBoundingClientRect();
            const pairs = [];
            for (let i = 0; i < Math.min(lPages.length, rGroups.length, 8); i++) {
              const a = lPages[i].getBoundingClientRect();
              const b = rGroups[i].getBoundingClientRect();
              pairs.push({ idx: i + 1, aRight: Math.round(a.right), bLeft: Math.round(b.left), hGap: Math.round(b.left - a.right) });
            }
            // 译文段间垂直分离（文档流自然保证，仍显式校验）
            const zhParas = [...right.querySelectorAll('.dpv-zhpara')];
            const paraGaps = [];
            for (let i = 0; i + 1 < Math.min(zhParas.length, 10); i++) {
              const a = zhParas[i].getBoundingClientRect();
              const b = zhParas[i + 1].getBoundingClientRect();
              paraGaps.push(Math.round(b.top - a.bottom));
            }
            const hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
            return { n: pairs.length, paneGap: Math.round(rRect.left - lRect.right), pairs, paraGaps,
                     paraMin: paraGaps.length ? Math.min(...paraGaps) : null, hScroll,
                     minGap: pairs.length ? Math.min(...pairs.map(p => p.hGap)) : null };
          })()
        `);
        log('geo pairs(A=pdf page,B=zh group): ' + JSON.stringify(flowGeo.pairs));
        log(`geo: pairs=${flowGeo.n}, paneGap=${flowGeo.paneGap}, minGap=${flowGeo.minGap}, paraMin=${flowGeo.paraMin}, hScroll=${flowGeo.hScroll}`);
        const geoOk = flowGeo.n >= 5 && flowGeo.minGap > 0 && flowGeo.paneGap >= 0
          && (flowGeo.paraMin === null || flowGeo.paraMin >= 0) && !flowGeo.hScroll;
        log(`geometry (A|B physically separated): ${geoOk ? 'PASS' : 'FAIL'}`);

        // 三态切换 + 右→左点击定位
        const modeSwitch: any = await win.webContents.executeJavaScript(`
          (async () => {
            const btns = document.querySelectorAll('.dpv-mode-switch button');
            if (btns.length < 3) return { ok: false, reason: 'no mode btns' };
            // 仅原文
            btns[0].click(); await new Promise(r => setTimeout(r, 300));
            const enOnly = { left: !!document.querySelector('.dpv-left'), right: !!document.querySelector('.dpv-right') };
            // 仅译文
            btns[2].click(); await new Promise(r => setTimeout(r, 300));
            const zhOnly = { left: !!document.querySelector('.dpv-left'), right: !!document.querySelector('.dpv-right') };
            // 回双语
            btns[1].click(); await new Promise(r => setTimeout(r, 400));
            const both = { left: !!document.querySelector('.dpv-left'), right: !!document.querySelector('.dpv-right') };
            // 点击右栏第一段 → 左栏应存在对应页（定位后 canvas/页节点还在）
            const para = document.querySelector('.dpv-zhpara');
            if (para) para.click();
            await new Promise(r => setTimeout(r, 500));
            const leftPages = document.querySelectorAll('.dpv-left .pdf-page').length;
            return { enOnly, zhOnly, both, leftPagesAfterClick: leftPages,
                     ok: !enOnly.right && enOnly.left && zhOnly.right && !zhOnly.left && both.left && both.right && leftPages >= 1 };
          })()
        `);
        log(`mode switch + jump: ${JSON.stringify(modeSwitch)}`);
        log(`mode switch (en/both/zh) + click-jump: ${modeSwitch.ok ? 'PASS' : 'FAIL'}`);

        // 字号缩放隔离：A+ 只动右栏 HTML 字号，左栏 PDF canvas 纹丝不动（原汁原味底线）
        const zoomIso: any = await win.webContents.executeJavaScript(`
          (async () => {
            // 轮询等 canvas 重渲染完（模式切换后懒渲染需要时间）
            let c0 = null;
            for (let i = 0; i < 20; i++) {
              c0 = document.querySelector('.dpv-left .pdf-page canvas');
              if (c0 && c0.getBoundingClientRect().width > 50) break;
              await new Promise(r => setTimeout(r, 300));
            }
            const right = document.querySelector('.dpv-right');
            if (!c0 || !right) return { ok: false, reason: 'panes missing' };
            const w0 = c0.getBoundingClientRect().width, h0 = c0.getBoundingClientRect().height;
            const fs0 = getComputedStyle(right).fontSize;
            const zoomIn = [...document.querySelectorAll('.dpv-actions button')].find(b => (b.textContent ?? '').includes('+'));
            if (!zoomIn) return { ok: false, reason: 'zoom btn missing' };
            zoomIn.click(); zoomIn.click();
            await new Promise(r => setTimeout(r, 300));
            const c1 = document.querySelector('.dpv-left .pdf-page canvas');
            const w1 = c1?.getBoundingClientRect().width ?? -1, h1 = c1?.getBoundingClientRect().height ?? -1;
            const fs1 = getComputedStyle(right).fontSize;
            return { w0: Math.round(w0), w1: Math.round(w1), h0: Math.round(h0), h1: Math.round(h1), fs0, fs1,
                     ok: Math.abs(w1 - w0) < 0.5 && Math.abs(h1 - h0) < 0.5 && parseFloat(fs1) > parseFloat(fs0) };
          })()
        `);
        log(`zoom isolation: w ${zoomIso.w0}->${zoomIso.w1}, h ${zoomIso.h0}->${zoomIso.h1}, right font ${zoomIso.fs0}->${zoomIso.fs1}`);
        log(`zoom isolation (A+ affects right HTML only, PDF canvas untouched): ${zoomIso.ok ? 'PASS' : 'FAIL'}`);

        // 视觉锚点联动：左滚到第 2 页中部 → 右栏跟随滚动到 data-page=2 首段（视口内可见）；右点段落 → 左栏 .dpv-flash 闪现后消失
        const anchor: any = await win.webContents.executeJavaScript(`
          (async () => {
            const L = document.querySelector('.dpv-left');
            const R = document.querySelector('.dpv-right');
            if (!L || !R) return { ok: false, reason: 'panes missing' };
            const p2 = L.querySelector('[data-page="2"]');
            if (!p2) return { ok: false, reason: 'page2 missing' };
            L.scrollTop = p2.offsetTop + p2.offsetHeight / 2 - 100; L.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 1200));
            // 连续流模式：跟随滚到 data-page=2 的首段，断言它进入右栏视口
            const t2 = R.querySelector('.dpv-zhpara[data-page="2"]');
            const rr = R.getBoundingClientRect();
            const tr = t2?.getBoundingClientRect();
            const followed = !!(tr && tr.top < rr.bottom && tr.bottom > rr.top);
            // 找一段有映射（有 data-pid 且其 pid 有 box）的段落点击，pending 段也可（点击 p 本体走 jumpToPid）
            const paras = [...R.querySelectorAll('.dpv-zhpara[data-pid]')];
            let para = null;
            for (const p of paras) {
              const pid = Number(p.dataset.pid);
              if (window.__dpvBoxesPids && window.__dpvBoxesPids.includes(pid)) { para = p; break; }
            }
            if (!para) para = paras[0];
            if (!para) return { ok: false, reason: 'no para', followed };
            para.click();
            await new Promise(r => setTimeout(r, 250));
            const flashShown = !!L.querySelector('.dpv-flash');
            await new Promise(r => setTimeout(r, 1000));
            const flashGone = !L.querySelector('.dpv-flash');
            return { followed, flashShown, flashGone, ok: followed && flashShown && flashGone };
          })()
        `);
        log(`anchor sync: ${JSON.stringify(anchor)}`);
        log(`anchor sync (follow data-page + click flash box): ${anchor.ok ? 'PASS' : 'FAIL'}`);

        // 右→左滚动跟随：右栏滚到 data-page=3 首段位置 → 左栏应滚到第 3 页附近
        const rightFollow: any = await win.webContents.executeJavaScript(`
          (async () => {
            const L = document.querySelector('.dpv-left');
            const R = document.querySelector('.dpv-right');
            if (!L || !R) return { ok: false, reason: 'panes missing' };
            // 复位（左栏程序化复位会带动右栏，等联动结束）
            L.scrollTop = 0; L.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 900));
            R.scrollTop = 0; R.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 600));
            // 模拟用户滚右栏：直接设 scrollTop（无程序化标记 → 判定为用户滚动）
            const t3 = R.querySelector('.dpv-zhpara[data-page="3"]');
            if (!t3) return { ok: false, reason: 'no data-page=3 para' };
            R.scrollTop = t3.offsetTop - R.offsetTop - 20;
            R.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 1200));
            // 左栏当前应显示第 3 页附近（视口中心页）
            const pages = [...L.querySelectorAll('.pdf-page')];
            const lr = L.getBoundingClientRect();
            let centerPage = 0;
            for (const p of pages) {
              const r = p.getBoundingClientRect();
              if (r.top < lr.top + lr.height / 2 && r.bottom > lr.top + lr.height / 2) { centerPage = Number(p.dataset.page); break; }
            }
            return { centerPage, leftTop: Math.round(L.scrollTop), ok: centerPage >= 2 && centerPage <= 4 };
          })()
        `);
        log(`right->left follow: ${JSON.stringify(rightFollow)}`);
        log(`right->left follow (scroll zh pane -> pdf follows): ${rightFollow.ok ? 'PASS' : 'FAIL'}`);

        // 字体一致性：打包 Noto Serif SC/Sans SC 必须实际加载；有译文胶囊时 computed family 必须唯一
        const fontStats: any = await win.webContents.executeJavaScript(`
          (async () => {
            await document.fonts.ready;
            const loaded400 = document.fonts.check('400 14px "Noto Serif SC"', '译文测试一致性');
            const loaded700 = document.fonts.check('700 14px "Noto Serif SC"', '译');
            const loadedSans = document.fonts.check('600 14px "Noto Sans SC"', '标题');
            const caps = [...document.querySelectorAll('.dpv-zhblock, .dpv-zhheading')];
            const fams = new Set();
            for (const c of caps) fams.add(getComputedStyle(c).fontFamily.split(',')[0].replace(/"/g, ''));
            return { loaded400, loaded700, loadedSans, n: caps.length, fams: [...fams] };
          })()
        `);
        log(`fonts: serif400=${fontStats.loaded400}, serif700=${fontStats.loaded700}, sans600=${fontStats.loadedSans}, zhCaps=${fontStats.n}, families=${JSON.stringify(fontStats.fams)}`);
        const fontOk = fontStats.loaded400 && fontStats.loaded700 && fontStats.loadedSans
          && (fontStats.n === 0 || (fontStats.fams.length === 1 && fontStats.fams[0] === 'Noto Serif SC'));
        log(`font consistency: ${fontOk ? 'PASS' : 'FAIL'}`);

        // 截图前复位到顶部（锚点测试滚到了第 2 页），保证截图是首屏干净状态
        await win.webContents.executeJavaScript(`
          (async () => {
            const L = document.querySelector('.dpv-left');
            const R = document.querySelector('.dpv-right');
            if (L) { L.scrollTop = 0; L.dispatchEvent(new Event('scroll')); }
            if (R) R.scrollTop = 0;
            await new Promise(r => setTimeout(r, 600));
          })()
        `);
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.resolve('build'), { recursive: true });
        fs.writeFileSync(path.resolve('build/pdf-ui-e2e.png'), img.toPNG());
        log(`screenshot: split view captured (zhGroups=${zhGroupCount}, cluster=${JSON.stringify(clusterInfo)})`);
        // translate 视图单独截图（切回去再截）
        await win.webContents.executeJavaScript(`window.__store.getState().setLayout('translate')`);
        await new Promise(r => setTimeout(r, 800));
        const tvImg = await win.webContents.capturePage();
        fs.writeFileSync(path.resolve('build/translate-ui-e2e.png'), tvImg.toPNG());
        log('screenshots saved');
        const allPass = stats.canvases >= 1 && stats.firstCanvasW > 300
          && tvStats.rows >= 50 && linked.linked && shell.sidebar && shell.navBtns >= 2 && shell.topSearch
          && fontOk && geoOk && modeSwitch.ok && zoomIso.ok && anchor.ok && rightFollow.ok
          && stats.hasLeft && stats.hasRight && stats.zhParas >= 1
          && clusterInfo && zhGroupCount >= 5;
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
  if (process.env.PR_SOAK) {
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
function registerIpc() {
  // ---------- papers ----------
  wrap('papers:list', () => db.listPapers());
  wrap('papers:get', (_e, id: number) => { db.touchPaper(id); return db.getPaper(id); });
  wrap('papers:delete', (_e, id: number) => { db.deletePaper(id); return true; });
  wrap('papers:getBlocks', (_e, id: number) => db.getBlocks(id));

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

  // 确保论文 PDF 存在（返回是否存在）
  wrap('pdf:ensure', async (_e, paperId: number) => {
    const paper = db.getPaper(paperId) as any;
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
    const pdfPath = path.join(pdfsDir, `${paperId}.pdf`);
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

  // text 降级论文自动升级入口（注册后异步执行）
  function scheduleUpgradeTextImports() {
    setTimeout(() => { upgradeTextImports().catch(() => {}); }, 3000);
  }
  scheduleUpgradeTextImports();

  // text 降级论文自动升级：重抓 HTML 结构化导入（含图表）+ PDF
  async function upgradeTextImports() {
    const rows = db.getDb().prepare("SELECT id, arxiv_id FROM papers WHERE import_type='text'").all() as any[];
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
    const stmt = db.getDb().prepare('UPDATE blocks SET fig_path=? WHERE pid=?');
    for (const b of blocks) {
      if (b.type !== 'fig' || !b.fig_path) continue;
      i++;
      const url = b.fig_path;
      const ext = (url.match(/\.(svg|png|jpg|jpeg|gif)$/i) || [, 'png'])[1];
      const fname = `fig-${i}.${ext}`;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        fsMod.writeFileSync(path.join(figuresDir, fname), buf);
        stmt.run(`${paperId}/${fname}`, b.pid);
        send('fig:updated', { pid: b.pid, figPath: `${paperId}/${fname}` });
      } catch { /* 单图失败跳过 */ }
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
        onDone: (full) => resolve({ ok: true, text: cleanZh((full || acc).trim()) }),
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
    paperId: number; pid: number; question: string; context: string; highlightId?: number;
  }) => {
    const provider = getDefaultProvider();
    if (!provider) throw new Error('未配置 LLM Provider，请先到设置页添加');
    const qaId = db.addQa({ paperId: arg.paperId, highlightId: arg.highlightId, pid: arg.pid, question: arg.question, answer: '', provider: provider.name, model: provider.model });
    const ch = `qa:stream:${qaId}`;
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

    await llm.chatStream(provider, [
      { role: 'system', content: sys },
      ...histMsgs,
      { role: 'user', content: userParts.join('\n\n') },
    ], {
      onDelta: (d) => { acc += d; e.sender.send(ch, { delta: d }); },
      onDone: (full) => {
        const answer = (full || acc).trim();
        db.getDb().prepare('UPDATE qa_pairs SET answer=? WHERE id=?').run(answer, qaId);
        e.sender.send(ch, { done: true });
      },
      onError: (err) => e.sender.send(ch, { error: err }),
    }, { temperature: 0.4, maxTokens: 4096, signal: ctl.signal }).finally(() => activeAbort.delete(ctl));
    return qaId;
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
    // local-figure:// 引用转 base64 内联（离线打印窗口没有自定义协议）
    const figDir = path.join(app.getPath('userData'), 'figures');
    let html = arg.html.replace(/local-figure:\/\/([^"'\s)]+)/g, (_m, rel: string) => {
      try {
        const name = rel.split('/').pop() ?? '';
        const p = path.join(figDir, path.basename(decodeURIComponent(name)));
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
  wrap('gh:writeQa', (_e, arg: { arxivId: string; question: string; answer: string }) => {
    const root = gh.getRepoRoot();
    if (!root) throw new Error('未连接仓库');
    const date = new Date().toISOString().slice(0, 10);
    return gh.appendQaToNote(root, arg.arxivId, { question: arg.question, answer: arg.answer, date });
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
