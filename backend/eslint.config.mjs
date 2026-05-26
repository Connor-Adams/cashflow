import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'

export default defineConfig([
  // Global linter options — suppress unused-disable warnings globally since we
  // intentionally load plugins without enabling all their rules.
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  // Load the typescript-eslint plugin so that existing inline
  // `// eslint-disable-next-line @typescript-eslint/*` comments are recognised
  // as valid directives (without enabling the underlying rules).
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
  },
  // Forbid console.* in src/ — use logger (pino) instead.
  // Tests (test/**) are intentionally excluded so they may use console for debugging.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
])
