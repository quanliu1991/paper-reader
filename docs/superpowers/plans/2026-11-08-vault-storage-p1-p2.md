# Vault 存储层 P1+P2 实施计划

> **For agentic workers:** 本计划由本会话内联执行（executing-plans 模式）。步骤用 checkbox 跟踪。

**Goal:** 落地设计文档 P1（vault 双写层）+ P2（迁移器 + 索引重建），DB 降级为可重建索引，sidecar 文件成为事实源。

**Architecture:** db.ts 全部写函数发 writeHook 事件 → vault-sink 异步队列（合并去脏 + journal 崩溃恢复）→ vault-wiring 处理器按 DB 当前状态全量重序列化 sidecar 文件（幂等、原子写）。P2 迁移器一次性 DB→vault 导出，重建器从 vault 显式 legacy_id 插入恢复（跨设备 id 不变，读路径零改动）。

**Tech Stack:** TypeScript、better-sqlite3（既有）、yaml（新增纯 JS）、esbuild 测试模式（既有）。

## 全局约束

- SQL 只在 `electron/db.ts`（DEVELOPMENT.md 约定）
- vault 写失败绝不阻塞 App：队列捕获全部错误，计入 stats 上报
- sidecar 写入原子：tmp 文件 + rename
- 测试模式 PR_* 环境变量必须指向隔离 userData（db.ts guard 既有）
- 提交信息中文：feat:/fix:/chore:/docs:/test:

## 格式契约（冻结——P4 Web 端与 electron/vault.ts 双侧对齐）

### paperKey

`<YYYY>-<sanitized arxivId>`；YYYY 取 papers.created_at 年份；sanitize 把 `[/:\\]` 替换 `-`。例：`2024-2401.02345`、`2026-local-abc123def456`。

### meta.yaml

```yaml
version: 1
legacy_id: 3
arxiv_id: 2401.02345
title: ...
authors: ...
source_url: ...
import_type: html
status: reading
tags: [a, b]           # 空为 []
created_at: '2026-11-08 10:00:00'
read_pct: 45            # 无则 0
sha256: ''              # paper.pdf 的 sha256（迁移时计算；无 PDF 为空）
pdf:
  dual: paper-dual.pdf  # 可选
  mono: paper-mono.pdf  # 可选
summary:                # 可选（paper_summaries）
  provider: glm
  model: glm-4.7
  body: '<原始 summary JSON 字符串>'
  sections: '<原始 section_summaries JSON 字符串>'
```

### annotations.json

```json
{ "version": 1, "items": [
  { "sid": "h1", "legacy_id": 12, "kind": "text", "seq": 5, "text_en": "...", "note": "", "color": "yellow", "created_at": "..." },
  { "sid": "h2", "legacy_id": 13, "kind": "rect", "side": "en", "page": 3, "rects": [{ "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1 }], "text": "...", "seq": null, "note": "", "color": "green", "created_at": "..." }
]}
```

sid 规则：kind 前缀 + 序号（h1..hN / n1.. / q1.. / f1..），按 legacy_id 升序分配，创建后不变。

### notes.md

```markdown
<!-- note sid=n1 legacy=5 seq=7 created=2026-11-08 10:00:00 updated=2026-11-08 11:00:00 -->
笔记正文（markdown， wikilink 保留）

<!-- note sid=n2 legacy=6 seq= created=... updated=... -->
...
```

### qa.jsonl

每行：`{"sid":"q1","legacy_id":3,"seq":5,"question":"...","answer":"...","provider":"...","model":"...","created_at":"..."}`

### translations.jsonl

每行：`{"seq":5,"src_hash":"<sha256(norm(en))>","en":"<原文>","zh":"<译文>","provider":"...","model":"...","updated_at":"..."}`

norm：去 `$...$` 行内公式、`\s+`→单空格、trim（与 findPidByText 一致）。en 来自 join blocks。

### digest.md（paper）

首行 `<!-- digest kind=paper updated=2026-11-08 12:00:00 -->`，随后是 body 原文（含 【H12】【N3】【Q5】 令牌）。

### flashcards.jsonl（vault 根，全局）

每行：`{"sid":"f1","legacy_id":9,"paper_key":"2024-2401.02345","legacy_paper_id":3,"seq":5,"front":"...","back":"...","interval_days":0,"ease":2.5,"reps":0,"lapses":0,"due":"...","created_at":"..."}`

### topics/<slug>.json

slug = name sanitize（非 [a-zA-Z0-9\u4e00-\u9fff-] → -）。结构：

```json
{ "version": 1, "legacy_id": 2, "name": "...", "query": "...", "status": "ready",
  "node_count": 10, "edge_count": 30, "note": "", "created_at": "...", "updated_at": "...",
  "papers": [{ "arxiv_id": "...", "title": "...", "year": 2023, "citation_count": 100, "layer": "key", "in_degree": 4, "out_degree": 2, "read_order": 1, "imported": 0 }],
  "edges": [{ "src": "...", "dst": "..." }] }
```

### profile.md

```markdown
<!-- profile kind=bg updated=... -->
<背景文本>

<!-- profile kind=signals updated=... -->
concept: 3
method: 5
```

### 目录布局

```text
<vault>/
├── AGENTS.md  .gitignore      # ensureLayout 写入（存在不覆盖）
├── glossary/                   # proto-vault 升格时沿用
├── topics/<slug>.json + <slug>.digest.md
├── flashcards.jsonl  profile.md
├── papers/<paperKey>/{paper.pdf, paper-dual.pdf, paper-mono.pdf, meta.yaml, annotations.json, notes.md, qa.jsonl, digest.md, translations.jsonl}
└── trash/<paperKey>-<ts>/      # paperDelete 移入（不物理删）
```

## 接口签名（冻结）

```typescript
// vault-sink.ts
export type VaultTaskKind = 'meta'|'annotations'|'notes'|'qa'|'translations'|'digest'|'flashcards'|'topics'|'profile'|'paperDelete';
export interface VaultTask { kind: VaultTaskKind; paperId?: number; topicId?: number }
export interface VaultSink {
  enqueue(task: VaultTask): void;
  flush(): Promise<void>;          // 等待队列清空（含在途）
  stats(): { pending: number; errors: number; lastError?: string };
}
export function createSink(opts: { flush: (tasks: VaultTask[]) => Promise<void>; journalPath?: string; delayMs?: number }): VaultSink;

// vault.ts
export function paperKeyFor(p: { arxiv_id: string|null; created_at: string }): string;
export function slugFor(name: string): string;
export function srcHash(en: string): string;
export function ensureLayout(vaultDir: string): void;
export function serializeMeta(p: any, extra: { readPct: number; sha256?: string; hasDual: boolean; hasMono: boolean; summary?: any }): string;
export function parseMeta(text: string): any;
export function serializeAnnotations(items: any[]): string;
export function parseAnnotations(text: string): any[];
export function serializeNotes(rows: any[]): string;
export function parseNotes(text: string): any[];
export function serializeQa(rows: any[]): string;
export function parseQa(text: string): any[];
export function serializeTranslations(rows: Array<{seq:number;en:string;zh:string;provider:string;model:string;updated_at:string}>): string;
export function parseTranslations(text: string): any[];
export function serializeDigest(body: string, updatedAt: string): string;
export function parseDigest(text: string): { body: string; updated_at: string } | null;
export function serializeFlashcards(rows: any[]): string;
export function parseFlashcards(text: string): any[];
export function serializeTopic(t: any, papers: any[], edges: any[]): string;
export function parseTopic(text: string): any;
export function serializeProfile(bg: string, signals: Record<string, number>, updatedAt: string): string;
export function parseProfile(text: string): { bg: string; signals: Record<string, number> };
export function writeAtomic(filePath: string, content: string): void;

// vault-wiring.ts
export interface VaultProvider {
  getPaper(id: number): any;
  getBlocksWithEn(paperId: number): Array<{ pid: number; seq: number; en: string }>;
  getTranslationsFull(paperId: number): Array<{ pid: number; seq: number; en: string; zh: string; provider: string; model: string; updated_at: string }>;
  listHighlights(paperId: number): any[];
  listPdfHighlights(paperId: number): any[];
  listNotes(paperId: number): any[];
  listQa(paperId: number): any[];
  getDigest(kind: string, refId: number): any;
  listTopics(): any[];
  listTopicPapers(topicId: number): any[];
  listTopicEdges(topicId: number): any[];
  listAllFlashcards(): any[];
  getReaderProfile(): { bg: string; signals: Record<string, number> };
  getSummary(paperId: number): any;
  getReadProgress(paperId: number): number;
  getPaperKeyMeta(paperId: number): { arxiv_id: string|null; created_at: string } | null;
}
export function createVaultProcessor(opts: { vaultDir: string; provider: VaultProvider }): {
  handle(tasks: VaultTask[]): Promise<void>;
};

// db.ts 新增
export type WriteEvent = VaultTask;
export function setWriteHook(fn: (e: WriteEvent) => void): void;
export function listAllFlashcards(): any[];
export function insertPaperWithId(p: { id: number; arxivId: string; title: string; authors: string; sourceUrl: string; importType: string; createdAt: string; status: string; tags: string }): void;
// 重建用显式 id 插入系列（insertBlocksWithIds、addHighlightWithId、addNoteWithId、addQaWithId、
// saveTranslationWithMeta、addFlashcardWithId、upsertTopicWithId、saveTopicGraphRows、
// addPdfHighlightWithId、insertPaperSummaryWithId、setReaderProfileRows、restoreReadPct）

// vault-migrate.ts
export function vaultMigrate(vaultDir: string, provider: VaultProvider, opts: { userDataDir: string }): { report: any };
export function vaultRebuild(vaultDir: string): { report: any };
export function vaultReconcile(vaultDir: string, provider: VaultProvider, opts: { userDataDir: string }): { ok: boolean; report: any };
```

## 任务清单

### Task 1 vault-sink 队列 [P1]
- 实现 `electron/vault-sink.ts`：enqueue 触发 debounce 定时器（默认 800ms）；同 key（kind+paperId/topicId）合并只留最新；flush 批量回调；journal：flush 前追加 JSONL、成功后 truncate、createSink 时重放。
- 单测 `tests/vault-unit.test.mjs`（esbuild 模式）：coalesce、journal 重放、flush 等待、错误隔离（flush 抛错不丢任务？——错误计入 stats 且任务重试一次后丢弃，避免毒丸阻塞）。

### Task 2 序列化 A：paperKey/布局/meta/annotations [P1]
- vault.ts 实现第一批 + writeAtomic + ensureLayout（AGENTS.md 模板含管辖区声明；.gitignore: `.paper-reader/`、`trash/`、`*.conflict.*`）。
- 单测 round-trip + paperKey sanitize 用例（`hep-th/9901001`、`local:abc`）。

### Task 3 序列化 B：notes/qa/translations/digest/flashcards/topics/profile [P1]
- vault.ts 第二批。digest 解析容忍无头注释（返回 null body 兼容）。profile 信号段可选。
- 单测 round-trip 全覆盖（含空数组/空文本边界）。

### Task 4 db.ts writeHook [P1]
- setWriteHook + 全部写函数发事件：insertPaper/insertBlocks→meta+translations、saveTranslation→translations、addHighlight/removeHighlight/addPdfHighlight/removePdfHighlight→annotations、addNote/updateNote/deleteNote→notes、addQa→qa、upsertDigest→digest、addFlashcard/gradeFlashcard/updateFlashcardBack→flashcards、createTopic/saveTopicGraph/setTopicError/deleteTopic/markTopicPaperImported→topics、setReaderBg/bumpSignal→profile、setPaperStatus/setTags/setReadPct(=setSetting read:*)→meta、deletePaper→paperDelete、saveSummary→meta。
- 同时新增 listAllFlashcards。
- e2e 增补（vault-entry 内）：hook 收集事件断言。

### Task 5 vault-wiring 处理器 [P1]
- handle(tasks)：按 kind+paperId 去重后逐个执行；每类资产 = 从 provider 读全量 → serialize → writeAtomic。paperDelete：papers/<key>/ 存在则 mkdir trash + rename 移入。找不到 paper（已删）跳过。
- 单测：内存 fake provider + tmp 目录，断言各类文件内容。

### Task 6 main.ts 接线 + vault e2e [P1]
- 设置键 `vault_dir`；IPC `vault:getDir/setDir/pickDir/status`；app ready 后若 vault_dir 非空：ensureLayout + createSink(processor.handle) + setWriteHook(sink.enqueue)；before-quit flush（preventDefault 一次）。
- `tests/vault-e2e.test.mjs` + `tests/vault-entry.ts`（克隆 e2e 模式）：种子论文→划线/笔记/QA/翻译→flush→断言 sidecar 文件逐字段。

### Task 7 译文重锚修复 [P1]
- db.ts insertBlocks：事务内先读旧 translations join 旧 blocks（en, zh, provider, model）→删 blocks→插新 blocks→按 srcHash(新 en) 匹配重插 translations；未命中的插 `orphan_translations` 表（新表：paper_id, zh, provider, model, updated_at）绝不静默删。
- e2e 增补：upgrade 场景断言译文保留。

### Task 8 Settings UI [P1]
- Settings.tsx vault 区：目录选择（复用 lib:pickDir 模式）、状态行（pending/errors）、「重建索引」按钮（vault:rebuild）、「迁移到 vault」按钮（vault:migrate，P2 Task 9 提供后接线）。preload.ts 补 API。

### Task 9 vaultMigrate 导出 [P2]
- 遍历 listPapers 全量 + 每篇全资产 → sidecar；PDF 复制 userData/pdfs/<id>.pdf→vault/papers/<key>/paper.pdf（存在才复制，sha256 计算）；dual/mono 同理；全局 flashcards.jsonl/profile.md/topics/；报告 {papers, files, bytes, errors}。
- e2e：种子 2 篇论文全资产类型 → migrate → 断言文件树 + meta 字段。

### Task 10 vaultRebuild 导入 [P2]
- 读 vault 全部 sidecar → 显式 legacy_id 插入空库（重建系列函数）；blocks 不重建（B 级，见约束）；digest 令牌照原文恢复；report 行数统计。
- 单测 round-trip（serialize→parse→显式插入内存库→读出比对）；e2e。

### Task 11 vaultReconcile 对账 [P2]
- migrate→临时目录建临时库→rebuild→逐表行数对比 + papers/highlights/notes/qa/translations/flashcards/topics 抽样字段比对 + 全部 digest resolveCites 令牌命中校验 → report {ok, checks[]}。
- e2e 全绿断言。

### Task 12 启动引导 [P2]
- main.ts：DB 文件不存在（首次启动/被删）且 vault_dir 配置且 vault 有 meta.yaml → 自动 vaultRebuild + 状态事件；IPC `vault:rebuild`（Settings 按钮也用）。
- e2e：跑完 Task 6 的 e2e 后删 DB 文件重启（第二个 electron 进程，独立 userData）→ 断言数据完整。

### Task 13 proto-vault 升格 [P2]
- migrate 时若 settings.repo_path 存在：glossary/ 目录复制到 vault（不存在才建）；notes/papers/*.md 中匹配 arxivId 的历史内容以追加区并入对应论文 notes.md 尾部（`<!-- imported-from-repo -->` 定界，只增不删）。
- e2e：构造 repo 结构断言并入。

### Task 14 收尾 [P2]
- README 存储章节、DEVELOPMENT.md vault 约定（SQL 只在 db.ts；sidecar 序列化只在 vault.ts；新表须进重建路径）；`npm run test:all` 全量回归；提交；切分支 feat/vault-sync。

## 明确约束（重建语义）

- blocks 是 B 级派生数据不进 vault；rebuild 后 blocks 为空 → 阅读器走「重新导入」路径（importPaperCore 的 upgrade 流程），译文按 src_hash 重挂（Task 7 已修）。MVP 接受此限制并在 README 说明。
- providers/settings（除 read:*）不进 vault——密钥永不离开本机。
