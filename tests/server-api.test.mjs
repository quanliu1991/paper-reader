// server-api.test.mjs：团队服务端全 API round-trip（起真实服务 + fetch 断言）。
// 覆盖：注册/登录/会话 → 团队创建/邀请码加入/转让/移除 → 清单增删认领 → 组会排期领读
// → 进度上报 → 动态流全类型 → 术语 push/pull → 限流。
// 运行：node tests/server-api.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-team-server-'));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) !== JSON.stringify(b) ? `（got ${JSON.stringify(a)}, want ${JSON.stringify(b)}）` : ''}`); }

async function api(method, p, { body, token, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const j = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
  return { status: res.status, ...j };
}

// ---------- 起服务 ----------
const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmpDir, 'test.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server start timeout')), 8000);
  const onOut = d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } };
  proc.stdout.on('data', onOut);
});

try {
  // ===== 认证 =====
  console.log('== 认证 ==');
  let r = await api('POST', '/api/auth/register', { body: { username: 'alice', password: 'password123', display_name: 'Alice' } });
  assert(r.ok && r.data.token && r.data.user.username === 'alice', '注册成功返回 token');
  const aliceTok = r.data.token;
  const aliceId = r.data.user.id;

  r = await api('POST', '/api/auth/register', { body: { username: 'alice', password: 'password456' } });
  eq(r.status, 409, '重复用户名 409');

  r = await api('POST', '/api/auth/register', { body: { username: 'bob', password: 'short' } });
  eq(r.status, 400, '短密码 400');

  r = await api('POST', '/api/auth/register', { body: { username: 'bob', password: 'password456', display_name: 'Bob' } });
  assert(r.ok, 'bob 注册成功');
  const bobTok = r.data.token;
  const bobId = r.data.user.id;

  r = await api('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrongpass99' } });
  eq(r.status, 401, '错误密码 401');

  r = await api('POST', '/api/auth/login', { body: { username: 'alice', password: 'password123' } });
  assert(r.ok && r.data.token, '登录成功');
  const aliceTok2 = r.data.token;

  r = await api('GET', '/api/auth/me', { token: aliceTok2 });
  assert(r.ok && r.data.username === 'alice', 'me 返回用户');

  r = await api('GET', '/api/auth/me', { token: 'deadbeef'.repeat(8) });
  eq(r.status, 401, '无效 token 401');

  // ===== 团队 =====
  console.log('== 团队 ==');
  r = await api('POST', '/api/teams', { token: aliceTok, body: { name: 'LLM 师门' } });
  assert(r.ok && r.data.invite_code && r.data.invite_code.length === 8, '创建团队返回 8 位邀请码');
  const teamId = r.data.id;
  const code = r.data.invite_code;

  r = await api('GET', '/api/teams', { token: aliceTok });
  assert(r.ok && r.data.length === 1 && r.data[0].role === 'owner' && r.data[0].member_count === 1, '我的团队列表（owner）');

  r = await api('GET', '/api/teams', { token: bobTok });
  assert(r.ok && r.data.length === 0, 'bob 团队列表为空');

  r = await api('POST', `/api/join/XXXXXXXX`, { token: bobTok }); // X 不在码表，只是长度匹配正则
  eq(r.status, 404, '无效邀请码 404');

  r = await api('POST', `/api/join/${code}`, { token: bobTok });
  assert(r.ok && r.data.role === 'member', 'bob 凭码加入');

  r = await api('POST', `/api/join/${code}`, { token: bobTok });
  eq(r.status, 409, '重复加入 409');

  r = await api('GET', `/api/teams/${teamId}`, { token: bobTok });
  assert(r.ok && r.data.members.length === 2, '成员列表 2 人');

  // 未成员访问被拒
  r = await api('POST', '/api/auth/register', { body: { username: 'carol', password: 'password789' } });
  const carolTok = r.data.token;
  r = await api('GET', `/api/teams/${teamId}`, { token: carolTok });
  eq(r.status, 403, '非成员 403');

  // ===== 阅读清单 =====
  console.log('== 阅读清单 ==');
  r = await api('POST', `/api/teams/${teamId}/reading-list`, { token: aliceTok, body: { arxiv_id: '2609.34683', title: 'Speculative Decoding Survey' } });
  assert(r.ok, '添加清单项');
  const itemId = r.data.id;

  r = await api('POST', `/api/teams/${teamId}/reading-list`, { token: aliceTok, body: { arxiv_id: '2609.34683', title: 'dup' } });
  eq(r.status, 409, '重复添加 409');

  r = await api('GET', `/api/teams/${teamId}/reading-list`, { token: bobTok });
  assert(r.ok && r.data.length === 1 && r.data[0].status === 'open' && r.data[0].arxiv_id === '2609.34683', '清单含 arxiv_id');

  r = await api('PATCH', `/api/reading-items/${itemId}`, { token: bobTok, body: { action: 'claim' } });
  assert(r.ok, 'bob 认领');

  r = await api('GET', `/api/teams/${teamId}/reading-list`, { token: aliceTok });
  eq(r.data[0].status, 'claimed', '状态 open→claimed');

  r = await api('PATCH', `/api/reading-items/${itemId}`, { token: aliceTok, body: { action: 'done' } });
  assert(r.ok, 'alice 标记完成（任意成员可标）');
  r = await api('GET', `/api/teams/${teamId}/reading-list`, { token: aliceTok });
  eq(r.data[0].status, 'done', '状态 claimed→done');

  // 完成后可重新添加
  r = await api('POST', `/api/teams/${teamId}/reading-list`, { token: aliceTok, body: { arxiv_id: '2609.34683', title: 'Speculative Decoding Survey' } });
  assert(r.ok, '完成后可再添加');

  // bob 不能删别人加的
  const itemId2 = r.data.id;
  r = await api('DELETE', `/api/reading-items/${itemId2}`, { token: bobTok });
  eq(r.status, 403, 'member 删他人清单项 403');
  r = await api('DELETE', `/api/reading-items/${itemId2}`, { token: aliceTok });
  assert(r.ok, '添加人可删');

  // ===== 组会 =====
  console.log('== 组会 ==');
  const when = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  r = await api('POST', `/api/teams/${teamId}/meetings`, { token: aliceTok, body: { title: '第 42 次组会', scheduled_at: when, paper_arxiv_id: '2609.34683', paper_title: 'Speculative Decoding Survey' } });
  assert(r.ok, '排期组会（挂论文）');
  const meetingId = r.data.id;

  r = await api('GET', `/api/teams/${teamId}/meetings`, { token: bobTok });
  assert(r.ok && r.data[0].paper_arxiv_id === '2609.34683', '组会列表含挂接论文');

  r = await api('PATCH', `/api/meetings/${meetingId}`, { token: bobTok, body: { action: 'claim' } });
  assert(r.ok, 'bob 认领领读');
  r = await api('GET', `/api/teams/${teamId}/meetings`, { token: aliceTok });
  assert(r.data[0].presenter_id === bobId, '领读人是 bob');

  r = await api('PATCH', `/api/meetings/${meetingId}`, { token: aliceTok, body: { notes: '讨论 speculative decoding 综述' } });
  assert(r.ok, '写会议笔记');

  // ===== 进度 + 动态流 =====
  console.log('== 进度与动态流 ==');
  r = await api('PUT', `/api/teams/${teamId}/progress`, { token: bobTok, body: { paperKey: '2026-2609.34683', arxiv_id: '2609.34683', title: 'Speculative Decoding Survey', pct: 42 } });
  assert(r.ok, '进度上报');

  r = await api('GET', `/api/teams/${teamId}/feed?limit=100`, { token: aliceTok });
  assert(r.ok, '动态流可读');
  const types = new Set(r.data.map(x => x.type));
  for (const t of ['join', 'add', 'claim', 'done', 'item_remove', 'meeting', 'progress', 'term']) {
    if (t === 'term') continue; // 还没 push，后面验
    assert(types.has(t), `动态流含 ${t}`);
  }
  const prog = r.data.find(x => x.type === 'progress');
  assert(prog?.payload?.pct === 42 && prog?.user?.username === 'bob', '进度条目含 pct 与人');

  // ===== 术语表 =====
  console.log('== 术语表 ==');
  r = await api('POST', `/api/teams/${teamId}/terms/push`, { token: aliceTok, body: { items: [
    { term: 'KV cache', level: 'known', explain: '缓存已算过的 K/V 避免重算' },
    { term: 'speculative decoding', level: 'learning', explain: '草稿模型猜 + 主模型验证' },
  ] } });
  assert(r.ok && r.data.added === 2, 'push 2 词条');

  r = await api('POST', `/api/teams/${teamId}/terms/push`, { token: bobTok, body: { items: [
    { term: 'KV cache', level: 'known', explain: '（更新）KV 缓存' },
    { term: 'MoE', level: 'unknown', explain: '混合专家' },
  ] } });
  assert(r.ok && r.data.added === 1 && r.data.updated === 1, '二次 push 1 增 1 改');

  r = await api('GET', `/api/teams/${teamId}/terms`, { token: bobTok });
  assert(r.ok && r.data.length === 3, 'pull 3 词条');
  const kv = r.data.find(x => x.term === 'KV cache');
  assert(kv.explain.includes('更新'), '同名词条被更新');

  // 载荷上限
  const big = await api('POST', `/api/teams/${teamId}/terms/push`, { token: aliceTok, body: { items: Array.from({ length: 5001 }, (_, i) => ({ term: `t${i}` })) }, raw: false });
  eq(big.status, 413, '超 5000 词条 413');

  r = await api('GET', `/api/teams/${teamId}/feed?limit=100`, { token: aliceTok });
  assert(r.data.some(x => x.type === 'term'), '动态流含 term');

  // ===== owner 转让 + 移除成员 =====
  console.log('== 转让与移除 ==');
  r = await api('POST', `/api/teams/${teamId}/transfer`, { token: bobTok, body: { user_id: aliceId } });
  eq(r.status, 403, 'member 不能转让');

  r = await api('POST', `/api/teams/${teamId}/transfer`, { token: aliceTok, body: { user_id: bobId } });
  assert(r.ok, 'owner 转让给 bob');

  r = await api('GET', `/api/teams/${teamId}`, { token: aliceTok });
  const roles = Object.fromEntries(r.data.members.map(m => [m.username, m.role]));
  eq(roles.bob, 'owner', 'bob 是 owner');
  eq(roles.alice, 'member', 'alice 降为 member');

  // 新 owner 移除 carol（先加入）
  r = await api('POST', `/api/join/${code}`, { token: carolTok });
  assert(r.ok, 'carol 加入');
  r = await api('DELETE', `/api/teams/${teamId}/members/${carolTok.length ? (await api('GET', '/api/auth/me', { token: carolTok })).data.id : ''}`, { token: aliceTok });
  eq(r.status, 403, 'member 不能移除他人');
  const carolId = (await api('GET', '/api/auth/me', { token: carolTok })).data.id;
  r = await api('DELETE', `/api/teams/${teamId}/members/${carolId}`, { token: bobTok });
  assert(r.ok, 'owner 移除成员');
  r = await api('GET', `/api/teams/${teamId}`, { token: bobTok });
  eq(r.data.members.length, 2, '回到 2 人');

  // owner 不能被移除
  r = await api('DELETE', `/api/teams/${teamId}/members/${bobId}`, { token: bobTok });
  eq(r.status, 400, 'owner 自移除被拒（应先转让）');

  // ===== logout =====
  r = await api('POST', '/api/auth/logout', { token: aliceTok2 });
  assert(r.ok, 'logout');
  r = await api('GET', '/api/auth/me', { token: aliceTok2 });
  eq(r.status, 401, 'logout 后 token 失效');

  // ===== 限流（新 IP 维度按连接区分不可靠，此处验证 join 错误码路径已覆盖；限流单测见下）=====
  // 直接打满：同一连接连续 12 次无效码 join
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const rr = await api('POST', `/api/join/${code}`, { token: aliceTok, raw: false });
    if (rr.status === 429 || rr.status === 409) { if (rr.status === 429) limited = true; }
  }
  // alice 已在团队（409）不计入限流窗口？——实现里限流检查在成员检查之前，因此计入。
  assert(limited, '连续 join 触发限流 429');

} finally {
  proc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
