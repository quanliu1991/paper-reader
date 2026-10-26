// E2E：右栏重复检测 + 滚动同步误差 ≤50px（PR_DEDUP_E2E 入口，由 main.ts require）
// 数据：fixture 论文 + 每段注入唯一中文译文（直接写 db，绕过 LLM，使「重复」100% 可判定）
// A. 右栏文字重复检测：
//    A1 滑窗 5 段两两比对 ≥20 字符完全重复字串（同段译文渲染两次 → 必现重复对）
//    A2 段内自重复（前缀 20 字符窗口在段内再次出现 → 段内排版重复）
// B. 滚动同步误差（用户硬性标准 ≤50px）：
//    左→右：左栏滚到页 N 顶部 → 同步后，右栏首个 [data-page=N] 段的 rect.top
//           与左栏页 N 的 rect.top 之差即误差（同视口坐标系，直接可比）
//    右→左：右栏滚到页 N 首段 → 同步后，左栏页 N rect.top vs 右栏该段 rect.top
//    稳定性：同步落定后 600ms 二次采样，漂移 ≤2px（无 ping-pong 拉扯）
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
    // ---- 种子：fixture 论文 + 唯一译文 ----
    const parsed = arxiv.parseArxivHtml(fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8'), '2609.34683');
    const paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'html' });
    db.insertBlocks(paperId, parsed.blocks);
    const pdfsDir = path.join(process.env.PR_USER_DATA_ROOT ? '' : '', '');
    const pdfDir = path.join(require('electron').app.getPath('userData'), 'pdfs');
    fs.mkdirSync(pdfDir, { recursive: true });
    const seedPdf = path.resolve('build/test-paper.pdf');
    if (fs.existsSync(seedPdf)) fs.copyFileSync(seedPdf, path.join(pdfDir, `${paperId}.pdf`));
    // 每段注入唯一译文：随机词组拼装（无共享模板串，任何跨段 20 字符重复都只能是渲染重复）
    // 注意：insertBlocks 重分配 pid，必须用 getBlocks 取真实 pid
    const realBlocks = (db.getBlocks(paperId) as any[]).filter(b => b.type !== 'fig');
    const WORDS = ['推理', '显存', '吞吐', '延迟', '批处理', '量化', '并行', '缓存', '解码', '调度', '算子', '梯度', '注意力', '蒸馏', '剪枝', '稀疏', '编译', '流水线', '集群', '降级', '回退', '融合', '压缩', '映射', '对齐', '采样', '核函数', '掩码', '门控', '路由'];
    const rand = (n: number) => Math.floor(Math.random() * n);
    let seeded = 0;
    for (const b of realBlocks) {
      const words = Array.from({ length: 12 }, () => WORDS[rand(WORDS.length)]).join('');
      db.saveTranslation(paperId, b.pid, `第${seeded + 1}段：${words}。这句译文编号${100000 + seeded}，专属段落${b.pid}，绝无重复。`, 'test', 'test');
      seeded++;
    }
    log(`seed: paper=${paperId}, blocks=${parsed.blocks.length}, 译文注入=${seeded}, pdf=${fs.existsSync(path.join(pdfDir, `${paperId}.pdf`))}`);

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
      clusterInfo = await win.webContents.executeJavaScript('window.__dpvClusterDone ?? null');
      if (clusterInfo) break;
      await sleep(500);
    }
    if (!clusterInfo) { log('FATAL: cluster never finished'); pass = false; }
    else {
      log(`cluster: ${JSON.stringify(clusterInfo)}`);

      // ---- 预热：滚完整篇左栏，把懒渲染页全部变成最终高度，消除占位高度漂移 ----
      await win.webContents.executeJavaScript(`
        (async () => {
          const L = document.querySelector('.dpv-left');
          for (let y = 0; y < L.scrollHeight; y += 700) {
            L.scrollTop = y;
            await new Promise(r => setTimeout(r, 120));
          }
          L.scrollTop = 0;
          await new Promise(r => setTimeout(r, 800));
        })()
      `);
      log('warm-up: 左栏全页渲染完成，高度已定型');

      // ---------- A. 右栏重复检测 ----------
      log('[A] 右栏文字重复检测');
      const a: any = await win.webContents.executeJavaScript(`
        (() => {
          const paras = [...document.querySelectorAll('.dpv-right .dpv-zhpara')];
          const texts = paras.map(p => (p.textContent ?? '').replace(/\\s+/g, ' ').trim());
          const dupPairs = [];
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
          const selfDup = [];
          for (let i = 0; i < texts.length; i++) {
            const t = texts[i];
            if (t.length < 60) continue;
            const w20 = t.slice(0, 20);
            if (t.indexOf(w20, 20) !== -1) selfDup.push({ i, frag: w20 });
          }
          return { paras: paras.length, dupCount: dupPairs.length, dupPairs: dupPairs.slice(0, 5), selfDupCount: selfDup.length, selfDup: selfDup.slice(0, 5) };
        })()
      `);
      log('  段数=' + a.paras + ', 跨段重复=' + a.dupCount + ', 段内自重复=' + a.selfDupCount);
      if (a.dupCount > 0) log('  跨段重复样例: ' + JSON.stringify(a.dupPairs));
      if (a.selfDupCount > 0) log('  段内自重复样例: ' + JSON.stringify(a.selfDup));
      const aOk = a.dupCount === 0 && a.selfDupCount === 0 && a.paras === seeded;
      log('[A] 右栏重复检测: ' + (aOk ? 'PASS' : 'FAIL'));
      if (!aOk) pass = false;

      // ---------- B. 滚动同步误差 ----------
      log('[B] 滚动同步误差（阈值 50px，视口坐标系 rect.top 直接相减）');
      const b2: any = await win.webContents.executeJavaScript(`
        (async () => {
          const L = document.querySelector('.dpv-left'), R = document.querySelector('.dpv-right');
          if (!L || !R) return { ok: false, reason: 'no panes' };
          const TOL = 50;
          const domPage = n => L.querySelector('.pdf-page[data-page="' + n + '"]');
          const domPara = n => R.querySelector('.dpv-zhpara[data-page="' + n + '"]');
          // 动态取有页锚的页（跳过无映射段的页），前/中/后各采样
          const anchored = [...new Set([...R.querySelectorAll('.dpv-zhpara[data-page]')].map(p => Number(p.dataset.page)))].sort((x, y) => x - y);
          const pick = arr => arr.filter(n => n).slice(0, 6);
          const lPages = pick([anchored[1], anchored[2], anchored[Math.floor(anchored.length / 2)], anchored[anchored.length - 3], anchored[anchored.length - 2], anchored[anchored.length - 1]]);
          const rPages = pick([anchored[2], anchored[3], anchored[Math.floor(anchored.length / 2) + 1], anchored[anchored.length - 4], anchored[anchored.length - 2], anchored[anchored.length - 1]]);
          const samples = [];
          // B1 左→右
          for (const pg of lPages) {
            const pageEl = domPage(pg);
            if (!pageEl) continue;
            L.scrollTop = pageEl.getBoundingClientRect().top - L.getBoundingClientRect().top + L.scrollTop - 10;
            L.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 1400));
            const paraEl = domPara(pg);
            if (!paraEl) { samples.push({ dir: 'L2R', pg, err: null, note: 'no para' }); continue; }
            const err = Math.round(paraEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top);
            samples.push({ dir: 'L2R', pg, err, within: Math.abs(err) <= TOL });
          }
          // B2 右→左
          for (const pg of rPages) {
            const paraEl = domPara(pg);
            if (!paraEl) continue;
            R.scrollTop = paraEl.getBoundingClientRect().top - R.getBoundingClientRect().top + R.scrollTop - 10;
            R.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 1400));
            const pageEl = domPage(pg);
            if (!pageEl) { samples.push({ dir: 'R2L', pg, err: null, note: 'no page' }); continue; }
            const err = Math.round(paraEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top);
            samples.push({ dir: 'R2L', pg, err, within: Math.abs(err) <= TOL });
          }
          // B3 稳定性：落定后 600ms 二次采样漂移 ≤2px
          L.scrollTop = Math.round(L.scrollHeight * 0.5);
          L.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 1500));
          const s1 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
          await new Promise(r => setTimeout(r, 600));
          const s2 = { l: Math.round(L.scrollTop), r: Math.round(R.scrollTop) };
          const stable = Math.abs(s2.l - s1.l) <= 2 && Math.abs(s2.r - s1.r) <= 2;
          const ok = samples.length >= 6 && samples.every(s => s.within === true) && stable;
          return { anchored: anchored.length, samples, stable, s1, s2, ok };
        })()
      `);
      log('  页锚总数=' + (b2.anchored ?? '?'));
      for (const s of (b2.samples ?? [])) log('  ' + JSON.stringify(s));
      log('  稳定性: stable=' + b2.stable + ' (' + JSON.stringify(b2.s1) + ' -> ' + JSON.stringify(b2.s2) + ')');
      log('[B] 滚动同步误差: ' + (b2.ok ? 'PASS' : 'FAIL'));
      if (!b2.ok) pass = false;
    }
    log(pass ? 'DEDUP-SCROLL ALL PASS' : 'DEDUP-SCROLL FAIL');
  } catch (e: any) {
    log('FATAL: ' + (e?.stack ?? e));
    pass = false;
  } finally {
    fs.writeFileSync(doneFile, pass ? '1' : '0');
  }
}
