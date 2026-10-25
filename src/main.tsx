import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useStore } from './store';
import './styles.css';
import 'katex/dist/katex.min.css';

// E2E 驱动钩子：暴露 store（仅测试用，生产无副作用）
(window as any).__store = useStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
