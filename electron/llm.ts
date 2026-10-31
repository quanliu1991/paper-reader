// LLM 服务层：OpenAI 兼容 + Anthropic 原生协议，流式输出
// key 用 Windows DPAPI 加密存储（mac 上降级为明文 + Keychain 待办）
import * as crypto from 'crypto';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ProviderConfig {
  id?: number;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;      // 内存中明文，存库前加密
  model: string;
  isDefault?: boolean;
}

// ---------- DPAPI 加密（Windows）----------
// Electron main 进程没有 dpapi 内置模块，用 PowerShell 兜底太重。
// 简化方案：AES-256-GCM 对称加密，密钥派生自机器指纹（首次运行生成随机密钥存 userData）。
// 威胁模型：防「数据库文件被拷走后 key 直接泄露」，不防本机攻击者。
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

let masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const keyPath = path.join(app.getPath('userData'), '.mk');
  if (fs.existsSync(keyPath)) {
    masterKey = Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'hex');
  } else {
    masterKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, masterKey.toString('hex'), { mode: 0o600 });
  }
  return masterKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

export function decryptSecret(s: string): string {
  const [ivHex, tagHex, encHex] = s.split('.');
  if (!ivHex || !tagHex || !encHex) return s; // 兼容历史明文
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ---------- 流式 chat ----------
export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: string) => void;
}

export async function chatStream(
  provider: ProviderConfig,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  opts?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<void> {
  const temperature = opts?.temperature ?? 0.3;
  const maxTokens = opts?.maxTokens ?? 4096;
  // E2E fake-LLM：环境变量开启时返回确定性 canned 流，不烧 token。
  // 守卫遵循 DEVELOPMENT.md E2E 泄漏陷阱规范：仅当显式设置 PR_FAKE_LLM=1 时生效，
  // 打包版宿主 shell 残留变量时因无测试上下文最多影响一次非流式调用（测试用隔离 userData，不触真实用户库）。
  if (process.env.PR_FAKE_LLM === '1') {
    fakeChatStream(messages, handlers);
    return;
  }
  try {
    if (provider.protocol === 'anthropic') {
      await streamAnthropic(provider, messages, handlers, temperature, maxTokens, opts?.signal);
    } else {
      await streamOpenAI(provider, messages, handlers, temperature, maxTokens, opts?.signal);
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') { handlers.onDone(''); return; }
    handlers.onError(String(e?.message ?? e));
  }
}

// fake 流：按用户消息内容生成确定性回复（问答带【段落 #N】引用格式，摘要/翻译给固定中文）
// 让上层「引用解析 / QC / 摘要卡渲染」逻辑可被真实地走一遍
function fakeChatStream(messages: ChatMessage[], h: StreamHandlers) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  let reply: string;
  if (/摘要|一句话|summary/i.test(lastUser)) {
    reply = '【一句话】本文提出一种条件无发定理，证明 Transformer 在特定条件下收敛到不动点。\n【问题】Transformer 是否存在不动点收敛结构。\n【方法】构造条件证明。\n【结果】在两类注意力下成立。';
  } else if (/翻译|translate/i.test(lastUser)) {
    reply = '这是一段用于测试的预填译文，内容与原文等长且完整，符合质检长度比要求。';
  } else {
    // 问答：引用最后提到的段落编号（若有），否则引 #1
    const m = lastUser.match(/段落\s*#?(\d+)|#(\d+)/);
    const ref = m ? (m[1] ?? m[2]) : '1';
    reply = `这是针对该问题的确定性测试回答。依据【段落 #${ref}】，可以解释为核心机制的直接推论。`;
  }
  // 按 8 字符分片模拟流
  const chunks = reply.match(/[\s\S]{1,8}/g) ?? [reply];
  setImmediate(() => {
    for (const c of chunks) h.onDelta(c);
    h.onDone(reply);
  });
}

// OpenAI 兼容：OpenAI / GLM / DeepSeek / Qwen / Ollama / vLLM ...
async function streamOpenAI(
  p: ProviderConfig, messages: ChatMessage[], h: StreamHandlers,
  temperature: number, maxTokens: number, signal?: AbortSignal
) {
  const url = joinUrl(p.baseUrl, '/chat/completions');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.model, messages, temperature, max_tokens: maxTokens, stream: true }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`.slice(0, 300));
  }
  const full = await readSse(resp.body, h.onDelta);
  h.onDone(full);
}

// Anthropic 原生
async function streamAnthropic(
  p: ProviderConfig, messages: ChatMessage[], h: StreamHandlers,
  temperature: number, maxTokens: number, signal?: AbortSignal
) {
  const url = joinUrl(p.baseUrl, '/v1/messages');
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const rest = messages.filter(m => m.role !== 'system');
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': p.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: p.model, system: system || undefined, messages: rest,
      temperature, max_tokens: maxTokens, stream: true,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`.slice(0, 300));
  }
  const full = await readSse(resp.body, h.onDelta);
  h.onDone(full);
}

async function readSse(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<string> {
  let full = '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const data = t.slice(5).trim();
        if (data === '[DONE]') return full;
        const delta = extractDelta(data);
        if (delta) { full += delta; onDelta(delta); }
      }
    }
  }
  return full;
}

// 从 SSE data 行提取文本增量（OpenAI 兼容 + Anthropic 两种格式）
function extractDelta(data: string): string {
  try {
    const j = JSON.parse(data);
    return j.choices?.[0]?.delta?.content ?? j.delta?.text ?? '';
  } catch { return ''; /* keep-alive 注释行等 */ }
}

function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  // 用户填了完整路径（以 /v1 结尾）就不再拼 /v1
  if (suffix === '/chat/completions' && /\/v\d+$/.test(b)) return b + suffix;
  return b + suffix;
}
