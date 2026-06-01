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
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // vitest.setup.ts binds jsdom localStorage on globalThis (Node 26 workaround).
    // test-setup.ts wires @testing-library/jest-dom matchers.
    setupFiles: ['./vitest.setup.ts', './src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // `all` counts uncovered source files as 0% so the denominator is the
      // whole app, not just files a test happened to import.
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/test-setup.ts',
      ],
    },
  },
})
