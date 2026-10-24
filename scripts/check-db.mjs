import dbMod from 'better-sqlite3';
import os from 'os';
import path from 'path';

const db = new dbMod(path.join(os.tmpdir(), 'pr-check.db'), { readonly: true });
const papers = db.prepare('SELECT id, arxiv_id, substr(title,1,50) t, last_opened_at FROM papers').all();
console.log(JSON.stringify(papers, null, 1));
console.log('blocks:', db.prepare('SELECT COUNT(*) n FROM blocks').get().n);
const s = db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'pdfmap%'").get();
console.log('pdfmap settings:', s.n);
