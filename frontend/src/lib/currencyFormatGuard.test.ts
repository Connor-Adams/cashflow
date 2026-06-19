import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Regression guard (AC #11): currency rendering must go through the shared
 * en-CA formatters (`formatCurrency` / `formatMoney`). No other source file may
 * construct a `style: 'currency'` `Intl.NumberFormat` with an implicit or
 * `undefined` locale — that re-introduces the system-locale drift this issue
 * fixed. The two formatter modules are the only sanctioned home for a currency
 * `Intl.NumberFormat`, and they pin `en-CA`.
 */

const srcRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

// Formatter modules are the sanctioned home for the construct; tests assert on
// it directly. Everything else must delegate.
const ALLOWED = new Set([
  path.join(srcRoot, 'lib', 'formatCurrency.ts'),
  path.join(srcRoot, 'lib', 'formatMoney.ts'),
])

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    if (ALLOWED.has(full)) continue
    out.push(full)
  }
  return out
}

// Matches an Intl.NumberFormat(...) call whose first argument is `undefined` or
// omitted — i.e. an implicit (system) locale — that also requests currency
// style somewhere in the same construction. We scan the construction window to
// keep this robust to multi-line formatting.
function hasImplicitLocaleCurrencyFormatter(source: string): boolean {
  const re = /new\s+Intl\.NumberFormat\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const start = match.index + match[0].length
    // Find the matching close paren for this constructor call.
    let depth = 1
    let i = start
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    const window = source.slice(start, i)
    if (!/style\s*:\s*['"]currency['"]/.test(window)) continue
    // The first argument is the locale. Implicit if it's `undefined` or the
    // first thing is an options object `{` (no locale arg at all).
    const firstArg = window.replace(/^\s*/, '')
    if (firstArg.startsWith('undefined') || firstArg.startsWith('{')) {
      return true
    }
  }
  return false
}

describe('currency formatting guard', () => {
  it('no non-formatter source uses a currency Intl.NumberFormat with an implicit locale', () => {
    const offenders: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8')
      if (hasImplicitLocaleCurrencyFormatter(source)) {
        offenders.push(path.relative(srcRoot, file))
      }
    }
    expect(
      offenders,
      `Use formatMoney/formatCurrency (en-CA) instead of an implicit-locale currency formatter in: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('self-check: the guard would catch an implicit-locale currency formatter', () => {
    const bad = "new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CAD' })"
    expect(hasImplicitLocaleCurrencyFormatter(bad)).toBe(true)
    const good = "new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })"
    expect(hasImplicitLocaleCurrencyFormatter(good)).toBe(false)
  })
})
