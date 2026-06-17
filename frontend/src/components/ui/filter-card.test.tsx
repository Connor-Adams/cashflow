import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { FilterCard } from './filter-card'

describe('FilterCard', () => {
  it('defaults to comfortable (full-width, no compact classes) with mb-4', () => {
    const { container } = render(<FilterCard><div>filters</div></FilterCard>)
    const el = container.querySelector('[data-slot="filter-card"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.className).toContain('mb-4')
    expect(el.className).not.toContain('w-fit')
  })

  it('compact density adds w-fit and tight padding (overriding Card default)', () => {
    const { container } = render(<FilterCard density="compact"><div>filters</div></FilterCard>)
    const el = container.querySelector('[data-slot="filter-card"]') as HTMLElement
    expect(el.className).toContain('w-fit')
    expect(el.className).toContain('p-2')
    expect(el.className).not.toContain('p-4') // twMerge dropped Card's p-4
  })

  it('renders children and merges className', () => {
    const { container, getByText } = render(<FilterCard className="mt-2"><div>filters</div></FilterCard>)
    expect(getByText('filters')).toBeInTheDocument()
    expect((container.querySelector('[data-slot="filter-card"]') as HTMLElement).className).toContain('mt-2')
  })
})
