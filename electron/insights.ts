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
