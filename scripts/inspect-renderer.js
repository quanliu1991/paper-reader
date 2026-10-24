// 检查运行中窗口的实际渲染状态（通过 E2E 同款 executeJavaScript 不可用于生产窗口，
// 这里用 win.webContents.executeJavaScript 需在主进程 —— 改为 devtools protocol 不现实。
// 简化：重启一个 E2E 窗口连用户真实库，打开用户最近的论文截图。）
