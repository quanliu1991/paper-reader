// sync-agent：vault git 同步代理（simple-git 薄封装，exec 可注入）。
// 冲突策略（DB 本地权威）：rebase 失败 → abort → 冲突文件取远端 + 本地副本存 .conflict. → 重新提交 → push
import os from 'os';
import fs from 'fs';
import path from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';

export interface SyncResult {
  ok: boolean;
  committed?: boolean;       // 本次是否产生新 commit
  pulled?: number;           // pull 拉到的远端变更文件数
  pushed?: boolean;
  conflicts?: string[];      // 冲突文件（已自动解决，副本存 .conflict.*）
  error?: string;
}

export interface SyncConfig {
  remoteUrl: string;
  pushEnabled: boolean;
  dryRun: boolean;           // true：只 commit 不 push（默认）
}

export function deviceIdentity(): string {
  return `paper-reader-${os.hostname().split('.')[0].toLowerCase()}`;
}

export function createGitAgent(vaultDir: string, cfg: SyncConfig, gitOverride?: SimpleGit) {
  const git = gitOverride ?? simpleGit(vaultDir);

  async function ensureRepo(): Promise<void> {
    if (!fs.existsSync(path.join(vaultDir, '.git'))) {
      await git.init();
    }
    // identity：同步专用（不动全局配置）
    await git.addConfig('user.name', deviceIdentity(), false, true);
    await git.addConfig('user.email', `${deviceIdentity()}@paper-reader.local`, false, true);
    // 远端
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (cfg.remoteUrl) {
      if (!origin) await git.addRemote('origin', cfg.remoteUrl);
      else if (origin.refs.fetch !== cfg.remoteUrl) await git.remote(['set-url', 'origin', cfg.remoteUrl]);
    }
    // 初始提交（空仓 rebase 需要 HEAD）
    try {
      await git.revparse(['HEAD']);
    } catch {
      try {
        await git.raw(['add', '.']);
        await git.commit('deposit: init vault');
      } catch { /* 真空目录（连 .gitignore 都没有）跳过 */ }
    }
  }

  async function commitAll(message: string): Promise<boolean> {
    const st = await git.status();
    if (st.isClean()) return false;
    await git.raw(['add', '.']);
    await git.commit(message);
    return true;
  }

  async function pullRebase(): Promise<{ pulled: number; conflicts: string[] }> {
    if (!cfg.remoteUrl) return { pulled: 0, conflicts: [] }; // 未配置远端：本地仓库模式
    const headBefore = await headSha();
    let conflicts: string[] = [];
    try {
      await git.pull('origin', 'main', { '--rebase': null, '--no-rebase': undefined } as any);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('CONFLICT') || msg.includes('conflict')) {
        const st = await git.status();
        conflicts = [...st.conflicted, ...st.deleted];
        // DB 本地权威：冲突文件取远端内容 + 本地副本留档
        for (const f of conflicts) {
          const local = path.join(vaultDir, f);
          if (fs.existsSync(local)) {
            const conflictCopy = `${f}.conflict.${deviceIdentity()}.${Date.now()}`;
            fs.copyFileSync(local, path.join(vaultDir, conflictCopy));
          }
          try { await git.checkout(['--theirs', f]); } catch { /* deleted 冲突时 theirs 也无 */ }
        }
        try { await git.rebase(['--continue']); } catch {
          try { await git.rebase(['--abort']); } catch { /* 已结束 */ }
        }
      } else {
        // 网络失败等：静默离线
        throw e;
      }
    }
    const headAfter = await headSha();
    return { pulled: headBefore !== headAfter ? await changedFiles(headBefore, headAfter) : 0, conflicts };
  }

  async function syncOnce(message: string): Promise<SyncResult> {
    try {
      await ensureRepo();
      const committed = await commitAll(message);
      const { pulled, conflicts } = await pullRebase();
      let pushed = false;
      if (cfg.pushEnabled && !cfg.dryRun && cfg.remoteUrl) {
        try {
          await git.push('origin', 'main', { '--set-upstream': null } as any);
          pushed = true;
        } catch (e: any) {
          return { ok: false, committed, pulled, conflicts, error: `push 失败: ${e?.message ?? e}` };
        }
      }
      return { ok: true, committed, pulled, conflicts, pushed };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  async function headSha(): Promise<string> {
    try { return await git.revparse(['HEAD']); } catch { return ''; }
  }

  async function changedFiles(from: string, to: string): Promise<number> {
    if (!from) return 0;
    try {
      const diff = await git.diff([`${from}..${to}`, '--name-only']);
      return diff.split('\n').filter(Boolean).length;
    } catch { return 0; }
  }

  return { ensureRepo, commitAll, pullRebase, syncOnce, headSha };
}
