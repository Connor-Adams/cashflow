import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  preview: {
    // Hosts vite preview will serve. Production runs `vite preview` behind
    // Railway, so every public hostname must be listed or vite returns
    // "Blocked request. This host is not allowed." `.up.railway.app` covers the
    // default Railway domains; `.connoradams.ca` covers the custom domains
    // (cashflow.connoradams.ca UI + api.cashflow.connoradams.ca).
    allowedHosts: ['.up.railway.app', '.connoradams.ca'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@cashflow/shared': path.resolve(__dirname, '../shared/api-types.ts'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
