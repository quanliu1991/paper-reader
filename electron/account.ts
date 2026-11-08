// account.ts：团队服务端 HTTP 客户端 + 进度上报调度（主进程）。
// 凭据存 DB settings 表（account.* 键）——与 provider 密钥同级本地资产，不入 vault。
// 401 处理：清 token + 广播 'account:changed'（渲染层 Settings 账户区响应刷新）。
// 进度上报三时机：论文关闭/切换 + 阅读中每 5 分钟 + before-quit flush（不 hook 滚动路径）。
import * as db from './db';

const K = {
  serverUrl: 'account.server_url',
  token: 'account.token',
  userId: 'account.user_id',
  username: 'account.username',
  activeTeamId: 'account.active_team_id',
  progressReport: 'account.progress_report', // '0' = 关（默认开）
};

export interface AccountInfo {
  configured: boolean;      // 服务器地址已填
  loggedIn: boolean;
  serverUrl: string;
  user: { id: string; username: string; display_name?: string } | null;
  activeTeamId: string | null;
  progressReport: boolean;
}

export function getAccountInfo(): AccountInfo {
  const token = db.getSetting(K.token);
  const uid = db.getSetting(K.userId);
  return {
    configured: !!(db.getSetting(K.serverUrl) ?? ''),
    loggedIn: !!(token && uid),
    serverUrl: db.getSetting(K.serverUrl) ?? '',
    user: token && uid ? { id: uid, username: db.getSetting(K.username) ?? '' } : null,
    activeTeamId: db.getSetting(K.activeTeamId),
    progressReport: db.getSetting(K.progressReport) !== '0',
  };
}

export function setServerUrl(url: string): void {
  db.setSetting(K.serverUrl, url.trim().replace(/\/+$/, ''));
  // 换服务器 = 旧会话作废
  clearSession();
}

export function setProgressReport(on: boolean): void {
  db.setSetting(K.progressReport, on ? '1' : '0');
}

export function setActiveTeam(teamId: string | null): void {
  db.setSetting(K.activeTeamId, teamId ?? '');
}

function clearSession(): void {
  for (const k of [K.token, K.userId, K.username, K.activeTeamId]) {
    db.getDb().prepare('DELETE FROM settings WHERE key = ?').run(k);
  }
}

// ---------- HTTP ----------
export class ApiError extends Error {
  status: number; hint: string;
  constructor(status: number, message: string, hint = '') {
    super(message);
    this.status = status; this.hint = hint;
  }
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const base = db.getSetting(K.serverUrl);
  if (!base) throw new ApiError(400, '未配置团队服务器地址', '到设置 → 账户填写服务器地址');
  const token = db.getSetting(K.token) ?? '';
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    throw new ApiError(0, /timeout|aborted/i.test(msg) ? '请求超时' : `无法连接团队服务器（${msg}）`, '检查服务器地址与网络');
  }
  let j: any = null;
  try { j = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401) {
    // 会话失效：清凭据通知前端（登出/过期统一走这里）
    clearSession();
    notifyChanged();
    throw new ApiError(401, j?.error ?? '会话已过期，请重新登录');
  }
  if (!res.ok || !j?.ok) {
    throw new ApiError(res.status, j?.error ?? `请求失败（HTTP ${res.status}）`, j?.hint ?? '');
  }
  return j.data as T;
}

// ---------- 登录/注册 ----------
export async function register(username: string, password: string, displayName: string): Promise<AccountInfo> {
  const r = await api<{ token: string; user: any }>('POST', '/api/auth/register', { username, password, display_name: displayName });
  saveSession(r);
  return getAccountInfo();
}

export async function login(username: string, password: string): Promise<AccountInfo> {
  const r = await api<{ token: string; user: any }>('POST', '/api/auth/login', { username, password });
  saveSession(r);
  return getAccountInfo();
}

function saveSession(r: { token: string; user: any }): void {
  db.setSetting(K.token, r.token);
  db.setSetting(K.userId, r.user.id);
  db.setSetting(K.username, r.user.username);
  notifyChanged();
}

export async function logout(): Promise<void> {
  // 尽力通知服务端删 session（失败也继续本地登出）
  try { await api('POST', '/api/auth/logout'); } catch { /* 网络失败忽略 */ }
  clearSession();
  pendingReport = null; // 丢弃未上报进度
  notifyChanged();
}

// ---------- 进度上报 ----------
// 待上报缓冲：paperId → {paperKey, arxiv_id, title, pct}
let pendingReport: Record<number, { paperKey: string; arxiv_id: string; title: string; pct: number }> | null = null;
let reportTimer: NodeJS.Timeout | null = null;
let broadcast: ((channel: string, payload?: any) => void) | null = null;

export function setBroadcaster(fn: (channel: string, payload?: any) => void): void {
  broadcast = fn;
}
function notifyChanged(): void {
  try { broadcast?.('account:changed', getAccountInfo()); } catch { /* 窗口可能未就绪 */ }
}

// 论文进度变化入口（papers:setReadPct / 论文关闭时调用；绝不 hook 高频滚动）
export function noteProgress(paper: { id: number; arxiv_id: string | null; title: string; created_at: string }, pct: number): void {
  if (!pendingReport) pendingReport = {};
  pendingReport[paper.id] = {
    paperKey: `${(paper.created_at ?? '').slice(0, 4) || '0000'}-${paper.arxiv_id ?? 'local'}`,
    arxiv_id: paper.arxiv_id ?? '',
    title: paper.title,
    pct: Math.max(0, Math.min(100, Math.round(pct))),
  };
  scheduleReport(false);
}

function scheduleReport(immediate: boolean): void {
  if (reportTimer) { if (!immediate) return; clearTimeout(reportTimer); reportTimer = null; }
  reportTimer = setTimeout(() => { reportTimer = null; void flushProgress(); }, immediate ? 0 : 5 * 60_000);
  reportTimer.unref?.();
}

export async function flushProgress(): Promise<void> {
  if (!pendingReport || !Object.keys(pendingReport).length) return;
  const info = getAccountInfo();
  if (!info.loggedIn || !info.activeTeamId || !info.progressReport) { pendingReport = null; return; }
  const items = Object.values(pendingReport);
  pendingReport = null;
  for (const it of items) {
    try {
      await api('PUT', `/api/teams/${info.activeTeamId}/progress`, it);
    } catch { /* 单条失败静默（下次再报）*/ }
  }
}

// ---------- 术语同步 ----------
// push：本地 vault glossary 词条 → 服务端；pull：服务端 → 本地（追加式合并，冲突本地优先）。
// 落盘走 vault.ts writeAtomic（见 glossary-sync.ts；此文件只做网络）。
export async function pushTerms(teamId: string, items: Array<{ term: string; level: string; explain: string }>): Promise<{ added: number; updated: number }> {
  return api('POST', `/api/teams/${teamId}/terms/push`, { items });
}

export async function pullTerms(teamId: string): Promise<Array<{ term: string; level: string; explain: string; updated_at: string }>> {
  return api('GET', `/api/teams/${teamId}/terms`);
}
