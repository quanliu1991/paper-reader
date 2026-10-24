const path = require('path');
const fs = require('fs');
// dev 模式下 Electron 的 userData 由 package.json name 决定
// name=paper-reader-app → %APPDATA%\paper-reader-app；productName 只影响打包
// 但 db 检查显示库在 Paper Reader（打包版创建）——dev 版每次用空库
// 这里列出所有候选目录的 mtime，找 dev App 实际写的位置
for (const d of ['paper-reader-app', 'Paper Reader', 'Electron', 'paper-reader']) {
  const p = path.join(process.env.APPDATA, d);
  if (fs.existsSync(p)) {
    const db = path.join(p, 'paper-reader.db');
    console.log(d, fs.existsSync(db) ? `db mtime=${fs.statSync(db).mtime.toISOString()}` : '(no db)');
  }
}
// 也查 package.json name
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
console.log('package name:', pkg.name, '| productName:', pkg.build?.productName);
