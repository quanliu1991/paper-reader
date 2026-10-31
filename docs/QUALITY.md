# 质量仪表盘（QUALITY.md）

> 自动生成 by improve-loop --report · 2026-10-31T16:45:02.830Z

## 总览

| 指标 | 值 |
|---|---|
| 测试通过率 | 12/12 |
| 未解决问题 | 4（high 4 / medium 0 / low 0） |
| 已解决 | 2 |
| 问题来源 | visual-judge:4 |

## 未解决问题（按优先级）

- **[high]** 视觉异常：02-reader-zh（`visual-02-reader-zh`，visual-judge，出现 1 次）—— 译文模式多处段落仅显示『待翻译』占位符及模板说明文字（如“对应中文译文第 2 段…”），未呈现实际译文内容
- **[high]** 视觉异常：02-reader-dual（`visual-02-reader-dual`，visual-judge，出现 1 次）—— 右栏中文译文未正常生成，仅显示'研究指出：The optimization of LLM serving engines,……对应中文译文第 2 段…'等占位/错误说明文本
- **[high]** 视觉异常：03-ask-panel（`visual-03-ask-panel`，visual-judge，出现 1 次）—— 左下角问答侧栏浮层与第5段译文文本区域重叠，遮挡了部分正文内容。
- **[high]** 视觉异常：guard-both（`visual-guard-both`，visual-judge，出现 1 次）—— 右侧译文区全部显示'待翻译'占位且出现种子译文测试文本，译文未正常渲染

## 已解决

- ✅ 视觉检验未覆盖 PDF 真实渲染截图（图表/公式可见性盲区）（`vision-coverage-pdf-screens`，2026-11-01 → 2026-11-01）
- ✅ 测试层失败：dedup-scroll（滚动同步 UI）（`test-fail-node-tests-dedup-scroll-test-mjs`，2026-10-31 → 2026-10-31）

## 最近审计历史

- 2026-10-31T16:45 audit: +3 new / 3 total signals
- 2026-10-31T16:41 audit: +1 new / 1 total signals
- 2026-10-31T16:38 audit: +0 new / 0 total signals
- 2026-10-31T16:15 audit: +0 new / 0 total signals
- 2026-10-31T16:05 audit: +0 new / 0 total signals
- 2026-10-31T16:04 verify: closed test-fail-node-tests-dedup-scroll-test-mjs
- 2026-10-31T16:02 audit: +0 new / 0 total signals
- 2026-10-31T15:46 audit: +1 new / 1 total signals
