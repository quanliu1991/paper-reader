# pdf2zh 验证笔记（feat/pdf2zh-reading）

日期：2026-11-07　环境：macOS（Mac Studio）、uv + Python 3.12、默认 Provider：智谱 BigModel（glm-5.3-flash，OpenAI 兼容）

## 目的

当前对照阅读（DualPdfView）是"左 PDF canvas + 右 HTML 译文流"分栏 + ~280 行启发式滚动同步，对齐是反复修复的痛点。
pdf2zh 的路线：直接重排生成保留版式的双语 PDF（每段原文下紧跟译文，公式/图表/目录保留），单一滚动流，同步问题根源消失。

## 集成方式（本分支已落地）

- `electron/pdf2zh.ts`：独立模块。spawn CLI 子进程（`~/.local/bin/pdf2zh`），默认 Provider 注入 `OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL` 环境变量（key 不落盘），产物从 tmp 目录归位到 `userData/pdfs/<paperId>-dual.pdf` + `-mono.pdf`，路径记入 `papers.dual_pdf_path`。
- IPC：`pdf2zh:status / translate / cancel` + 推送 `pdf2zh:progress|done|error`。
- 渲染层：`Pdf2zhView.tsx` 复用 pdf.js canvas 管线加载 `local-pdf://p/<paperId>-dual`（协议零改动），工具栏新增「双语版式」模式按钮 + 生成入口 + 日志条。
- AGPL 合规：CLI 子进程进程边界隔离，本仓库不包含其源码。

## CLI 验证（3 篇真实论文）

| # | 论文 | 页数 | 用时 | 版式保留 | 字体 | 译文质量 | 备注 |
|---|------|-----|------|---------|------|---------|------|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |

核对标准：公式/图表/双栏/脚注位置保留；中文无豆腐块；译文质量 ≥ 站内段落翻译（同服务）；速度可接受。

## 应用内对比（同论文双模式并读）

- 双语版式 vs PDF 阅读（分栏同步）：
- 双语版式 vs 对照/双语（HTML 流）：

## 结论与决策

（验证后填写：是否基于 pdf2zh 深度集成——划线问答在 dual.pdf 上运行、逐步替代旧分栏同步代码；或关闭分支）
