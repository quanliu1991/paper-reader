// glossary-sync.ts：团队共享术语表 ↔ 本地 vault 双向同步。
// 合并策略（计划 v2 冻结）：追加式 upsert——
//   push：本地全部词条 → 服务端（服务端按 team_id+term upsert）
//   pull：服务端词条按 term 名合入本地；同名冲突【本地优先】，差异项返回给 UI 展示
// 落盘纪律：序列化用 vault.ts serializeGlossary，写入走 writeAtomic（tmp+rename）——
// 遵守 DEVELOPMENT.md「序列化只在 vault.ts / sidecar 原子写」铁律；不动 DB（glossary 不在 SQLite）。
import fs from 'fs';
import path from 'path';
import { parseGlossary, serializeGlossary, writeAtomic } from './vault';
import { pushTerms, pullTerms } from './account';

export interface GlossaryTerm { term: string; level: string; explain: string }

export interface GlossarySyncResult {
  pushed: { added: number; updated: number };
  pulled: { added: number; conflicts: Array<{ term: string; local: string; remote: string }> };
}

function termsPath(vaultDir: string): string {
  return path.join(vaultDir, 'glossary', 'terms.yaml');
}

export function loadLocalTerms(vaultDir: string): GlossaryTerm[] {
  const p = termsPath(vaultDir);
  if (!fs.existsSync(p)) return [];
  return parseGlossary(fs.readFileSync(p, 'utf8'));
}

// 完整双向同步（IPC 调用）
export async function syncGlossaryAsync(vaultDir: string, teamId: string): Promise<GlossarySyncResult> {
  const local = loadLocalTerms(vaultDir);

  // 1) push 本地全集（服务端 upsert 幂等）
  const pushed = local.length
    ? await pushTerms(teamId, local.map(t => ({ term: t.term, level: t.level, explain: t.explain })))
    : { added: 0, updated: 0 };

  // 2) pull 服务端全集，按 term 合入本地
  const remote = await pullTerms(teamId);
  const localMap = new Map(local.map(t => [t.term, t]));
  const added: GlossaryTerm[] = [];
  const conflicts: Array<{ term: string; local: string; remote: string }> = [];
  for (const r of remote) {
    const existing = localMap.get(r.term);
    if (!existing) {
      const t = { term: r.term, level: r.level, explain: r.explain };
      added.push(t);
      localMap.set(r.term, t);
    } else if (existing.level !== r.level || existing.explain !== r.explain) {
      // 冲突：本地优先，不覆盖；差异上报 UI
      conflicts.push({
        term: r.term,
        local: `level=${existing.level} ${existing.explain}`.trim(),
        remote: `level=${r.level} ${r.explain}`.trim(),
      });
    }
  }

  // 3) 落盘（仅当有新增；冲突不动本地）
  if (added.length) {
    const merged = [...localMap.values()];
    writeAtomic(termsPath(vaultDir), serializeGlossary(merged));
  }

  return { pushed, pulled: { added: added.length, conflicts } };
}
