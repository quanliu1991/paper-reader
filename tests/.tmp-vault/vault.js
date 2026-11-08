// electron/vault.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";
import YAML from "yaml";
function sanitizeKeyPart(s) {
  return s.replace(/[/:\\]/g, "-");
}
function paperKeyFor(p) {
  const year = (p.created_at ?? "").slice(0, 4) || "0000";
  if (p.arxiv_id) return `${year}-${sanitizeKeyPart(p.arxiv_id)}`;
  const h = crypto.createHash("sha1").update(p.created_at ?? "").digest("hex").slice(0, 12);
  return `${year}-local-${h}`;
}
function slugFor(name) {
  return (name ?? "").trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "") || "topic";
}
function srcHash(en) {
  const norm = (en ?? "").replace(/\$[^$]*\$/g, " ").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(norm, "utf8").digest("hex");
}
var AGENTS_MD = `# Paper Reader Vault

\u8FD9\u662F\u8BBA\u6587\u9605\u8BFB\u7684\u77E5\u8BC6\u5E93\uFF08\u4E8B\u5B9E\u6E90\uFF09\u3002App \u7684 SQLite \u53EA\u662F\u53EF\u91CD\u5EFA\u7D22\u5F15\u3002

## \u76EE\u5F55

- papers/&lt;year&gt;-&lt;arxivId&gt;/\uFF1A\u6BCF\u7BC7\u8BBA\u6587\u4E00\u4E2A\u6587\u4EF6\u5939
  - paper.pdf / paper-dual.pdf / paper-mono.pdf\uFF1A\u539F\u59CB\u4E0E\u7FFB\u8BD1\u4EA7\u7269
  - meta.yaml\uFF1A\u9898\u5F55/\u72B6\u6001/\u6807\u7B7E/\u8FDB\u5EA6\uFF08App \u7BA1\u8F96\u533A\uFF09
  - annotations.json\uFF1A\u5212\u7EBF\uFF08\u6587\u672C + \u5750\u6807\uFF0C\u542B sid/legacy_id\uFF09
  - notes.md\uFF1A\u6BB5\u843D\u951A\u5B9A\u7B14\u8BB0\uFF08&lt;!-- note ... --&gt; \u5B9A\u754C\uFF0C\u6B63\u6587\u533A\u4EBA\u7C7B\u53EF\u7F16\u8F91\uFF09
  - qa.jsonl\uFF1A\u95EE\u7B54\uFF08\u8FFD\u52A0\u5F0F\uFF09
  - translations.jsonl\uFF1A\u8BD1\u6587\uFF08src_hash \u951A\u5B9A\uFF0C\u81EA\u5E26\u539F\u6587\uFF09
  - digest.md\uFF1A\u7CBE\u70BC\u7B14\u8BB0\uFF08\u542B \u3010H12\u3011\u3010N3\u3011\u3010Q5\u3011 \u5F15\u7528\u4EE4\u724C\uFF09
- topics/\uFF1A\u4E3B\u9898\u56FE\u8C31 + \u4E3B\u9898\u7CBE\u70BC
- glossary/terms.yaml\uFF1A\u672F\u8BED\u8868
- flashcards.jsonl / profile.md\uFF1A\u95EA\u5361\u4E0E\u753B\u50CF

## \u5916\u90E8\u7F16\u8F91\u89C4\u5219

1. frontmatter/HTML \u6CE8\u91CA\u5B9A\u754C\u884C/JSON \u5B57\u6BB5\uFF08sid\u3001legacy_id\u3001seq \u951A\uFF09\u662F App \u7BA1\u8F96\u533A\uFF0C\u8BF7\u52FF\u6539\u52A8
2. notes.md \u5B9A\u754C\u884C\u4E4B\u95F4\u7684\u6B63\u6587\u53EF\u81EA\u7531\u7F16\u8F91\uFF0CApp \u5199\u524D\u4F1A\u91CD\u8BFB\u5E76\u4E0D\u8986\u76D6\u4F60\u7684\u4FEE\u6539\u533A\u8BED\u4E49
3. \u5220\u9664\u884C = \u5220\u9664\u8BE5\u6761\u76EE\uFF08rebuild \u65F6\u4EE5\u6587\u4EF6\u4E3A\u51C6\uFF09

\u540C\u6B65\uFF1A\u672C\u76EE\u5F55\u5373 git \u4ED3\u5E93\uFF0C\u8FDC\u7AEF\u7531\u7528\u6237\u914D\u7F6E\u3002
`;
var GITIGNORE = `.paper-reader/
trash/
*.conflict.*
`;
function ensureLayout(vaultDir) {
  fs.mkdirSync(path.join(vaultDir, "papers"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "topics"), { recursive: true });
  const agents = path.join(vaultDir, "AGENTS.md");
  if (!fs.existsSync(agents)) fs.writeFileSync(agents, AGENTS_MD);
  const gi = path.join(vaultDir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE);
}
function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.tmp-${path.basename(filePath)}`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}
function serializeMeta(p, extra) {
  const tags = (() => {
    if (Array.isArray(p.tags)) return p.tags;
    if (typeof p.tags === "string" && p.tags.trim()) {
      try {
        return JSON.parse(p.tags);
      } catch {
        return [];
      }
    }
    return [];
  })();
  const obj = {
    version: 1,
    legacy_id: p.id,
    arxiv_id: p.arxiv_id ?? null,
    title: p.title ?? "",
    authors: p.authors ?? "",
    source_url: p.source_url ?? "",
    import_type: p.import_type ?? "html",
    status: p.status ?? "unread",
    tags,
    created_at: p.created_at ?? "",
    read_pct: extra.readPct ?? 0,
    sha256: extra.sha256 ?? "",
    pdf: {
      ...extra.hasDual ? { dual: "paper-dual.pdf" } : {},
      ...extra.hasMono ? { mono: "paper-mono.pdf" } : {}
    },
    ...extra.summary ? { summary: extra.summary } : {}
  };
  return YAML.stringify(obj);
}
function parseMeta(text) {
  return YAML.parse(text);
}
function serializeAnnotations(items) {
  return JSON.stringify({ version: 1, items }, null, 2) + "\n";
}
function parseAnnotations(text) {
  if (!text.trim()) return [];
  try {
    const obj = JSON.parse(text);
    return Array.isArray(obj?.items) ? obj.items : [];
  } catch {
    return [];
  }
}
var NOTE_RE = /^<!--\s*note\s+sid=(\S+)\s+legacy=(\d+)\s+seq=(\S*)\s+created=(.+?)\s+updated=(.+?)\s*-->$/;
function serializeNotes(rows) {
  const parts = [];
  for (const n of rows) {
    const head = `<!-- note sid=${n.sid} legacy=${n.legacy_id} seq=${n.pid ?? ""} created=${n.created_at} updated=${n.updated_at} -->`;
    parts.push(`${head}
${n.text ?? ""}`);
  }
  return parts.join("\n\n") + (parts.length ? "\n" : "");
}
function parseNotes(text) {
  if (!text.trim()) return [];
  const out = [];
  const lines = text.split("\n");
  let cur = null;
  const body = [];
  const flush = () => {
    if (cur) {
      cur.text = body.join("\n").replace(/\n+$/, "");
      out.push(cur);
    }
    cur = null;
    body.length = 0;
  };
  let inBody = false;
  for (const line of lines) {
    const m = line.trim().match(NOTE_RE);
    if (m) {
      flush();
      cur = {
        sid: m[1],
        legacy_id: Number(m[2]),
        seq: m[3] === "" ? null : Number(m[3]),
        created_at: m[4],
        updated_at: m[5],
        text: ""
      };
      inBody = true;
    } else if (inBody && cur) {
      body.push(line);
    }
  }
  flush();
  return out;
}
function serializeQa(rows) {
  return rows.map((r) => JSON.stringify({
    sid: r.sid,
    legacy_id: r.legacy_id,
    seq: r.pid ?? null,
    question: r.question,
    answer: r.answer ?? "",
    provider: r.provider ?? "",
    model: r.model ?? "",
    created_at: r.created_at
  })).join("\n") + (rows.length ? "\n" : "");
}
function parseQa(text) {
  return parseJsonl(text);
}
function serializeTranslations(rows) {
  return rows.map((r) => JSON.stringify({
    seq: r.seq,
    src_hash: srcHash(r.en),
    en: r.en,
    zh: r.zh,
    provider: r.provider ?? "",
    model: r.model ?? "",
    updated_at: r.updated_at
  })).join("\n") + (rows.length ? "\n" : "");
}
function parseTranslations(text) {
  return parseJsonl(text);
}
var DIGEST_HEAD_RE = /^<!--\s*digest\s+kind=(\S+)\s+updated=(.+?)\s*-->$/;
function serializeDigest(body, updatedAt) {
  return `<!-- digest kind=paper updated=${updatedAt} -->
${body}
`;
}
function parseDigest(text) {
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const m = lines[0].trim().match(DIGEST_HEAD_RE);
  if (!m) return { body: text, updated_at: "" };
  return { body: lines.slice(1).join("\n").replace(/\n+$/, ""), updated_at: m[2] };
}
function serializeFlashcards(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
function parseFlashcards(text) {
  return parseJsonl(text);
}
function serializeTopic(t, papers, edges) {
  return JSON.stringify({
    version: 1,
    legacy_id: t.legacy_id ?? t.id,
    name: t.name,
    query: t.query ?? "",
    status: t.status ?? "ready",
    node_count: t.node_count ?? papers.length,
    edge_count: t.edge_count ?? edges.length,
    note: t.note ?? "",
    created_at: t.created_at,
    updated_at: t.updated_at,
    papers: papers.map((p) => ({
      arxiv_id: p.arxiv_id,
      title: p.title,
      year: p.year ?? null,
      citation_count: p.citation_count ?? 0,
      layer: p.layer ?? "node",
      in_degree: p.in_degree ?? 0,
      out_degree: p.out_degree ?? 0,
      read_order: p.read_order ?? null,
      imported: p.imported ? 1 : 0
    })),
    edges: edges.map((e) => ({ src: e.src, dst: e.dst }))
  }, null, 2) + "\n";
}
function parseTopic(text) {
  return JSON.parse(text);
}
var PROFILE_BG_RE = /^<!--\s*profile\s+kind=bg\s+updated=(.+?)\s*-->$/;
var PROFILE_SIG_RE = /^<!--\s*profile\s+kind=signals\s+updated=(.+?)\s*-->$/;
function serializeProfile(bg, signals, updatedAt) {
  const sig = Object.entries(signals ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `<!-- profile kind=bg updated=${updatedAt} -->
${bg ?? ""}

<!-- profile kind=signals updated=${updatedAt} -->
${sig}
`;
}
function parseProfile(text) {
  const lines = (text ?? "").split("\n");
  let bg = [];
  const signals = {};
  let mode = "none";
  for (const line of lines) {
    if (PROFILE_BG_RE.test(line.trim())) {
      mode = "bg";
      continue;
    }
    if (PROFILE_SIG_RE.test(line.trim())) {
      mode = "signals";
      continue;
    }
    if (mode === "bg") bg.push(line);
    else if (mode === "signals") {
      const m = line.match(/^(\S+):\s*(\d+)$/);
      if (m) signals[m[1]] = Number(m[2]);
    }
  }
  return { bg: bg.join("\n").replace(/\n+$/, ""), signals };
}
function parseJsonl(text) {
  if (!text.trim()) return [];
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
export {
  ensureLayout,
  paperKeyFor,
  parseAnnotations,
  parseDigest,
  parseFlashcards,
  parseMeta,
  parseNotes,
  parseProfile,
  parseQa,
  parseTopic,
  parseTranslations,
  sanitizeKeyPart,
  serializeAnnotations,
  serializeDigest,
  serializeFlashcards,
  serializeMeta,
  serializeNotes,
  serializeProfile,
  serializeQa,
  serializeTopic,
  serializeTranslations,
  slugFor,
  srcHash,
  writeAtomic
};
