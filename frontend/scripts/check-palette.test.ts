import { describe, it, expect } from 'vitest'
import { blankComments, findViolations } from './check-palette.mjs'

const find = (src: string, file = 'x.tsx') => findViolations(src, file)
const values = (src: string, file = 'x.tsx') => find(src, file).map((v) => v.value)

describe('blankComments', () => {
  it('blanks line comments but keeps the newline and offsets', () => {
    const out = blankComments('a // PR #259\nb')
    expect(out).toBe('a          \nb')
  })
  it('leaves // inside string literals alone', () => {
    const src = 'const u = "https://x.com//y"'
    expect(blankComments(src)).toBe(src)
  })
  it('blanks block comments across lines', () => {
    expect(blankComments('a/*\n#fff\n*/b')).toBe('a  \n    \n  b')
  })
  it('leaves a regex literal containing // intact (not blanked as a comment)', () => {
    expect(blankComments('const re = /a\\/\\/b/')).toBe('const re = /a\\/\\/b/')
  })
  it('blanks a real line comment after a division operator (not a regex)', () => {
    // "a / b" is division; "// note" after it is a real line comment and must be blanked
    // "// note" = 7 chars → 1 space for "//" token + 5 spaces for " note" = 6 spaces after " b "
    // The key assertion: comment IS blanked (not copied verbatim as if a regex)
    const out = blankComments('const x = a / b // note')
    expect(out).toMatch(/^const x = a \/ b\s+$/)
    expect(out).not.toContain('// note')
  })
})

describe('findViolations — hex', () => {
  it('flags 6-digit hex in tsx', () => {
    expect(values("const c = '#9B2D3A'")).toEqual(['#9B2D3A'])
  })
  it('flags 8-digit hex', () => {
    expect(values("const c = '#9B2D3AFF'")).toEqual(['#9B2D3AFF'])
  })
  it('does not flag a numeric PR ref in a comment', () => {
    expect(values('foo() // see PR #259')).toEqual([])
  })
  it('does not flag a 3-digit token-like ref in tsx code', () => {
    expect(values('const issue = "#259"')).toEqual([])
  })
  it('flags 3-digit hex only inside a css color value', () => {
    expect(values('a { color: #fff; }', 'x.css')).toEqual(['#fff'])
    expect(values('grid-column: #fff', 'x.css')).toEqual([]) // not a color prop
  })
})

describe('findViolations — functional + named', () => {
  it('flags rgb()/hsl()', () => {
    expect(values('background: rgb(155,45,58)', 'x.css')).toContain('rgb()')
    expect(values('color: hsl(0 0% 0%)', 'x.css')).toContain('hsl()')
  })
  it('flags named colors in a css color-mix anchor', () => {
    expect(values('border-color: color-mix(in srgb, var(--border) 88%, white 4%)', 'x.css'))
      .toEqual(['white'])
  })
  it('flags black in color-mix', () => {
    expect(values('background: color-mix(in srgb, var(--bg) 90%, black 4%)', 'x.css'))
      .toEqual(['black'])
  })
  it('flags a named color in a tsx style color key', () => {
    expect(values("style={{ color: 'red' }}")).toEqual(['red'])
  })
  it('does not flag the word red in plain JSX text', () => {
    expect(values('<span>red alert</span>')).toEqual([])
  })
})

describe('findViolations — regex literal', () => {
  it('flags hex color after a regex that contains //', () => {
    expect(findViolations("const re = /https?:\\/\\//; const c = '#abcdef'", 'x.tsx').map((v) => v.value)).toEqual(['#abcdef'])
  })
})

describe('findViolations — clean / suppressed', () => {
  it('does not flag var(--token) references', () => {
    expect(values('color: var(--primary); background: var(--zinc-50)', 'x.css')).toEqual([])
  })
  it('respects // palette-allow on the line', () => {
    expect(values("const c = '#9B2D3A' // palette-allow")).toEqual([])
  })
})
