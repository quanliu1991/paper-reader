# 质量仪表盘（QUALITY.md）

> 自动生成 by improve-loop --report · 2026-11-03T18:35:51.743Z

## 总览

| 指标 | 值 |
|---|---|
| 测试通过率 | 11/13 |
| 未解决问题 | 3（high 2 / medium 0 / low 1） |
| 已解决 | 9 |
| 问题来源 | test:2 · lint:1 |

## 未解决问题（按优先级）

- **[high]** 测试层失败：interact-ui（命令面板/复习/问答/设置 UI）（`test-fail-node-tests-interact-ui-e2e-test-mjs`，test，出现 1 次）—— settings key masked: PASS | E2E ALL PASS |  | [interact-ui] 1 FAILURES
- **[high]** 测试层失败：uex（用户旅程全流程）（`test-fail-node-tests-uex-e2e-test-mjs-timeout-240000`，test，出现 1 次）——   ✅ 论文卡显示「读至 X%」+ 进度条 | E2E FAIL |  | [uex-e2e] FAIL
- **[low]** 组件内硬编码色值（`lint-hex-src/components/NotesView.tsx:9`，lint，出现 1 次）—— const HL_BAR: Record<string, string> = { yellow: '#e6c84a', green: '#7dcea0', blue: '#85b7eb', pink: '#f0a3bd' };

## 已解决

- ✅ 测试层失败：guard（视觉门禁）（`test-fail-node-tests-visual-guard-test-mjs`，2026-10-31 → 2026-11-01）
- ✅ 真实用户库被 fake-LLM 种子译文污染（inspect 未隔离 + fake 无打包守卫）（`real-db-fake-llm-pollution`，2026-11-01 → 2026-11-01）
- ✅ 非 PDF 视图图表全不显示（object SVG 解析缺口 + 版本化 URL 404 + 表格假占位）（`fig-object-svg-not-rendered`，2026-11-01 → 2026-11-01）
- ✅ 视觉异常：guard-both（`visual-guard-both`，2026-10-31 → 2026-11-01）
- ✅ 视觉异常：03-ask-panel（`visual-03-ask-panel`，2026-10-31 → 2026-11-01）
- ✅ 视觉异常：02-reader-dual（`visual-02-reader-dual`，2026-10-31 → 2026-11-01）
- ✅ 视觉异常：02-reader-zh（`visual-02-reader-zh`，2026-10-31 → 2026-11-01）
- ✅ 视觉检验未覆盖 PDF 真实渲染截图（图表/公式可见性盲区）（`vision-coverage-pdf-screens`，2026-11-01 → 2026-11-01）
- ✅ 测试层失败：dedup-scroll（滚动同步 UI）（`test-fail-node-tests-dedup-scroll-test-mjs`，2026-10-31 → 2026-11-01）

## 最近审计历史

- 2026-11-03T18:35 audit: +3 new / 3 total signals
- 2026-11-02T18:35 audit: +0 new / 0 total signals
- 2026-11-01T18:33 audit: +0 new / 0 total signals
- 2026-11-01T16:43 release-final: all open findings closed, v0.4.0 release-ready
- 2026-11-01T10:39 close 2 findings: scroll-sync root cause fixed in c1e386b
- 2026-11-01T00:27 audit: +0 new / 3 total signals
- 2026-11-01T08:23 close 2 env-conflict misreports (residual electron during nightly); nightly pre-clean added
- 2026-10-31T18:33 audit: +1 new / 2 total signals
- 2026-11-01T01:51 release-audit: 4 visual findings closed (3 misreport rules + 1 real layout fix); pollution incident fixed
- 2026-11-01T01:18 fix+verify: fig-object-svg-not-rendered closed (round 4)
