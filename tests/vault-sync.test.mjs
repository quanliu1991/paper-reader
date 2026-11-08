// vault-sync 单元测试：git agent init/commit/pull-rebase-push/冲突（tmp 真实 repo，离线）
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

await build({
  entryPoints: ['electron/sync-agent.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['simple-git'],
  outfile: 'tests/.tmp-vault/sync-agent.cjs', logLevel: 'silent',
});
const { createGitAgent, deviceIdentity } = await import('../tests/.tmp-vault/sync-agent.cjs');

let pass = 0, fail = 0;
const assert = (c, n) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.error(`  FAIL  ${n}`); } };

const g = (dir, ...args) => execSync(`git -C "${dir}" ${args.join(' ')}`, { encoding: 'utf8' }).trim();
const write = (dir, f, content) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), content); };

// ---------- 环境：bare 远端 + 两个设备 clone ----------
console.log('== sync-agent 环境 ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sync-'));
const remote = path.join(tmp, 'remote.git');
const a = path.join(tmp, 'deviceA');
const b = path.join(tmp, 'deviceB');
execSync(`git init --bare -b main "${remote}"`);
assert(fs.existsSync(remote), 'bare 远端创建');

const mkDevice = (d) => {
  fs.mkdirSync(d, { recursive: true });
  g(d, 'init', '-b', 'main');
  g(d, 'config', 'user.email', 't@t');
  g(d, 'config', 'user.name', 't');
  g(d, 'remote', 'add', 'origin', remote);
};

{
  // ---------- Task 16：init/identity/commit ----------
  console.log('== agent init + commit ==');
  const vault = path.join(tmp, 'vaultA');
  fs.mkdirSync(vault, { recursive: true });
  write(vault, 'papers/2024-x/meta.yaml', 'version: 1\nlegacy_id: 1\n');
  const agent = createGitAgent(vault, { remoteUrl: '', pushEnabled: false, dryRun: true });
  const r1 = await agent.syncOnce('deposit: add 2024-x');
  assert(r1.ok, `syncOnce 无远端成功（${JSON.stringify(r1).slice(0, 100)}）`);
  assert(g(vault, 'log', '--format=%s').includes('init vault'), 'init commit 由 ensureRepo 完成');
  assert(g(vault, 'log', '-1', '--format=%an') === deviceIdentity(), 'identity 是 paper-reader-<host>');
  const r2 = await agent.syncOnce('deposit: nothing');
  assert(r2.ok && r2.committed === false, '干净仓库不空提交');
  // 二进制 PDF
  write(vault, 'papers/2024-x/paper.pdf', Buffer.from('%PDF-1.4 fake'));
  const r3 = await agent.syncOnce('deposit: pdf 2024-x');
  assert(r3.ok && r3.committed, '二进制 PDF 入库');
}

{
  // ---------- Task 18：A push → B pull → 冲突 → theirs + .conflict. 留档 ----------
  console.log('== 双设备同步 + 冲突 ==');
  mkDevice(a); mkDevice(b);
  // A 初始推
  write(a, 'papers/2024-p1/annotations.json', '{"v":1,"items":[{"sid":"h1"}]}');
  execSync(`git -C "${a}" add . && git -C "${a}" commit -m "A1" && git -C "${a}" push origin main`, { shell: '/bin/bash' });
  // B 设备用 agent pull
  const agentB = createGitAgent(b, { remoteUrl: remote, pushEnabled: false, dryRun: true });
  await agentB.ensureRepo();
  await agentB.pullRebase();
  assert(fs.existsSync(path.join(b, 'papers/2024-p1/annotations.json')), 'B pull 到 A 的文件');

  // 冲突：A、B 都改同一文件
  write(a, 'papers/2024-p1/annotations.json', '{"v":1,"items":[{"sid":"h1","note":"A改"}]}');
  write(b, 'papers/2024-p1/annotations.json', '{"v":1,"items":[{"sid":"h1","note":"B改"}]}');
  execSync(`git -C "${a}" add . && git -C "${a}" commit -m "A2" && git -C "${a}" push origin main`, { shell: '/bin/bash' });
  const rB = await agentB.syncOnce('deposit: B 改标注');
  const bFile = fs.readFileSync(path.join(b, 'papers/2024-p1/annotations.json'), 'utf8');
  const conflictCopies = fs.readdirSync(path.join(b, 'papers/2024-p1')).filter(f => f.includes('.conflict.'));
  assert(bFile.includes('A改'), `冲突文件取远端 theirs（got: ${bFile.slice(0, 80)}）`);
  assert(conflictCopies.length >= 1, `本地副本 .conflict. 留档（${conflictCopies.length} 个）`);
  // 冲突解决后 B 的本地修改仍在工作区（DB 权威会重新入队）
  assert(rB.conflicts !== undefined, 'conflicts 已上报');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
