const path = require('path');
const os = require('os');
const fs = require('fs');
// 连同 WAL/SHM 一起复制，看到运行中 App 的真实状态
const src = path.join(process.env.APPDATA, 'Paper Reader');
const dst = path.join(os.tmpdir(), 'pr-live');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['paper-reader.db', 'paper-reader.db-wal', 'paper-reader.db-shm']) {
  try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch {}
}
const db = require('better-sqlite3')(path.join(dst, 'paper-reader.db'), { readonly: true });
const papers = db.prepare('SELECT id, arxiv_id, substr(title,1,55) t, import_type FROM papers').all();
console.log(JSON.stringify(papers, null, 1));
for (const pid of [2, 3, 4]) {
  const s = db.prepare('SELECT type, COUNT(*) n FROM blocks WHERE paper_id=? GROUP BY type').all(pid);
  console.log(`paper${pid}:`, JSON.stringify(s));
}
