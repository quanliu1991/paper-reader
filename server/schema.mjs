// schema.mjs：服务端建表 SQL（唯一权威）。
// 版本管理：PRAGMA user_version——服务端第一天就有 schema 版本，后续加表/加列走 versionedMigrations。
// 约定：全部 UUID 字符串主键（crypto.randomUUID），时间 ISO 字符串。

const V1 = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,            -- scrypt: salt:hash hex
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,             -- 32 字节随机 hex（不透明令牌，非 JWT）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,   -- 8 位字母数字
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner | member
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tm_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS reading_items (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  arxiv_id TEXT NOT NULL,             -- 必填：他人可一键走 arXiv 导入管线
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  added_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open', -- open | claimed | done
  claimed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ri_team ON reading_items(team_id, created_at);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,         -- ISO 时间
  paper_arxiv_id TEXT,                -- 可空：挂接清单/库内论文
  paper_title TEXT DEFAULT '',
  presenter_id TEXT REFERENCES users(id),
  notes TEXT DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_team ON meetings(team_id, scheduled_at);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                 -- progress | claim | done | unclaim | meeting | term | join | leave | add | item_remove
  payload TEXT NOT NULL,              -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_team ON activity(team_id, id DESC);

CREATE TABLE IF NOT EXISTS terms (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  term TEXT NOT NULL,                 -- 合并主键（同名词条追加式合并，本地优先）
  level TEXT DEFAULT '',
  explain TEXT DEFAULT '',
  pushed_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, term)
);
`;

// user_version 递增迁移：新版本只增不改旧块
const versionedMigrations = [
  { version: 1, sql: V1 },
];

export function initSchema(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  const cur = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  for (const m of versionedMigrations) {
    if (m.version <= cur) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
