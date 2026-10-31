// LLM 体验评估：模拟读者视角给 摘要卡/翻译抽样/问答接地性 打分
// Provider：本地 LM Studio 优先 → 云端 GLM 兜底 → 都不可用降级 SKIP（记 finding 不阻塞）
// 产出：LLM-JUDGE 行（improve-loop 消费）+ build/ux/llm-judge.json
import { app } from 'electron';
import * as db from '../electron/db';
import { parsePlainText } from '../electron/arxiv';
import { resolveProvider, chatJson, extractJson } from '../electron/vision';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const judgeFinding = (f: any) => log('LLM-JUDGE-FINDING: ' + JSON.stringify(f));
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

app.whenReady().then(async () => {
  const results: any[] = [];
  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
    log('== LLM 体验评估 ==');

    const provider = await resolveProvider();
    if (!provider) {
      log('provider: NONE → SKIP（记 finding）');
      judgeFinding({ id: 'llm-not-ready', severity: 'medium', view: 'llm-judge', title: '无可用 LLM（本地未加载且云端未配）', evidence: 'resolveProvider=null' });
      log('LLM JUDGE DONE');
      finish();
      setTimeout(() => app.quit(), 200);
      return;
    }
    log(`provider: ${provider.kind} (${provider.model})`);

    // 真实论文模式（PR_JUDGE_REAL=1）：用 arXiv 真实 fixture 论文评估摘要卡接地性
    // （合成论文自写自评有自证偏差——真实论文的摘要声明必须能被正文支撑）
    const useReal = process.env.PR_JUDGE_REAL === '1';
    let paperId: number;
    let paras: any[];
    let triage: any;
    if (useReal) {
      const arxiv = await import('../electron/arxiv');
      const html = fs.readFileSync(path.resolve('tests/fixtures/2609.34683.html'), 'utf8');
      const parsed = (arxiv as any).parseArxivHtml(html, '2609.34683');
      paperId = db.insertPaper({ arxivId: '2609.34683', title: parsed.title, authors: parsed.authors, sourceUrl: '', importType: 'text' });
      db.insertBlocks(paperId, parsed.blocks);
      const blocks = db.getBlocks(paperId) as any[];
      paras = blocks.filter((b: any) => b.type === 'para');
      // 摘要卡：取论文摘要段的前 800 字符让 judge 核实
      const abstractPara = paras.find((b: any) => /benchmark|agentic|inference/i.test(b.en)) ?? paras[1];
      triage = {
        oneLiner: '为智能体 LLM 的推理性能建立基准测试套件 AgentPerfBench',
        problem: '智能体工作流的 LLM 推理性能缺少系统性评测基准',
        method: '构建饱和测量(saturation-based)基准与评测套件，覆盖多 GPU 平台',
        results: '发布 3000+ 基准结果与 14 万+ NCU 内核剖析记录（四 GPU 平台）',
        related: '',
      };
      db.saveSummary(paperId, JSON.stringify(triage), '[]', 'judge', 'judge');
      // 真实论文模式：接地核查对象 = triage 声明 vs 论文正文
      // 上下文 = 前 3 段（摘要/动机）+ 含数据声明的段落（3000+/NCU/GPU），避免宽泛词命中同一段
      const ctxParas: string[] = [];
      for (const b of paras.slice(0, 2)) ctxParas.push(String(b.en).slice(0, 500));
      // 数据声明段：方法与结果密集区（para 2-9）固定窗口，避免脆弱的关键词段查找
      for (const b of paras.slice(2, 10)) ctxParas.push(String(b.en).slice(0, 500));
      const verifyCtx = ctxParas.join('\n\n').slice(0, 4200);


      const r = await chatJson(provider, [
        { role: 'system', content: '你是事实核查员。判断摘要卡四项声明（一句话/问题/方法/结果）是否被论文正文片段支撑。只输出 JSON：{"one_liner_ok": true/false, "problem_ok": true/false, "method_ok": true/false, "results_ok": true/false, "issues": "一句话"}' },
        { role: 'user', content: `摘要卡：${JSON.stringify(triage)}\n\n论文正文片段：\n${verifyCtx}` },
      ], { maxTokens: 400 });
      const allOk = r && r.one_liner_ok && r.problem_ok && r.method_ok && r.results_ok;
      log(`真实论文摘要接地: oneLiner=${r?.one_liner_ok} problem=${r?.problem_ok} method=${r?.method_ok} results=${r?.results_ok}`);
      if (r && !allOk) {
        judgeFinding({ id: 'llm-judge-real-summary', severity: 'medium', view: 'reader-triage', title: '真实论文摘要卡声明未被正文支撑', evidence: String(r.issues ?? '') });
      }
      log('LLM JUDGE DONE');
      finish();
      setTimeout(() => app.quit(), 200);
      return;
    }

    // 种子论文 + 真实摘要 + 预填译文 + 问答对（评估对象）
    const text = `Speculative Decoding for Edge LLMs

Abstract. We accelerate LLM inference on edge devices using speculative decoding with adaptive draft lengths.

1 Introduction
Edge devices cannot fit large models. Speculative decoding uses a small draft model to propose tokens and the target model verifies them in parallel.

2 Method
We adapt draft length to device thermal state. The scheduler monitors junction temperature and shortens drafts when hot.

3 Results
On Jetson Orin we reach 2.1x speedup with negligible quality loss. Energy per token drops 38 percent.`;
    const parsed = parsePlainText(text, '9999.03101', 'Speculative Decoding for Edge LLMs');
    paperId = db.insertPaper({ arxivId: '9999.03101', title: parsed.title, authors: 'X; Y', sourceUrl: '', importType: 'text' });
    db.insertBlocks(paperId, parsed.blocks);
    const blocks = db.getBlocks(paperId) as any[];
    paras = blocks.filter((b: any) => b.type === 'para');
    // 摘要（评估对象 1）
    triage = { oneLiner: '让手机也能跑大模型：按设备温度动态调整投机解码的草稿长度', problem: '边缘设备算力与散热有限，固定草稿长度的投机解码不划算', method: '调度器监测结温，过热时缩短草稿长度', results: 'Jetson Orin 2.1x 加速，每 token 能耗降 38%，质量几乎无损', related: '' };
    db.saveSummary(paperId, JSON.stringify(triage), '[]', 'judge', 'judge');
    // 译文（评估对象 2）——故意一好一差
    db.saveTranslation(paperId, paras[0].pid, '边缘设备装不下大模型。投机解码用小草稿模型提议 token，目标模型并行验证。', 'judge', 'judge');
    db.saveTranslation(paperId, paras[1].pid, '我们 adaptd 草稿长度 too 设备温度。', 'judge', 'judge'); // 差译：中英混杂
    // 问答（评估对象 3）——接地引用指向含结果数据的段落（parsePlainText 顺序：0=标题 1=Abstract 2=Intro 3=Method 4=Results）
    const resultsPara = paras.find((b: any) => /Jetson Orin/.test(b.en)) ?? paras[0];
    db.addQa({ paperId, pid: resultsPara.pid, question: '加速倍数是多少？', answer: '在 Jetson Orin 上达到 2.1 倍加速，同时每 token 能耗下降 38%。依据【段落 #5】。', provider: 'judge', model: 'judge' });

    // ---- 维度 1：摘要卡有用性 ----
    {
      const r = await chatJson(provider, [
        { role: 'system', content: '你是苛刻的科研读者。评估论文摘要卡是否有用。只输出 JSON：{"useful": 0-10, "reasons": "一句话"}' },
        { role: 'user', content: `论文标题：${parsed.title}\n摘要卡：\n一句话：${triage.oneLiner}\n核心问题：${triage.problem}\n方法：${triage.method}\n结果：${triage.results}` },
      ], { maxTokens: 300 });
      const score = r?.useful ?? null;
      log(`摘要卡: score=${score} (${r?.reasons ?? 'parse-fail'})`);
      results.push({ dim: 'summary', score });
      if (score !== null && Number(score) < 6) {
        judgeFinding({ id: 'llm-judge-summary', severity: 'medium', view: 'reader-triage', title: `摘要卡评分低（${score}/10）`, evidence: String(r?.reasons ?? '') });
      }
    }

    // ---- 维度 2：翻译质量抽样（好/差各独立评，避免 A/B 对比混淆） ----
    {
      const good = '边缘设备装不下大模型。投机解码用小草稿模型提议 token，目标模型并行验证。';
      const bad = '我们 adaptd 草稿长度 too 设备温度。';
      const origGood = 'Edge devices cannot fit large models. Speculative decoding uses a small draft model to propose tokens and the target model verifies them in parallel.';
      const origBad = 'We adapt draft length to device thermal state.';
      const rG = await chatJson(provider, [
        { role: 'system', content: '你是中英翻译质检员。给译文质量打分（流畅/忠实/术语保留）。只输出 JSON：{"quality": 0-10}' },
        { role: 'user', content: `原文：${origGood}\n译文：${good}` },
      ], { maxTokens: 200 });
      const rB = await chatJson(provider, [
        { role: 'system', content: '你是中英翻译质检员。给译文质量打分（流畅/忠实/术语保留）。只输出 JSON：{"quality": 0-10}' },
        { role: 'user', content: `原文：${origBad}\n译文：${bad}` },
      ], { maxTokens: 200 });
      const g = rG?.quality ?? null;
      const b = rB?.quality ?? null;
      log(`翻译抽样: good=${g}, bad=${b}`);
      results.push({ dim: 'translation', good: g, bad: b });
      // judge 失效检测：好差无法区分（分差 <2 或 bad 反超）→ judge 本身不可信，降级记录
      if (g !== null && b !== null && Number(g) - Number(b) < 2) {
        judgeFinding({ id: 'llm-judge-translation-weak', severity: 'low', view: 'llm-judge', title: '翻译 judge 区分度不足', evidence: `good=${g} bad=${b}` });
      }
    }

    // ---- 维度 3：问答接地性（引用段落是否真支撑答案） ----
    {
      const qa = (db.listQa(paperId) as any[]).find(x => x.answer);
      const refPara = paras.find((b: any) => /Jetson Orin/.test(b.en)) ?? paras[0];
      const r = await chatJson(provider, [
        { role: 'system', content: '你是事实核查员。判断答案是否被引用段落支撑、引用是否正确。只输出 JSON：{"grounded": 0-10, "ref_correct": true/false, "issues": "一句话"}' },
        { role: 'user', content: `问题：${qa.question}\n答案：${qa.answer}\n引用段落原文：${refPara.en}` },
      ], { maxTokens: 300 });
      const g = r?.grounded ?? null;
      log(`问答接地: score=${g}, refCorrect=${r?.ref_correct} (${r?.issues ?? 'parse-fail'})`);
      results.push({ dim: 'qa-grounded', score: g, refCorrect: r?.ref_correct });
      if (g !== null && Number(g) < 6) {
        judgeFinding({ id: 'llm-judge-qa', severity: 'medium', view: 'ask-panel', title: `问答接地性低（${g}/10）`, evidence: String(r?.issues ?? '') });
      }
    }

    fs.mkdirSync('build/ux', { recursive: true });
    fs.writeFileSync('build/ux/llm-judge.json', JSON.stringify({ at: new Date().toISOString(), provider: { kind: provider.kind, model: provider.model }, results }, null, 2));
    log('LLM JUDGE DONE');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
    judgeFinding({ id: 'llm-judge-crash', severity: 'high', view: 'llm-judge', title: 'LLM 评估崩溃', evidence: String(e?.message ?? e) });
  }
  finish();
  setTimeout(() => app.quit(), 200);
});
