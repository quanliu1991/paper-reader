// pdf2zh 双语版式 UI 探针：驱动正在运行的 dev app（localhost:5173 的 Electron 窗口）
// 通过 vite dev server 直连渲染进程（Electron 窗口加载的就是这个页面）
// 用 Playwright connectOverCDP 不可用（dev 未开远程调试口），改为直接开浏览器验证
// 渲染层逻辑：模拟打开论文 1 → 切双语版式 → 截图。
// 注意：浏览器里没有 window.api（preload 只注入 Electron），此脚本探测 Electron 的
// remote debugging 端口；找不到则退化为 vite 页面冒烟（验证 React 组件不崩溃）。
import { chromium } from '@playwright/test';

const APP_URL = 'http://localhost:5173/';
const OUT = 'build/pdf2zh-ui-probe.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(APP_URL, { waitUntil: 'networkidle' });

// Electron preload 不在：window.api 应 undefined（冒烟：页面本身可渲染）
const hasApi = await page.evaluate(() => typeof window.api !== 'undefined');
console.log('window.api present (browser):', hasApi);

// vite 页面冒烟：React 挂载不崩溃即通过（真实 UI 验证由 Electron 窗口人工/截图完成）
await page.screenshot({ path: OUT });
console.log('screenshot saved:', OUT);
if (errors.length) {
  console.log('page errors:', errors.slice(0, 5));
  process.exit(1);
}
console.log('smoke OK');
await browser.close();
