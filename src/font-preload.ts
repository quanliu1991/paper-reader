// 中文字体预加载：fontsource 按 unicode-range 分包懒加载，译文 DOM 出现前不会请求。
// 显式 load 常用区间（CJK 基本区 + 标点），避免首屏译文闪 SimSun。
export async function preloadZhFonts(): Promise<void> {
  const probes = [
    '400 16px "Noto Serif SC"',
    '700 16px "Noto Serif SC"',
    '400 16px "Noto Sans SC"',
    '600 16px "Noto Sans SC"',
  ];
  const samples = ['译文字体预加载测试', '论文阅读', '，。；：', 'ABC abc 123'];
  try {
    await Promise.all(probes.map(p =>
      Promise.all(samples.map(s => (document as any).fonts.load(p, s).catch(() => {})))
    ));
  } catch { /* 字体加载失败静默降级系统字体 */ }
}
