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

// 5. GitHub Release（有 gh 且已登录才发；否则留待手动）
console.log(`[release] step 5/5: GitHub Release`);
const releaseDir = path.join(root, 'release');
const asset = fs.readdirSync(releaseDir).find(f => /^Paper Reader Setup .*\.exe$/i.test(f));
if (hasGh()) {
  const notes = `## v${version}\n\n- 安装包：${asset ?? '（见 release/ 目录）'}\n- 上一版本以来的变更见 [commits](https://github.com/quanliu1991/paper-reader/compare/v0.2.0...v${version})\n- 交付前已通过 guard 门禁（物理重叠/内容去重/滚动锁定/三态截图/图表原位断言 ALL PASS）\n`;
  fs.writeFileSync(path.join(releaseDir, 'NOTES.md'), notes);
  try {
    run(`gh release create v${version} "${path.join(releaseDir, asset)}" --title "Paper Reader v${version}" --notes-file "${path.join(releaseDir, 'NOTES.md')}"`);
    console.log(`[release] v${version} 已发布到 GitHub Releases`);
  } catch (e) {
    console.error(`[release] gh release 失败（可手动发布）：${e.message}`);
    process.exit(1);
  }
} else {
  console.log(`[release] gh CLI 未安装/未登录——tag v${version} 已推送，请在 GitHub 手动创建 Release 并上传 ${asset}`);
}
console.log(`[release] DONE v${version}`);
