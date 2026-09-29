/**
 * The Personal T1 tab must show the year's actuals by default, and must say what
 * the number is when it is not actuals.
 *
 * Locks the prod defect: the tab auto-selected the most-recently-created
 * non-baseline scenario. For entity 1 / 2026 that was scenario 18, a
 * `projection_root` parented to the 2025 fork, which resolves through
 * `projectPersonalFactsFromPrevYear` and carries no 2026 transactions — its cached
 * CPP of 1,168.96 and EI of 384.23 can only be 2025 T4 income scaled forward.
 * Nothing on screen said so.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Scenario } from '../../hooks/useScenarios'

const NOW = new Date().toISOString()

function scenario(over: Partial<Scenario> & Pick<Scenario, 'id' | 'kind'>): Scenario {
  return {
    parentId: null,
    entityId: 1,
    year: 2026,
    name: `S${over.id}`,
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const BASELINE = scenario({ id: 11, kind: 'baseline', name: 'Baseline' })
const FORK = scenario({ id: 12, kind: 'fork', parentId: 11, name: 'Scratch' })
// Created last, parented to the *prior* year's fork — exactly prod's shape.
const PROJECTION = scenario({ id: 18, kind: 'projection_root', parentId: 2, name: 'Projection 2026' })

let scenarioList: Scenario[] = []
const detailIds: (number | null)[] = []
let detailFor: Scenario = BASELINE

vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 1, kind: 'personal' }], error: null }),
}))
vi.mock('../../hooks/useScenarioChain', () => ({
  useScenarioChain: () => ({ chain: [], error: null, loading: false }),
}))
vi.mock('../../hooks/useScenarios', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScenarios: () => ({
    scenarios: scenarioList,
    error: null,
    loading: false,
    reload: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    fork: vi.fn(),
    remove: vi.fn(),
    projectNextYear: vi.fn(),
  }),
  useScenarioDetail: (id: number | null) => {
    detailIds.push(id)
    if (id === null) return { data: null, error: null, loading: false, reload: vi.fn() }
    return {
      data: {
        scenario: detailFor,
        computed: {
          scenarioId: detailFor.id,
          factsHash: 'h',
          computedAt: NOW,
          lines: [],
          totals: { totalPayable: '300.00', refundOrOwing: '300.00', totalIncome: '27035.16', taxableIncome: '27035.16' },
          warnings: [],
          cached: true,
        },
      },
      error: null,
      loading: false,
      reload: vi.fn(),
    }
  },
}))

import { PersonalT1Tab } from './PersonalT1Tab'

describe('PersonalT1Tab provenance', () => {
  beforeEach(() => {
    detailIds.length = 0
    detailFor = BASELINE
  })

  it('defaults to the baseline even though the projection was created last', () => {
    scenarioList = [BASELINE, FORK, PROJECTION]
    render(<PersonalT1Tab year={2026} />)
    // The tab must ask for the baseline's detail, not the last-created scenario.
    expect(detailIds).toContain(11)
    expect(detailIds).not.toContain(18)
  })

  it('says what a projection is and what it lacks when one is selected', () => {
    scenarioList = [PROJECTION]
    detailFor = PROJECTION
    render(<PersonalT1Tab year={2026} />)
    expect(screen.getByText(/Projection from 2025/)).toBeInTheDocument()
    expect(screen.getByText(/Contains no transactions from 2026\./)).toBeInTheDocument()
  })

  it('labels an actuals baseline as actuals', () => {
    scenarioList = [BASELINE]
    detailFor = BASELINE
    render(<PersonalT1Tab year={2026} />)
    expect(screen.getByText(/Actuals/)).toBeInTheDocument()
    expect(screen.queryByText(/Contains no transactions/)).not.toBeInTheDocument()
  })
})
