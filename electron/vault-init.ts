// vault-init：App 启动时把 db writeHook 接到 vault 写穿队列（幂等，可重复调用）。
// 生命周期：registerIpc() 首次调用时 init；before-quit 时 flushPending()。
// vault_dir 的持久化：DB 外 JSON（userData/vault-config.json）——
// 启动引导场景 DB 不存在也要能找到 vault；DB settings 仍镜像一份（P3 同步读取）。
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import * as db from './db';
import { createSink, type VaultSink } from './vault-sink';
import { createVaultProcessor, type VaultProvider } from './vault-wiring';

const VAULT_DIR_KEY = 'vault_dir';
const CONFIG_FILE = 'vault-config.json';

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

let sink: VaultSink | null = null;
let currentDir = '';

// Provider：把 db 读函数适配为 vault-wiring 需要的形状（唯一 import db 的地方）
const provider: VaultProvider = {
  getPaper: (id) => db.getPaper(id) as any,
  listHighlights: (pid) => db.listHighlights(pid) as any[],
  listPdfHighlights: (pid) => db.listPdfHighlights(pid) as any[],
  listNotes: (pid) => db.listNotes(pid) as any[],
  listQa: (pid) => db.listQa(pid) as any[],
  getBlockEn(paperId: number) {
    const rows = db.getBlocks(paperId) as any[];
    const m = new Map<number, { seq: number; en: string }>();
    for (const b of rows) m.set(b.pid, { seq: b.seq, en: b.en });
    return m;
  },
  getTranslationsFull: (pid) => {
    const d = db.getDb();
    return d.prepare(
      `SELECT t.pid, t.zh, t.provider, t.model, t.updated_at FROM translations t WHERE t.paper_id=? ORDER BY t.pid`
    ).all(pid) as any[];
  },
  getDigest: (kind, refId) => db.getDigest(kind as 'paper' | 'topic', refId) as any,
  getSummary: (pid) => db.getSummary(pid) as any,
  getReadProgress: (pid) => db.getReadProgress(pid),
  getTopic: (id) => db.getTopic(id) as any,
  listTopicPapers: (id) => db.listTopicPapers(id) as any[],
  listTopicEdges: (id) => db.listTopicEdges(id) as any[],
  listAllFlashcards: () => db.listAllFlashcards() as any[],
  getReaderProfile: () => db.getReaderProfile(),
};

export function getVaultDir(): string {
  try {
    if (fs.existsSync(configPath())) {
      return JSON.parse(fs.readFileSync(configPath(), 'utf8')).dir ?? '';
    }
  } catch { /* 损坏回落 DB */ }
  return db.getSetting(VAULT_DIR_KEY) ?? '';
}

export function setVaultDir(dir: string): void {
  try { fs.writeFileSync(configPath(), JSON.stringify({ dir }, null, 2)); } catch { /* best effort */ }
  db.setSetting(VAULT_DIR_KEY, String(dir || ''));
  reinit();
}

// 幂等初始化：vault_dir 已配置则挂 hook；目录变化时重建 sink
export function initVault(): void {
  const dir = getVaultDir();
  if (!dir) return;
  if (sink && currentDir === dir) return;
  const processor = createVaultProcessor({ vaultDir: dir, provider });
  sink = createSink({
    flush: (tasks) => processor.handle(tasks),
    journalPath: path.join(app.getPath('userData'), 'vault-journal.jsonl'),
    delayMs: 800,
  });
  currentDir = dir;
  db.setWriteHook((e) => sink?.enqueue(e));
}

function reinit(): void {
  sink = null;
  currentDir = '';
  db.setWriteHook(null);
  initVault();
}

export function vaultStatus(): { enabled: boolean; dir: string; pending: number; errors: number; lastError?: string } {
  const dir = getVaultDir();
  if (!dir || !sink) return { enabled: false, dir, pending: 0, errors: 0 };
  const s = sink.stats();
  return { enabled: true, dir, ...s };
}

export async function flushVault(): Promise<void> {
  if (sink) await sink.flush();
}

// 启动引导：DB 文件不存在且 vault 已配置有数据 → 自动重建索引（main.ts 正常启动调用；
// bootstrap e2e 复用同一函数）。返回报告或 null（未触发）。
export function bootstrapIfNeeded(): { papers: number; highlights: number; errors: number } | null {
  const vaultDir = getVaultDir();
  if (!vaultDir) return null;
  const dbFile = path.join(app.getPath('userData'), 'paper-reader.db');
  if (fs.existsSync(dbFile)) return null;
  if (!fs.existsSync(path.join(vaultDir, 'papers'))) return null;
  // 动态 require 避免 db 单例在模块加载期打开（vault-migrate import db 没问题，但保持引导路径轻）
  const vaultMig = require('./vault-migrate');
  const rb = vaultMig.vaultRebuild(vaultDir);
  return { papers: rb.report.papers, highlights: rb.report.highlights, errors: rb.report.errors.length };
}
