import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@modules': path.resolve(__dirname, './src/modules'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@types': path.resolve(__dirname, './src/types'),
    },
  },
  server: {
    port: 1420,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'companion-toast': path.resolve(__dirname, 'companion-toast.html'),
        'translate-toast': path.resolve(__dirname, 'translate-toast.html'),
        'voice-toast': path.resolve(__dirname, 'voice-toast.html'),
        'memo-sticky': path.resolve(__dirname, 'memo-sticky.html'),
        // 临时：release 产物渲染验证页（排查用，验证后移除）
        'dev-cm-spike': path.resolve(__dirname, 'dev-cm-spike.html'),
      },
    },
  },
})
