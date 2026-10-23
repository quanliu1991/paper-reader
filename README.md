# Paper Reader

论文阅读桌面 App：arXiv 导入、中英对照阅读、划线提问、知识沉淀。科研人员的「一个下午读完一篇论文」工具。

## v0.2 功能

### 阅读（专业级解析）
- arXiv HTML 导入，LaTeXML `alttext` 提取 LaTeX 公式，KaTeX 渲染（行内 `$...$` / 块级 `$$...$$`）
- 论文图表自动下载本地缓存，点击放大
- 双栏对照 / 仅原文 / 仅译文（Ctrl+Shift+L 循环切换）
- 阅读进度记忆、字号调节、栏宽切换、沉浸模式（Ctrl+Shift+F）
- 暗色模式跟随系统

### AI 层（豆包式对话流）
- **Triage 摘要卡**：导入后自动生成「一句话/问题/方法/结果/与已读关联」，列表页信息卡流展示
- **分节通读摘要**：按章节生成 2-3 句概要（阅读页顶部）
- **划线提问**：回答标注【段落 #N】依据，可点击跳转定位；追问芯片（详细解释/举个例子/换个说法/这篇的局限）
- **术语一致性校验**：翻译后抽查术语译法与 glossary 冲突
- LLM 多厂商：OpenAI / Anthropic / GLM / DeepSeek / Qwen / Ollama / vLLM 自部署；Key AES-256-GCM 加密

### 知识沉淀
- 高亮四色划线（飞书式划词工具条：高亮/复制/提问/闪卡/译此段）
- 闪卡 + SM-2 间隔复习（今日到期卡片复习流，AI 可代生成答案）
- BibTeX 一键导出
- 知识库仓库连接（`D:\paper`）：读 `.fulltext`/术语表，问答写回笔记 ❓ Q&A 节（只追加），阅读摘要导出为 markdown 笔记

### 效率与稳定
- 命令面板 Ctrl+K（搜论文/段落/动作，飞书式）
- toast 轻提示、骨架屏、微动效
- IPC 统一错误结构、翻译可取消、导入串行队列防写锁
- 验收体系：解析 fixtures 回归 + E2E 黄金路径 + soak 内存监控

## 快捷键

| 键 | 功能 |
|---|---|
| Ctrl+K | 命令面板 |
| Ctrl+Shift+L | 切换 原文/对照/译文 |
| Ctrl+Shift+K | 问答侧栏 |
| Ctrl+Shift+F | 沉浸模式 |

## 开发

```bash
npm install
npm run electron:dev
```

## 测试（外部裁判体系）

```bash
node tests/fixtures.test.mjs   # 解析回归（多论文形态快照断言）
node tests/e2e.test.mjs        # E2E 黄金路径（导入→划线→闪卡→SM-2→持久化）
node tests/soak.test.mjs       # 稳定性（30 轮导入+300 次读取，内存增长 <30%）
```

## 打包

```bash
npm run electron:build   # release/ 下 NSIS 安装包
```

Mac：`package.json` 已预留 dmg 配置，需在 macOS 构建（原生模块 ABI）。

## 架构

- **Renderer**（React + zustand）：列表卡流 / 阅读视图（KaTeX/同步滚动）/ 问答侧栏 / 复习页 / 命令面板
- **Main**（Electron）：arXiv 解析器（alttext+图表）、SQLite（papers/blocks/translations/highlights/qa/summaries/flashcards）、LLM 流式层、知识库桥、`local-figure://` 协议
- **IPC**：统一 `{ok, data, error, hint}` 结构，contextIsolation 安全隔离
