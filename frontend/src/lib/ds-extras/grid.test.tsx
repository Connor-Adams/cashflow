import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Grid } from './grid'

describe('Grid', () => {
  it('sets a responsive auto-fit template by default', () => {
    const { container } = render(<Grid minItemWidth={200}><span>a</span></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el.style.gridTemplateColumns).toContain('auto-fit')
    expect(el.style.gridTemplateColumns).toContain('200px')
    expect(el.className).toContain('grid')
  })

  it('uses auto-fill when fill is set', () => {
    const { container } = render(<Grid fill><span>a</span></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el.style.gridTemplateColumns).toContain('auto-fill')
  })
})
