import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * 前端工程（React + antd）。开发期由 vite 提供 :5173 并把 API/WS 代理到 :3000；
 * 生产构建产物落在 web/dist，由 Fastify 单端口托管（architecture.md §3）。
 */
export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
})
