import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')

function expectToken(name: string, value: string) {
  expect(css).toContain(`${name}: ${value};`)
}

describe('cashflow palette tokens', () => {
  test('defines the explicit brand tonal scales', () => {
    expectToken('--amber-400', '#E0A726')
    expectToken('--plum-600', '#5B2B46')
    expectToken('--jade-400', '#3FA46D')
    expectToken('--rust-400', '#C14E2A')
    expectToken('--ink', '#121118')
    expectToken('--bone', '#FAF7F0')
  })

  test('maps semantic UI tokens to palette variables instead of raw oklch values', () => {
    expectToken('--background', 'var(--bone)')
    expectToken('--foreground', 'var(--ink)')
    expectToken('--card', 'var(--cream)')
    expectToken('--primary', 'var(--amber-400)')
    expectToken('--primary-hover', 'var(--amber-500)')
    expectToken('--secondary', 'var(--plum-600)')
    expectToken('--success-bg', 'var(--jade-50)')
    expectToken('--warning-bg', 'var(--rust-50)')
  })
})
