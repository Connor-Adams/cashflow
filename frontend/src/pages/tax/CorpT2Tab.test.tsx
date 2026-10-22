import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

void React

const scenarioYears: number[] = []
const create = vi.fn()
const patchJson = vi.fn()
const corpEntity: Record<string, unknown> = { id: 7, kind: 'corp', legalName: 'Acme Inc', associatedGroupId: null }

vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({
    entities: [corpEntity],
    error: null,
    reload: vi.fn(),
  }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  patchJson: (...args: unknown[]) => patchJson(...args),
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
    patchJson.mockReset()
    corpEntity.personalServicesBusinessYears = [2024]
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

  it('toggles personal services business for the page year only', async () => {
    create.mockResolvedValue({})
    patchJson.mockResolvedValue({})
    render(<CorpT2Tab year={2025} />)
    const box = screen.getByRole('checkbox', { name: /Personal services business in 2025/ })
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(patchJson).toHaveBeenCalledTimes(1))
    expect(patchJson).toHaveBeenCalledWith('/api/tax/entities/7', {
      personalServicesBusinessYears: [2024, 2025],
    })
  })

  it('shows a flagged year as checked and unticking removes only that year', async () => {
    create.mockResolvedValue({})
    patchJson.mockResolvedValue({})
    corpEntity.personalServicesBusinessYears = [2024, 2025]
    render(<CorpT2Tab year={2025} />)
    const box = screen.getByRole('checkbox', { name: /Personal services business in 2025/ })
    expect(box).toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(patchJson).toHaveBeenCalledWith('/api/tax/entities/7', {
      personalServicesBusinessYears: [2024],
    }))
  })
})
