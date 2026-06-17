import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SectionHeader } from './section-header'

describe('SectionHeader', () => {
  it('renders the title as an h2', () => {
    render(<SectionHeader title="Accounts" />)
    const h = screen.getByRole('heading', { name: 'Accounts', level: 2 })
    expect(h).toBeInTheDocument()
  })

  it('renders description and actions when provided', () => {
    render(
      <SectionHeader
        title="Budgets"
        description="Spend vs target"
        actions={<button>Add</button>}
      />,
    )
    expect(screen.getByText('Spend vs target')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('omits description and actions wrappers when absent', () => {
    const { container } = render(<SectionHeader title="Bare" />)
    expect(container.querySelector('[data-slot="section-header"]')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('merges a passed className', () => {
    const { container } = render(<SectionHeader title="X" className="mb-0" />)
    const el = container.querySelector('[data-slot="section-header"]') as HTMLElement
    expect(el.className).toContain('mb-0')
    expect(el.className).toContain('justify-between')
  })
})
