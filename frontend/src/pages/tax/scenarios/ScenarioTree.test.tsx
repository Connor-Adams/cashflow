/**
 * Tests for ScenarioTree — tree-structured scenario list for tax planning.
 * Covers: empty state, scenario buttons, active scenario, fork/delete buttons.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScenarioTree } from './ScenarioTree'
import type { Scenario } from '../../../hooks/useScenarios'

const NOW = new Date().toISOString()

const BASELINE: Scenario = {
  id: 1,
  parentId: null,
  name: 'Baseline',
  year: 2025,
  entityId: 1,
  kind: 'baseline',
  overrides: {},
  assumptions: {},
  nextYearId: null,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
}

const SCRATCH: Scenario = {
  id: 2,
  parentId: 1,
  name: 'Scratch',
  year: 2025,
  entityId: 1,
  kind: 'fork',
  overrides: {},
  assumptions: {},
  nextYearId: null,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
}

const PROJECTION: Scenario = {
  id: 3,
  parentId: null,
  name: 'Projection 2026',
  year: 2026,
  entityId: 1,
  kind: 'projection_root',
  overrides: {},
  assumptions: {},
  nextYearId: null,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
}

describe('ScenarioTree', () => {
  it('renders all three kinds distinguishably', () => {
    render(
      <ScenarioTree
        scenarios={[BASELINE, SCRATCH, PROJECTION]}
        activeId={null}
        onSelect={vi.fn()}
        onForkActive={vi.fn()}
        onDeleteActive={vi.fn()}
      />,
    )
    // A baseline is the year's actuals.
    expect(screen.getByRole('button', { name: /Baseline.*actuals/ })).toBeInTheDocument()
    // A projection root is NOT actuals and must say so — this is the defect that
    // let a 2025-scaled forecast render as if it were the 2026 return.
    expect(
      screen.getByRole('button', { name: /Projection 2026.*projection/i }),
    ).toBeInTheDocument()
    // A fork carries overrides on top of actuals; it is neither of the above.
    const fork = screen.getByRole('button', { name: /Scratch/ })
    expect(fork.textContent).not.toMatch(/actuals\)/)
    expect(fork.textContent).not.toMatch(/projection/i)
  })

  it('shows empty state when no scenarios', () => {
    render(
      <ScenarioTree
        scenarios={[]}
        activeId={null}
        onSelect={vi.fn()}
        onForkActive={vi.fn()}
        onDeleteActive={vi.fn()}
      />,
    )
    expect(screen.getByText('No scenarios yet.')).toBeInTheDocument()
  })

  it('renders scenario names as buttons', () => {
    render(
      <ScenarioTree
        scenarios={[BASELINE, SCRATCH]}
        activeId={null}
        onSelect={vi.fn()}
        onForkActive={vi.fn()}
        onDeleteActive={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Baseline/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Scratch/ })).toBeInTheDocument()
  })

  it('calls onSelect with id when a scenario is clicked', () => {
    const onSelect = vi.fn()
    render(
      <ScenarioTree
        scenarios={[BASELINE]}
        activeId={null}
        onSelect={onSelect}
        onForkActive={vi.fn()}
        onDeleteActive={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Baseline/ }))
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('fork and delete buttons are disabled when no active id', () => {
    render(
      <ScenarioTree
        scenarios={[BASELINE]}
        activeId={null}
        onSelect={vi.fn()}
        onForkActive={vi.fn()}
        onDeleteActive={vi.fn()}
      />,
    )
    const buttons = screen.getAllByRole('button')
    const forkBtn = buttons.find((b) => b.textContent?.includes('Fork'))
    const deleteBtn = buttons.find((b) => b.textContent === 'Delete')
    expect(forkBtn).toBeDisabled()
    expect(deleteBtn).toBeDisabled()
  })

  it('fork and delete buttons are enabled when active id is set', () => {
    render(
      <ScenarioTree
        scenarios={[BASELINE]}
        activeId={1}
        onSelect={vi.fn()}
        onForkActive={vi.fn()}
        onDeleteActive={vi.fn()}
      />,
    )
    const buttons = screen.getAllByRole('button')
    const forkBtn = buttons.find((b) => b.textContent?.includes('Fork'))
    const deleteBtn = buttons.find((b) => b.textContent === 'Delete')
    expect(forkBtn).not.toBeDisabled()
    expect(deleteBtn).not.toBeDisabled()
  })
})
