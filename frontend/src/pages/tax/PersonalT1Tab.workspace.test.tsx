/**
 * Workspace state across the page's year picker, and the starter-scenario
 * bootstrap when it fails.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { Scenario } from '../../hooks/useScenarios'

void React

const NOW = new Date().toISOString()

function baseline(id: number, year: number): Scenario {
  return {
    id,
    kind: 'baseline',
    parentId: null,
    entityId: 1,
    year,
    name: `Baseline ${year}`,
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

let byYear: Record<number, Scenario[]> = {}
const detailIds: (number | null)[] = []
const create = vi.fn()

vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 1, kind: 'personal' }], error: null }),
}))
vi.mock('../../hooks/useScenarioChain', () => ({
  useScenarioChain: () => ({ data: [], error: null, loading: false, reload: vi.fn() }),
}))
vi.mock('../../hooks/useTaxOutlook', () => ({
  useTaxOutlook: () => ({ data: null, loading: false, error: null, reload: vi.fn() }),
}))
vi.mock('../../hooks/useScenarios', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScenarios: (_entityId: number, year: number) => ({
    scenarios: byYear[year] ?? [],
    error: null,
    loading: false,
    reload: vi.fn(),
    create,
    patch: vi.fn(),
    fork: vi.fn(),
    remove: vi.fn(),
    projectNextYear: vi.fn(),
  }),
  useScenarioDetail: (id: number | null) => {
    detailIds.push(id)
    return { data: null, error: null, loading: false, reload: vi.fn() }
  },
}))

import { PersonalT1Tab } from './PersonalT1Tab'

describe('PersonalT1Tab workspace', () => {
  beforeEach(() => {
    detailIds.length = 0
    create.mockReset()
    byYear = {}
  })

  it('drops the previous year\'s scenario when the page year changes', async () => {
    byYear = { 2025: [baseline(21, 2025)], 2026: [baseline(11, 2026)] }
    const { rerender } = render(<PersonalT1Tab year={2025} />)
    await waitFor(() => expect(detailIds.at(-1)).toBe(21))
    rerender(<PersonalT1Tab year={2026} />)
    await waitFor(() => expect(detailIds.at(-1)).toBe(11))
  })

  it('attempts the starter scenario once and shows the error when it fails', async () => {
    create.mockRejectedValue(new Error('boom'))
    render(<PersonalT1Tab year={2025} />)
    expect(await screen.findByText(/Failed to create a starter scenario: boom/)).toBeInTheDocument()
    // Give a retry loop room to fire if it still existed.
    await new Promise((r) => setTimeout(r, 50))
    expect(create).toHaveBeenCalledTimes(1)
  })
})
