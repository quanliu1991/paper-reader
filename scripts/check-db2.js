const db = require('better-sqlite3')(require('path').join(require('os').tmpdir(), 'pr-check.db'), { readonly: true });
const papers = db.prepare('SELECT id, arxiv_id, import_type, authors FROM papers').all();
console.log(JSON.stringify(papers, null, 1));
// 论文 2 的 blocks 类型分布
const stat = db.prepare("SELECT type, COUNT(*) n FROM blocks WHERE paper_id=2 GROUP BY type").all();
console.log('paper2 blocks:', JSON.stringify(stat));
const stat1 = db.prepare("SELECT type, COUNT(*) n FROM blocks WHERE paper_id=1 GROUP BY type").all();
console.log('paper1 blocks:', JSON.stringify(stat1));
