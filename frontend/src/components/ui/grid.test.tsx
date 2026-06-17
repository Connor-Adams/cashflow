import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Grid } from './grid'

describe('Grid', () => {
  it('emits an auto-fit minmax template with a responsive floor by default', () => {
    const { container } = render(<Grid minItemWidth={180}><div /></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.className).toContain('grid')
    expect(el.className).toContain('gap-3') // md default
    expect(el.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(100%, 180px), 1fr))')
  })

  it('supports auto-fill and a bare (non-floored) min track', () => {
    const { container } = render(<Grid minItemWidth={320} fill responsiveFloor={false} gap="lg"><div /></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el.className).toContain('gap-4')
    expect(el.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(320px, 1fr))')
  })

  it('merges a passed className', () => {
    const { container } = render(<Grid className="mb-4"><div /></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el.className).toContain('mb-4')
    expect(el.className).toContain('grid')
  })
})
