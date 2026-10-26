// 一键发版：npm run release [-- <major|minor|patch>（默认 patch）]
// 流程：guard 门禁全绿 → bump 版本 → NSIS 打包 → git tag + push → GitHub Release（gh CLI，附安装包）
// 规约：guard 不全绿禁止发版；tag 打不出/推送失败立即中止并报告。
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const bump = process.argv[2] ?? 'patch';
if (!['major', 'minor', 'patch'].includes(bump)) { console.error(`[release] 非法 bump: ${bump}`); process.exit(1); }

const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
const hasGh = () => { try { execSync('gh --version', { stdio: 'ignore' }); return true; } catch { return false; } };

// 1. guard 门禁（强制）：不绿即止
console.log(`[release] step 1/5: guard 门禁`);
run('npm run guard');

// 2. bump 版本
console.log(`[release] step 2/5: bump ${bump}`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
pkg.version = bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const version = pkg.version;
console.log(`[release] version → ${version}`);

// 3. 打包（NSIS）
console.log(`[release] step 3/5: electron-builder 打包`);
run('npm run build');
run('npx electron-builder --win nsis');

// 4. tag + push
console.log(`[release] step 4/5: git tag + push`);
run('git add package.json');
run(`git commit -m "release: v${version}"`);
run(`git tag v${version}`);
run('git push');
run(`git push origin v${version}`);

// 5. GitHub Release（REST API + git 凭据管理器 token；gh CLI 未登录也能发）
console.log(`[release] step 5/5: GitHub Release`);
const releaseDir = path.join(root, 'release');
// 资产必须匹配本次版本号（排除历史残留安装包）
const asset = fs.readdirSync(releaseDir).find(f => new RegExp(`^Paper Reader Setup ${version.replace(/\./g, '\\.')}\\.exe$`, 'i').test(f));
if (!asset) { console.error(`[release] FATAL: release/ 下没找到 v${version} 安装包`); process.exit(1); }
try {
  run(`node scripts/gh-release.mjs v${version} "${path.join(releaseDir, asset)}"`);
  console.log(`[release] v${version} 已发布到 GitHub Releases`);
} catch (e) {
  console.error(`[release] GitHub Release 失败（tag 已推送）：${e.message}`);
  console.error(`[release] 手动补发: node scripts/gh-release.mjs v${version} "${path.join(releaseDir, asset)}"`);
}
// 收尾：清理历史残留安装包（保留本次版本）
for (const f of fs.readdirSync(releaseDir)) {
  if (/^Paper Reader Setup .+\.exe(\.blockmap)?$/.test(f) && !f.includes(`Setup ${version}`)) {
    fs.rmSync(path.join(releaseDir, f));
    console.log(`[release] 清理残留: ${f}`);
  }
}
console.log(`[release] DONE v${version}`);
