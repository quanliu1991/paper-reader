import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 只负责 renderer 进程；Electron 主进程由 scripts/electron-build.mjs（esbuild）单独编译到 dist-electron/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
