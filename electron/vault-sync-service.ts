// vault-sync-service：同步调度（防抖提交 + 启动 pull + 轮询）+ 状态机 + 配置。
// 设计：vault-sink flush 成功后标记 dirty → 90s 静默期后 syncOnce；
// 启动时 pull 一次（远端变更经 vault-import 入库）；5min 轮询 pull。
// 状态：unconfigured / idle / syncing / conflict / offline
import * as db from './db';
import { createGitAgent, type SyncResult, type SyncConfig } from './sync-agent';
import { importAfterPull } from './vault-import';

export type SyncState = 'unconfigured' | 'idle' | 'dirty' | 'syncing' | 'conflict' | 'offline';

const SYNC_KEYS = {
  remoteUrl: 'vault_sync.remote_url',
  pushEnabled: 'vault_sync.push_enabled',
  dryRun: 'vault_sync.dry_run',
};

export function getSyncConfig(): SyncConfig & { configured: boolean } {
  return {
    remoteUrl: db.getSetting(SYNC_KEYS.remoteUrl) ?? '',
    pushEnabled: db.getSetting(SYNC_KEYS.pushEnabled) === '1',
    dryRun: db.getSetting(SYNC_KEYS.dryRun) !== '0', // 默认 dry-run
    configured: !!(db.getSetting(SYNC_KEYS.remoteUrl) ?? ''),
  };
}

export function setSyncConfig(patch: Partial<SyncConfig>): void {
  if (patch.remoteUrl !== undefined) db.setSetting(SYNC_KEYS.remoteUrl, patch.remoteUrl);
  if (patch.pushEnabled !== undefined) db.setSetting(SYNC_KEYS.pushEnabled, patch.pushEnabled ? '1' : '0');
  if (patch.dryRun !== undefined) db.setSetting(SYNC_KEYS.dryRun, patch.dryRun ? '1' : '0');
}

export interface SyncStatus {
  state: SyncState;
  lastResult?: SyncResult;
  lastSyncAt?: string;
  nextPollAt?: number;
  firstPushSucceeded?: boolean; // 首次 push 成功（UI 提示可关 dry-run）
}

export function createSyncScheduler(opts: {
  vaultDir: string;
  quietMs?: number;      // 写后静默期（默认 90s）
  pollMs?: number;       // 轮询间隔（默认 5min）
  importAfterPullFn?: (vaultDir: string, headBefore: string) => Promise<number>; // 测试注入；默认走 vault-import
  onStateChange?: (s: SyncStatus) => void;
}) {
  const quietMs = opts.quietMs ?? 90_000;
  const pollMs = opts.pollMs ?? 300_000;
  let state: SyncState = 'idle';
  let lastResult: SyncResult | undefined;
  let lastSyncAt: string | undefined;
  let dirty = false;
  let firstPushSucceeded = false;
  let quietTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let syncing = false;

  function cfg(): SyncConfig {
    const c = getSyncConfig();
    return { remoteUrl: c.remoteUrl, pushEnabled: c.pushEnabled, dryRun: c.dryRun };
  }

  function setState(s: SyncState) {
    state = s;
    opts.onStateChange?.({ state, lastResult, lastSyncAt, firstPushSucceeded });
  }

  function markDirty(): void {
    dirty = true;
    setState('dirty');
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => { quietTimer = null; void syncNow('deposit: 阅读沉淀'); }, quietMs);
    quietTimer.unref?.();
  }

  async function syncNow(message: string): Promise<SyncResult | null> {
    if (syncing) return null;
    syncing = true;
    setState('syncing');
    try {
      const agent = createGitAgent(opts.vaultDir, cfg());
      const headBefore = await agent.headSha();
      const r = await agent.syncOnce(message);
      lastResult = r;
      lastSyncAt = new Date().toISOString();
      if (!r.ok && (r.error?.includes('fetch') || r.error?.includes('Could not read'))) {
        setState('offline');
      } else if ((r.conflicts?.length ?? 0) > 0) {
        setState('conflict');
      } else {
        dirty = false;
        setState('idle');
        if (r.pushed) firstPushSucceeded = true;
        // pull 拉到远端变更 → 增量导入 DB（B 级 blocks 缺失由重导入路径自愈）
        if (r.pulled && headBefore) {
          try {
            const doImport = opts.importAfterPullFn ?? importAfterPull;
            await doImport(opts.vaultDir, headBefore);
          } catch { /* 导入失败下次 pull 再试 */ }
        }
      }
      return r;
    } finally {
      syncing = false;
    }
  }

  function status(): SyncStatus {
    return { state, lastResult, lastSyncAt, firstPushSucceeded };
  }

  function start(): void {
    // 启动 pull + 轮询
    void syncNow('deposit: startup pull');
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!syncing) void syncNow('deposit: poll pull');
    }, pollMs);
    pollTimer.unref?.();
  }

  function stop(): void {
    if (quietTimer) clearTimeout(quietTimer);
    if (pollTimer) clearInterval(pollTimer);
    quietTimer = null;
    pollTimer = null;
  }

  async function flushPending(): Promise<void> {
    // 退出前：dirty 则立即 commit（不 push，dry-run 语义留给下次启动）
    if (dirty) {
      stop();
      await syncNow('deposit: quit flush');
    }
  }

  return { markDirty, syncNow, start, stop, flushPending, status };
}
