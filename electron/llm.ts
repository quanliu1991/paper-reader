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
