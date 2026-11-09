# Paper Reader

论文阅读桌面 App：arXiv 导入、中英对照阅读（PDF 原位翻译）、划线提问、主题依赖库、知识沉淀。科研人员的「一个下午读完一篇论文」工具。

技术栈：Electron 33 + React 18 + zustand + better-sqlite3 + pdfjs-dist + KaTeX + Vite 6 + TypeScript 5。

## 快速开始

```bash
npm install          # 安装依赖（含原生模块 better-sqlite3，需 Node 20+ 与构建工具链）
npm run electron:dev # 开发模式（vite dev server + electron 热加载）
```

首次使用：左侧栏 → 设置 → 添加 LLM Provider（OpenAI / Anthropic / GLM / DeepSeek / Qwen / Ollama / vLLM 自部署均可，Key 用 DPAPI/AES 加密落盘）。配置后即可导入论文并翻译。

## 使用说明

### 论文导入与阅读
1. **论文库**页顶部输入框：粘贴 arXiv ID（如 `2609.34683`）或链接，回车导入。导入自动完成：解析正文（LaTeXML HTML，公式转 LaTeX）、下载图表、下载 PDF、生成 AI 摘要卡（一句话/问题/方法/结果）。
2. 点击卡片进入阅读器，三种模式（Ctrl+Shift+L 循环，v3 布局收敛）：
   - **智能对照（默认）**：文本行级网格秒开（左英右中，点行联动高亮），原版 PDF 就绪后自动升级为原位对照
   - **中**：纯中文学术排版（宋体衬线、首行缩进、KaTeX 公式）
   - **英**：纯英文原文
3. 阅读进度自动记忆；字号、栏宽可调；沉浸模式 Ctrl+Shift+F。

### 翻译
- 点「翻译全文」批量翻译；PDF 模式下滚动到可见页面自动按需翻译。
- 翻译引擎上下文感知：论文元信息 + 章节标题链 + 摘要 + 前文译文 + 后文原文 + 全篇术语表注入提示词。
- QC 自动质检五项：公式完整性、数字与单位换算（`64x`↔`64倍`）、长度比、未译残留、包裹符越界。不合格自动带问题重译一次。
- 译文字体统一打包 Noto Serif SC（正文）/ Noto Sans SC（标题），任何机器渲染一致。

### 划线与提问
- 划选文字弹出工具条：**解释 / 搜索 / 翻译**（行内浮层即答）、四色高亮、复制、提问、存闪卡。
- 提问回答标注【段落 #N】依据，可点击跳转定位；支持追问芯片（详细解释/举个例子/换个说法/这篇的局限）。

### 主题依赖库（新）
输入主题关键词（如 `speculative decoding`），自动：
1. arXiv 按相关性搜索 20 篇种子论文
2. Semantic Scholar 拉引用图（高引种子的被引 + 引用双向扩展）
3. 相关性过滤（标题命中查询词，全局高引地基论文豁免）
4. 分层：**地基**（领域早期奠基，被图内大量依赖）→ **核心**（图内被引最高）→ **桥梁**（引用多方且被引）→ **前沿**（近两年新作）
5. 按层生成推荐阅读顺序（地基年代升序在前，前沿新作殿后）

每篇可一键导入论文库（含翻译/摘要全流程）或直达 arXiv。

### 知识沉淀
- **闪卡 + SM-2 间隔复习**：划线存卡，复习页每日到期流，AI 可代生成答案背面。
- **BibTeX 导出**：论文库一键导出 `.bib`。
- **知识库仓库连接**（设置 → 仓库路径，如 `D:\paper`）：读取 `.fulltext` 全文缓存与术语表；问答写回笔记 ❓ Q&A 节（只追加）；阅读摘要导出为 markdown 笔记。
- **翻译版 PDF 导出**：学术排版 + 图表内联，可直接分享。

## 快捷键

| 键 | 功能 |
|---|---|
| Ctrl+K | 命令面板（搜论文/段落/动作） |
| Ctrl+Shift+L | 循环切换 智能对照/中/英 |
| Ctrl+Shift+K | 问答侧栏 |
| Ctrl+Shift+F | 沉浸模式（Esc 退出） |

## 打包

```bash
npm run electron:build   # Windows NSIS 安装包 → release/
```

### Mac（macOS 12+，Apple Silicon 或 Intel）

Windows 上打出的安装包**不能**给 Mac 用（`better-sqlite3` 是原生模块，必须在本平台编译）。两种方式：

**方式一：Mac 上从源码构建（推荐，可控可更新）**

```bash
# 1. 装 Node 20+（推荐 nvm：brew install nvm && nvm install 20）
# 2. 克隆仓库
git clone https://github.com/quanliu1991/paper-reader.git
cd paper-reader
# 3. 安装依赖（原生模块自动按本机架构编译）
npm install
# 4. 打 DMG 安装包 → release/ 目录，双击安装
npm run electron:build
```

Apple Silicon（M1/M2/M3/M4）打 arm64 包；Intel 机打 x64 包，electron-builder 按 `process.arch` 自动选。

**方式二：不打包直接开发模式跑**

```bash
npm install
npm run electron:dev    # 起开发窗口，日常阅读够用
```

**首次打开注意（macOS Gatekeeper）**：未签名/未公正（无 Apple 开发者账号）的 app 首次打开会被拦，右键 app →「打开」→ 再点「打开」；或系统设置 → 隐私与安全性 → 「仍要打开」。代码本身全平台兼容（Key 加密用 AES-GCM 随机主密钥而非 Windows DPAPI，数据目录在 `~/Library/Application Support/paper-reader-app/`）。

**方式三：让 Windows 机器交叉构建 Mac 包**——需要 Mac 签名/公正环节，没有 Apple 开发者账号意义不大，不推荐；有需要再补 CI（GitHub Actions macos-latest 出包）。

### 快捷键在 Mac 上

| Win/Linux | Mac | 功能 |
|---|---|---|
| Ctrl+K | Cmd+K | 命令面板 |
| Ctrl+Shift+L | Cmd+Shift+L | 循环切换 智能对照/中/英 |
| Ctrl+Shift+K | Cmd+Shift+K | 问答侧栏 |
| Ctrl+Shift+F | Cmd+Shift+F | 沉浸模式（Esc 退出） |

## 测试

```bash
node tests/fixtures.test.mjs        # arXiv 解析回归（fixtures 快照断言）
node tests/translate-qc.test.mjs    # 翻译 QC + 提示词（离线）
node tests/highlight.test.mjs       # 划线高亮渲染（离线）
node tests/pdf-align.test.mjs       # PDF 行对齐（离线）
node tests/digest.test.mjs          # 精炼笔记材料组装（离线）
node tests/reader-profile.test.mjs  # 读者画像策略（离线）
node tests/fig-listing.test.mjs     # 图表提取（离线）
node tests/e2e.test.mjs             # E2E 黄金路径（导入→划线→闪卡→SM-2→持久化）
node tests/uex-e2e.test.mjs         # 用户旅程全流程 UI E2E（导入→阅读→翻译→划线提问→高亮笔记→闪卡复习→沉淀→管理→进度）
node tests/topic-graph.test.mjs     # 主题依赖库分层/排序（离线单元）
node tests/topic-e2e.mjs            # 主题构建真实网络 E2E（arXiv + S2）
node tests/pdf-ui-e2e.test.mjs      # PDF 视图 UI E2E（真实窗口 + 字体断言）
node tests/topic-ui-e2e.test.mjs    # 主题库 UI E2E（真实窗口全流程）
node tests/server-api.test.mjs      # 团队服务端全 API round-trip
node tests/team-ui-e2e.test.mjs     # 团队功能 UI E2E（server + vite + 真实窗口）
node tests/split-ui-e2e.test.mjs    # 原版对照 UI E2E（像素同步/划线双边）
node tests/vault-unit.test.mjs      # vault 写穿层离线单元（sink/序列化/处理器）
node tests/vault-sync.test.mjs      # git 同步 agent 离线单测（裸仓库 pull/rebase/push）
node tests/vault-format-align.test.mjs  # desktop↔web 序列化格式对齐
```

全量回归：`npm run test:all`（27 层：离线单元 → 主进程 e2e → UI e2e → 视觉门禁；含团队功能与 vault 全链路）。`npm run test:all:full` 追加 soak/PDF 真实下载/主题真实网络/翻译质量/真实库图表验证。

测试规范详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 架构

```
electron/                 # 主进程
  main.ts                 # 入口：窗口/协议(local-figure,local-pdf)/IPC 注册/E2E 分支
  arxiv.ts                # arXiv 抓取解析（LaTeXML alttext 公式 + 图表 + 去噪）
  db.ts                   # SQLite（papers/blocks/translations/highlights/qa/summaries/flashcards/topics）
  translate.ts            # 翻译引擎：上下文提取 + 提示词 + QC 质检
  topic-graph.ts          # 主题依赖库：搜索/图扩展/分层/排序
  llm.ts                  # 多厂商 LLM 流式层
  github-bridge.ts        # 知识库仓库桥（读写笔记/术语表/全文缓存）
  vault-sink.ts           # vault 写穿队列（合并去脏/journal 崩溃恢复/毒丸隔离）
  vault.ts                # vault 文件格式序列化（meta/标注/笔记/问答/译文/闪卡，唯一权威）
  vault-wiring.ts         # 事件→sidecar 全量重序列化处理器（幂等/原子写）
  vault-init.ts           # 启动接线（hook 注册/vault_dir 持久化/启动引导）
  vault-migrate.ts        # 迁移导出 + 索引重建 + 对账
  sync-agent.ts           # simple-git 封装（init/commit/pull-rebase/push + 冲突保真）
  vault-sync-service.ts   # 防抖调度（90s 静默提交 + 5min 轮询 + 退出 flush）
  vault-import.ts         # pull 后增量导入（diff → sidecar upsert → SQLite）
  preload.ts              # contextBridge API（{ok,data,error,hint} 统一结构）
web/                     # Web 阅读端（独立 Vite+React 工程，零后端）
  src/gitlab.ts           # GitLab REST（PAT/tree/raw/commits）
  src/vault-format.ts     # sidecar 解析（与 electron/vault.ts 对齐）
src/                      # 渲染层（React + zustand）
  components/Reader.tsx          # 阅读器壳（v3 三模式 smart/zh/en、划词、工具栏、原版对照升级）
  components/TranslateView.tsx   # 智能对照文本网格视图（行级对齐，smart 模式主体）
  components/SplitPdfView.tsx    # 原版对照视图（左原版 PDF + 右 mono 中文 PDF）
  components/TopicView.tsx       # 主题依赖库页
  components/TopicGraph.tsx      # 主题力导向 Canvas 图谱（分层着色）
  components/PaperList.tsx       # 论文库卡片流
  components/Review.tsx          # 闪卡复习
  components/KnowledgeView.tsx   # 知识沉淀页（笔记/问答/精炼）
  components/TeamView.tsx        # 实验室团队页（清单/组会/动态）
  components/Settings.tsx        # Provider/vault/仓库/账户/偏好设置
  components/CommandPalette.tsx  # Ctrl+K 命令面板
```

- **IPC**：统一 `{ok, data, error, hint}` 返回，contextIsolation + nodeIntegration:false 安全隔离
- **导入队列**：串行链防 SQLite 写锁；翻译并发 3 + 可取消（AbortController 生命周期挂在 app before-quit）
- **字体**：@fontsource 分包 woff2 按 unicode-range 懒加载，启动时 `font-preload.ts` 显式预载 CJK 常用区间

## vault 知识库（存储边界）

全部沉淀资产以**人类可读文件**写入本地 vault 文件夹——文件即事实源，SQLite 退化为可重建索引：

```
<vault>/
├── papers/<年份>-<arxivId>/     # 每篇论文一个文件夹
│   ├── paper.pdf / paper-dual.pdf / paper-mono.pdf
│   ├── meta.yaml                # 题录/状态/标签/进度（App 管辖区）
│   ├── annotations.json         # 划线（文本 + 坐标；sid/legacy_id 稳定）
│   ├── notes.md                 # 段落锚定笔记（<!-- note --> 定界，正文可外部编辑）
│   ├── qa.jsonl                 # 问答
│   ├── translations.jsonl       # 译文（src_hash 锚定，自带原文——Web 端可直接渲染）
│   └── digest.md                # 精炼笔记（【H12】【N3】【Q5】 引用令牌）
├── topics/<slug>.json           # 主题图谱
├── glossary/terms.yaml          # 术语表
├── flashcards.jsonl             # 闪卡 + SM-2 调度
└── profile.md                   # 读者画像
```

- **双写**：数据库每次写操作经 writeHook → 防抖队列 → 全量重序列化对应 sidecar（幂等、原子写）；写失败绝不阻塞 App
- **迁移**：设置 → vault 知识库 →「全量迁移到 vault」（含 PDF 复制与 proto-vault 历史笔记并入）
- **重建**：换设备/库损坏时，DB 缺失 + vault 存在 → 启动自动重建索引（整型 id 跨设备不变，精炼令牌零失效）
- **译文保护**：blocks 重解析按源文哈希重挂译文，孤儿译文保留不静默删除
- **限制**：blocks 解析表是派生数据不入 vault——重建后需重新导入原文（升级路径自动重挂译文）；providers/settings（密钥）永不离开本机

## Git 同步与 Web 阅读

vault 本身是 git 仓库——**文件即事实源，git 即传输层**：

- **同步**（设置 → vault 知识库）：填远端 URL，90s 静默防抖自动 commit+push，5min 拉取增量导入；冲突取远端 + 本地副本存 `*.conflict.<device>.<ts>`，桌面 DB 为本地权威自动重写回。dry-run 默认开（只 commit 不 push），PDF 总量 >5GB 提示 LFS。
- **Web 端**（`web/`）：手机/平板浏览器读 vault。GitLab Pages 静态部署，PAT 存浏览器本地直连 GitLab API；双语流阅读 + 段落锚挂载笔记/问答/划线 + 划选英文一键回写 `annotations.json`。部署见 [web/DEPLOY.md](web/DEPLOY.md)。

## 实验室团队（自托管）

师门共享阅读清单、组会排期、团队动态与共享术语表。服务端零依赖自托管（[server/README.md](server/README.md)）：

```bash
# 实验室任意服务器（Node ≥ 22.5）
cd server && node server.mjs        # 默认 :8787，数据单文件 SQLite
```

桌面端：设置 → 账户与团队 → 填服务器地址注册登录；侧栏「团队」页凭 8 位邀请码加入或创建团队。

- **阅读清单**：论文库卡片一键分享（含 arXiv ID，他人可一键导入）；认领 → 读完状态流转
- **组会排期**：排期 + 领读认领 + 挂接清单论文 + 会议笔记
- **动态**：谁在读什么（进度%）、认领/读完、组会变更、术语同步——一个流看全组
- **术语表**：vault `glossary/terms.yaml` 与团队双向同步（同名冲突保留本地并提示）
- **隐私边界**：只上报论文标题与进度百分比；划线/笔记/译文等 vault 资产永远留在本机；进度上报可在设置中关闭

## 数据与隐私

- 全部数据本地存储：`%APPDATA%/paper-reader-app/`（SQLite + PDF/图表缓存）
- LLM 仅在翻译/摘要/问答时调用你配置的 Provider，无遥测
