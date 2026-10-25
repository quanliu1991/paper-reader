// 用 Electron 内嵌 Node 清除指定论文的译文（修复乱码后重翻）
// 用法: node scripts/clean-translations.js <paperId>
const path = require('path');
const { app } = require('electron');
const paperId = Number(process.argv[process.argv.length - 1]);

app.whenReady().then(() => {
  const Database = require('better-sqlite3');
  const dbFile = path.join(app.getPath('userData'), 'reader.db');
  const db = new Database(dbFile);
  const info = db.prepare('DELETE FROM translations WHERE paper_id=?').run(paperId);
  console.log('deleted translations for paper', paperId, ':', info.changes);
  app.quit();
});
