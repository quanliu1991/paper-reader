#!/usr/bin/env node
// Paper Reader 团队服务端（自托管，MVP）
// 纯 Node 标准库：node:http + node:sqlite + node:crypto——零 npm 依赖，拷到实验室服务器
// `node server.mjs` 即跑（Node >= 22.5，需 node:sqlite）。
// 边界：只存团队协作元数据（清单/组会/动态/术语）；vault 本地资产不上云。
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSchema } from './schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'team-server.db');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

const db = new DatabaseSync(DB_PATH);
initSchema(db);

// ---------- 工具 ----------
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const j = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
};
const ok = (res, data) => j(res, 200, { ok: true, data });
const fail = (res, status, error, hint = '') => j(res, status, { ok: false, error, hint });

// scrypt 哈希（参数写死，hex 存 salt:hash）
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pw, salt, SCRYPT.keylen, SCRYPT);
  // 定长比较防时序侧信道
  return calc.length === Buffer.from(hash, 'hex').length && crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}

// 8 位邀请码（去掉易混淆 0O1lI）
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genInviteCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}

// 每 IP 简单限流（内存，join 端点专用：10 次/分钟）
const joinHits = new Map(); // ip -> timestamps[]
function joinRateLimited(ip) {
  const t = Date.now();
  const arr = (joinHits.get(ip) ?? []).filter(x => t - x < 60_000);
  if (arr.length >= 10) { joinHits.set(ip, arr); return true; }
  arr.push(t);
  joinHits.set(ip, arr);
  return false;
}

function validStr(v, max = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

// ---------- 会话 ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now(), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return token;
}
function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.display_name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name };
}

// ---------- 团队权限 ----------
function membership(teamId, userId) {
  return db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId) ?? null;
}
function requireMember(teamId, user) {
  const m = membership(teamId, user.id);
  if (!m) throw httpErr(403, '你不是该团队成员', '凭邀请码加入团队后再试');
  return m; // { role }
}
function httpErr(status, error, hint = '') {
  const e = new Error(error);
  e.status = status; e.hint = hint;
  return e;
}

function teamActivity(teamId, userId, type, payload) {
  db.prepare('INSERT INTO activity (team_id, user_id, type, payload, created_at) VALUES (?,?,?,?,?)')
    .run(teamId, userId, type, JSON.stringify(payload ?? {}), now());
}

// 用户公开信息（动态流/成员列表用）
function pubUser(uid) {
  const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(uid);
  return u ? { username: u.username, display_name: u.display_name || u.username } : { username: '?', display_name: '?' };
}

// ---------- 路由表 ----------
// 每条：method + path 正则 + handler(req body, url, authUser)
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), ...opts, handler });
}

// ---------- 认证 ----------
route('POST', '/api/auth/register', (b) => {
  const { username, password, display_name } = b ?? {};
  if (!validStr(username, 32) || !/^[a-zA-Z0-9_\u4e00-\u9fff]+$/.test(username.trim()))
    throw httpErr(400, '用户名 1-32 位（字母/数字/下划线/中文）');
  if (typeof password !== 'string' || password.length < 8)
    throw httpErr(400, '密码至少 8 位');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()))
    throw httpErr(409, '用户名已被注册');
  const id = uuid();
  db.prepare('INSERT INTO users (id, username, display_name, pass_hash, created_at) VALUES (?,?,?,?,?)')
    .run(id, username.trim(), validStr(display_name, 64) ? display_name.trim() : '', hashPassword(password), now());
  return { token: createSession(id), user: { id, username: username.trim(), display_name } };
});

route('POST', '/api/auth/login', (b) => {
  const { username, password } = b ?? {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim());
  // 用户不存在与密码错误同一话术，不泄露注册面
  if (!u || !verifyPassword(String(password ?? ''), u.pass_hash))
    throw httpErr(401, '用户名或密码错误');
  return { token: createSession(u.id), user: { id: u.id, username: u.username, display_name: u.display_name } };
});

route('POST', '/api/auth/logout', { auth: true }, (b, url, user, token) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return true;
});

route('GET', '/api/auth/me', { auth: true }, (b, url, user) => user);

// ---------- 团队 ----------
route('POST', '/api/teams', { auth: true }, (b, _u, user) => {
  const { name } = b ?? {};
  if (!validStr(name, 64)) throw httpErr(400, '团队名 1-64 字');
  const id = uuid();
  const code = genInviteCode();
  db.prepare('INSERT INTO teams (id, name, invite_code, owner_id, created_at) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), code, user.id, now());
  db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?,?,?,?)')
    .run(id, user.id, 'owner', now());
  teamActivity(id, user.id, 'join', { name: pubUser(user.id).display_name, created: true });
  return { id, name: name.trim(), invite_code: code, role: 'owner' };
});

route('GET', '/api/teams', { auth: true }, (b, _u, user) => {
  const rows = db.prepare(
    `SELECT t.id, t.name, t.invite_code, t.owner_id, t.created_at, m.role,
       (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS member_count
     FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.created_at`
  ).all(user.id);
  return rows;
});

route('POST', '/api/join/([A-Z0-9]{8})', { auth: true }, (b, m, user, _t, req) => {
  const ip = req.socket.remoteAddress ?? '?';
  if (joinRateLimited(ip)) throw httpErr(429, '尝试过于频繁，请一分钟后再试');
  const code = m[1];
  const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(code);
  if (!team) throw httpErr(404, '邀请码无效');
  if (membership(team.id, user.id)) throw httpErr(409, '你已是该团队成员');
  db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?,?,?,?)')
    .run(team.id, user.id, 'member', now());
  teamActivity(team.id, user.id, 'join', { name: pubUser(user.id).display_name });
  return { id: team.id, name: team.name, role: 'member' };
});

// 团队详情：成员列表 + 邀请码（成员也可见，方便师门转发）
route('GET', '/api/teams/([a-f0-9-]{36})', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const team = db.prepare('SELECT id, name, invite_code, owner_id, created_at FROM teams WHERE id = ?').get(teamId);
  const members = db.prepare(
    `SELECT u.id, u.username, u.display_name, m.role, m.joined_at
     FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined_at`
  ).all(teamId).map(x => ({ ...x, display_name: x.display_name || x.username }));
  return { ...team, members };
});

// owner 移除成员 / member 自退（uid = 自己时）
route('DELETE', '/api/teams/([a-f0-9-]{36})/members/([a-f0-9-]{36})', { auth: true }, (b, m, user) => {
  const [, teamId, uid] = m;
  const me = requireMember(teamId, user);
  if (uid !== user.id && me.role !== 'owner')
    throw httpErr(403, '只有导师/创建者可以移除成员');
  const target = membership(teamId, uid);
  if (!target) throw httpErr(404, '该用户不是团队成员');
  if (target.role === 'owner') throw httpErr(400, '创建者不能被移除，可先转让创建者');
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, uid);
  if (uid !== user.id) teamActivity(teamId, user.id, 'leave', { name: pubUser(uid).display_name, removed: true });
  return true;
});

// owner 转让（毕业交接防死锁）
route('POST', '/api/teams/([a-f0-9-]{36})/transfer', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  const me = requireMember(teamId, user);
  if (me.role !== 'owner') throw httpErr(403, '只有创建者可以转让');
  const { user_id: newOwner } = b ?? {};
  if (!membership(teamId, String(newOwner ?? ''))) throw httpErr(400, '目标用户不是团队成员');
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?").run(teamId, user.id);
    db.prepare("UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?").run(teamId, String(newOwner));
    db.prepare('UPDATE teams SET owner_id = ? WHERE id = ?').run(String(newOwner), teamId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  teamActivity(teamId, user.id, 'join', { name: pubUser(String(newOwner)).display_name, transferred: true });
  return true;
});

// ---------- 共享阅读清单 ----------
route('GET', '/api/teams/([a-f0-9-]{36})/reading-list', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  return db.prepare(
    `SELECT r.*, u.username AS added_by_name FROM reading_items r JOIN users u ON u.id = r.added_by
     WHERE r.team_id = ? ORDER BY r.created_at DESC`
  ).all(teamId);
});

route('POST', '/api/teams/([a-f0-9-]{36})/reading-list', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const { arxiv_id, title, note } = b ?? {};
  if (!validStr(arxiv_id, 32)) throw httpErr(400, 'arxiv_id 必填（他人可一键导入）');
  if (!validStr(title, 300)) throw httpErr(400, '标题必填');
  // 同团队去重（未完成状态内）
  const dup = db.prepare(
    "SELECT id FROM reading_items WHERE team_id = ? AND arxiv_id = ? AND status != 'done'"
  ).get(teamId, arxiv_id.trim());
  if (dup) throw httpErr(409, '清单里已有这篇（未读完）', '可在清单里找到它并认领');
  const id = uuid();
  db.prepare(
    `INSERT INTO reading_items (id, team_id, arxiv_id, title, note, added_by, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'open', ?, ?)`
  ).run(id, teamId, arxiv_id.trim(), title.trim(), String(note ?? '').slice(0, 500), user.id, now(), now());
  teamActivity(teamId, user.id, 'add', { arxiv_id: arxiv_id.trim(), title: title.trim() });
  return { id };
});

// 状态流转：open -> claimed -> done（claimed 可退回 open）
route('PATCH', '/api/reading-items/([a-f0-9-]{36})', { auth: true }, (b, m, user) => {
  const id = m[1];
  const item = db.prepare('SELECT * FROM reading_items WHERE id = ?').get(id);
  if (!item) throw httpErr(404, '清单项不存在');
  requireMember(item.team_id, user);
  const { action } = b ?? {}; // claim | unclaim | done | unarchive
  const t = now();
  if (action === 'claim') {
    db.prepare("UPDATE reading_items SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?").run(user.id, t, id);
    teamActivity(item.team_id, user.id, 'claim', { arxiv_id: item.arxiv_id, title: item.title, name: pubUser(user.id).display_name });
  } else if (action === 'unclaim') {
    db.prepare("UPDATE reading_items SET status = 'open', claimed_by = NULL, updated_at = ? WHERE id = ?").run(t, id);
    teamActivity(item.team_id, user.id, 'unclaim', { arxiv_id: item.arxiv_id, title: item.title });
  } else if (action === 'done') {
    db.prepare("UPDATE reading_items SET status = 'done', updated_at = ? WHERE id = ?").run(t, id);
    teamActivity(item.team_id, user.id, 'done', { arxiv_id: item.arxiv_id, title: item.title, name: pubUser(user.id).display_name });
  } else {
    throw httpErr(400, 'action 取值：claim | unclaim | done');
  }
  return true;
});

route('DELETE', '/api/reading-items/([a-f0-9-]{36})', { auth: true }, (b, m, user) => {
  const id = m[1];
  const item = db.prepare('SELECT * FROM reading_items WHERE id = ?').get(id);
  if (!item) throw httpErr(404, '清单项不存在');
  const me = requireMember(item.team_id, user);
  if (me.role !== 'owner' && item.added_by !== user.id)
    throw httpErr(403, '只有添加人或导师可删除');
  db.prepare('DELETE FROM reading_items WHERE id = ?').run(id);
  teamActivity(item.team_id, user.id, 'item_remove', { arxiv_id: item.arxiv_id, title: item.title });
  return true;
});

// ---------- 组会 ----------
route('GET', '/api/teams/([a-f0-9-]{36})/meetings', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const rows = db.prepare(
    `SELECT mt.*, u.username AS presenter_name,
       (SELECT display_name FROM users WHERE id = mt.presenter_id) AS presenter_display
     FROM meetings mt LEFT JOIN users u ON u.id = mt.presenter_id
     WHERE mt.team_id = ? ORDER BY mt.scheduled_at DESC LIMIT 100`
  ).all(teamId);
  return rows.map(r => ({ ...r, presenter_display: r.presenter_display || r.presenter_name || '' }));
});

route('POST', '/api/teams/([a-f0-9-]{36})/meetings', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const { title, scheduled_at, paper_arxiv_id, paper_title } = b ?? {};
  if (!validStr(title, 120)) throw httpErr(400, '标题必填（1-120 字）');
  if (!validStr(scheduled_at, 40) || Number.isNaN(Date.parse(scheduled_at)))
    throw httpErr(400, '时间格式无效（ISO）');
  const id = uuid();
  db.prepare(
    `INSERT INTO meetings (id, team_id, title, scheduled_at, paper_arxiv_id, paper_title, presenter_id, notes, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, teamId, title.trim(), scheduled_at.trim(),
    validStr(paper_arxiv_id, 32) ? paper_arxiv_id.trim() : null,
    validStr(paper_title, 300) ? paper_title.trim() : '',
    null, '', user.id, now(), now());
  teamActivity(teamId, user.id, 'meeting', { title: title.trim(), scheduled_at: scheduled_at.trim(), action: 'create' });
  return { id };
});

route('PATCH', '/api/meetings/([a-f0-9-]{36})', { auth: true }, (b, m, user) => {
  const id = m[1];
  const mt = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!mt) throw httpErr(404, '组会不存在');
  requireMember(mt.team_id, user);
  const { action, scheduled_at, notes, paper_arxiv_id, paper_title } = b ?? {};
  const t = now();
  if (action === 'claim') { // 认领领读
    db.prepare('UPDATE meetings SET presenter_id = ?, updated_at = ? WHERE id = ?').run(user.id, t, id);
    teamActivity(mt.team_id, user.id, 'meeting', { title: mt.title, action: 'claim_presenter', name: pubUser(user.id).display_name });
  } else if (action === 'unclaim') {
    db.prepare('UPDATE meetings SET presenter_id = NULL, updated_at = ? WHERE id = ?').run(t, id);
  } else { // 编辑字段（改期/挂论文/笔记）
    const sets = ['updated_at = ?'];
    const args = [t];
    if (scheduled_at !== undefined) {
      if (Number.isNaN(Date.parse(String(scheduled_at)))) throw httpErr(400, '时间格式无效');
      sets.push('scheduled_at = ?'); args.push(String(scheduled_at));
    }
    if (notes !== undefined) { sets.push('notes = ?'); args.push(String(notes).slice(0, 20_000)); }
    if (paper_arxiv_id !== undefined) { sets.push('paper_arxiv_id = ?'); args.push(paper_arxiv_id ? String(paper_arxiv_id).slice(0, 32) : null); }
    if (paper_title !== undefined) { sets.push('paper_title = ?'); args.push(String(paper_title ?? '').slice(0, 300)); }
    args.push(id);
    db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    teamActivity(mt.team_id, user.id, 'meeting', { title: mt.title, action: 'update' });
  }
  return true;
});

route('DELETE', '/api/meetings/([a-f0-9-]{36})', { auth: true }, (b, m, user) => {
  const id = m[1];
  const mt = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!mt) throw httpErr(404, '组会不存在');
  const me = requireMember(mt.team_id, user);
  if (me.role !== 'owner' && mt.created_by !== user.id)
    throw httpErr(403, '只有创建人或导师可删除');
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  teamActivity(mt.team_id, user.id, 'meeting', { title: mt.title, action: 'remove' });
  return true;
});

// ---------- 阅读进度 + 动态流 ----------
route('PUT', '/api/teams/([a-f0-9-]{36})/progress', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const { paperKey, arxiv_id, title, pct } = b ?? {};
  const p = Math.max(0, Math.min(100, Math.round(Number(pct))));
  if (!Number.isFinite(p)) throw httpErr(400, 'pct 无效');
  if (!validStr(title, 300)) throw httpErr(400, 'title 必填');
  teamActivity(teamId, user.id, 'progress', {
    paperKey: String(paperKey ?? ''), arxiv_id: String(arxiv_id ?? ''), title: title.trim(), pct: p,
    name: pubUser(user.id).display_name,
  });
  return true;
});

route('GET', '/api/teams/([a-f0-9-]{36})/feed', { auth: true }, (b, m, user, _t, req, url) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  const rows = db.prepare(
    `SELECT a.id, a.type, a.payload, a.created_at, u.username, u.display_name
     FROM activity a JOIN users u ON u.id = a.user_id
     WHERE a.team_id = ? ORDER BY a.id DESC LIMIT ?`
  ).all(teamId, limit);
  return rows.map(r => {
    let payload = {};
    try { payload = JSON.parse(r.payload); } catch { /* 损坏行 */ }
    return { id: r.id, type: r.type, payload, created_at: r.created_at, user: { username: r.username, display_name: r.display_name || r.username } };
  });
});

// ---------- 共享术语表 ----------
route('GET', '/api/teams/([a-f0-9-]{36})/terms', { auth: true }, (b, m, user) => {
  const teamId = m[1];
  requireMember(teamId, user);
  return db.prepare('SELECT term, level, explain, updated_at FROM terms WHERE team_id = ? ORDER BY term').all(teamId);
});

route('POST', '/api/teams/([a-f0-9-]{36})/terms/push', { auth: true }, (b, m, user, _t, req, rawBody) => {
  const teamId = m[1];
  requireMember(teamId, user);
  const items = Array.isArray(b?.items) ? b.items : null;
  if (!items || !items.length) throw httpErr(400, 'items 数组必填');
  if (items.length > 5000) throw httpErr(413, '词条过多（单次 ≤5000）');
  const t = now();
  let added = 0, updated = 0;
  db.exec('BEGIN');
  try {
    const up = db.prepare(
      `INSERT INTO terms (team_id, term, level, explain, pushed_by, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(team_id, term) DO UPDATE SET level = excluded.level, explain = excluded.explain, pushed_by = excluded.pushed_by, updated_at = excluded.updated_at`
    );
    for (const it of items) {
      if (!validStr(it?.term, 120)) continue;
      const exists = db.prepare('SELECT term FROM terms WHERE team_id = ? AND term = ?').get(teamId, it.term.trim());
      up.run(teamId, it.term.trim(), String(it.level ?? '').slice(0, 32), String(it.explain ?? '').slice(0, 2000), user.id, t);
      exists ? updated++ : added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  teamActivity(teamId, user.id, 'term', { added, updated, name: pubUser(user.id).display_name });
  return { added, updated };
});

// ---------- HTTP 服务 ----------
const MAX_BODY = 2 * 1024 * 1024; // 2MB（terms push 1MB 上限 + 余量）

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!pathname.startsWith('/api/')) return fail(res, 404, 'not found');

  // CORS：自托管场景同源/局域网直连为主，宽松放行（无 cookie，令牌显式头）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 读 body
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return fail(res, 413, '请求体过大');
  }
  let body = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { return fail(res, 400, 'JSON 解析失败'); }
  }

  // 匹配路由
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.pattern);
    if (!m) continue;
    try {
      // 认证
      let user = null;
      let token = '';
      if (r.auth) {
        token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        user = userForToken(token);
        if (!user) throw httpErr(401, '未登录或会话已过期', '请重新登录');
      }
      const data = await r.handler(body, m, user, token, req, url);
      return ok(res, data);
    } catch (e) {
      const status = e?.status ?? 500;
      if (status >= 500) console.error(`[${pathname}]`, e);
      return fail(res, status, String(e?.message ?? e).replace(/^Error:\s*/, ''), e?.hint ?? '');
    }
  }
  return fail(res, 404, 'not found');
});

// 启动（测试注入端口复用同一 server 实例）
server.listen(PORT, () => {
  console.log(`[team-server] listening on http://localhost:${PORT} (db: ${DB_PATH})`);
});

export { server, db };
