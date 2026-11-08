// vault-sink：DB 写事件 → sidecar 文件的异步写穿队列。
// 设计要点（docs/superpowers/specs/2026-11-08-storage-boundaries-design.md P1）：
// - 阅读中的高频小写入合并去脏（同 kind+paperId 只留最新），防抖批量落地
// - journal 落盘保证崩溃恢复：flush 前追加、成功后 truncate、重启重放
// - 毒丸隔离：flush 失败重试一次后丢弃并计数，绝不阻塞 App
import fs from 'fs';
import path from 'path';

export type VaultTaskKind =
  | 'meta' | 'annotations' | 'notes' | 'qa' | 'translations'
  | 'digest' | 'flashcards' | 'topics' | 'profile' | 'paperDelete';

export interface VaultTask {
  kind: VaultTaskKind;
  paperId?: number;
  topicId?: number;
}

export interface VaultSinkStats {
  pending: number;
  errors: number;
  lastError?: string;
}

export interface VaultSink {
  enqueue(task: VaultTask): void;
  flush(): Promise<void>;
  stats(): VaultSinkStats;
}

interface SinkInternal {
  queue: Map<string, VaultTask>;       // key 去脏，保持插入顺序
  timer: NodeJS.Timeout | null;
  flushing: Promise<void> | null;
  errors: number;
  lastError?: string;
  retries: Map<string, number>;        // key → 已重试次数
  opts: {
    flush: (tasks: VaultTask[]) => Promise<void>;
    journalPath?: string;
    delayMs: number;
  };
}

function taskKey(t: VaultTask): string {
  return `${t.kind}:${t.paperId ?? t.topicId ?? ''}`;
}

function writeJournal(p: string, tasks: VaultTask[]): void {
  // 全量重写（enqueue 追加 + drain 成功后收敛到当前队列，两种场景共用）
  const lines = tasks.map(t => JSON.stringify(t)).join('\n');
  fs.writeFileSync(p, lines ? lines + '\n' : '');
}

function appendJournal(p: string, task: VaultTask): void {
  try { fs.appendFileSync(p, JSON.stringify(task) + '\n'); } catch { /* journal 尽力而为 */ }
}

function readJournal(p: string): VaultTask[] {
  try {
    const text = fs.readFileSync(p, 'utf8').trim();
    if (!text) return [];
    const out: VaultTask[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as VaultTask); } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch {
    return []; // 文件不存在
  }
}

export function createSink(opts: {
  flush: (tasks: VaultTask[]) => Promise<void>;
  journalPath?: string;
  delayMs?: number;
}): VaultSink {
  const internal: SinkInternal = {
    queue: new Map(),
    timer: null,
    flushing: null,
    errors: 0,
    lastError: undefined,
    retries: new Map(),
    opts: { flush: opts.flush, journalPath: opts.journalPath, delayMs: opts.delayMs ?? 800 },
  };

  // 崩溃恢复：重放 journal 中未完成的任务
  if (internal.opts.journalPath) {
    const pending = readJournal(internal.opts.journalPath);
    for (const t of pending) internal.queue.set(taskKey(t), t);
  }

  async function drain(): Promise<void> {
    if (internal.queue.size === 0) {
      if (internal.opts.journalPath) writeJournal(internal.opts.journalPath, []);
      return;
    }
    const batch = [...internal.queue.values()];
    internal.queue.clear();
    try {
      await internal.opts.flush(batch);
      if (internal.opts.journalPath) writeJournal(internal.opts.journalPath, [...internal.queue.values()]);
      for (const t of batch) internal.retries.delete(taskKey(t));
    } catch (err: any) {
      internal.errors += 1;
      internal.lastError = String(err?.message ?? err);
      // 毒丸隔离：整批重试一次（写回队列，等下一轮 drain），二次失败丢弃
      for (const t of batch) {
        const key = taskKey(t);
        const n = internal.retries.get(key) ?? 0;
        if (n < 1) {
          internal.retries.set(key, n + 1);
          internal.queue.set(key, t); // 重新入队
        }
        // n >= 1：丢弃（错误已计数）
      }
      if (internal.queue.size > 0 && !internal.timer) {
        internal.timer = setTimeout(() => {
          internal.timer = null;
          void drain();
        }, internal.opts.delayMs);
        internal.timer.unref?.();
      }
    }
  }

  return {
    enqueue(task: VaultTask): void {
      internal.queue.set(taskKey(task), task);
      if (internal.opts.journalPath) appendJournal(internal.opts.journalPath, task);
      if (internal.timer) clearTimeout(internal.timer);
      internal.timer = setTimeout(() => {
        internal.timer = null;
        void drain();
      }, internal.opts.delayMs);
      internal.timer.unref?.();
    },
    flush(): Promise<void> {
      if (internal.timer) { clearTimeout(internal.timer); internal.timer = null; }
      // 链式等待：并发 flush 只有一个 drain 在途
      internal.flushing = (internal.flushing ?? Promise.resolve()).then(() => drain());
      return internal.flushing;
    },
    stats(): VaultSinkStats {
      const s: VaultSinkStats = { pending: internal.queue.size, errors: internal.errors };
      if (internal.lastError !== undefined) s.lastError = internal.lastError;
      return s;
    },
  };
}

// 工具：vault 相对路径规约（供 wiring/migrate 复用）
export function vaultPaths(vaultDir: string) {
  return {
    root: vaultDir,
    papersDir: path.join(vaultDir, 'papers'),
    topicsDir: path.join(vaultDir, 'topics'),
    glossaryDir: path.join(vaultDir, 'glossary'),
    trashDir: path.join(vaultDir, 'trash'),
    flashcards: path.join(vaultDir, 'flashcards.jsonl'),
    profile: path.join(vaultDir, 'profile.md'),
    paperDir: (key: string) => path.join(vaultDir, 'papers', key),
    meta: (key: string) => path.join(vaultDir, 'papers', key, 'meta.yaml'),
    annotations: (key: string) => path.join(vaultDir, 'papers', key, 'annotations.json'),
    notes: (key: string) => path.join(vaultDir, 'papers', key, 'notes.md'),
    qa: (key: string) => path.join(vaultDir, 'papers', key, 'qa.jsonl'),
    translations: (key: string) => path.join(vaultDir, 'papers', key, 'translations.jsonl'),
    digest: (key: string) => path.join(vaultDir, 'papers', key, 'digest.md'),
    topicJson: (slug: string) => path.join(vaultDir, 'topics', `${slug}.json`),
    topicDigest: (slug: string) => path.join(vaultDir, 'topics', `${slug}.digest.md`),
  };
}
