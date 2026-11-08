import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitLab Pages 部署：项目仓库路径（如 user/papers → /user/papers/）
export default defineConfig({
  plugins: [react()],
  base: process.env.WEB_BASE ?? '/',
});
