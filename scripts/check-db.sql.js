// 用 Electron 内嵌 Node 跑（与 App 同 ABI）
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const db = require('better-sqlite3')(path.join(os.tmpdir(), 'pr-check.db'), { readonly: true });
const papers = db.prepare('SELECT id, arxiv_id, substr(title,1,60) t, last_opened_at FROM papers').all();
console.log(JSON.stringify(papers, null, 1));
console.log('blocks:', db.prepare('SELECT COUNT(*) n FROM blocks').get().n);
try {
  console.log('pdfmap settings:', db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'pdfmap%'").get().n);
} catch { console.log('pdfmap settings: (no settings table)'); }
console.log('settings keys:', db.prepare('SELECT key FROM settings LIMIT 20').all().map(r => r.key).join(', '));
