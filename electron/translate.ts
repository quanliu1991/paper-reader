// 上下文感知翻译引擎：提示词工程 + 上下文组装 + 质量守卫
// 目标：学术论文级翻译准确率（语义忠实 + 术语一致 + 公式无损）

export interface BlockLite {
  pid: number; seq: number; type: string; level: number; en: string; zh?: string | null;
}

export interface PaperMeta {
  title: string; authors: string; arxivId?: string;
}

// ---------- 提示词：学术翻译系统提示 ----------
export function buildSystemPrompt(glossaryLines: string[]): string {
  const glossary = glossaryLines.length
    ? `\n\n【本篇术语表】（前文已统一译法，必须严格沿用）：\n${glossaryLines.join('\n')}`
    : '';
  return `你是一位顶尖的 AI/ML 领域学术译者，具备以下能力：深度熟悉机器学习、深度学习、自然语言处理、计算机视觉、系统与体系结构、优化与概率统计的全部核心概念；能精准辨析近义术语（如 throughput vs latency、layer vs block、token vs embedding）；长期为顶级会议（NeurIPS/ICML/ICLR/CVPR/ACL）做专业翻译。

【任务】把用户给的英文论文段落翻译成中文，供研究者严肃阅读。

【忠实性铁律】（最高优先级，违反任何一条即为废稿）
1. 语义完全忠实：不增译、不漏译、不改写。原文有的限定词（如 only、solely、significantly）一个都不能丢；原文没有的推断、评价、举例绝对不加。
2. 数字、单位、专有名词零差错：数字必须逐位核对（如 1.5B 不能译成 15 亿）；单位保留国际写法（ms、GB/s、FLOPs）；人名保留英文原文（如 Hinton 不译成辛顿）。
3. 数学公式逐字符保留：$...$ 与 $$...$$ 内的任何字符不得改动、翻译、增删。公式前后的连接词（where、such that、denote）要译准（其中、使得、表示）。
4. 段落结构一一对应：一段进一段出，绝不合并或拆分。

【术语规范】
5. 领域通用缩写与术语保留英文首次出现加括号中文，之后裸用英文：KV cache、prefill、decode、speculative decoding、PagedAttention、MoE、LoRA、FFN、attention、transformer、baseline、ablation、SOTA、zero-shot、few-shot、chain-of-thought、RLHF、top-p、temperature。
6. 有标准中译的术语用标准译法：inference→推理、context window→上下文窗口、embedding→嵌入表示（后文可用 embedding）、benchmark→基准测试、fine-tuning→微调、pretraining→预训练、scaling law→缩放定律、hallucination→幻觉、distillation→蒸馏、quantization→量化、pruning→剪枝、overfitting→过拟合、loss→损失、gradient→梯度、batch→批次（batch size 保留英文）、epoch→轮次。
7. 同一术语全文必须同一个译法，禁止同段换词。

【中文表达规范】
8. 学术书面语，禁止口语化（「咱们」「特别牛」禁止）。句子宁短勿长，长定语从句拆成短句，但拆句不得改变逻辑关系。
9. 被动语态按中文习惯转主动或无主句：「we propose」→「本文提出」；「it is shown that」→「结果表明」。
10. 图表标题格式：「Table 3: ...」→「表 3：…」「Figure 2: ...」→「图 2：…」「Algorithm 1」→「算法 1」。章节引用保留原文编号：「Section 4.2」→「4.2 节」。
11. 只输出译文本身。不要任何前言、后记、注释、markdown 代码块标记。${glossary}`;
}

// ---------- 上下文包组装 ----------
export interface ContextPack {
  paperLine: string;        // 论文标识行
  sectionLine: string;      // 当前章节链
  abstractHint: string;     // 摘要片段（术语定义源）
  prevZh: string;           // 前文已译（承接指代）
  nextEn: string;           // 后文原文（消歧）
}

export function buildContextBlock(ctx: ContextPack): string {
  const parts: string[] = [];
  parts.push(`【论文】${ctx.paperLine}`);
  if (ctx.sectionLine) parts.push(`【当前章节】${ctx.sectionLine}`);
  if (ctx.abstractHint) parts.push(`【摘要（术语以此为准）】${ctx.abstractHint}`);
  if (ctx.prevZh) parts.push(`【前文译文（承接其指代与行文）】\n${ctx.prevZh}`);
  if (ctx.nextEn) parts.push(`【后文原文（仅供消歧，不要翻译）】\n${ctx.nextEn}`);
  parts.push(`【待译段落】\n`);
  return parts.join('\n\n');
}

// 从 blocks 序列提取：当前章节链（最近 heading 链）+ 前后文
export function extractContext(
  blocks: BlockLite[], pid: number,
  opts: { prevChars?: number; nextChars?: number; abstractChars?: number } = {},
): ContextPack | null {
  const prevLimit = opts.prevChars ?? 1200;
  const nextLimit = opts.nextChars ?? 400;
  const absLimit = opts.abstractChars ?? 800;
  const idx = blocks.findIndex(b => b.pid === pid);
  if (idx === -1) return null;

  // 章节链：向前找最近的 heading 序列（level 递增）
  const headings: string[] = [];
  const wantLevels: number[] = [];
  for (let i = idx - 1; i >= 0 && headings.length < 4; i--) {
    const b = blocks[i];
    if (b.type !== 'heading') continue;
    if (wantLevels.length === 0 || b.level < (wantLevels[wantLevels.length - 1] ?? 9)) {
      headings.unshift(b.en.replace(/\s+/g, ' ').trim().slice(0, 80));
      wantLevels.push(b.level);
      if (b.level <= 1) break;
    }
  }

  // 前文：已译的连续段落（跳过未译，取最近 1200 字符）
  let prevZh = '';
  for (let i = idx - 1; i >= 0 && prevZh.length < prevLimit; i--) {
    const b = blocks[i];
    if (b.type === 'fig' || !b.en) continue;
    const piece = (b.zh || b.en).replace(/\s+/g, ' ').trim();
    if (!piece) continue;
    prevZh = piece + (prevZh ? '\n…\n' + prevZh : '');
  }

  // 后文：紧邻的原文段（消歧用）
  let nextEn = '';
  for (let i = idx + 1; i < blocks.length && nextEn.length < nextLimit; i++) {
    const b = blocks[i];
    if (b.type === 'fig' || !b.en) continue;
    nextEn += b.en.replace(/\s+/g, ' ').trim().slice(0, nextLimit) + '\n';
    if (nextEn.length >= nextLimit) break;
  }

  // 摘要：第一个 para（通常是 abstract）
  let abstractHint = '';
  for (const b of blocks) {
    if (b.type === 'para' && b.en && b.en.length > 200) {
      abstractHint = b.en.replace(/\s+/g, ' ').trim().slice(0, absLimit);
      break;
    }
  }

  return {
    paperLine: '',
    sectionLine: headings.join(' > '),
    abstractHint,
    prevZh,
    nextEn,
  };
}

// ---------- 质量守卫 ----------
export interface QcResult {
  ok: boolean;
  issues: string[];
  score: number; // 0-100
}

// 公式完整性 + 基本忠实性校验
export function qcTranslation(en: string, zh: string): QcResult {
  const issues: string[] = [];
  let deductions = 0;

  // 1. 公式逐字符校验：原文的每个公式必须在译文中原样存在
  const enMath = en.match(/\$\$[^$]+\$\$|\$[^$\n]+\$/g) ?? [];
  for (const m of enMath) {
    if (!zh.includes(m)) {
      issues.push(`公式缺失或被改动: ${m.slice(0, 40)}`);
      deductions += 25;
    }
  }

  // 2. 数字守卫：原文的关键数字必须出现在译文（含单位后缀与等价形式：
  //    64x ≈ 64 倍 / 82% ≈ 82% 或百分之 82 / 12ms ≈ 12 毫秒）
  const enNums = en.match(/\b\d+(?:\.\d+)?(?:[xX×]\d+)?(?:\s?(?:B|M|K|G|T|ms|s|GB|MB|KB|TB|%|FLOPs?|Hz|x))?\b/g) ?? [];
  const uniqNums = [...new Set(enNums)].filter(n => parseFloat(n) >= 2 || n.includes('%'));
  for (const n of uniqNums.slice(0, 30)) {
    const num = n.match(/\d+(?:\.\d+)?/)?.[0] ?? n;   // 纯数字部分
    const suffix = n.slice(num.length).trim().toLowerCase();
    // 等价形式表：数字后接中文单位词也算命中
    const equivBySuffix: Record<string, RegExp> = {
      'x': new RegExp(`${num}\\s*(?:倍|x|×)`),
      '%': new RegExp(`${num}\\s*%|百分之\\s*${num}|${num}\\s*(?:个?百分比)`),
      'ms': new RegExp(`${num}\\s*(?:ms|毫秒)`),
      's': new RegExp(`${num}\\s*(?:s|秒)`),
      'gb': new RegExp(`${num}\\s*(?:GB|吉字节)`, 'i'),
      'mb': new RegExp(`${num}\\s*(?:MB|兆字节)`, 'i'),
      'b': new RegExp(`${num}\\s*(?:B|亿|billion)`, 'i'),
      'm': new RegExp(`${num}\\s*(?:M|百万|million)`, 'i'),
      'k': new RegExp(`${num}\\s*(?:K|千|thousand)`, 'i'),
      't': new RegExp(`${num}\\s*(?:T|TB|万亿|tera)`, 'i'),
    };
    const equiv = equivBySuffix[suffix];
    const hit = zh.includes(n) || (equiv && equiv.test(zh)) || (equiv && equiv.test(zh.replace(/\s/g, '')));
    if (!hit) {
      issues.push(`数字缺失: ${n}`);
      deductions += 8;
    }
  }

  // 3. 长度比守卫：译文应在原文的 0.28-2.2 倍字符比之间（中英文信息密度差）
  const ratio = zh.length / Math.max(1, en.length);
  if (ratio < 0.28 || ratio > 2.2) {
    issues.push(`长度比异常: ${ratio.toFixed(2)}`);
    deductions += 20;
  }

  // 4. 残留英文句子守卫（整句未译）：连续 30+ 英文字符且不含术语白名单
  const leftover = zh.match(/[A-Za-z][A-Za-z ,;'"\-()]{29,}/g) ?? [];
  const whitelist = /^(KV cache|prefill|decode|attention|transformer|baseline|ablation|SOTA|zero-shot|few-shot|chain-of-thought|RLHF|MoE|LoRA|FFN|top-p|temperature|embedding|benchmark|fine-tuning|pretraining|scaling law|hallucination|distillation|quantization|pruning|overfitting|batch size|Figure|Table|Algorithm|Section)/i;
  const badLeftover = leftover.filter(s => !whitelist.test(s.trim()));
  if (badLeftover.length > 0) {
    issues.push(`疑似整句未译: ${badLeftover[0].slice(0, 40)}`);
    deductions += 40;
  }

  // 5. 译者越界守卫：常见 LLM 自作主张标记
  for (const marker of ['翻译如下', '以下是翻译', '译注', '（注：', '```']) {
    if (zh.includes(marker)) { issues.push(`越界输出: ${marker}`); deductions += 40; }
  }

  return { ok: deductions <= 15, issues, score: Math.max(0, 100 - deductions) };
}

// 从已译段落提取本篇已定术语（中文片段 → 后续段落沿用）
export function extractSettledTerms(blocks: BlockLite[], max = 40): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  // 常见需要一致的英文名词出现在原文中，且译文保留了英文 → 视为已定术语
  const termRe = /\b(KV cache|PagedAttention|speculative decoding|prefill|decode|MoE|LoRA|FFN|top-p|temperature|batch size|zero-shot|few-shot|chain-of-thought|RLHF|embedding|attention|transformer|baseline|SOTA)\b/gi;
  for (const b of blocks) {
    if (!b.zh) continue;
    const inEn = b.en.match(termRe) ?? [];
    for (const t of new Set(inEn.map(s => s.trim()))) {
      const key = t.toLowerCase();
      if (!seen.has(key) && b.zh.includes(t)) {
        seen.add(key);
        lines.push(`- ${t}: 保留英文`);
        if (lines.length >= max) return lines;
      }
    }
  }
  return lines;
}
