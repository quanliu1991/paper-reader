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
    // 加载源：默认 vite dev（HMR 便于调试）；PR_E2E_LOAD=dist 用 vite build 产物（无 dev server 依赖，
    // 彻底规避 vite 挂死导致的假挂死——2026-11 实测 vite 长跑后 5199 无响应，测试随机卡死）。
    if (process.env.PR_E2E_LOAD === 'dist') {
      await win.loadFile(path.join(__dirname, '../dist/index.html'));
    } else {
      await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
    }
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
      // 两轮收敛：canvas 懒渲染替换占位会改变 scrollHeight/页位，一轮后高度已变，
      // 第二轮按新高度滚全篇直至 scrollHeight 稳定（±2px）——B1 L2R 采样曾因 L 布局
      // 在采样后位移 895px 全军覆没（err2≈0 证明同步算法本身正确）。
      const warmResult = await win.webContents.executeJavaScript(`
        (async () => {
          const L = document.querySelector('.dpv-left');
          for (let round = 0; round < 4; round++) {
            const h0 = L.scrollHeight;
            for (let y = 0; y < L.scrollHeight; y += 700) {
              L.scrollTop = y;
              await new Promise(r => setTimeout(r, 120));
            }
            L.scrollTop = 0;
            await new Promise(r => setTimeout(r, 500));
            if (Math.abs(L.scrollHeight - h0) <= 2) return 'converged@' + round;
          }
          return 'not-converged:' + L.scrollHeight;
        })()
      `);
      log('warm-up: 左栏全页渲染完成，高度已定型 (' + warmResult + ')');

      // ---- 预热 2：右栏图表物化等待 ----
      // 占位 → 真图切换（fig:updated）会撑高布局数百 px，若发生在采样中，
      // 已对齐锚段被推下 → 误差假阳性（pg8 err 274px 根因）。等所有真图完全加载
      // （naturalWidth>0）或确认为无图占位/表格标注后布局才定型。
      const figReady: any = await win.webContents.executeJavaScript(`
        (async () => {
          const R = document.querySelector('.dpv-right');
          if (!R) return { ok: false };
          for (let i = 0; i < 60; i++) {
            const imgs = [...R.querySelectorAll('.dpv-zhfig img')];
            const allLoaded = imgs.every(im => im.complete && im.naturalWidth > 0);
            const pending = [...R.querySelectorAll('.dpv-zhfigph')].filter(ph => ph.textContent?.includes('图片下载中')).length;
            if (allLoaded && pending === 0) return { ok: true, imgs: imgs.length, waited: i * 500 };
            await new Promise(r => setTimeout(r, 500));
          }
          return { ok: false, imgs: R.querySelectorAll('.dpv-zhfig img').length, pending: R.querySelectorAll('.dpv-zhfigph').length };
        })()
      `);
      log('warm-up 2: 右栏图表物化 ' + JSON.stringify(figReady));
      if (!figReady?.ok) log('  ⚠️ 图表未全部物化（下载中），布局可能在采样期间变化');

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
      // 并行进度监视器：B 步 executeJavaScript 曾在 14 表格布局下挂死（超时被 driver 杀，
      // 日志停在 [B] 无任何输出）——监视器每 8s 打点 __dedupProgress，定位挂点页。
      let monitorStop = false;
      const monitor = (async () => {
        for (let i = 0; i < 40 && !monitorStop; i++) {
          await sleep(8000);
          if (monitorStop) return;
          try {
            const p = await win.webContents.executeJavaScript('window.__dedupProgress ?? "(none)"');
            log(`  [B monitor ${(i + 1) * 8}s] ${p}`);
          } catch { return; }
        }
      })();
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
          const progress = s => { window.__dedupProgress = (window.__dedupProgress || '') + s; };
          // 等同步落定：轮询直至两侧 scrollTop 稳定（连续 2 次 250ms 采样差 ≤1px）或超时。
          // 固定 1400ms 在 CPU 负载高时不够平滑滚动（400ms/次跳页动画）完成——曾致 err 5000px 级误采样。
          const settle = async (pane, ms = 4000) => {
            let last = pane.scrollTop, same = 0;
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
              await new Promise(r => setTimeout(r, 250));
              const cur = pane.scrollTop;
              if (Math.abs(cur - last) <= 1) { same++; if (same >= 2) return true; } else same = 0;
              last = cur;
            }
            progress('settle-timeout(' + (pane === L ? 'L' : 'R') + '@' + Math.round(pane.scrollTop) + ') ');
            return false;
          };
          // B1 左→右
          for (const pg of lPages) {
            progress('B1:' + pg + ',');
            const pageEl = domPage(pg);
            if (!pageEl) continue;
            L.scrollTop = pageEl.getBoundingClientRect().top - L.getBoundingClientRect().top + L.scrollTop - 10;
            L.dispatchEvent(new Event('scroll'));
            await settle(L); progress('sL' + pg + ' ');
            await settle(R); progress('sR' + pg + ' ');
            // 跟随效果等待：L→R 联动是 IO 驱动的异步级联（IO 周期 + 滚动动画），settle 只保证
            // 「滚动停止」不保证「跟随已执行」。等 pg 首段真正靠近 R 视口顶（或 3s 超时），再采样。
            for (let w = 0; w < 12; w++) {
              const pe = domPara(pg), rr0 = R.getBoundingClientRect();
              if (!pe || Math.abs(pe.getBoundingClientRect().top - (rr0.top + 12)) <= 50) break;
              await new Promise(r => setTimeout(r, 250));
            }
            progress('w' + pg + ' ');
            await new Promise(r => setTimeout(r, 200));
            const paraEl = domPara(pg);
            if (!paraEl) { samples.push({ dir: 'L2R', pg, err: null, note: 'no para' }); continue; }
            const err = Math.round(paraEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top);
            const within = Math.abs(err) <= TOL;
            // 失败时附诊断：左右各自视口顶部锚（判断是右栏跟错页还是渲染未落定）
            if (!within) {
              const lr = L.getBoundingClientRect(), rr = R.getBoundingClientRect();
              const lTop = [...L.querySelectorAll('.pdf-page')].find(p => p.getBoundingClientRect().bottom > lr.top + 4);
              const rTop = [...R.querySelectorAll('.dpv-zhpara[data-page]')].find(p => p.getBoundingClientRect().bottom > rr.top + 4);
              // 右栏 pg 边界解剖：该页第一个 [data-page] 元素是什么（figure 头？段落？）+ 前页尾部结构
              const firstEl = R.querySelector('[data-page="' + pg + '"]');
              const anatomy = firstEl ? { tag: firstEl.tagName, cls: firstEl.className?.toString?.().slice(0, 40), topInR: Math.round(firstEl.getBoundingClientRect().top - rr.top) } : null;
              const prevTail = [...R.querySelectorAll('.dpv-zhpara[data-page="' + (pg - 1) + '"]')].slice(-1).map(p => ({ bottomInR: Math.round(p.getBoundingClientRect().bottom - rr.top), h: Math.round(p.getBoundingClientRect().height) }));
              // 一锤定音：手动把 pg 首段对齐到视口顶+10（与左栏同标准），再量一次 err。
              // err2≈0 → 命令后内容位移（锚定/补偿缺失）；err2≈err → 目标计算本身错。
              const pe = domPara(pg);
              if (pe) { R.scrollTop += Math.round(pe.getBoundingClientRect().top - (rr.top + 10)); }
              await new Promise(r => setTimeout(r, 300));
              const pe2 = domPara(pg);
              const err2 = pe2 ? Math.round(pe2.getBoundingClientRect().top - (pageEl.getBoundingClientRect().top)) : null;
              samples.push({ dir: 'L2R', pg, err, within, err2, lTopPg: lTop?.dataset.page ?? '?', rTopPg: rTop?.dataset.page ?? '?', lST: Math.round(L.scrollTop), rST: Math.round(R.scrollTop), anatomy, prevTail });
            } else {
              samples.push({ dir: 'L2R', pg, err, within });
            }
          }
          // B2 右→左
          for (const pg of rPages) {
            progress('B2:' + pg + ',');
            const paraEl = domPara(pg);
            if (!paraEl) continue;
            R.scrollTop = paraEl.getBoundingClientRect().top - R.getBoundingClientRect().top + R.scrollTop - 10;
            R.dispatchEvent(new Event('scroll'));
            await settle(R); await settle(L);
            await new Promise(r => setTimeout(r, 200));
            const pageEl = domPage(pg);
            if (!pageEl) { samples.push({ dir: 'R2L', pg, err: null, note: 'no page' }); continue; }
            const err = Math.round(paraEl.getBoundingClientRect().top - pageEl.getBoundingClientRect().top);
            const within = Math.abs(err) <= TOL;
            // 诊断（不改判定）：失败时 dump 左栏落点页 + 视口顶段落，定位错位来源
            if (!within) {
              const diag = (() => {
                const lr = L.getBoundingClientRect();
                const vis = [...L.querySelectorAll('.pdf-page')].find(p => { const r2 = p.getBoundingClientRect(); return r2.bottom > lr.top + 4; });
                const rr = R.getBoundingClientRect();
                const rTarget = [...R.querySelectorAll('.dpv-zhpara[data-page]')].find(p => { const r2 = p.getBoundingClientRect(); return r2.bottom > rr.top + 4; });
                return { leftTopPage: vis?.dataset.page ?? '?', prodTargetPage: rTarget?.dataset.page ?? '?', lScrollTop: Math.round(L.scrollTop) };
              })();
              samples.push({ dir: 'R2L', pg, err, within, ...diag });
            } else {
              samples.push({ dir: 'R2L', pg, err, within });
            }
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
      monitorStop = true;
      log('  页锚总数=' + (b2.anchored ?? '?'));
      for (const s of (b2.samples ?? [])) log('  ' + JSON.stringify(s));
      log('  稳定性: stable=' + b2.stable + ' (' + JSON.stringify(b2.s1) + ' -> ' + JSON.stringify(b2.s2) + ')');
      log('[B] 滚动同步误差: ' + (b2.ok ? 'PASS' : 'FAIL'));
      if (!b2.ok) pass = false;
    }
    log(pass ? 'DEDUP-SCROLL ALL PASS' : 'DEDUP-SCROLL FAIL');
  } catch (e: any) {
    // 超时诊断：B 步 executeJavaScript 曾在 14 表格布局下挂死（本 catch 也到不了——driver 超时先杀）。
    log('FATAL: ' + (e?.stack ?? e));
    pass = false;
  } finally {
    try {
      const prog = await win.webContents.executeJavaScript('window.__dedupProgress ?? ""').catch(() => '');
      if (prog) log('B 步进度（事后）: ' + prog);
    } catch { /* window 可能已销毁 */ }
    fs.writeFileSync(doneFile, pass ? '1' : '0');
  }
}
