// 查询 release 状态（带 token）：node scripts/gh-release-check.mjs v0.3.0
import { execSync } from 'child_process';
const tag = process.argv[2] ?? 'v0.3.0';
const cred = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', { shell: 'bash', encoding: 'utf8' });
const token = (cred.match(/^password=(.+)$/m) || [])[1]?.trim();
const r = await fetch(`https://api.github.com/repos/quanliu1991/paper-reader/releases/tags/${tag}`, {
  headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pr-rel', Accept: 'application/vnd.github+json' },
});
console.log('status:', r.status);
if (r.ok) {
  const j = await r.json();
  console.log('release id:', j.id, '| draft:', j.draft, '| assets:', (j.assets ?? []).map(a => `${a.name}(${(a.size / 1048576).toFixed(1)}MB, state=${a.state})`));
} else {
  console.log((await r.text()).slice(0, 300));
}
