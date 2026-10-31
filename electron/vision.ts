// 视觉/体验判定共享 LLM 层：本地 LM Studio 优先 → 云端 GLM 兜底 → 不可用降级
// 供 llm-judge（文本打分）与 visual-judge（截图断言）复用
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import * as crypto from 'crypto';

// ---------- key 安全：从 llm.txt 或加密 Provider 读，绝不写日志 ----------
let cachedKey: string | null = null;
export function readCloudKey(): string | null {
  if (cachedKey) return cachedKey;
  // 优先项目根 llm.txt（gitignored）
  for (const cand of [path.resolve('llm.txt'), path.join(process.cwd(), 'llm.txt')]) {
    try {
      if (fs.existsSync(cand)) {
        const first = fs.readFileSync(cand, 'utf8').split('\n')[0].trim().split(/\s+/);
        if (first.length >= 1 && first[0].includes('.')) { cachedKey = first[0]; return cachedKey; }
      }
    } catch { /* next */ }
  }
  return null;
}

// ---------- Provider 探测 ----------
export interface ResolvedProvider {
  kind: 'local' | 'cloud';
  baseUrl: string;       // 不含 /chat/completions 后缀
  model: string;
  apiKey: string;
}

export async function resolveProvider(): Promise<ResolvedProvider | null> {
  // 1) 本地 LM Studio（OpenAI 兼容）——只认 chat 模型（过滤 embedding）
  try {
    const r = await fetch('http://localhost:1234/v1/models', { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const j: any = await r.json();
      const models: string[] = (j.data ?? []).map((m: any) => m.id).filter(Boolean);
      const chat = models.filter(id => !/embed|bge|rerank/i.test(id));
      if (chat.length > 0) {
        // 优先 Qwen3.6-35B（部署目标），否则第一个 chat 模型
        const pick = chat.find(id => /qwen/i.test(id)) ?? chat[0];
        return { kind: 'local', baseUrl: 'http://localhost:1234/v1', model: pick, apiKey: 'lm-studio' };
      }
    }
  } catch { /* not running */ }
  // 2) 云端 GLM（llm.txt；模型可用 PR_VISION_MODEL 覆盖）
  const key = readCloudKey();
  if (key) {
    return { kind: 'cloud', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: process.env.PR_VISION_MODEL || 'glm-5.3-flash', apiKey: key };
  }
  return null;
}

// ---------- 统一 chat（非流式，带 JSON 提取） ----------
export async function chatJson(
  p: ResolvedProvider,
  messages: any[],
  { maxTokens = 800, timeoutMs = 90000 } = {}
): Promise<any | null> {
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.apiKey}` },
      // thinking disabled：GLM 推理模型关思考直接出答案（本地 LM Studio 忽略此参数无碍）
      body: JSON.stringify({ model: p.model, messages, max_tokens: maxTokens, temperature: 0.1, thinking: { type: 'disabled' } }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    // 推理模型：答案可能在 content，也可能 content 为空而 JSON 出现在 reasoning 尾部
    const content = m.content ?? '';
    const reasoning = m.reasoning_content ?? '';
    return extractJson(content) ?? extractJson(reasoning);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// 从文本提取第一个 JSON 对象（容忍 ```json 围栏与前后缀文字）
export function extractJson(text: string): any | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}
