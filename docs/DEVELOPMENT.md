# 开发规范（DEVELOPMENT.md）

面向本仓库的贡献者（含 AI 协作者）。目标：改任何一处，全量测试能在 5 分钟内给出可信判定。

## 目录职责

| 路径 | 职责 | 改动约束 |
|---|---|---|
| `electron/main.ts` | 窗口/协议/IPC 注册/E2E 分支 | IPC 一律 `wrap()` 包裹；新 IPC 同步更新 `preload.ts` |
| `electron/arxiv.ts` | arXiv 抓取与解析 | 解析器改动必须过 `tests/fixtures.test.mjs` |
| `electron/db.ts` | SQLite 全部表结构 + CRUD | 新表先加 `CREATE TABLE IF NOT EXISTS`（老库自动迁移）；禁止手写 SQL 散落其他文件 |
| `electron/translate.ts` | 翻译提示词 + QC | 提示词改动必须过 `tests/translate-qc.test.mjs`（含离线断言） |
| `electron/topic-graph.ts` | 主题依赖库引擎 | 纯函数部分（stratifyAndOrder）必须可离线单测 |
| `src/components/` | 渲染层组件 | 单组件单文件；禁止直接 `ipcRenderer`（走 `window.api`） |
| `src/store.ts` | zustand 全局状态 | 新 view 类型先扩 `View` 联合类型 |
| `tests/` | 测试（见下） | 新功能必须带测试；fixtures 只增不删 |
| `scripts/` | 构建/调试脚本 | `electron-build.mjs` 是打包链核心，慎改 |

## 命名与代码风格

- TypeScript strict；主进程 Node 侧代码不 import 渲染层，反之亦然（preload 是唯一桥）
- 组件文件 PascalCase；工具模块 camelCase；CSS 类前缀按组件缩写（`dpv-` DualPdfView、`tv-` TranslateView、`tp-` TopicView）
- 注释写「为什么」不写「是什么」；关键算法（对齐评分、分层阈值、QC 规则）必须在代码处说明原理
- 中文注释 OK；提交信息格式：`feat:/fix:/ui:/chore:/test: + 中文摘要`

## IPC 规范

```ts
// main.ts —— 统一 wrap，自动 {ok, data} / {ok:false, error, hint}
wrap('ns:action', async (_e, arg) => { ... });

// preload.ts —— 每个通道一个具名函数，事件订阅必须返回解绑函数
nsAction: (arg) => call('ns:action', arg),
onNsEvent: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('ns:event', l);
  return () => ipcRenderer.removeListener('ns:event', l); },
```

- 错误信息中文 + 可操作（「请到设置页…」），`hint` 字段给修复路径
- 长任务必须支持取消（AbortController 进 `activeAbort`，app 退出统一 abort）
- 进度用 `e.sender.send` 推送，不轮询

## 数据库规范

- 新表/新列：`CREATE TABLE IF NOT EXISTS` + `migrateColumns()` 模式（参考 blocks.fig_kind 迁移）
- 批量写必须 `d.transaction()` 包裹
- 外键 `ON DELETE CASCADE`，保证删论文不残留孤儿数据
- `data/index.json` 类多日累积文件只允许插入/追加，禁止全文件重写（对齐 D:\paper 知识库规范）

## 翻译引擎规范

- 提示词改动跑：`node tests/translate-qc.test.mjs`（20 项离线断言：铁律存在性、术语提取、QC 规则）
- QC 新规则加入 `qcTranslation` 时同步加测试用例（等价形式如 `64x`↔`64倍` 必须双向覆盖）
- 真实 LLM 验证（烧 token，手动）：`node tests/translate-quality.test.mjs`，QC ≥95 分才算过

## 测试规范

| 层 | 文件 | 要求 |
|---|---|---|
| 解析回归 | `fixtures.test.mjs` | fixtures 快照断言；新解析特性先抓真论文 HTML 入 `fixtures/` |
| 翻译离线 | `translate-qc.test.mjs` | 不依赖网络/LLM，秒级 |
| 引擎单元 | `topic-graph.test.mjs` | 纯函数离线测；网络部分单独放 `topic-e2e.mjs` |
| E2E 黄金路径 | `e2e.test.mjs` | 无窗口主进程级；覆盖导入→划线→闪卡→SM-2→持久化 |
| UI E2E | `pdf-ui-e2e.test.mjs` `topic-ui-e2e.test.mjs` | 真实窗口 + vite dev；断言 DOM 结构与 computed 样式（如字体一致性） |
| 稳定性 | `soak.test.mjs` | 30 轮导入 + 300 读；内存增长阈值 30% |

规则：
1. **改一处跑一层**：解析改 → fixtures；提示词改 → qc；IPC/DB 改 → e2e；UI 改 → 对应 ui-e2e；发版前全量。
2. UI E2E 注意：`.test.mjs` 只编译自己的 entry，**不含 main.ts**——改了 `electron/main.ts` 的 E2E 分支必须手动 `esbuild electron/main.ts` 后再跑（教训：2026-10 字体断言加错文件，跑了旧 main.js 假绿）。
3. E2E 环境变量（`PR_E2E`/`PR_PDF_UI_E2E` 等）可能从宿主 shell 泄漏到打包版——main.ts 已有「entry 不存在则忽略」守卫，新增 E2E 分支必须保持此模式。
4. 网络测试（topic-e2e）容忍 API 波动：单种子失败降级继续，只断言总量级（节点 ≥10、边 ≥5）。

## UI 规范

- 设计 token 统一走 CSS 变量（`--bg/--panel/--card/--accent/--border/--shadow-1/2/3`），禁止组件内写死色值
- 中文正文字体栈：`"Noto Serif SC", "Source Han Serif SC", "SimSun", serif` + `font-synthesis: none`（禁伪加粗）；打包字体走 `@fontsource`，新字重须在 `main.tsx` 引入并在 `font-preload.ts` 预载
- 长耗时操作必须有进度反馈（toast / 行内进度）；破坏性操作必须 confirm
- 阅读器内交互遵循「不打断阅读」：浮层就近出、Esc 可退、单栏优先

## Git 规范

- `master` 单线开发；每个功能/修复一个 commit（`feat:/fix:/ui:/chore:/test:`）
- **禁止**命令行裸 `git commit`（Cursor shell 注入 trailer，本机 git 2.24 不支持）；用 IDE 提交或脚本
- **禁止** force push；push 失败先 `pull --rebase`
- `build/` 里的截图是调试产物但已入库（历史依据），新截图继续放 `build/`，但**不要**提交 `dist/`、`release/`、`tests/.tmp-tg/`

## 已知陷阱（踩过的坑）

1. **E2E 环境变量泄漏**：宿主 `$env:PR_E2E="1"` 残留会让打包版静默无窗口——入口存在性守卫已修，新分支保持模式。
2. **打包时进程占用**：`Paper Reader.exe` 运行中会导致 electron-builder `Access is denied`——构建前 kill。
3. **local-pdf 协议纯数字 host**：`local-pdf://2` 被解析成 IPv4，必须用 path 段 `local-pdf://p/2`。
4. **fontsource 懒加载**：unicode-range 分包在 DOM 无中文时不请求字体——启动必须显式 `document.fonts.load()` 预载。
5. **SQLite upsert lastInsertRowid**：`ON CONFLICT DO UPDATE` 时不可靠，显式 `SELECT id` 查回。
6. **PDF 译文层依赖翻译完成顺序**：pageMap 对齐率约 82%，未对齐段落显示原文——测试断言用总量级不用精确数。
