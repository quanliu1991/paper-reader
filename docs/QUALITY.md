# 质量仪表盘（QUALITY.md）

> 自动生成 by improve-loop --report · 2026-10-31T17:51:26.802Z

## 总览

| 指标 | 值 |
|---|---|
| 测试通过率 | 12/12 |
| 未解决问题 | 0（high 0 / medium 0 / low 0） |
| 已解决 | 8 |
| 问题来源 | — |

## 未解决问题（按优先级）

（全部清零 🎉）

## 已解决

- ✅ 真实用户库被 fake-LLM 种子译文污染（inspect 未隔离 + fake 无打包守卫）（`real-db-fake-llm-pollution`，2026-11-01 → 2026-11-01）
- ✅ 非 PDF 视图图表全不显示（object SVG 解析缺口 + 版本化 URL 404 + 表格假占位）（`fig-object-svg-not-rendered`，2026-11-01 → 2026-11-01）
- ✅ 视觉异常：guard-both（`visual-guard-both`，2026-10-31 → 2026-11-01）
- ✅ 视觉异常：03-ask-panel（`visual-03-ask-panel`，2026-10-31 → 2026-11-01）
- ✅ 视觉异常：02-reader-dual（`visual-02-reader-dual`，2026-10-31 → 2026-11-01）
- ✅ 视觉异常：02-reader-zh（`visual-02-reader-zh`，2026-10-31 → 2026-11-01）
- ✅ 视觉检验未覆盖 PDF 真实渲染截图（图表/公式可见性盲区）（`vision-coverage-pdf-screens`，2026-11-01 → 2026-11-01）
- ✅ 测试层失败：dedup-scroll（滚动同步 UI）（`test-fail-node-tests-dedup-scroll-test-mjs`，2026-10-31 → 2026-10-31）

## 最近审计历史

- 2026-11-01T01:51 release-audit: 4 visual findings closed (3 misreport rules + 1 real layout fix); pollution incident fixed
- 2026-11-01T01:18 fix+verify: fig-object-svg-not-rendered closed (round 4)
- 2026-10-31T16:45 audit: +3 new / 3 total signals
- 2026-10-31T16:41 audit: +1 new / 1 total signals
- 2026-10-31T16:38 audit: +0 new / 0 total signals
- 2026-10-31T16:15 audit: +0 new / 0 total signals
- 2026-10-31T16:05 audit: +0 new / 0 total signals
- 2026-10-31T16:04 verify: closed test-fail-node-tests-dedup-scroll-test-mjs
- 2026-10-31T16:02 audit: +0 new / 0 total signals
- 2026-10-31T15:46 audit: +1 new / 1 total signals
