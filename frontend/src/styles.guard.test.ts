import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = __dirname
const appCss = readFileSync(join(SRC, 'App.css'), 'utf8')
const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8')

// Recursively collect .tsx/.ts source files (excluding tests, extension, bookmarklets
// — the last two inject styles into pages without our stylesheet, so literal hexes/classes are legitimate there).
function collectSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'extension' || entry === 'bookmarklets') continue
      collectSource(full, acc)
    } else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

const HUE_UTILITY = /(?:text|bg|border|ring|from|to|via|fill|stroke|decoration|accent)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|gray|slate|zinc)-[0-9]+/g

describe('palette drift guard', () => {
  it('App.css has no off-palette hardcoded colors', () => {
    expect(appCss).not.toMatch(/rgba\(119,\s*167,\s*255/) // old blue glow
    expect(appCss).not.toMatch(/rgba\(245,\s*158,\s*11/)  // raw tailwind amber
    expect(appCss).not.toMatch(/rgba\(34,\s*197,\s*94/)   // raw tailwind green
  })

  it('index.css no longer defines retired ramps', () => {
    expect(indexCss).not.toMatch(/--plum-\d/)
    expect(indexCss).not.toMatch(/--jade-\d/)
    expect(indexCss).not.toMatch(/--rust-\d/)
    // the new warning ramp --amber-w-* is allowed; the numeric --amber-NN ramp is retired:
    expect(indexCss).not.toMatch(/--amber-\d/)
  })

  it('no hardcoded Tailwind hue/grey utilities remain in app source', () => {
    const offenders: string[] = []
    for (const file of collectSource(SRC)) {
      const text = readFileSync(file, 'utf8')
      const matches = text.match(HUE_UTILITY)
      // allow the new warning ramp utility name amber-w (won't match \d after amber- anyway)
      if (matches) offenders.push(`${file.replace(SRC, 'src')}: ${[...new Set(matches)].join(', ')}`)
    }
    expect(offenders).toEqual([])
  })
})
