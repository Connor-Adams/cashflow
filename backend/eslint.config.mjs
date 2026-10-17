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
  // Tests are intentionally excluded so they may use console for debugging: the
  // integration suite lives in test/** (outside this config's `src` target), and
  // unit tests are colocated as src/**/*.test.ts, which this rule must skip.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-console': 'error',
    },
  },
])
