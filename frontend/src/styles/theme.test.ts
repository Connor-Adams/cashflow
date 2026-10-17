import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

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

// ── Chart tokens ────────────────────────────────────────────────────────────
// @connor-adams/tokens ships a chart ramp (--chart-1…5, --chart-line-1…6,
// --chart-spend/credit/payment/business/personal). The per-domain names the
// Sankey / forecast / scenario / performance charts reach for are app-owned and
// aliased in theme.css. A `var(--chart-…)` that resolves nowhere silently falls
// back to the browser default fill (black rects, invisible strokes), so scan the
// real call sites rather than trusting a hand-kept list.
const srcRoot = ['src', 'frontend/src'].find(existsSync)
if (!srcRoot) throw new Error('frontend src not found from cwd ' + process.cwd())

const dsTokens = readFileSync(
  createRequire(import.meta.url).resolve('@connor-adams/tokens/src/semantic.css'),
  'utf8',
)

function definedTokens(css: string): Set<string> {
  return new Set(css.match(/--chart-[a-z0-9-]+(?=\s*:)/g) ?? [])
}

const defined = new Set([...definedTokens(dsTokens), ...definedTokens(theme)])

const referenced = new Map<string, string[]>()
for (const entry of readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })) {
  if (!/\.(ts|tsx|css)$/.test(entry)) continue
  const file = join(srcRoot, entry)
  if (!statSync(file).isFile()) continue
  for (const m of readFileSync(file, 'utf8').matchAll(/var\(\s*(--chart-[a-z0-9-]+)/g)) {
    referenced.set(m[1], [...(referenced.get(m[1]) ?? []), entry])
  }
}

describe('chart tokens', () => {
  it('finds chart token references to check', () => {
    expect(referenced.size).toBeGreaterThan(10)
  })

  it('resolves every referenced --chart-* token', () => {
    const orphans = [...referenced]
      .filter(([token]) => !defined.has(token))
      .map(([token, files]) => `${token} (${[...new Set(files)].join(', ')})`)
    expect(orphans).toEqual([])
  })

  // The app-owned aliases, spelled out so a deletion names itself in the diff.
  const appOwned = [
    '--chart-income:', '--chart-category:', '--chart-savings:', '--chart-uncategorized:',
    '--chart-draws:', '--chart-surplus:',
    '--chart-link-stroke:', '--chart-danger-line:',
    '--chart-scenario:', '--chart-scenario-pos:', '--chart-scenario-neg:',
    '--chart-portfolio:', '--chart-reference:',
  ]
  it.each(appOwned)('aliases %s', (alias) => {
    expect(theme).toContain(alias)
  })
})
