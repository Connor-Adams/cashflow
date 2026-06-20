import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

// Guards the app-owned Tailwind theme/token-compat layer. If a mapping or legacy
// alias is dropped, pages that use the corresponding utility/var render unstyled
// (the "builds but blank" failure). Cheap static guard; CI's build is the dynamic one.
// Read relative to cwd (vitest runs from the frontend workspace; repo root as fallback).
const themePath = ['src/styles/theme.css', 'frontend/src/styles/theme.css'].find(existsSync)
if (!themePath) throw new Error('theme.css not found from cwd ' + process.cwd())
const theme = readFileSync(themePath, 'utf8')

describe('token theme layer', () => {
  // High-traffic semantic utilities mapped via @theme inline.
  const required = [
    '--color-background', '--color-foreground', '--color-card', '--color-card-foreground',
    '--color-popover', '--color-muted', '--color-muted-foreground',
    '--color-primary', '--color-accent', '--color-accent-foreground',
    '--color-brand', '--color-brand-foreground', '--color-link',
    '--color-border', '--color-input', '--color-ring',
    '--color-danger', '--color-danger-bg', '--color-destructive',
    '--color-warning', '--color-warning-bg', '--color-warning-foreground',
    '--color-success', '--color-success-bg', '--color-success-foreground',
    '--color-info', '--color-info-foreground',
    '--color-positive', '--color-negative', '--color-negative-bg',
  ]
  it.each(required)('maps %s', (token) => {
    expect(theme).toContain(token)
  })

  // Legacy raw-var aliases the app still references in inline styles + App.css.
  const legacyAliases = ['--fg:', '--bg:', '--bg2:', '--bg3:', '--accent-soft:', '--accent-warm:', '--accent-green:', '--accent-positive:']
  it.each(legacyAliases)('aliases legacy var %s', (alias) => {
    expect(theme).toContain(alias)
  })
})
