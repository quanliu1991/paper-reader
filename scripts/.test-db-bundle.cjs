"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scripts/test-db-entry.ts
var test_db_entry_exports = {};
__export(test_db_entry_exports, {
  default: () => run
});
module.exports = __toCommonJS(test_db_entry_exports);
var import_electron2 = require("electron");
var import_fs2 = __toESM(require("fs"));

// electron/db.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));
var import_electron = require("electron");
var db = null;
function getDb() {
  if (db) return db;
  const userData = import_electron.app.getPath("userData");
  import_fs.default.mkdirSync(userData, { recursive: true });
  db = new import_better_sqlite3.default(import_path.default.join(userData, "paper-reader.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}
function migrate(d) {
  d.exec(`  CREATE TABLE IF NOT EXISTS papers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arxiv_id TEXT UNIQUE,
    title TEXT NOT NULL,
    authors TEXT DEFAULT '',
    source_url TEXT DEFAULT '',
    import_type TEXT DEFAULT 'html',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_opened_at TEXT
  );

  CREATE TABLE IF NOT EXISTS blocks (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'para',        -- heading | para | fig
    level INTEGER DEFAULT 0,                  -- heading \u7EA7\u522B
    en TEXT NOT NULL,
    fig_path TEXT                             -- \u672C\u5730\u56FE\u8868\u8DEF\u5F84\uFF08\u53EF\u9009\uFF09
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_paper ON blocks(paper_id, seq);

  CREATE TABLE IF NOT EXISTS translations (
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    pid INTEGER NOT NULL REFERENCES blocks(pid) ON DELETE CASCADE,
    zh TEXT NOT NULL,
    provider TEXT DEFAULT '',
    model TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (paper_id, pid)
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    pid INTEGER NOT NULL,
    text_en TEXT NOT NULL,                    -- \u9009\u4E2D\u7684\u539F\u6587
    note TEXT DEFAULT '',                     -- \u7528\u6237\u5907\u6CE8\uFF08\u53EF\u9009\uFF09
    color TEXT DEFAULT 'yellow',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_hl_paper ON highlights(paper_id);

  CREATE TABLE IF NOT EXISTS qa_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    highlight_id INTEGER,
    pid INTEGER,                              -- \u63D0\u95EE\u6240\u5728\u6BB5\u843D
    question TEXT NOT NULL,
    answer TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    model TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_qa_paper ON qa_pairs(paper_id);

  CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'openai',  -- openai | anthropic
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,                    -- DPAPI \u52A0\u5BC6\u540E
    model TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS paper_summaries (
    paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,                    -- JSON: {oneLiner, problem, method, results, related}
    section_summaries TEXT DEFAULT '',        -- JSON: [{heading, summary, seq}]
    provider TEXT DEFAULT '',
    model TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    pid INTEGER NOT NULL,
    front TEXT NOT NULL,
    back TEXT DEFAULT '',
    -- SM-2 \u7B80\u5316\u7248\u8C03\u5EA6\u5B57\u6BB5
    interval_days REAL DEFAULT 0,
    ease REAL DEFAULT 2.5,
    reps INTEGER DEFAULT 0,
    lapses INTEGER DEFAULT 0,
    due TEXT DEFAULT (datetime('now','localtime')),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_fc_due ON flashcards(due);
  `);
  migrateColumns(d);
}
function migrateColumns(d) {
  const cols = d.prepare("PRAGMA table_info(blocks)").all();
  if (cols.length && !cols.some((c) => c.name === "fig_kind")) {
    d.prepare("ALTER TABLE blocks ADD COLUMN fig_kind TEXT").run();
  }
}
function insertPaper(p) {
  const d = getDb();
  d.prepare(
    `INSERT INTO papers (arxiv_id, title, authors, source_url, import_type) VALUES (?,?,?,?,?)
     ON CONFLICT(arxiv_id) DO UPDATE SET title=excluded.title, authors=excluded.authors`
  ).run(p.arxivId, p.title, p.authors, p.sourceUrl, p.importType);
  const row = d.prepare("SELECT id FROM papers WHERE arxiv_id=?").get(p.arxivId);
  return row.id;
}
function listPapers() {
  return getDb().prepare(
    `SELECT p.*, COUNT(b.pid) AS block_count,
       (SELECT COUNT(*) FROM translations t WHERE t.paper_id=p.id) AS translated_count,
       (SELECT COUNT(*) FROM highlights h WHERE h.paper_id=p.id) AS highlight_count,
       (SELECT s.summary FROM paper_summaries s WHERE s.paper_id=p.id) AS summary,
       (SELECT value FROM settings WHERE key='read:' || p.id) AS read_pct
     FROM papers p LEFT JOIN blocks b ON b.paper_id=p.id
     GROUP BY p.id ORDER BY p.created_at DESC`
  ).all();
}
function insertBlocks(paperId, blocks) {
  const d = getDb();
  const tx = d.transaction((rows) => {
    d.prepare("DELETE FROM blocks WHERE paper_id=?").run(paperId);
    const stmt = d.prepare("INSERT INTO blocks (paper_id, seq, type, level, en, fig_path) VALUES (?,?,?,?,?,?)");
    for (const b of rows) stmt.run(paperId, b.seq, b.type, b.level, b.en, b.figPath ?? null);
  });
  tx(blocks);
}
function getBlocks(paperId) {
  return getDb().prepare(
    `SELECT b.pid, b.seq, b.type, b.level, b.en, b.fig_path, t.zh
     FROM blocks b LEFT JOIN translations t ON t.paper_id=b.paper_id AND t.pid=b.pid
     WHERE b.paper_id=? ORDER BY b.seq`
  ).all(paperId);
}
function saveTranslation(paperId, pid, zh, provider, model) {
  getDb().prepare(
    `INSERT INTO translations (paper_id, pid, zh, provider, model, updated_at)
     VALUES (?,?,?,?,?, datetime('now','localtime'))
     ON CONFLICT(paper_id, pid) DO UPDATE SET zh=excluded.zh, provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at`
  ).run(paperId, pid, zh, provider, model);
}
function addHighlight(h) {
  const info = getDb().prepare(
    "INSERT INTO highlights (paper_id, pid, text_en, note, color) VALUES (?,?,?,?,?)"
  ).run(h.paperId, h.pid, h.textEn, h.note ?? "", h.color ?? "yellow");
  return Number(info.lastInsertRowid);
}
function listHighlights(paperId) {
  return getDb().prepare("SELECT * FROM highlights WHERE paper_id=? ORDER BY pid, created_at").all(paperId);
}
function removeHighlight(id) {
  getDb().prepare("DELETE FROM highlights WHERE id=?").run(id);
}
function addQa(q) {
  const info = getDb().prepare(
    "INSERT INTO qa_pairs (paper_id, highlight_id, pid, question, answer, provider, model) VALUES (?,?,?,?,?,?,?)"
  ).run(q.paperId, q.highlightId ?? null, q.pid ?? null, q.question, q.answer, q.provider ?? "", q.model ?? "");
  return Number(info.lastInsertRowid);
}
function listQa(paperId) {
  return getDb().prepare("SELECT * FROM qa_pairs WHERE paper_id=? ORDER BY created_at").all(paperId);
}
function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

// electron/arxiv.ts
function normalizeArxivId(input) {
  const s = input.trim();
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!m) return null;
  return m[1];
}
function parsePlainText(text, arxivId, title) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let seq = 0;
  let buf = [];
  const flush = () => {
    const t = buf.join(" ").trim();
    if (t.length > 1) {
      const isHeading = t.length < 80 && /^(abstract|references|appendix|[0-9]+\.|chapter| acknowledg)/i.test(t);
      blocks.push({ seq: seq++, type: isHeading ? "heading" : "para", level: isHeading ? 2 : 0, en: t });
    }
    buf = [];
  };
  for (const line of lines) {
    if (line.trim() === "") flush();
    else buf.push(line.trim());
  }
  flush();
  return { arxivId, title: title || arxivId, authors: "", blocks, importType: "text" };
}

// scripts/test-db-entry.ts
var log = (s) => {
  import_fs2.default.appendFileSync(process.env.PR_LOG, s + "\n");
};
async function run() {
  if (process.env.PR_TEST_DIR) import_electron2.app.setPath("userData", process.env.PR_TEST_DIR);
  const sampleText = `AgentPerfBench: A Benchmarking and Evaluation Suite

Abstract. We present AgentPerfBench, a benchmark for agentic LLM inference.

1 Introduction
Agentic inference has driven a dramatic increase in the volume of LLM inference workloads. Serving engines must adapt.

2 Background
KV cache management is central to serving efficiency. The prefill phase differs from decode.

References
[1] Some reference.`;
  const parsed = parsePlainText(sampleText, "2609.34683", "AgentPerfBench");
  log(`plaintext blocks: ${parsed.blocks.length}`);
  const paperId = insertPaper({
    arxivId: "2609.34683",
    title: parsed.title,
    authors: "",
    sourceUrl: "https://arxiv.org/abs/2609.34683",
    importType: "text"
  });
  insertBlocks(paperId, parsed.blocks);
  const again = insertPaper({
    arxivId: "2609.34683",
    title: parsed.title,
    authors: "",
    sourceUrl: "",
    importType: "text"
  });
  log(`idempotent insert: ${again === paperId ? "PASS" : `FAIL (${again} vs ${paperId})`}`);
  const blocks = getBlocks(paperId);
  log(`blocks read back: ${blocks.length}`);
  saveTranslation(paperId, blocks[1].pid, "\u6D4B\u8BD5\u8BD1\u6587", "test-provider", "test-model");
  const after = getBlocks(paperId);
  log(`translation cached: ${after[1].zh === "\u6D4B\u8BD5\u8BD1\u6587" ? "PASS" : "FAIL"}`);
  const hlId = addHighlight({ paperId, pid: blocks[1].pid, textEn: "KV cache management" });
  const hls = listHighlights(paperId);
  log(`highlight: ${hls.length === 1 && hls[0].id === hlId ? "PASS" : "FAIL"}`);
  removeHighlight(hlId);
  log(`highlight removed: ${listHighlights(paperId).length === 0 ? "PASS" : "FAIL"}`);
  addQa({ paperId, pid: blocks[1].pid, question: "\u4EC0\u4E48\u662F prefill\uFF1F", answer: "\u4E00\u53E3\u6C14\u8BFB\u5B8C\u9898\u76EE\u7684\u9636\u6BB5" });
  const qas = listQa(paperId);
  log(`qa: ${qas.length === 1 ? "PASS" : "FAIL"}`);
  setSetting("repo_path", "D:\\paper");
  log(`settings: ${getSetting("repo_path") === "D:\\paper" ? "PASS" : "FAIL"}`);
  const list = listPapers();
  log(`list: ${list.length === 1 && list[0].block_count === parsed.blocks.length ? "PASS" : "FAIL"}`);
  log(`normalize: ${normalizeArxivId("https://arxiv.org/abs/2609.34683") === "2609.34683" ? "PASS" : "FAIL"}`);
  log("ALL PASS");
  import_fs2.default.writeFileSync(process.env.PR_DONE, "1");
  import_electron2.app.quit();
}
run().catch((e) => {
  log(`FATAL: ${e?.stack ?? e}`);
  import_fs2.default.writeFileSync(process.env.PR_DONE, "1");
  import_electron2.app.quit();
});
