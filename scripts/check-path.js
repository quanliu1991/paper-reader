const path = require('path');
const fs = require('fs');
// ELECTRON_RUN_AS_NODE 下没有 app 对象——直接推算：dev 模式 name=paper-reader-app → userData = %APPDATA%\paper-reader-app
for (const d of ['paper-reader-app', 'Paper Reader', 'Electron']) {
  const p = path.join(process.env.APPDATA, d);
  console.log(d, '->', fs.existsSync(path.join(p, 'paper-reader.db')) ? 'HAS DB' : 'no db');
}
