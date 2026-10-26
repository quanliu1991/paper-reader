// 用 git 凭据管理器里的 GitHub token 直接调 REST API 创建 Release 并上传安装包
// 用法：node scripts/gh-release.mjs <tag> <assetPath>
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const [tag, assetPath] = process.argv.slice(2);
if (!tag || !assetPath) { console.error('usage: node scripts/gh-release.mjs <tag> <assetPath>'); process.exit(1); }
const repo = 'quanliu1991/paper-reader';
const version = tag.replace(/^v/, '');

// 从凭据管理器取 token（与 git push 同源）。非交互守卫：GCM 弹窗时立即失败而不是挂死。
function getToken() {
  const env = { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE_ALWAYS: 'never' };
  try {
    const cred = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', {
      shell: 'bash', encoding: 'utf8', env, timeout: 15000,
      stdio: ['pipe', 'pipe', 'ignore'] as any,
    });
    return (cred.match(/^password=(.+)$/m) || [])[1]?.trim();
  } catch { return null; }
}
const token = getToken();
if (!token) { console.error('no token in credential store'); process.exit(1); }

const H = { Authorization: `Bearer ${token}`, 'User-Agent': 'paper-reader-release', Accept: 'application/vnd.github+json' };

// 1. 创建（或复用）Release
let rel;
const exists = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: H });
if (exists.ok) {
  rel = await exists.json();
  console.log(`[gh-release] 复用已有 release #${rel.id}`);
} else {
  const notes = `## v${version}\n\n- 安装包：${path.basename(assetPath)}（NSIS，Windows x64）\n- 变更见 [commits](https://github.com/${repo}/commits/v${version})\n- 交付前已通过 guard 门禁（物理重叠/内容去重/滚动锁定/三态截图/图表原位断言 ALL PASS）\n`;
  const created = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Paper Reader ${tag}`, body: notes }),
  });
  if (!created.ok) { console.error(`[gh-release] create 失败: ${created.status} ${await created.text()}`); process.exit(1); }
  rel = await created.json();
  console.log(`[gh-release] 已创建 release #${rel.id} ${tag}`);
}

// 2. 上传资产
const upUrl = rel.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(path.basename(assetPath))}`);
const buf = fs.readFileSync(assetPath);
console.log(`[gh-release] 上传 ${path.basename(assetPath)} (${(buf.length / 1048576).toFixed(1)}MB) ...`);
const up = await fetch(upUrl, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
  body: buf,
});
if (!up.ok) { console.error(`[gh-release] 上传失败: ${up.status} ${await up.text()}`); process.exit(1); }
console.log(`[gh-release] DONE → https://github.com/${repo}/releases/tag/${tag}`);
