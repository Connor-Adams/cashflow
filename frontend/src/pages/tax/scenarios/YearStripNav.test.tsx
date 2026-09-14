/**
 * Tests for YearStripNav — year navigation strip for scenario chains.
 * Covers: empty state, year buttons, active year highlight, project button.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { YearStripNav } from './YearStripNav'

const CHAIN = [
  { scenario: { id: 10, year: 2024, kind: 'personal', name: 'Baseline' } },
  { scenario: { id: 11, year: 2025, kind: 'personal', name: 'Projection' } },
]

describe('YearStripNav', () => {
  it('shows no years message when chain is empty', () => {
    render(
      <YearStripNav
        entityId={1}
        activeYear={2025}
        activeScenarioId={null}
        chain={[]}
        onSelectYear={vi.fn()}
        onProjectNextYear={vi.fn()}
        isProjecting={false}
      />,
    )
    expect(screen.getByText('No years yet.')).toBeInTheDocument()
  })

  it('renders a button for each year in the chain', () => {
    render(
      <YearStripNav
        entityId={1}
        activeYear={2024}
        activeScenarioId={10}
        chain={CHAIN}
        onSelectYear={vi.fn()}
        onProjectNextYear={vi.fn()}
        isProjecting={false}
      />,
    )
    expect(screen.getByRole('button', { name: /2024/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2025/ })).toBeInTheDocument()
  })

  it('calls onSelectYear with year and scenarioId when clicked', () => {
    const onSelectYear = vi.fn()
    render(
      <YearStripNav
        entityId={1}
        activeYear={2024}
        activeScenarioId={10}
        chain={CHAIN}
        onSelectYear={onSelectYear}
        onProjectNextYear={vi.fn()}
        isProjecting={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /2025/ }))
    expect(onSelectYear).toHaveBeenCalledWith(2025, 11)
  })

  // A year whose return could not be computed (e.g. projected past the last
  // encoded rate table) still has to be listed and clickable — it is flagged,
  // not hidden, so the user can see which year is broken and why.
  it('flags a chain entry that failed to compute', () => {
    render(
      <YearStripNav
        entityId={1}
        activeYear={2024}
        activeScenarioId={10}
        chain={[
          CHAIN[0],
          {
            scenario: { id: 12, year: 2098, kind: 'projection_root', name: 'Projection 2098' },
            computed: null,
            error: 'no rate table encoded for year 2098',
          },
        ]}
        onSelectYear={vi.fn()}
        onProjectNextYear={vi.fn()}
        isProjecting={false}
      />,
    )
    const broken = screen.getByRole('button', { name: /2098/ })
    expect(broken).toHaveAttribute('title', expect.stringContaining('no rate table encoded for year 2098'))
    expect(screen.getByLabelText('year failed to compute')).toBeInTheDocument()
    // Still navigable — the user must be able to select and inspect it.
    expect(broken).toBeEnabled()
  })

  it('shows projecting state on project button', () => {
    render(
      <YearStripNav
        entityId={1}
        activeYear={2024}
        activeScenarioId={10}
        chain={CHAIN}
        onSelectYear={vi.fn()}
        onProjectNextYear={vi.fn()}
        isProjecting={true}
      />,
    )
    expect(screen.getByRole('button', { name: /Projecting/ })).toBeDisabled()
  })
})
