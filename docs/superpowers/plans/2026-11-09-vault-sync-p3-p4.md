# Vault 同步 P3+P4 实施计划（feat/vault-sync 分支）

> 承接 [2026-11-08-vault-storage-p1-p2.md](2026-11-08-vault-storage-p1-p2.md)（已全部落地）。P1+P2 提交链在 `feat/pdf2zh-reading`，P3+P4 在 `feat/vault-sync`。

**Goal:** P3 把 vault 变成 git 同步的知识库（桌面端 obsidian-git 路径）；P4 提供 GitLab Pages 上的只读 Web 阅读端 + 标注回写 MVP。

**核心决策：**
- git agent 用 `simple-git`（obsidian-git 验证过的路径），包装层可注入 fake 便于单测
- 冲突策略：DB 是本地权威。rebase 失败 → abort → 冲突文件取远端（`checkout --theirs`）+ 本地副本存 `<name>.conflict.<device>.<ts>` + 本地写重新入队 → 重提交 → push
- 行级删除不同步（文档化限制）：同步只做「文件→DB」的 upsert 与整目录删除
- dry_run 默认开（只 commit 不 push），首次成功 push 后提示可关闭

## P3 任务（15-22）

### Task 15 SyncService 骨架
- `electron/sync-agent.ts`：`GitAgent` 接口（exec 可注入）；`detectEnvironment()`：git 可用性/vault 是否 init/远端配置
- 设置键：`vault_sync.remote_url/push_enabled/dry_run`（settings 表，非 vault 资产）
- IPC：`sync:status/getConfig/setConfig`
- 单测：tmp 真实 repo 离线跑（系统 git）

### Task 16 git agent 核心
- `ensureRepo()`：init + identity `paper-reader-<hostname>` + .gitignore 校验
- `commitAll(message)`：status→add→commit；message 约定 `deposit: <动作> <paperKey>`
- 单测：tmp repo 断言 commit 存在、二进制 PDF 正常入库

### Task 17 防抖调度
- `SyncScheduler`：写事件 → dirty → 90s 静默提交；启动 pull；5min 轮询；before-quit flush（与 vault sink flush 协调）
- fake timer 单测

### Task 18 pull→rebase→push
- `syncOnce()`：commit 本地 → pull(rebase) → push；冲突按上述策略
- 双 tmp repo 制造冲突的离线单测（bare repo 做远端，两个 clone 做两设备）

### Task 19 vault-import 增量导入
- `electron/vault-import.ts`：pull 后 `git diff --name-status HEAD~1` 变更集 → 解析 sidecar → upsert DB（按 legacy_id/sid）
- 整篇论文目录删除 → 级联删 DB
- round-trip 单测

### Task 20 同步状态 UI
- Settings vault 区：状态条（未配置/干净/待推送/同步中/冲突/离线）+「立即同步」按钮 + 冲突文件列表
- `*.conflict.*` 不入 git（.gitignore 已含）

### Task 21 干跑模式 + LFS 顾问
- dry_run 默认 true；首次成功 push 后 toast 提示
- vault PDF 总量 >5GB 时提示 LFS（只提示 + 文档链接）

### Task 22 P3 回归
- 双 repo 两设备 e2e：A 写→push→B pull→B 的 DB 出现 A 的划线
- test:all 全量

## P4 任务（23-28）

### Task 23 web/ 脚手架
- `web/{package.json,vite.config.ts,index.html,src/}`：Vite+React+TS 零后端 SPA，独立工程
- 根 .gitignore 增 `web/node_modules`、`web/dist`

### Task 24 PAT 认证
- 首屏：GitLab host + PAT + projectId（localStorage 按设备存）
- `/user` + `/projects/:id` 校验；401/403 处理

### Task 25 vault 只读层
- tree API 列 `papers/`；并行 raw fetch meta.yaml → 论文列表（状态/标签/进度）；内存缓存

### Task 26 阅读页
- translations.jsonl 双语流渲染（en+zh 都在文件内）
- notes/qa/annotations 按 seq 锚挂载；digest.md 精炼卡
- H/N/Q 令牌 → 同文件 seq 锚点跳转；PDF 外链 raw URL（MVP 限制）

### Task 27 标注回写
- 划选英文 → fetch annotations.json → merge → POST Commits API（action: update）
- 乐观 UI + 失败回滚；单人使用可接受行级并发丢更新（文档化）

### Task 28 P4 收尾
- `web/src/vault-format.ts` 与 electron/vault.ts 格式对齐测试（同 fixture 双侧 round-trip）
- GitLab Pages 部署文档 + README web 章节

## 约束

- 遵守 DEVELOPMENT.md vault 规范（SQL 只在 db.ts、序列化只在 vault.ts、新写函数发 hook）
- git 失败绝不阻塞 App；网络错误静默降级为离线状态
- web/ 完全独立：不 import 根工程代码，格式对齐靠 fixture 测试保证
