#!/usr/bin/env node
/**
 * local-llm-watch.mjs — 无人值守的本地 LLM 接管监视器
 *
 * 职责（对应计划步骤 0 的收尾）：
 *  1. 轮询 Qwen3.6-35B-A3B-MLX-4bit 下载目录，等待全部 `.part` 消失（下载完成、分片改名）
 *  2. 通过 LM Studio CLI（lms）加载模型；失败则退回提示手工加载
 *  3. 双路实测：
 *     a) chat completion（/v1/chat/completions）
 *     b) 多模态读图（发送本地 PNG base64 到 /v1/chat/completions）
 *  4. 结果写 build/local-llm-check.json；供 improve-loop --audit 与人工查验
 *
 * 用法：nohup node scripts/local-llm-watch.mjs > build/local-llm-watch.log 2>&1 &
 * 幂等：已存在完成报告时直接退出。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const MODEL_DIR = path.join(homedir(), '.lmstudio/models/lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit');
const MODEL_ID = 'lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit';
const BASE = 'http://localhost:1234/v1';
const OUT = 'build/local-llm-check.json';
const POLL_MS = 5 * 60 * 1000; // 5 分钟
const MAX_HOURS = 24;

const log = (m) => console.log(`[watch ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(OUT)) {
  log(`已存在 ${OUT}，无需重复执行`);
  process.exit(0);
}

/** 目录内是否还有未完成分片 */
function partsRemaining() {
  if (!existsSync(MODEL_DIR)) return Infinity; // 目录都没了，异常
  return readdirSync(MODEL_DIR).filter((f) => f.endsWith('.part')).length;
}

/** 找一个小的本地 PNG 作为视觉测试图 */
function findTestPng() {
  for (const c of ['build/ux/screenshots/01-paper-list.png', 'build/pdf-ui-e2e.png']) {
    const p = path.resolve(c);
    if (existsSync(p)) return p;
  }
  return null;
}

async function tryLoad() {
  const lms = [path.join(homedir(), '.lmstudio/lms'), 'lms'].find((c) => {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  });
  if (!lms) return { ok: false, error: 'lms CLI 不可用' };
  try {
    execFileSync(lms, ['load', MODEL_ID], { timeout: 10 * 60_000, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message ?? e).slice(0, 200) };
  }
}

async function listChatModels() {
  const r = await fetch(`${BASE}/models`);
  const j = await r.json();
  return (j.data ?? [])
    .map((m) => m.id)
    .filter((id) => !/embed|bge|rerank/i.test(id)); // 与 electron/vision.ts 过滤规则一致
}

async function testChat(model) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复两个字：就绪' }],
      max_tokens: 512,
      temperature: 0,
    }),
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  return { ok: r.ok && text.length > 0, sample: text.slice(0, 60) };
}

async function testVision(model, pngPath) {
  const b64 = readFileSync(pngPath).toString('base64');
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          { type: 'text', text: '这是论文阅读应用截图。用一句话描述界面主要区域；若无法读取图片，回复「无法读图」。' },
        ],
      }],
    }),
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  const err = j.error?.message ?? '';
  return { ok: r.ok && text.length > 0 && !/无法读图|unable/i.test(text), sample: (text || err).slice(0, 120) };
}

async function main() {
  const deadline = Date.now() + MAX_HOURS * 3600_000;
  log(`监视 ${MODEL_DIR}`);
  while (Date.now() < deadline) {
    const n = partsRemaining();
    if (n === 0) {
      log('下载完成（无 .part 残留）');
      break;
    }
    log(`仍有 ${n} 个分片下载中，${POLL_MS / 60000} 分钟后复查`);
    await sleep(POLL_MS);
  }
  if (partsRemaining() > 0) {
    writeFileSync(OUT, JSON.stringify({ status: 'timeout', at: new Date().toISOString() }, null, 2));
    process.exit(1);
  }

  // 等 LM Studio 完成分片改名与索引（保守 60s）
  await sleep(60_000);

  const load = await tryLoad();
  log(`lms load: ${load.ok ? 'ok' : load.error}`);

  const report = { at: new Date().toISOString(), model: MODEL_ID, load, chat: null, vision: null };
  try {
    const models = await listChatModels();
    log(`可聊天模型: ${models.join(', ') || '（无）'}`);
    if (models.length > 0) {
      report.chat = await testChat(models[0]);
      log(`chat 实测: ${report.chat.ok ? 'PASS' : 'FAIL'} → ${report.chat.sample}`);
      const png = findTestPng();
      if (png) {
        report.vision = await testVision(models[0], png);
        log(`vision 实测: ${report.vision.ok ? 'PASS（可读图，visual-judge 将自动走本地）' : 'FAIL → ' + report.vision.sample}`);
      }
    }
  } catch (e) {
    report.error = String(e.message ?? e).slice(0, 200);
  }
  report.status = report.vision?.ok ? 'vision-ready' : report.chat?.ok ? 'chat-only' : 'not-ready';
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`报告 → ${OUT} (status=${report.status})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
