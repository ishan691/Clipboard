import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Runtime uploads/atomic renames are data, not frontend source. Watching locked
    // .partial files can crash Windows' filesystem watcher during a transfer.
    watch: { ignored: ['**/LiquidVault.Api/**', '**/.local/**', '**/tmp/**', '**/tests/**', '**/docs/**'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:5000', changeOrigin: false, timeout: 0, proxyTimeout: 0 },
      '/health': { target: 'http://127.0.0.1:5000', changeOrigin: false },
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
