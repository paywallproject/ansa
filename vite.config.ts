import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = `http://localhost:${process.env.PORT || 3000}`

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: { '/api': { target: apiTarget, changeOrigin: false }, '/mcp': apiTarget },
  },
})
