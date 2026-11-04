// 图表源工具：fig_path 的两种形态
//   1. 远端 URL（https://arxiv.org/html/.../fig1.png）——图表还在下载，未落地
//   2. 本地相对路径（<paperId>/fig-N.ext）——已下载，可走 local-figure:// 协议
// 渲染规则：只有本地落地形态才出 <img>；远端形态一律显示占位（防死链/破图）。
// 下载完成后主进程会 send('fig:updated') → store 更新 fig_path → 视图自动重渲染为真图。
export function figSrc(figPath: string | null | undefined): string | null {
  if (!figPath) return null;
  // 本地形态：数字/fig-N.ext（无协议头、无域名）
  if (/^\d+\/fig-\d+\.(svg|png|jpe?g|gif)$/i.test(figPath)) {
    // host 用 'f' 前缀：纯数字 host 会被 Chromium URL 解析成 IPv4（0.0.0.x）导致 404
    return `local-figure://f/${figPath}`;
  }
  return null;
}

// 远端 URL 或内联 SVG 还在落盘。没有路径说明原文就没有可下载的图，阅读页不该停在「下载中」。
export function figAwaiting(figPath: string | null | undefined): boolean {
  if (!figPath) return false;
  if (/^https?:/i.test(figPath)) return true;
  return figPath === 'inline:';
}
