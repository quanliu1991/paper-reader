import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useStore } from './store';
import './styles.css';
import 'katex/dist/katex.min.css';
// 中文字体打包：Noto Serif SC 正文两字重（fontsource 分包 woff2，按 unicode-range 按需加载）
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/600.css';
import { preloadZhFonts } from './font-preload';

// 应用启动即预载中文字体（译文首屏渲染前就绪，避免闪系统字体）
preloadZhFonts();

// E2E 驱动钩子：暴露 store（仅测试用，生产无副作用）
(window as any).__store = useStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
