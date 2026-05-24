import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@cashflow/shared': path.resolve(__dirname, '../shared/api-types.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        // jsdom v26 requires a non-opaque origin for localStorage / sessionStorage to
        // be available. The default vitest URL is already http://localhost:3000 but we
        // set it explicitly here for clarity.
        url: 'http://localhost',
      },
    },
    // vitest's populateGlobal does not forward Window.prototype getters (like
    // localStorage) to the test global. vitest.setup.ts manually binds them.
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
