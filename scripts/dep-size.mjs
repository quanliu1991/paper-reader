// node_modules 生产依赖体积排名（electron-builder 按此决定 asar 内容）
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const deps = JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies;
const sizes = [];
for (const name of Object.keys(deps)) {
  const p = path.join('node_modules', ...name.split('/'));
  try {
    const out = execSync(`powershell -c "(Get-ChildItem -Recurse -File '${p.replace(/'/g, "''")}' | Measure-Object Length -Sum).Sum"`, { encoding: 'utf8' });
    sizes.push([name, Math.round(Number(out.trim()) / 1048576 * 10) / 10]);
  } catch { sizes.push([name, -1]); }
}
for (const [n, mb] of sizes.sort((a, b) => b[1] - a[1])) console.log(String(mb).padStart(8) + 'MB', n);
