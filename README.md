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
2. 点击卡片进入阅读器，三种模式（Ctrl+Shift+L 循环）：
   - **对照**：左英右中双栏，行级网格对齐，点行联动高亮
   - **PDF 阅读**：原版 PDF 单栏展示，译文按原文行距**原位覆盖**，顶部「中文/英文」一键切换；滚到哪自动翻到哪
   - **译文**：纯中文学术排版（宋体衬线、首行缩进、KaTeX 公式）
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
| Ctrl+Shift+L | 循环切换 对照/PDF/译文 |
| Ctrl+Shift+K | 问答侧栏 |
| Ctrl+Shift+F | 沉浸模式（Esc 退出） |

## 打包

```bash
npm run electron:build   # Windows NSIS 安装包 → release/
```

Mac：`package.json` 已配 dmg target，需在 macOS 上构建（better-sqlite3 原生模块 ABI）。

## 测试

```bash
node tests/fixtures.test.mjs        # arXiv 解析回归（fixtures 快照断言）
node tests/translate-qc.test.mjs    # 翻译 QC + 提示词（离线）
node tests/e2e.test.mjs             # E2E 黄金路径（导入→划线→闪卡→SM-2→持久化）
node tests/topic-graph.test.mjs     # 主题依赖库分层/排序（离线单元）
node tests/topic-e2e.mjs            # 主题构建真实网络 E2E（arXiv + S2）
node tests/pdf-ui-e2e.test.mjs      # PDF 视图 UI E2E（真实窗口 + 字体断言）
node tests/topic-ui-e2e.test.mjs    # 主题库 UI E2E（真实窗口全流程）
node tests/soak.test.mjs            # 稳定性（30 轮导入+300 读，内存增长 <30%）
```

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
  preload.ts              # contextBridge API（{ok,data,error,hint} 统一结构）
src/                      # 渲染层（React + zustand）
  components/Reader.tsx          # 阅读器壳（模式切换/划词/工具栏）
  components/DualPdfView.tsx     # PDF 原位翻译视图（canvas+译文层+按需翻译）
  components/TranslateView.tsx   # 双栏对照视图
  components/TopicView.tsx       # 主题依赖库页
  components/PaperList.tsx       # 论文库卡片流
  components/Review.tsx          # 闪卡复习
  components/Settings.tsx        # Provider/仓库/偏好设置
  components/CommandPalette.tsx  # Ctrl+K 命令面板
```

- **IPC**：统一 `{ok, data, error, hint}` 返回，contextIsolation + nodeIntegration:false 安全隔离
- **导入队列**：串行链防 SQLite 写锁；翻译并发 3 + 可取消（AbortController 生命周期挂在 app before-quit）
- **字体**：@fontsource 分包 woff2 按 unicode-range 懒加载，启动时 `font-preload.ts` 显式预载 CJK 常用区间

## 数据与隐私

- 全部数据本地存储：`%APPDATA%/paper-reader-app/`（SQLite + PDF/图表缓存）
- LLM 仅在翻译/摘要/问答时调用你配置的 Provider，无遥测
