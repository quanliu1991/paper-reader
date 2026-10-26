"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/insights.ts
var insights_exports = {};
__export(insights_exports, {
  chatOnce: () => chatOnce,
  checkTermConsistency: () => checkTermConsistency,
  deriveReaderStrategy: () => deriveReaderStrategy,
  genSectionSummaries: () => genSectionSummaries,
  genTriageSummary: () => genTriageSummary,
  suggestQuestions: () => suggestQuestions
});
module.exports = __toCommonJS(insights_exports);

// electron/llm.ts
var import_electron = require("electron");
async function chatStream(provider, messages, handlers, opts) {
  const temperature = opts?.temperature ?? 0.3;
  const maxTokens = opts?.maxTokens ?? 4096;
  try {
    if (provider.protocol === "anthropic") {
      await streamAnthropic(provider, messages, handlers, temperature, maxTokens, opts?.signal);
    } else {
      await streamOpenAI(provider, messages, handlers, temperature, maxTokens, opts?.signal);
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      handlers.onDone("");
      return;
    }
    handlers.onError(String(e?.message ?? e));
  }
}
async function streamOpenAI(p, messages, h, temperature, maxTokens, signal) {
  const url = joinUrl(p.baseUrl, "/chat/completions");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.model, messages, temperature, max_tokens: maxTokens, stream: true }),
    signal
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`${resp.status} ${await resp.text().catch(() => "")}`.slice(0, 300));
  }
  const full = await readSse(resp.body, h.onDelta);
  h.onDone(full);
}
async function streamAnthropic(p, messages, h, temperature, maxTokens, signal) {
  const url = joinUrl(p.baseUrl, "/v1/messages");
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: p.model,
      system: system || void 0,
      messages: rest,
      temperature,
      max_tokens: maxTokens,
      stream: true
    }),
    signal
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`${resp.status} ${await resp.text().catch(() => "")}`.slice(0, 300));
  }
  const full = await readSse(resp.body, h.onDelta);
  h.onDone(full);
}
async function readSse(body, onDelta) {
  let full = "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("data:")) {
        const data = t.slice(5).trim();
        if (data === "[DONE]") return full;
        const delta = extractDelta(data);
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    }
  }
  return full;
}
function extractDelta(data) {
  try {
    const j = JSON.parse(data);
    return j.choices?.[0]?.delta?.content ?? j.delta?.text ?? "";
  } catch {
    return "";
  }
}
function joinUrl(base, suffix) {
  const b = base.replace(/\/+$/, "");
  if (suffix === "/chat/completions" && /\/v\d+$/.test(b)) return b + suffix;
  return b + suffix;
}

// electron/insights.ts
function chatOnce(provider, messages, maxTokens = 2048) {
  return new Promise((resolve, reject) => {
    let acc = "";
    chatStream(provider, messages, {
      onDelta: (d) => {
        acc += d;
      },
      onDone: (full) => resolve((full || acc).trim()),
      onError: reject
    }, { temperature: 0.3, maxTokens });
  });
}
async function genTriageSummary(provider, title, authors, abstract, bodySample, knownTitles) {
  const context = `\u8BBA\u6587\u6807\u9898\uFF1A${title}
\u4F5C\u8005\uFF1A${authors}
\u6458\u8981\uFF1A${abstract}
\u6B63\u6587\u62BD\u6837\uFF1A${bodySample}`;
  const relatedHint = knownTitles.length ? `

\u6211\u77E5\u8BC6\u5E93\u5DF2\u8BFB\u8BBA\u6587\uFF08\u5982\u6709\u5173\u8054\u8BF7\u6307\u51FA\uFF0C\u6CA1\u6709\u5219\u5199\u300C\u65E0\u76F4\u63A5\u5173\u8054\u300D\uFF09\uFF1A
${knownTitles.slice(0, 20).join("\n")}` : "";
  const raw = await chatOnce(provider, [
    { role: "system", content: `\u4F60\u662F\u8BBA\u6587\u5FEB\u901F\u8BC4\u4F30\u52A9\u624B\u3002\u57FA\u4E8E\u7ED9\u5B9A\u5185\u5BB9\u8F93\u51FA JSON\uFF08\u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\uFF09\uFF1A
{"oneLiner": "\u4E00\u53E5\u8BDD\u8BF4\u8FD9\u7BC7\u8BBA\u6587\u89E3\u51B3\u4E86\u4EC0\u4E48\u95EE\u9898\uFF08\u666E\u901A\u4EBA\u80FD\u61C2\uFF09", "problem": "\u6838\u5FC3\u95EE\u9898 1-2 \u53E5", "method": "\u6838\u5FC3\u65B9\u6CD5 1-2 \u53E5", "results": "\u5173\u952E\u7ED3\u679C\uFF08\u542B\u6570\u5B57\uFF091-2 \u53E5", "related": "\u4E0E\u5DF2\u8BFB\u8BBA\u6587\u7684\u5173\u8054\u6216\u300C\u65E0\u76F4\u63A5\u5173\u8054\u300D"}
oneLiner \u8981\u5177\u4F53\uFF0C\u4E0D\u8981\u300C\u63D0\u51FA\u4E86\u4E00\u4E2A\u65B0\u65B9\u6CD5\u300D\u8FD9\u79CD\u7A7A\u8BDD\u3002` },
    { role: "user", content: context + relatedHint }
  ]);
  return parseJsonLoose(raw);
}
async function genSectionSummaries(provider, sections) {
  const out = [];
  const targets = sections.filter((s) => s.text.length > 200).slice(0, 30);
  const concurrency = 3;
  const queue = [...targets.entries()];
  async function worker() {
    for (; ; ) {
      const item = queue.shift();
      if (!item) return;
      const [i, sec] = item;
      try {
        const sum = await chatOnce(provider, [
          { role: "system", content: "\u7528\u4E2D\u6587 2-3 \u53E5\u603B\u7ED3\u8FD9\u4E00\u8282\u8BBA\u6587\u5185\u5BB9\uFF0C\u76F4\u63A5\u8F93\u51FA\u603B\u7ED3\uFF0C\u672F\u8BED\u4FDD\u7559\u82F1\u6587\u3002" },
          { role: "user", content: `\u3010${sec.heading}\u3011
${sec.text.slice(0, 4e3)}` }
        ], 512);
        out[i] = { seq: i, heading: sec.heading, summary: sum };
      } catch {
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out.filter(Boolean);
}
async function checkTermConsistency(provider, translatedBlocks, glossary) {
  const watchTerms = glossary.filter((t) => t.level === "learning" || t.level === "unknown");
  if (!watchTerms.length || !translatedBlocks.length) return [];
  const termList = watchTerms.slice(0, 100).map((t) => t.term).join(", ");
  const sample = translatedBlocks.slice(0, 20);
  const payload = sample.map((b) => `#${b.pid}
EN: ${b.en.slice(0, 300)}
ZH: ${b.zh.slice(0, 300)}`).join("\n\n");
  const raw = await chatOnce(provider, [
    { role: "system", content: `\u4F60\u662F\u7FFB\u8BD1\u8D28\u68C0\u5458\u3002\u4E0B\u9762\u6BCF\u4E2A\u7F16\u53F7\u6BB5\u843D\u6709\u82F1\u6587\u539F\u6587\u548C\u4E2D\u6587\u8BD1\u6587\u3002\u672F\u8BED\u8868\u5E94\u4FDD\u7559\u82F1\u6587\u7684\u672F\u8BED\uFF1A${termList}\u3002
\u68C0\u67E5\u8BD1\u6587\u662F\u5426\u8FDD\u53CD\u300C\u672F\u8BED\u4FDD\u7559\u82F1\u6587\u300D\u89C4\u5219\uFF08\u628A\u8BE5\u672F\u8BED\u7FFB\u8BD1\u6210\u4E86\u4E2D\u6587\uFF09\u3002
\u8F93\u51FA JSON \u6570\u7EC4\uFF08\u65E0\u95EE\u9898\u8F93\u51FA []\uFF0C\u53EA\u8F93\u51FA JSON\uFF09\uFF1A
[{"pid": \u6BB5\u843D\u53F7, "term": "\u88AB\u8BEF\u8BD1\u7684\u672F\u8BED", "zhSnippet": "\u8BD1\u6587\u4E2D\u9519\u8BEF\u7247\u6BB5\uFF0820\u5B57\u5185\uFF09", "suggestion": "\u6539\u6B63\u5EFA\u8BAE"}]` },
    { role: "user", content: payload }
  ], 1024);
  const arr = parseJsonLoose(raw);
  return Array.isArray(arr) ? arr.filter((x) => x && typeof x.pid === "number") : [];
}
function deriveReaderStrategy(profile) {
  const s = profile.signals ?? {};
  const concept = s.concept ?? 0;
  const method = s.method ?? 0;
  const result = s.result ?? 0;
  const shallow = s["tooShallow"] ?? 0;
  const deep = s["tooDeep"] ?? 0;
  const right = s["justRight"] ?? 0;
  const bg = (profile.bg ?? "").trim();
  const bgLower = bg.toLowerCase();
  let depthRule = "\u9ED8\u8BA4\u6309\u7814\u7A76\u751F\u6C34\u5E73\u56DE\u7B54\uFF1A\u5148\u76F4\u63A5\u7ED3\u8BBA\uFF0C\u518D\u7ED9\u63A8\u5BFC/\u8BC1\u636E\uFF0C\u5173\u952E\u6982\u5FF5\u987A\u5E26\u4E00\u53E5\u89E3\u91CA\u3002";
  if (shallow > deep + 1) depthRule = "\u7528\u6237\u53CD\u9988\u8FC7\u591A\u6B21\u300C\u592A\u6D45\u300D\uFF1A\u56DE\u7B54\u8981\u66F4\u6DF1\u2014\u2014\u7ED9\u516C\u5F0F\u63A8\u5BFC\u3001\u4E0E\u5176\u4ED6\u65B9\u6CD5\u7684\u5BF9\u6BD4\u3001\u5B9E\u73B0\u7EC6\u8282\uFF0C\u4E0D\u8981\u6CDB\u6CDB\u800C\u8C08\u3002";
  else if (deep > shallow + 1) depthRule = "\u7528\u6237\u53CD\u9988\u8FC7\u591A\u6B21\u300C\u592A\u6DF1\u300D\uFF1A\u56DE\u7B54\u8981\u66F4\u6D45\u2014\u2014\u5148\u6253\u6BD4\u65B9\u8BF4\u4EBA\u8BDD\uFF0C\u5C11\u5806\u516C\u5F0F\uFF0C\u6982\u5FF5\u5148\u4E00\u53E5\u8BDD\u5B9A\u4E49\u518D\u5C55\u5F00\u3002";
  else if (right >= 5 && shallow + deep === 0) depthRule = "\u5F53\u524D\u6DF1\u5EA6\u6B63\u5408\u9002\uFF0C\u4FDD\u6301\uFF1A\u5148\u7ED3\u8BBA\u540E\u5C55\u5F00\uFF0C\u4E13\u4E1A\u4F46\u514B\u5236\u3002";
  let vocabRule = "\u672F\u8BED\u4FDD\u7559\u82F1\u6587\uFF1B\u57FA\u7840\u6982\u5FF5\uFF08KV cache\u3001\u6295\u673A\u89E3\u7801\u8FD9\u7C7B\uFF09\u53EF\u76F4\u63A5\u4F7F\u7528\u4E0D\u89E3\u91CA\u3002";
  if (/不熟|新手|入门|小白/.test(bg)) vocabRule = "\u7528\u6237\u81EA\u8FF0\u65B0\u624B\uFF1A\u6BCF\u4E2A\u672F\u8BED\u9996\u6B21\u51FA\u73B0\u90FD\u7528\u4E00\u53E5\u8BDD\u65E5\u5E38\u7C7B\u6BD4\u89E3\u91CA\uFF08\u5982 KV cache \u5C31\u50CF\u8349\u7A3F\u7EB8\uFF09\uFF0C\u518D\u7ED9\u4E25\u8C28\u5B9A\u4E49\u3002";
  else if (/熟悉|精通|专家|多年/.test(bg) && !/不熟/.test(bg)) vocabRule = "\u7528\u6237\u662F\u4E13\u5BB6\uFF1A\u76F4\u63A5\u7528\u9886\u57DF\u9ED1\u8BDD\uFF0C\u4E0D\u7528\u89E3\u91CA\u57FA\u7840\u6982\u5FF5\uFF0C\u91CD\u70B9\u8BB2\u589E\u91CF\u8D21\u732E\u4E0E trade-off\u3002";
  else if (concept > method + result + 2) vocabRule = "\u7528\u6237\u5E38\u95EE\u6982\u5FF5\uFF1A\u9ED8\u8BA4\u8BFB\u8005\u5BF9\u57FA\u7840\u672F\u8BED\u4E0D\u719F\uFF0C\u9996\u6B21\u51FA\u73B0\u914D\u4E00\u53E5\u8BDD\u89E3\u91CA\u3002";
  const suggestKind = concept >= method && concept >= result ? "concept" : method >= result ? "method" : "result";
  const total = concept + method + result;
  let rationale = "\u8FD8\u6CA1\u6709\u4F60\u7684\u63D0\u95EE\u8BB0\u5F55\uFF0C\u5148\u6309\u5165\u95E8\u8BFB\u8005\u63A8\u8350\u6982\u5FF5\u7C7B\u95EE\u9898\u3002";
  if (total >= 3) {
    if (suggestKind === "concept") rationale = `\u4F60\u5E38\u95EE\u6982\u5FF5\u7C7B\u95EE\u9898\uFF08${concept}/${total}\uFF09\uFF0C\u7EE7\u7EED\u63A8\u8350\u6982\u5FF5\u6F84\u6E05\u7C7B\u3002`;
    else if (suggestKind === "method") rationale = `\u4F60\u66F4\u5173\u6CE8\u65B9\u6CD5\u7EC6\u8282\uFF08${method}/${total}\uFF09\uFF0C\u63A8\u8350\u65B9\u6CD5\u673A\u7406\u7C7B\u95EE\u9898\u3002`;
    else rationale = `\u4F60\u5173\u6CE8\u5B9E\u9A8C\u7ED3\u8BBA\uFF08${result}/${total}\uFF09\uFF0C\u63A8\u8350\u7ED3\u679C\u89E3\u8BFB\u7C7B\u95EE\u9898\u3002`;
  }
  if (shallow + deep >= 3) {
    rationale += shallow > deep ? "\uFF08\u6309\u4F60\u7684\u300C\u592A\u6D45\u300D\u53CD\u9988\uFF0C\u56DE\u7B54\u5DF2\u8C03\u6DF1\uFF09" : "\uFF08\u6309\u4F60\u7684\u300C\u592A\u6DF1\u300D\u53CD\u9988\uFF0C\u56DE\u7B54\u5DF2\u8C03\u6D45\uFF09";
  }
  return { depthRule, vocabRule, suggestKind, rationale };
}
function suggestQuestions(strategy, headings) {
  const h = headings.filter((x) => x && x.length > 3).slice(0, 12);
  const pick = () => h.length ? h[Math.floor(Math.random() * h.length)] : "Method";
  if (strategy.suggestKind === "concept") {
    return [
      { label: `\u300C${pick().slice(0, 18)}\u300D\u8FD9\u8282\u5728\u8BB2\u4EC0\u4E48`, prompt: `\u300CX\u300D\u8FD9\u4E00\u8282\u5728\u8BB2\u4EC0\u4E48\uFF1F\u548C\u5168\u6587\u4E3B\u7EBF\u4EC0\u4E48\u5173\u7CFB\uFF1F` },
      { label: "\u5168\u6587\u6838\u5FC3\u601D\u60F3", prompt: "\u7528\u4E09\u53E5\u8BDD\u8BB2\u6E05\u8FD9\u7BC7\u8BBA\u6587\u7684\u6838\u5FC3\u601D\u60F3\uFF0C\u518D\u6307\u51FA\u6700\u5173\u952E\u7684\u4E00\u4E2A\u516C\u5F0F\u6216\u56FE\u3002" },
      { label: "\u6211\u9700\u8981\u4EC0\u4E48\u5148\u9A8C\u77E5\u8BC6", prompt: "\u8BFB\u61C2\u8FD9\u7BC7\u9700\u8981\u54EA\u4E9B\u5148\u9A8C\u77E5\u8BC6\uFF1F\u6211\u7F3A\u4EC0\u4E48\u8865\u4EC0\u4E48\uFF0C\u6309\u91CD\u8981\u6027\u6392\u5E8F\u3002" }
    ];
  }
  if (strategy.suggestKind === "method") {
    return [
      { label: `\u65B9\u6CD5\u7684\u5173\u952E\u6B65\u9AA4`, prompt: `${pick()} \u90E8\u5206\u7684\u65B9\u6CD5\u5173\u952E\u6B65\u9AA4\u662F\u4EC0\u4E48\uFF1F\u9010\u6B65\u62C6\u89E3\uFF0C\u6807\u6CE8\u54EA\u6B65\u662F\u672C\u6587\u7684\u521B\u65B0\u3002` },
      { label: "\u4E3A\u4EC0\u4E48\u8FD9\u6837\u8BBE\u8BA1", prompt: "\u6838\u5FC3\u65B9\u6CD5\u4E3A\u4EC0\u4E48\u8FD9\u6837\u8BBE\u8BA1\uFF1F\u6362\u4E2A\u66F4\u7B80\u5355\u7684\u65B9\u6848\u884C\u4E0D\u884C\uFF0C\u5DEE\u5728\u54EA\uFF1F" },
      { label: "\u590D\u6742\u5EA6\u4E0E\u5F00\u9500", prompt: "\u8FD9\u4E2A\u65B9\u6CD5\u7684\u65F6\u95F4/\u7A7A\u95F4\u590D\u6742\u5EA6\u548C\u5DE5\u7A0B\u5F00\u9500\u600E\u4E48\u6837\uFF1F\u8D35\u5728\u54EA\uFF1F" }
    ];
  }
  return [
    { label: "\u5173\u952E\u6570\u5B57\u600E\u4E48\u8BFB", prompt: "\u5B9E\u9A8C\u90E8\u5206\u6700\u5173\u952E\u7684\u6570\u5B57\u7ED3\u8BBA\u662F\u4EC0\u4E48\uFF1F\u548C baseline \u6BD4\u63D0\u5347\u591A\u5C11\uFF0C\u4EE3\u4EF7\u662F\u4EC0\u4E48\uFF1F" },
    { label: "\u6D88\u878D\u8BF4\u660E\u4E86\u4EC0\u4E48", prompt: "\u6D88\u878D\u5B9E\u9A8C\u8BF4\u660E\u4E86\u4EC0\u4E48\uFF1F\u54EA\u4E2A\u7EC4\u4EF6\u8D21\u732E\u6700\u5927\uFF1F" },
    { label: "\u7ED3\u679C\u53EF\u4FE1\u5417", prompt: "\u5B9E\u9A8C\u8BBE\u7F6E\u6709\u6CA1\u6709\u503C\u5F97\u6000\u7591\u7684\u5730\u65B9\uFF08\u6570\u636E\u96C6\u89C4\u6A21\u3001baseline \u5F3A\u5EA6\u3001\u8D85\u53C2\u654F\u611F\u6027\uFF09\uFF1F" }
  ];
}
function parseJsonLoose(raw) {
  let s = raw.replace(/```(json)?/g, "").trim();
  const start = Math.min(
    ...[s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0)
  );
  if (Number.isFinite(start) && start > 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch {
    const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (lastBrace > 0) {
      try {
        return JSON.parse(s.slice(0, lastBrace + 1));
      } catch {
      }
    }
    throw new Error("AI \u8FD4\u56DE\u7684\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A" + raw.slice(0, 120));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  chatOnce,
  checkTermConsistency,
  deriveReaderStrategy,
  genSectionSummaries,
  genTriageSummary,
  suggestQuestions
});
