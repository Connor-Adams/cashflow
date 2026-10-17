import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

void React

const scenarioYears: number[] = []
const create = vi.fn()

vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({
    entities: [{ id: 7, kind: 'corp', legalName: 'Acme Inc', associatedGroupId: null }],
    error: null,
    reload: vi.fn(),
  }),
}))
vi.mock('../../hooks/useCorpScenarios', () => ({
  useCorpScenarios: (_entityId: number, year: number) => {
    scenarioYears.push(year)
    return {
      scenarios: [],
      loading: false,
      error: null,
      reload: vi.fn(),
      create,
      patch: vi.fn(),
      fork: vi.fn(),
      remove: vi.fn(),
      projectNextYear: vi.fn(),
    }
  },
}))
vi.mock('../../hooks/useCorpScenarioDetail', () => ({
  useCorpScenarioDetail: () => ({ data: null, error: null, loading: false, reload: vi.fn() }),
}))
vi.mock('../../hooks/useCorpScenarioChain', () => ({
  useCorpScenarioChain: () => ({ data: [], error: null, loading: false, reload: vi.fn() }),
}))

import { CorpT2Tab } from './CorpT2Tab'

describe('CorpT2Tab', () => {
  beforeEach(() => {
    scenarioYears.length = 0
    create.mockReset()
  })

  it('loads scenarios for the page year and follows it when it changes', () => {
    create.mockResolvedValue({})
    const { rerender } = render(<CorpT2Tab year={2025} />)
    // Not the calendar year: the tab used to default to it and ignore the picker.
    expect(scenarioYears).toEqual(scenarioYears.map(() => 2025))
    rerender(<CorpT2Tab year={2024} />)
    expect(scenarioYears.at(-1)).toBe(2024)
  })

  it('attempts the starter scenario once and shows the error when it fails', async () => {
    create.mockRejectedValue(new Error('boom'))
    render(<CorpT2Tab year={2025} />)
    expect(await screen.findByText(/Failed to create a starter scenario: boom/)).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 50))
    expect(create).toHaveBeenCalledTimes(1)
  })
})
