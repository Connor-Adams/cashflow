import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Data-fetch on mount and controlled row reset are valid; rule is overly strict for these patterns.
      'react-hooks/set-state-in-effect': 'off',
      'no-restricted-syntax': [
        'error',
        {
          // Raw hex color literals in component code — use a var(--token).
          selector:
            "Literal[value=/#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\\b/]",
          message:
            'Off-palette hex color. Use a design token: var(--token) or a token-backed class.',
        },
        {
          // Arbitrary Tailwind color brackets, e.g. bg-[#fff], text-[rgb(...)].
          selector:
            "Literal[value=/(?:bg|text|border|ring|fill|stroke|from|to|via|decoration|outline|shadow|divide|accent|caret)-\\[(?:#|rgb|hsl)/]",
          message:
            'Arbitrary Tailwind color value. Use a token-backed color class instead.',
        },
      ],
    },
  },
  {
    // The palette/hex rule does not apply where literals are legitimate:
    // test fixtures, the detector script itself, and the foreign-page bundles
    // (extension/bookmarklets) which cannot use app CSS tokens.
    files: [
      '**/*.test.{ts,tsx}',
      'scripts/**',
      'src/extension/**',
      'src/bookmarklets/**',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
])
