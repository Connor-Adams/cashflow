import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KpiStack } from './KpiStack'

describe('KpiStack', () => {
  it('renders each item as a DS StatCard with label, value, and hint', () => {
    const { container } = render(
      <KpiStack
        items={[
          { label: 'Transactions', value: 42, hint: 'Rows in current filters' },
          { label: 'Merchants', value: 7, hint: 'Distinct merchants' },
        ]}
      />,
    )

    // Rows render via the DS StatCard primitive (data-slot="stat-card").
    expect(container.querySelectorAll('[data-slot="stat-card"]')).toHaveLength(2)

    expect(screen.getByText('Transactions')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Rows in current filters')).toBeInTheDocument()
    expect(screen.getByText('Merchants')).toBeInTheDocument()
  })

  it('renders a delta node when provided', () => {
    render(
      <KpiStack
        items={[
          { label: 'Transactions', value: 42, delta: <span>+5</span> },
        ]}
      />,
    )
    expect(screen.getByText('+5')).toBeInTheDocument()
  })

  it('omits the top border on the first row only', () => {
    const { container } = render(
      <KpiStack
        items={[
          { label: 'A', value: 1 },
          { label: 'B', value: 2 },
        ]}
      />,
    )
    const rows = container.querySelectorAll('[data-slot="stat-card"]')
    // jsdom serializes `border-top: none` to an empty string; the separator row
    // keeps a real tokenized top border.
    expect((rows[0] as HTMLElement).style.borderTop).toBe('')
    expect((rows[1] as HTMLElement).style.borderTop).toContain('var(--border)')
  })
})
