import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  db = new Database(path.join(userData, 'paper-reader.db'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(d: Database.Database) {
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
    level INTEGER DEFAULT 0,                  -- heading 级别
    en TEXT NOT NULL,
    fig_path TEXT                             -- 本地图表路径（可选）
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
    text_en TEXT NOT NULL,                    -- 选中的原文
    note TEXT DEFAULT '',                     -- 用户备注（可选）
    color TEXT DEFAULT 'yellow',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_hl_paper ON highlights(paper_id);

  CREATE TABLE IF NOT EXISTS qa_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    highlight_id INTEGER,
    pid INTEGER,                              -- 提问所在段落
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
    api_key TEXT NOT NULL,                    -- DPAPI 加密后
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
    -- SM-2 简化版调度字段
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

// v0.1 建库时 blocks 无 fig_kind 列，v0.2 迁移
function migrateColumns(d: Database.Database) {
  const cols = d.prepare("PRAGMA table_info(blocks)").all() as any[];
  if (cols.length && !cols.some(c => c.name === 'fig_kind')) {
    d.prepare("ALTER TABLE blocks ADD COLUMN fig_kind TEXT").run();
  }
}

// ---------- papers ----------
export function insertPaper(p: { arxivId: string; title: string; authors: string; sourceUrl: string; importType: string }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO papers (arxiv_id, title, authors, source_url, import_type) VALUES (?,?,?,?,?)
     ON CONFLICT(arxiv_id) DO UPDATE SET title=excluded.title, authors=excluded.authors`
  ).run(p.arxivId, p.title, p.authors, p.sourceUrl, p.importType);
  // upsert 时 lastInsertRowid 不可靠（可能返回自增序列的新值），显式查回真实 id
  const row = d.prepare('SELECT id FROM papers WHERE arxiv_id=?').get(p.arxivId) as any;
  return row.id;
}

export function listPapers() {
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

export function getPaper(id: number) {
  return getDb().prepare('SELECT * FROM papers WHERE id=?').get(id);
}

export function touchPaper(id: number) {
  getDb().prepare(`UPDATE papers SET last_opened_at=datetime('now','localtime') WHERE id=?`).run(id);
}

export function deletePaper(id: number) {
  getDb().prepare('DELETE FROM papers WHERE id=?').run(id);
}

// ---------- blocks ----------
export function insertBlocks(paperId: number, blocks: Array<{ seq: number; type: string; level: number; en: string; figPath?: string }>) {
  const d = getDb();
  const tx = d.transaction((rows: typeof blocks) => {
    d.prepare('DELETE FROM blocks WHERE paper_id=?').run(paperId);
    const stmt = d.prepare('INSERT INTO blocks (paper_id, seq, type, level, en, fig_path) VALUES (?,?,?,?,?,?)');
    for (const b of rows) stmt.run(paperId, b.seq, b.type, b.level, b.en, b.figPath ?? null);
  });
  tx(blocks);
}

export function getBlocks(paperId: number) {
  return getDb().prepare(
    `SELECT b.pid, b.seq, b.type, b.level, b.en, b.fig_path, t.zh
     FROM blocks b LEFT JOIN translations t ON t.paper_id=b.paper_id AND t.pid=b.pid
     WHERE b.paper_id=? ORDER BY b.seq`
  ).all(paperId);
}

// ---------- translations ----------
export function saveTranslation(paperId: number, pid: number, zh: string, provider: string, model: string) {
  getDb().prepare(
    `INSERT INTO translations (paper_id, pid, zh, provider, model, updated_at)
     VALUES (?,?,?,?,?, datetime('now','localtime'))
     ON CONFLICT(paper_id, pid) DO UPDATE SET zh=excluded.zh, provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at`
  ).run(paperId, pid, zh, provider, model);
}

export function getTranslations(paperId: number) {
  return getDb().prepare('SELECT pid, zh FROM translations WHERE paper_id=?').all(paperId);
}

// ---------- highlights ----------
export function addHighlight(h: { paperId: number; pid: number; textEn: string; note?: string; color?: string }) {
  const info = getDb().prepare(
    'INSERT INTO highlights (paper_id, pid, text_en, note, color) VALUES (?,?,?,?,?)'
  ).run(h.paperId, h.pid, h.textEn, h.note ?? '', h.color ?? 'yellow');
  return Number(info.lastInsertRowid);
}

export function listHighlights(paperId: number) {
  return getDb().prepare('SELECT * FROM highlights WHERE paper_id=? ORDER BY pid, created_at').all(paperId);
}

export function removeHighlight(id: number) {
  getDb().prepare('DELETE FROM highlights WHERE id=?').run(id);
}

// ---------- qa ----------
export function addQa(q: { paperId: number; highlightId?: number; pid?: number; question: string; answer: string; provider?: string; model?: string }) {
  const info = getDb().prepare(
    'INSERT INTO qa_pairs (paper_id, highlight_id, pid, question, answer, provider, model) VALUES (?,?,?,?,?,?,?)'
  ).run(q.paperId, q.highlightId ?? null, q.pid ?? null, q.question, q.answer, q.provider ?? '', q.model ?? '');
  return Number(info.lastInsertRowid);
}

export function listQa(paperId: number) {
  return getDb().prepare('SELECT * FROM qa_pairs WHERE paper_id=? ORDER BY created_at').all(paperId);
}

// ---------- settings ----------
export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string) {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

// ---------- paper summaries (v0.2) ----------
export function saveSummary(paperId: number, summary: string, sectionSummaries: string, provider: string, model: string) {
  getDb().prepare(
    `INSERT INTO paper_summaries (paper_id, summary, section_summaries, provider, model, updated_at)
     VALUES (?,?,?,?,?, datetime('now','localtime'))
     ON CONFLICT(paper_id) DO UPDATE SET summary=excluded.summary, section_summaries=excluded.section_summaries,
       provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at`
  ).run(paperId, summary, sectionSummaries, provider, model);
}

export function getSummary(paperId: number) {
  return getDb().prepare('SELECT * FROM paper_summaries WHERE paper_id=?').get(paperId);
}

// ---------- flashcards (v0.2, SM-2 简化) ----------
export function addFlashcard(f: { paperId: number; pid: number; front: string; back: string }) {
  const info = getDb().prepare(
    'INSERT INTO flashcards (paper_id, pid, front, back) VALUES (?,?,?,?)'
  ).run(f.paperId, f.pid, f.front, f.back);
  return Number(info.lastInsertRowid);
}

export function updateFlashcardBack(id: number, back: string) {
  getDb().prepare('UPDATE flashcards SET back=? WHERE id=?').run(back, id);
}

export function listDueFlashcards() {
  return getDb().prepare(
    `SELECT f.*, p.title AS paper_title FROM flashcards f
     LEFT JOIN papers p ON p.id = f.paper_id
     WHERE f.due <= datetime('now','localtime') ORDER BY f.due LIMIT 50`
  ).all();
}

// SM-2 简化：q 0-5（0=忘了，3=良好，4=简单，5=太简单；<3 记为 lapse）
export function gradeFlashcard(id: number, q: number) {
  const d = getDb();
  const c = d.prepare('SELECT * FROM flashcards WHERE id=?').get(id) as any;
  if (!c) return;
  let { interval_days, ease, reps, lapses } = c;
  if (q < 3) {
    reps = 0; lapses += 1; interval_days = 0.02; ease = Math.max(1.3, ease - 0.2);
  } else {
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * 0.08));
    reps += 1;
    if (reps === 1) interval_days = 1;
    else if (reps === 2) interval_days = 6;
    else interval_days = Math.round(interval_days * ease);
  }
  const due = new Date(Date.now() + interval_days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  d.prepare('UPDATE flashcards SET interval_days=?, ease=?, reps=?, lapses=?, due=? WHERE id=?')
    .run(interval_days, ease, reps, lapses, due, id);
}

// ---------- 阅读进度 (v0.2) ----------
export function getReadProgress(paperId: number): number {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(`read:${paperId}`) as any;
  return row ? Number(row.value) || 0 : 0;
}
