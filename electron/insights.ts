// AI 洞察层：Triage 摘要 / 分节通读摘要 / 术语一致性校验
import { chatStream, ProviderConfig, ChatMessage } from './llm';

// 一次性 chat（非流式收集）
export function chatOnce(provider: ProviderConfig, messages: ChatMessage[], maxTokens = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = '';
    chatStream(provider, messages, {
      onDelta: d => { acc += d; },
      onDone: full => resolve((full || acc).trim()),
      onError: reject,
    }, { temperature: 0.3, maxTokens });
  });
}

export interface TriageSummary {
  oneLiner: string;       // 一句话（人话）
  problem: string;        // 核心问题
  method: string;         // 方法
  results: string;        // 关键数字结论
  related: string;        // 与知识库的关联（可空）
}

// Triage 卡片摘要：喂摘要 + 首尾正文抽样，产出 JSON
export async function genTriageSummary(
  provider: ProviderConfig, title: string, authors: string,
  abstract: string, bodySample: string, knownTitles: string[]
): Promise<TriageSummary> {
  const context = `论文标题：${title}
作者：${authors}
摘要：${abstract}
正文抽样：${bodySample}`;
  const relatedHint = knownTitles.length
    ? `\n\n我知识库已读论文（如有关联请指出，没有则写「无直接关联」）：\n${knownTitles.slice(0, 20).join('\n')}`
    : '';

  const raw = await chatOnce(provider, [
    { role: 'system', content: `你是论文快速评估助手。基于给定内容输出 JSON（只输出 JSON，不要 markdown 代码块）：
{"oneLiner": "一句话说这篇论文解决了什么问题（普通人能懂）", "problem": "核心问题 1-2 句", "method": "核心方法 1-2 句", "results": "关键结果（含数字）1-2 句", "related": "与已读论文的关联或「无直接关联」"}
oneLiner 要具体，不要「提出了一个新方法」这种空话。` },
    { role: 'user', content: context + relatedHint },
  ]);
  return parseJsonLoose(raw);
}

export interface SectionSummary { seq: number; heading: string; summary: string }

// 分节摘要：按 heading 分组正文，每节 2-3 句
export async function genSectionSummaries(
  provider: ProviderConfig,
  sections: Array<{ heading: string; text: string }>
): Promise<SectionSummary[]> {
  const out: SectionSummary[] = [];
  // 每节独立请求（段落少、可并发）；限制节数防爆量
  const targets = sections.filter(s => s.text.length > 200).slice(0, 30);
  const concurrency = 3;
  const queue = [...targets.entries()];
  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [i, sec] = item;
      try {
        const sum = await chatOnce(provider, [
          { role: 'system', content: '用中文 2-3 句总结这一节论文内容，直接输出总结，术语保留英文。' },
          { role: 'user', content: `【${sec.heading}】\n${sec.text.slice(0, 4000)}` },
        ], 512);
        out[i] = { seq: i, heading: sec.heading, summary: sum };
      } catch { /* 单节失败跳过 */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out.filter(Boolean);
}

// 术语一致性校验：抽查已译段落中 learning/unknown 术语的译法
export interface TermIssue { pid: number; term: string; zhSnippet: string; suggestion: string }

export async function checkTermConsistency(
  provider: ProviderConfig,
  translatedBlocks: Array<{ pid: number; en: string; zh: string }>,
  glossary: Array<{ term: string; level: string; explain: string }>
): Promise<TermIssue[]> {
  const watchTerms = glossary.filter(t => t.level === 'learning' || t.level === 'unknown');
  if (!watchTerms.length || !translatedBlocks.length) return [];
  const termList = watchTerms.slice(0, 100).map(t => t.term).join(', ');

  // 抽最多 20 段做批量审查
  const sample = translatedBlocks.slice(0, 20);
  const payload = sample.map(b => `#${b.pid}\nEN: ${b.en.slice(0, 300)}\nZH: ${b.zh.slice(0, 300)}`).join('\n\n');
  const raw = await chatOnce(provider, [
    { role: 'system', content: `你是翻译质检员。下面每个编号段落有英文原文和中文译文。术语表应保留英文的术语：${termList}。
检查译文是否违反「术语保留英文」规则（把该术语翻译成了中文）。
输出 JSON 数组（无问题输出 []，只输出 JSON）：
[{"pid": 段落号, "term": "被误译的术语", "zhSnippet": "译文中错误片段（20字内）", "suggestion": "改正建议"}]` },
    { role: 'user', content: payload },
  ], 1024);
  const arr = parseJsonLoose<any[]>(raw);
  return Array.isArray(arr) ? arr.filter(x => x && typeof x.pid === 'number') : [];
}

// ---------- 读者画像 → 问答策略 ----------
// 输入：静态背景文本 + 动态信号计数。输出注入系统提示词的策略段 + 前端建议问题的方向。
export interface ReaderStrategy {
  depthRule: string;        // 回答深度指令
  vocabRule: string;        // 术语处理指令
  suggestKind: 'concept' | 'method' | 'result';  // 建议问题偏好的类型
  rationale: string;        // 给前端展示的推荐理由（一句话）
}

export function deriveReaderStrategy(profile: { bg: string; signals: Record<string, number> }): ReaderStrategy {
  const s = profile.signals ?? {};
  const concept = s.concept ?? 0;
  const method = s.method ?? 0;
  const result = s.result ?? 0;
  const shallow = s["tooShallow"] ?? 0;
  const deep = s["tooDeep"] ?? 0;
  const right = s["justRight"] ?? 0;
  const bg = (profile.bg ?? '').trim();
  const bgLower = bg.toLowerCase();
  let depthRule = '默认按研究生水平回答：先直接结论，再给推导/证据，关键概念顺带一句解释。';
  if (shallow > deep + 1) depthRule = '用户反馈过多次「太浅」：回答要更深——给公式推导、与其他方法的对比、实现细节，不要泛泛而谈。';
  else if (deep > shallow + 1) depthRule = '用户反馈过多次「太深」：回答要更浅——先打比方说人话，少堆公式，概念先一句话定义再展开。';
  else if (right >= 5 && shallow + deep === 0) depthRule = '当前深度正合适，保持：先结论后展开，专业但克制。';

  // 词汇策略：静态背景里自己写的「熟悉/不熟」优先；无背景时按提问类型推断
  let vocabRule = '术语保留英文；基础概念（KV cache、投机解码这类）可直接使用不解释。';
  if (/不熟|新手|入门|小白/.test(bg)) vocabRule = '用户自述新手：每个术语首次出现都用一句话日常类比解释（如 KV cache 就像草稿纸），再给严谨定义。';
  else if (/熟悉|精通|专家|多年/.test(bg) && !/不熟/.test(bg)) vocabRule = '用户是专家：直接用领域黑话，不用解释基础概念，重点讲增量贡献与 trade-off。';
  else if (concept > method + result + 2) vocabRule = '用户常问概念：默认读者对基础术语不熟，首次出现配一句话解释。';

  // 建议问题方向：按提问分布，冷启动用 concept
  const suggestKind = (concept >= method && concept >= result) ? 'concept' : (method >= result ? 'method' : 'result') as ReaderStrategy['suggestKind'];

  // 推荐理由（前端展示）
  const total = concept + method + result;
  let rationale = '还没有你的提问记录，先按入门读者推荐概念类问题。';
  if (total >= 3) {
    if (suggestKind === 'concept') rationale = `你常问概念类问题（${concept}/${total}），继续推荐概念澄清类。`;
    else if (suggestKind === 'method') rationale = `你更关注方法细节（${method}/${total}），推荐方法机理类问题。`;
    else rationale = `你关注实验结论（${result}/${total}），推荐结果解读类问题。`;
  }
  if (shallow + deep >= 3) {
    rationale += shallow > deep ? '（按你的「太浅」反馈，回答已调深）' : '（按你的「太深」反馈，回答已调浅）';
  }

  return { depthRule, vocabRule, suggestKind, rationale };
}

// 按画像方向生成 3 条建议问题（不耗 LLM：模板 + 论文小节标题拼装）
export function suggestQuestions(
  strategy: ReaderStrategy, headings: string[]
): Array<{ label: string; prompt: string }> {
  const h = headings.filter(x => x && x.length > 3).slice(0, 12);
  const pick = () => h.length ? h[Math.floor(Math.random() * h.length)] : 'Method';
  if (strategy.suggestKind === 'concept') {
    return [
      { label: `「${pick().slice(0, 18)}」这节在讲什么`, prompt: `「X」这一节在讲什么？和全文主线什么关系？` },
      { label: '全文核心思想', prompt: '用三句话讲清这篇论文的核心思想，再指出最关键的一个公式或图。' },
      { label: '我需要什么先验知识', prompt: '读懂这篇需要哪些先验知识？我缺什么补什么，按重要性排序。' },
    ];
  }
  if (strategy.suggestKind === 'method') {
    return [
      { label: `方法的关键步骤`, prompt: `${pick()} 部分的方法关键步骤是什么？逐步拆解，标注哪步是本文的创新。` },
      { label: '为什么这样设计', prompt: '核心方法为什么这样设计？换个更简单的方案行不行，差在哪？' },
      { label: '复杂度与开销', prompt: '这个方法的时间/空间复杂度和工程开销怎么样？贵在哪？' },
    ];
  }
  return [
    { label: '关键数字怎么读', prompt: '实验部分最关键的数字结论是什么？和 baseline 比提升多少，代价是什么？' },
    { label: '消融说明了什么', prompt: '消融实验说明了什么？哪个组件贡献最大？' },
    { label: '结果可信吗', prompt: '实验设置有没有值得怀疑的地方（数据集规模、baseline 强度、超参敏感性）？' },
  ];
}

function parseJsonLoose<T>(raw: string): T {
  // 容错：剥 markdown 代码块、找第一个 { 或 [
  let s = raw.replace(/```(json)?/g, '').trim();
  const start = Math.min(
    ...[s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0)
  );
  if (Number.isFinite(start) && start > 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch {
    // 最后一次机会：截到匹配的括号
    const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (lastBrace > 0) {
      try { return JSON.parse(s.slice(0, lastBrace + 1)); } catch { /* give up */ }
    }
    throw new Error('AI 返回的不是合法 JSON：' + raw.slice(0, 120));
  }
}
